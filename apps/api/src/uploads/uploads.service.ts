import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable } from '@nestjs/common';

import type { StudioUserPrincipal } from '../auth/principal';
import { authorize } from '../authz/authorize';
import { ApiException } from '../common/api-exception';
import { GalleriesRepository } from '../galleries/galleries.repository';
import { originalKey } from '../storage/storage-key';
import { StorageService } from '../storage/storage.service';
import { isAcceptedContentType, ACCEPTED_CONTENT_TYPES } from './content-types';
import type { CreateUploadInput } from './uploads.schemas';
import { UploadsRepository } from './uploads.repository';

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
