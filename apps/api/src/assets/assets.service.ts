import { HttpStatus, Injectable } from '@nestjs/common';
import type { RenditionKind } from '@pixhaus/storage';

import type { StudioUserPrincipal } from '../auth/principal';
import { authorize } from '../authz/authorize';
import { ApiException } from '../common/api-exception';
import { StorageService } from '../storage/storage.service';
import { AssetsRepository } from './assets.repository';

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
    private readonly storage: StorageService,
  ) {}

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
