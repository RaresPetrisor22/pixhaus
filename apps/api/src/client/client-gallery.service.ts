import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { RenditionKind } from '@pixhaus/storage';

import type { GrantPrincipal } from '../auth/principal';
import { authorize, type Action, type DenyReason, type Resource } from '../authz/authorize';
import { AssetsRepository } from '../assets/assets.repository';
import { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import { GalleriesRepository } from '../galleries/galleries.repository';
import { StorageService } from '../storage/storage.service';
import type { ClientGalleryInput } from './client.schemas';

export type SignedUrl = { url: string; expiresAt: Date };

export type ClientGalleryPage = {
  gallery: { id: string; title: string };
  assets: {
    id: string;
    filename: string;
    width: number | null;
    height: number | null;
    blurhash: string | null;
    thumbUrl: string | null;
    gridUrl: string | null;
  }[];
  nextCursor: string | null;
};

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'asset_not_found', 'No such photo.');
}

function denied(reason: DenyReason): ApiException {
  if (reason === 'missing_right') {
    return new ApiException(
      HttpStatus.FORBIDDEN,
      'missing_right',
      'This link does not allow that.',
    );
  }

  // The photo is in the gallery but the worker has not finished with it, or
  // gave up. A client can only wait, so say so rather than pretending it is
  // missing.
  if (reason === 'asset_not_ready') {
    return new ApiException(HttpStatus.CONFLICT, 'asset_not_ready', 'This photo is not ready yet.');
  }

  // wrong_gallery and wrong_tenant cannot happen — every query below is scoped
  // to the grant's own gallery, so a mismatch has already returned 404.
  return new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'Not allowed.');
}

@Injectable()
export class ClientGalleryService {
  private readonly urlTtlSeconds: number;

  constructor(
    private readonly galleries: GalleriesRepository,
    private readonly assets: AssetsRepository,
    private readonly storage: StorageService,
    config: ConfigService<Env, true>,
  ) {
    this.urlTtlSeconds = config.get('CLIENT_URL_TTL_SECONDS', { infer: true });
  }

  private must(principal: GrantPrincipal, action: Action, resource: Resource): void {
    const decision = authorize(principal, action, resource);

    if (!decision.allow) {
      throw denied(decision.reason);
    }
  }

  /**
   * One request per page, with both grid sizes already signed. Presigning is a
   * local HMAC, so fifty of them cost nothing and the browser never comes back
   * here for an image.
   */
  async gallery(principal: GrantPrincipal, query: ClientGalleryInput): Promise<ClientGalleryPage> {
    const gallery = await this.galleries.findById(principal.studioId, principal.galleryId);

    // The gallery was deleted and the grant cascaded with it. The caller holds
    // a valid token, so there is nothing to conceal.
    if (!gallery) {
      throw new ApiException(
        HttpStatus.GONE,
        'grant_not_found',
        'This gallery is no longer available.',
      );
    }

    this.must(principal, 'gallery.view', {
      kind: 'gallery',
      studioId: principal.studioId,
      status: gallery.status,
    });

    const page = await this.assets.listReady(
      principal.studioId,
      principal.galleryId,
      query.limit,
      query.cursor,
    );

    const assets = await Promise.all(
      page.assets.map(async (asset) => ({
        id: asset.id,
        filename: asset.originalFilename,
        width: asset.width,
        height: asset.height,
        blurhash: asset.blurhash,
        thumbUrl: await this.sign(asset.thumbKey),
        gridUrl: await this.sign(asset.gridKey),
      })),
    );

    return {
      gallery: { id: gallery.id, title: gallery.title },
      assets,
      nextCursor: page.nextCursor,
    };
  }

  async renditionUrl(
    principal: GrantPrincipal,
    assetId: string,
    kind: RenditionKind,
  ): Promise<SignedUrl> {
    const asset = await this.assets.findRendition(
      principal.studioId,
      assetId,
      kind,
      principal.galleryId,
    );

    if (!asset) {
      throw notFound();
    }

    this.must(principal, 'asset.view_preview', {
      kind: 'asset',
      studioId: principal.studioId,
      galleryId: asset.galleryId,
      status: asset.assetStatus,
      galleryStatus: asset.galleryStatus,
    });

    if (!asset.storageKey) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'rendition_not_found',
        'That size is not available for this photo.',
      );
    }

    return {
      url: await this.storage.presignGet(asset.storageKey, { expiresIn: this.urlTtlSeconds }),
      expiresAt: this.expiry(),
    };
  }

  /** The full-resolution original, as a save-as. */
  async downloadUrl(principal: GrantPrincipal, assetId: string): Promise<SignedUrl> {
    const asset = await this.assets.findOriginal(principal.studioId, assetId, principal.galleryId);

    if (!asset) {
      throw notFound();
    }

    this.must(principal, 'asset.download_full', {
      kind: 'asset',
      studioId: principal.studioId,
      galleryId: asset.galleryId,
      status: asset.assetStatus,
      galleryStatus: asset.galleryStatus,
    });

    return {
      url: await this.storage.presignGet(asset.storageKey, {
        expiresIn: this.urlTtlSeconds,
        downloadFilename: asset.originalFilename,
      }),
      expiresAt: this.expiry(),
    };
  }

  private async sign(key: string | null): Promise<string | null> {
    return key ? this.storage.presignGet(key, { expiresIn: this.urlTtlSeconds }) : null;
  }

  private expiry(): Date {
    return new Date(Date.now() + this.urlTtlSeconds * 1000);
  }
}
