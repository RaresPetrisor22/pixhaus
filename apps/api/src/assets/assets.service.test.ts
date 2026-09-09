import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { RenditionKind } from '@pixhaus/storage';

import type { StudioUserPrincipal } from '../auth/principal';
import type { ApiException } from '../common/api-exception';
import type { StorageService } from '../storage/storage.service';
import type { AssetRendition, AssetsRepository } from './assets.repository';
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

function build(row: AssetRendition | null = found()) {
  const asked: { studioId: string; assetId: string; kind: RenditionKind }[] = [];
  const presigned: { key: string; expiresIn: number }[] = [];

  const repository = {
    findRendition: (studioId: string, assetId: string, kind: RenditionKind) => {
      asked.push({ studioId, assetId, kind });
      return Promise.resolve(row);
    },
  } as unknown as AssetsRepository;

  const storage = {
    presignGet: (key: string, options: { expiresIn: number }) => {
      presigned.push({ key, expiresIn: options.expiresIn });
      return Promise.resolve(`http://localhost:9000/pixhaus/${key}?X-Amz-Signature=deadbeef`);
    },
  } as unknown as StorageService;

  return { service: new AssetsService(repository, storage), asked, presigned };
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
