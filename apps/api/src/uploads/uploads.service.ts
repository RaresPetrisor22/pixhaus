import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import type { StudioUserPrincipal } from '../auth/principal';
import { authorize } from '../authz/authorize';
import { ApiException } from '../common/api-exception';
import { GalleriesRepository } from '../galleries/galleries.repository';
import { QueueService } from '../queue/queue.service';
import { originalKey } from '@pixhaus/storage';
import { StorageService } from '../storage/storage.service';
import { isAcceptedContentType, ACCEPTED_CONTENT_TYPES } from './content-types';
import { MAGIC_BYTES_NEEDED, sniffImageType } from './magic-bytes';
import type { CreateUploadInput } from './uploads.schemas';
import { UploadsRepository } from './uploads.repository';

export type FinalizedAsset = {
  assetId: string;
  status: 'uploaded';
  contentType: string;
  sizeBytes: number;
};

export type UploadTicket = {
  assetId: string;
  uploadUrl: string;
  expiresAt: Date;
  method: 'PUT';
  /** Exactly what the uploader must send. They are signed; anything else 403s. */
  headers: Record<string, string>;
};

@Injectable()
export class UploadsService {
  constructor(
    private readonly galleries: GalleriesRepository,
    private readonly assets: UploadsRepository,
    private readonly storage: StorageService,
    private readonly queue: QueueService,
  ) {}

  async createUpload(
    principal: StudioUserPrincipal,
    galleryId: string,
    input: CreateUploadInput,
  ): Promise<UploadTicket> {
    const gallery = await this.galleries.findById(principal.studioId, galleryId);

    if (!gallery) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'gallery_not_found', 'No such gallery.');
    }

    const decision = authorize(principal, 'asset.create', {
      kind: 'gallery',
      studioId: principal.studioId,
      status: gallery.status,
    });

    if (!decision.allow) {
      throw denied(decision.reason);
    }

    // Policy checks, after authorization: a caller who may not upload here
    // should not learn our size ceiling by probing.
    if (input.size > this.storage.maxUploadBytes) {
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'file_too_large',
        `Files must be ${this.storage.maxUploadBytes} bytes or smaller.`,
      );
    }

    if (!isAcceptedContentType(input.contentType)) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'unsupported_content_type',
        `Supported types: ${ACCEPTED_CONTENT_TYPES.join(', ')}.`,
      );
    }

    // Generated here, not by the database, because the storage key contains it
    // and the key is an insert column.
    const assetId = randomUUID();
    const storageKey = originalKey(principal.studioId, galleryId, assetId);

    await this.assets.create({
      id: assetId,
      galleryId,
      studioId: principal.studioId,
      storageKey,
      originalFilename: input.filename,
    });

    const upload = await this.storage.presignPut(storageKey, {
      contentLength: input.size,
      contentType: input.contentType,
    });

    return {
      assetId,
      uploadUrl: upload.url,
      expiresAt: upload.expiresAt,
      method: 'PUT',
      headers: upload.headers,
    };
  }

  /**
   * The trust boundary.
   *
   * Until this runs the server has never seen the object — it handed out a URL
   * and was told, by the same party that used it, that something arrived. So it
   * goes and looks. Only what it observes itself is written to the row.
   */
  async finalize(principal: StudioUserPrincipal, assetId: string): Promise<FinalizedAsset> {
    const asset = await this.assets.findById(principal.studioId, assetId);

    if (!asset) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such upload.');
    }

    // The reaper got here first — the row is a tombstone and the bytes are gone.
    if (asset.status === 'orphaned') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'upload_expired',
        'This upload was abandoned and has been cleaned up. Start a new one.',
      );
    }

    if (asset.status !== 'pending') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'already_finalized',
        'This upload has already been finalized.',
      );
    }

    const head = await this.storage.head(asset.storageKey);

    // Nothing was ever uploaded. Leave it pending rather than orphaning it: the
    // URL may still be live, and a client retrying a dropped connection should
    // find its asset where it left it. The reaper sweeps what never comes back.
    if (!head) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'object_missing',
        'Nothing has been uploaded for this asset yet.',
      );
    }

    if (head.sizeBytes <= 0 || head.sizeBytes > this.storage.maxUploadBytes) {
      return this.reject(principal.studioId, asset.storageKey, assetId, 'size');
    }

    const magic = await this.storage.getRange(asset.storageKey, 0, MAGIC_BYTES_NEEDED - 1);
    const contentType = magic ? sniffImageType(magic) : null;

    if (!contentType) {
      return this.reject(principal.studioId, asset.storageKey, assetId, 'content');
    }

    // Guarded on status='pending', so a concurrent finalize loses here rather
    // than both succeeding.
    const won = await this.assets.markUploaded(principal.studioId, assetId, {
      contentType,
      sizeBytes: head.sizeBytes,
    });

    if (!won) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'already_finalized',
        'This upload has already been finalized.',
      );
    }

    await this.queue.enqueueRendition({ assetId, studioId: principal.studioId });

    return { assetId, status: 'uploaded', contentType, sizeBytes: head.sizeBytes };
  }

  /**
   * Delete the bytes, then record the rejection. Leaving the object would mean
   * the lie still bought free storage, which is the whole attack ADR 0002 is
   * about.
   */
  private async reject(
    studioId: string,
    storageKey: string,
    assetId: string,
    reason: 'size' | 'content',
  ): Promise<never> {
    await this.storage.remove([storageKey]);
    await this.assets.markOrphaned(studioId, assetId);

    throw new ApiException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'upload_rejected',
      reason === 'size'
        ? 'The uploaded object is empty or larger than the limit.'
        : 'The uploaded object is not an image we support.',
    );
  }
}

function denied(reason: string): ApiException {
  if (reason === 'email_unverified') {
    return new ApiException(
      HttpStatus.FORBIDDEN,
      'email_unverified',
      'Verify your email address before uploading.',
    );
  }

  if (reason === 'gallery_archived') {
    return new ApiException(
      HttpStatus.FORBIDDEN,
      'gallery_archived',
      'This gallery is archived. Un-archive it before uploading.',
    );
  }

  return new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'Not allowed.');
}
