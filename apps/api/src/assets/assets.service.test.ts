import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RenditionKind } from '@pixhaus/storage';

import type { StudioUserPrincipal } from '../auth/principal';
import type { ApiException } from '../common/api-exception';
import type { Gallery, GalleriesRepository } from '../galleries/galleries.repository';
import type { StorageService } from '../storage/storage.service';
import type { AssetObjects, AssetRendition, AssetsRepository } from './assets.repository';
import { AssetsService, RENDITION_URL_TTL_SECONDS } from './assets.service';

const STUDIO = '11111111-1111-1111-1111-111111111111';
const ASSET = 'aaaaaaaa-0000-4000-8000-000000000001';
const KEY = `studios/${STUDIO}/galleries/g/renditions/${ASSET}/grid.webp`;

const principal: StudioUserPrincipal = {
  kind: 'user',
  userId: 'user-1',
  studioId: STUDIO,
  sessionId: 'a'.repeat(64),
  emailVerified: true,
};

function found(overrides: Partial<AssetRendition> = {}): AssetRendition {
  return {
    assetStatus: 'ready',
    galleryStatus: 'active',
    originalFilename: 'DSC_0001.jpg',
    storageKey: KEY,
    ...overrides,
  };
}

const GALLERY = 'bbbbbbbb-0000-4000-8000-000000000001';

function objects(overrides: Partial<AssetObjects> = {}): AssetObjects {
  return {
    galleryStatus: 'active',
    storageKey: `studios/${STUDIO}/galleries/g/originals/${ASSET}`,
    renditionKeys: [KEY],
    ...overrides,
  };
}

function build(
  row: AssetRendition | null = found(),
  extra: { objects?: AssetObjects | null; gallery?: Gallery | null; deleted?: boolean } = {},
) {
  const asked: { studioId: string; assetId: string; kind: RenditionKind }[] = [];
  const presigned: { key: string; expiresIn: number }[] = [];
  const listed: { studioId: string; galleryId: string; limit: number }[] = [];
  const removed: string[][] = [];
  const deletedIds: string[] = [];

  const repository = {
    findRendition: (studioId: string, assetId: string, kind: RenditionKind) => {
      asked.push({ studioId, assetId, kind });
      return Promise.resolve(row);
    },
    list: (studioId: string, galleryId: string, limit: number) => {
      listed.push({ studioId, galleryId, limit });
      return Promise.resolve({ assets: [], nextCursor: null });
    },
    findObjects: () => Promise.resolve(extra.objects === undefined ? objects() : extra.objects),
    delete: (_s: string, assetId: string) => {
      deletedIds.push(assetId);
      return Promise.resolve(extra.deleted ?? true);
    },
  } as unknown as AssetsRepository;

  const galleries = {
    findById: () =>
      Promise.resolve(
        extra.gallery === undefined
          ? ({ id: GALLERY, title: 'g', status: 'active' } as Gallery)
          : extra.gallery,
      ),
  } as unknown as GalleriesRepository;

  const storage = {
    presignGet: (key: string, options: { expiresIn: number }) => {
      presigned.push({ key, expiresIn: options.expiresIn });
      return Promise.resolve(`http://localhost:9000/pixhaus/${key}?X-Amz-Signature=deadbeef`);
    },
    remove: (keys: string[]) => {
      removed.push(keys);
      return Promise.resolve();
    },
  } as unknown as StorageService;

  return {
    service: new AssetsService(repository, galleries, storage),
    asked,
    presigned,
    listed,
    removed,
    deletedIds,
  };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as ApiException).code;
  }

  throw new Error('expected a rejection');
}

describe('AssetsService — the rendition redirect', () => {
  test('a ready asset presigns its rendition key for five minutes', async () => {
    const { service, presigned } = build();

    const url = await service.renditionUrl(principal, ASSET, 'grid');

    assert.deepEqual(presigned, [{ key: KEY, expiresIn: RENDITION_URL_TTL_SECONDS }]);
    assert.match(url, /X-Amz-Signature/);
  });

  test('the lookup is scoped to the principal, never to anything the caller sent', async () => {
    const { service, asked } = build();

    await service.renditionUrl(principal, ASSET, 'thumb');

    assert.deepEqual(asked, [{ studioId: STUDIO, assetId: ASSET, kind: 'thumb' }]);
  });
});

describe('AssetsService — what is refused', () => {
  test('an asset RLS hid is 404, and says nothing about whether it exists', async () => {
    const { service, presigned } = build(null);

    assert.equal(
      await codeOf(() => service.renditionUrl(principal, ASSET, 'grid')),
      'asset_not_found',
    );
    assert.deepEqual(presigned, [], 'presigned a URL for an asset it could not see');
  });

  test('an asset still in the pipeline is 409, not 404 — it is coming', async () => {
    for (const status of ['pending', 'uploaded', 'processing', 'failed', 'orphaned'] as const) {
      const { service } = build(found({ assetStatus: status, storageKey: null }));

      assert.equal(
        await codeOf(() => service.renditionUrl(principal, ASSET, 'grid')),
        'asset_not_ready',
        status,
      );
    }
  });

  test('a worker that gave up says so, rather than "still processing" forever', async () => {
    const { service } = build(found({ assetStatus: 'failed', storageKey: null }));

    try {
      await service.renditionUrl(principal, ASSET, 'grid');
      throw new Error('expected a rejection');
    } catch (error) {
      assert.match((error as ApiException).message, /could not be processed/);
    }
  });

  test('a ready asset whose rendition row is missing is 404 on the rendition', async () => {
    const { service } = build(found({ storageKey: null }));

    assert.equal(
      await codeOf(() => service.renditionUrl(principal, ASSET, 'preview')),
      'rendition_not_found',
    );
  });

  test('an archived gallery still serves previews — archived is read-only, not hidden', async () => {
    const { service } = build(found({ galleryStatus: 'archived' }));

    assert.match(await service.renditionUrl(principal, ASSET, 'grid'), /X-Amz-Signature/);
  });

  test('an unverified account can still look at what it already uploaded', async () => {
    const { service } = build();

    const url = await service.renditionUrl({ ...principal, emailVerified: false }, ASSET, 'grid');

    assert.match(url, /X-Amz-Signature/);
  });
});

describe('AssetsService — listing', () => {
  test('scopes to the principal and the gallery in the path', async () => {
    const { service, listed } = build();

    await service.list(principal, GALLERY, { limit: 25 });

    assert.deepEqual(listed, [{ studioId: STUDIO, galleryId: GALLERY, limit: 25 }]);
  });

  test('a gallery RLS hid is 404, and nothing is listed', async () => {
    const { service, listed } = build(found(), { gallery: null });

    assert.equal(
      await codeOf(() => service.list(principal, GALLERY, { limit: 25 })),
      'gallery_not_found',
    );
    assert.deepEqual(listed, []);
  });

  test('an unverified account can still read its own gallery', async () => {
    const { service, listed } = build();

    await service.list({ ...principal, emailVerified: false }, GALLERY, { limit: 25 });

    assert.equal(listed.length, 1);
  });
});

describe('AssetsService — delete', () => {
  test('deletes the row, then the original and every rendition', async () => {
    const { service, deletedIds, removed } = build();

    await service.remove(principal, ASSET);

    assert.deepEqual(deletedIds, [ASSET]);
    assert.deepEqual(removed, [[`studios/${STUDIO}/galleries/g/originals/${ASSET}`, KEY]]);
  });

  test('an asset RLS hid is 404, and no object is touched', async () => {
    const { service, removed, deletedIds } = build(found(), { objects: null });

    assert.equal(await codeOf(() => service.remove(principal, ASSET)), 'asset_not_found');
    assert.deepEqual(deletedIds, []);
    assert.deepEqual(removed, []);
  });

  test('an unverified account cannot delete', async () => {
    const { service, removed } = build();

    assert.equal(
      await codeOf(() => service.remove({ ...principal, emailVerified: false }, ASSET)),
      'email_unverified',
    );
    assert.deepEqual(removed, []);
  });

  test('a row that vanished between read and delete is 404, and keeps its bytes', async () => {
    const { service, removed } = build(found(), { deleted: false });

    assert.equal(await codeOf(() => service.remove(principal, ASSET)), 'asset_not_found');
    assert.deepEqual(removed, []);
  });

  test('an archived gallery still allows deleting — archived blocks new photos only', async () => {
    const { service, deletedIds } = build(found(), {
      objects: objects({ galleryStatus: 'archived' }),
    });

    await service.remove(principal, ASSET);

    assert.deepEqual(deletedIds, [ASSET]);
  });
});
