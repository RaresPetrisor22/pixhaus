import { HttpStatus, Injectable } from '@nestjs/common';
import type { RenditionKind } from '@pixhaus/storage';

import type { StudioUserPrincipal } from '../auth/principal';
import { authorize } from '../authz/authorize';
import { ApiException } from '../common/api-exception';
import { GalleriesRepository } from '../galleries/galleries.repository';
import { StorageService } from '../storage/storage.service';
import { AssetsRepository, type AssetPage } from './assets.repository';
import type { ListAssetsInput } from './assets.schemas';

/**
 * How long the URL a browser is redirected to stays valid.
 *
 * Short, because a grid of 200 thumbnails hands out 200 of these and each one
 * is a bearer token for an object. Long enough that a slow page still loads
 * every image it was given a URL for.
 */
export const RENDITION_URL_TTL_SECONDS = 300;

@Injectable()
export class AssetsService {
  constructor(
    private readonly assets: AssetsRepository,
    private readonly galleries: GalleriesRepository,
    private readonly storage: StorageService,
  ) {}

  async list(
    principal: StudioUserPrincipal,
    galleryId: string,
    query: ListAssetsInput,
  ): Promise<AssetPage> {
    const gallery = await this.galleries.findById(principal.studioId, galleryId);

    if (!gallery) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'gallery_not_found', 'No such gallery.');
    }

    const decision = authorize(principal, 'gallery.view', {
      kind: 'gallery',
      studioId: principal.studioId,
      status: gallery.status,
    });

    if (!decision.allow) {
      throw new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'Not allowed.');
    }

    return this.assets.list(principal.studioId, galleryId, query.limit, query.cursor);
  }

  async remove(principal: StudioUserPrincipal, assetId: string): Promise<void> {
    const objects = await this.assets.findObjects(principal.studioId, assetId);

    if (!objects) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such asset.');
    }

    const decision = authorize(principal, 'gallery.manage', {
      kind: 'gallery',
      studioId: principal.studioId,
      status: objects.galleryStatus,
    });

    if (!decision.allow) {
      if (decision.reason === 'email_unverified') {
        throw new ApiException(
          HttpStatus.FORBIDDEN,
          'email_unverified',
          'Verify your email address before deleting photos.',
        );
      }

      throw new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'Not allowed.');
    }

    if (!(await this.assets.delete(principal.studioId, assetId))) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such asset.');
    }

    await this.storage.remove([objects.storageKey, ...objects.renditionKeys]);
  }

  /**
   * The bytes never come through here — the caller is redirected at the bucket
   * with a URL that expires. That is the same trade as the upload: the API
   * decides, storage transfers.
   */
  async renditionUrl(
    principal: StudioUserPrincipal,
    assetId: string,
    kind: RenditionKind,
  ): Promise<string> {
    const asset = await this.assets.findRendition(principal.studioId, assetId, kind);

    if (!asset) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such asset.');
    }

    const decision = authorize(principal, 'asset.view_preview', {
      kind: 'asset',
      studioId: principal.studioId,
      galleryId: asset.galleryId,
      status: asset.assetStatus,
      galleryStatus: asset.galleryStatus,
    });

    if (!decision.allow) {
      // 409 rather than 404: the asset is theirs, and either it is coming or it
      // needs attention.
      if (decision.reason === 'asset_not_ready') {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'asset_not_ready',
          asset.assetStatus === 'failed'
            ? 'This photo could not be processed.'
            : 'This photo is still being processed.',
        );
      }

      throw new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'Not allowed.');
    }

    // Ready, but this particular size is missing — a rendition deleted out from
    // under us, or a `kind` added after this asset was processed.
    if (!asset.storageKey) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'rendition_not_found',
        'That size has not been generated for this photo.',
      );
    }

    return this.storage.presignGet(asset.storageKey, { expiresIn: RENDITION_URL_TTL_SECONDS });
  }
}
