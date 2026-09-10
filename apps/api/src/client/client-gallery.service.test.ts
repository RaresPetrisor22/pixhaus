import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ConfigService } from '@nestjs/config';
import type { RenditionKind } from '@pixhaus/storage';

import type {
  AssetOriginal,
  AssetRendition,
  AssetsRepository,
  ClientAssetPage,
} from '../assets/assets.repository';
import type { GrantPrincipal } from '../auth/principal';
import { RIGHT } from '../authz/rights';
import type { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import type { Gallery, GalleriesRepository } from '../galleries/galleries.repository';
import type { StorageService } from '../storage/storage.service';
import { ClientGalleryService } from './client-gallery.service';

const TTL = 5400;
const STUDIO = '11111111-1111-1111-1111-111111111111';
const GALLERY = '22222222-2222-2222-2222-222222222222';
const OTHER_GALLERY = '44444444-4444-4444-4444-444444444444';
const ASSET = '33333333-3333-3333-3333-333333333333';

const delivery: GrantPrincipal = {
  kind: 'grant',
  grantId: 'gr1',
  studioId: STUDIO,
  galleryId: GALLERY,
  rightsMask: RIGHT.view | RIGHT.download,
  epoch: 0,
};

const viewOnly: GrantPrincipal = { ...delivery, rightsMask: RIGHT.view };

const gallery: Gallery = {
  id: GALLERY,
  title: 'Ana & Mihai',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

function page(): ClientAssetPage {
  return {
    assets: [
      {
        id: ASSET,
        originalFilename: 'DSC_0001.jpg',
        width: 6000,
        height: 4000,
        blurhash: 'L6PZ',
        thumbKey: `studios/${STUDIO}/galleries/${GALLERY}/renditions/${ASSET}/thumb.webp`,
        gridKey: `studios/${STUDIO}/galleries/${GALLERY}/renditions/${ASSET}/grid.webp`,
      },
      {
        id: 'aaaaaaaa-0000-4000-8000-000000000002',
        originalFilename: 'DSC_0002.jpg',
        width: null,
        height: null,
        blurhash: null,
        thumbKey: null,
        gridKey: null,
      },
    ],
    nextCursor: 'next',
  };
}

function rendition(overrides: Partial<AssetRendition> = {}): AssetRendition {
  return {
    assetStatus: 'ready',
    galleryId: GALLERY,
    galleryStatus: 'active',
    originalFilename: 'DSC_0001.jpg',
    storageKey: `studios/${STUDIO}/galleries/${GALLERY}/renditions/${ASSET}/preview.webp`,
    ...overrides,
  };
}

function original(overrides: Partial<AssetOriginal> = {}): AssetOriginal {
  return {
    assetStatus: 'ready',
    galleryId: GALLERY,
    galleryStatus: 'active',
    storageKey: `studios/${STUDIO}/galleries/${GALLERY}/originals/${ASSET}`,
    originalFilename: 'DSC_0001.jpg',
    ...overrides,
  };
}

function build(
  options: {
    gallery?: Gallery | null;
    rendition?: AssetRendition | null;
    original?: AssetOriginal | null;
  } = {},
) {
  const listed: { galleryId: string; limit: number; cursor?: string }[] = [];
  const asked: { assetId: string; kind: RenditionKind; galleryId?: string }[] = [];
  const askedOriginal: { assetId: string; galleryId?: string }[] = [];
  const presigned: { key: string; expiresIn: number; downloadFilename?: string }[] = [];

  const assets = {
    listReady: (_s: string, galleryId: string, limit: number, cursor?: string) => {
      listed.push({ galleryId, limit, cursor });
      return Promise.resolve(page());
    },
    findRendition: (_s: string, assetId: string, kind: RenditionKind, galleryId?: string) => {
      asked.push({ assetId, kind, galleryId });
      return Promise.resolve(options.rendition === undefined ? rendition() : options.rendition);
    },
    findOriginal: (_s: string, assetId: string, galleryId?: string) => {
      askedOriginal.push({ assetId, galleryId });
      return Promise.resolve(options.original === undefined ? original() : options.original);
    },
  } as unknown as AssetsRepository;

  const galleries = {
    findById: () => Promise.resolve(options.gallery === undefined ? gallery : options.gallery),
  } as unknown as GalleriesRepository;

  const storage = {
    presignGet: (key: string, o: { expiresIn: number; downloadFilename?: string }) => {
      presigned.push({ key, ...o });
      return Promise.resolve(`https://bucket.example/${key}?sig=x`);
    },
  } as unknown as StorageService;

  const config = { get: () => TTL } as unknown as ConfigService<Env, true>;

  return {
    service: new ClientGalleryService(galleries, assets, storage, config),
    listed,
    asked,
    askedOriginal,
    presigned,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'no_error';
  } catch (error) {
    return (error as ApiException).code;
  }
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    return (error as ApiException).getStatus();
  }
}

describe('ClientGalleryService — gallery', () => {
  test('reads the gallery from the grant, never from a parameter', async () => {
    const { service, listed } = build();
    await service.gallery(delivery, { limit: 50 });

    assert.equal(listed[0].galleryId, GALLERY);
  });

  test('every asset comes back with its thumb and grid already signed', async () => {
    const { service } = build();
    const result = await service.gallery(delivery, { limit: 50 });

    assert.match(result.assets[0].thumbUrl!, /thumb\.webp\?sig=/);
    assert.match(result.assets[0].gridUrl!, /grid\.webp\?sig=/);
  });

  test('a page of 50 costs one round trip, not 51', async () => {
    // The whole reason the URLs are embedded: presigning is local, so the
    // browser never comes back here for an image.
    const { service, listed } = build();
    await service.gallery(delivery, { limit: 50 });

    assert.equal(listed.length, 1);
  });

  test('an asset whose renditions are missing yields nulls, not a failure', async () => {
    const { service } = build();
    const result = await service.gallery(delivery, { limit: 50 });

    assert.equal(result.assets[1].thumbUrl, null);
    assert.equal(result.assets[1].gridUrl, null);
  });

  test('signs with the client URL TTL', async () => {
    const { service, presigned } = build();
    await service.gallery(delivery, { limit: 50 });

    assert.ok(presigned.every((p) => p.expiresIn === TTL));
  });

  test('exposes dimensions and blurhash so the grid can lay out before loading', async () => {
    const { service } = build();
    const [first] = (await service.gallery(delivery, { limit: 50 })).assets;

    assert.equal(first.width, 6000);
    assert.equal(first.height, 4000);
    assert.equal(first.blurhash, 'L6PZ');
  });

  test('carries the cursor through', async () => {
    const { service, listed } = build();
    const result = await service.gallery(delivery, { limit: 10, cursor: 'abc' });

    assert.deepEqual(listed[0], { galleryId: GALLERY, limit: 10, cursor: 'abc' });
    assert.equal(result.nextCursor, 'next');
  });

  test('a deleted gallery is 410, not 404 — the caller already proved access', async () => {
    const { service } = build({ gallery: null });

    assert.equal(await statusOf(service.gallery(delivery, { limit: 50 })), 410);
  });

  test('a grant without the view bit is 403', async () => {
    const { service } = build();
    const noView: GrantPrincipal = { ...delivery, rightsMask: RIGHT.download };

    assert.equal(await codeOf(service.gallery(noView, { limit: 50 })), 'missing_right');
  });
});

describe('ClientGalleryService — renditions', () => {
  test('the lookup is scoped to the grant’s gallery', async () => {
    const { service, asked } = build();
    await service.renditionUrl(delivery, ASSET, 'preview');

    assert.equal(asked[0].galleryId, GALLERY);
  });

  test('returns JSON, because an <img> cannot send a bearer header', async () => {
    const { service } = build();
    const result = await service.renditionUrl(delivery, ASSET, 'preview');

    assert.match(result.url, /^https:\/\/bucket\.example\//);
    assert.ok(result.expiresAt > new Date());
  });

  test('an asset in another gallery is 404', async () => {
    // The repository filter already hid it; this is what the client sees.
    const { service } = build({ rendition: null });

    assert.equal(await codeOf(service.renditionUrl(delivery, ASSET, 'preview')), 'asset_not_found');
  });

  test('a photo the worker has not finished is 409', async () => {
    const { service } = build({ rendition: rendition({ assetStatus: 'processing' }) });

    assert.equal(await statusOf(service.renditionUrl(delivery, ASSET, 'preview')), 409);
  });

  test('a missing size is 404 rendition_not_found, not asset_not_found', async () => {
    const { service } = build({ rendition: rendition({ storageKey: null }) });

    assert.equal(
      await codeOf(service.renditionUrl(delivery, ASSET, 'preview')),
      'rendition_not_found',
    );
  });

  test('authorize still fires even though the query is already scoped', async () => {
    // Defence in depth: if the filter were ever dropped, this is the wall.
    const { service } = build({ rendition: rendition({ galleryId: OTHER_GALLERY }) });

    assert.equal(await statusOf(service.renditionUrl(delivery, ASSET, 'preview')), 403);
  });
});

describe('ClientGalleryService — download', () => {
  test('signs the original with the filename the photographer uploaded', async () => {
    const { service, presigned } = build();
    await service.downloadUrl(delivery, ASSET);

    assert.match(presigned[0].key, /\/originals\//);
    assert.equal(presigned[0].downloadFilename, 'DSC_0001.jpg');
  });

  test('a view-only grant cannot download', async () => {
    const { service, presigned } = build();

    assert.equal(await codeOf(service.downloadUrl(viewOnly, ASSET)), 'missing_right');
    assert.deepEqual(presigned, []);
  });

  test('rights are checked before the URL is minted, never after', async () => {
    // ADR: the presigned URL is the security boundary. Nothing is signed for a
    // caller who was not allowed to have it.
    const { service, presigned } = build({ original: original({ assetStatus: 'processing' }) });

    assert.equal(await statusOf(service.downloadUrl(delivery, ASSET)), 409);
    assert.deepEqual(presigned, []);
  });

  test('an asset in another gallery is 404', async () => {
    const { service } = build({ original: null });

    assert.equal(await codeOf(service.downloadUrl(delivery, ASSET)), 'asset_not_found');
  });
});
