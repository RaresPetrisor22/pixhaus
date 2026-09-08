import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StudioUserPrincipal } from '../auth/principal';
import type { ApiException } from '../common/api-exception';
import type { Gallery, GalleriesRepository } from '../galleries/galleries.repository';
import type { StorageService } from '../storage/storage.service';
import type { Asset, NewAsset, UploadsRepository } from './uploads.repository';
import { MAGIC_BYTES_NEEDED } from './magic-bytes';
import { UploadsService } from './uploads.service';

const STUDIO = '11111111-1111-1111-1111-111111111111';
const GALLERY = 'aaaaaaaa-0000-4000-8000-000000000001';
const MAX_BYTES = 1_000_000;

const verified: StudioUserPrincipal = {
  kind: 'user',
  userId: 'user-1',
  studioId: STUDIO,
  sessionId: 'a'.repeat(64),
  emailVerified: true,
};

const unverified: StudioUserPrincipal = { ...verified, emailVerified: false };

const VALID = { filename: 'DSC_0001.jpg', size: 4_211_337 % MAX_BYTES, contentType: 'image/jpeg' };

function build(
  gallery: Gallery | null = {
    id: GALLERY,
    title: 'g',
    status: 'active',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
) {
  const created: NewAsset[] = [];
  const presigned: { key: string; contentLength: number; contentType: string }[] = [];

  const galleries = { findById: () => Promise.resolve(gallery) } as unknown as GalleriesRepository;

  const assets = {
    create: (asset: NewAsset) => {
      created.push(asset);
      return Promise.resolve({ ...asset, status: 'pending', position: 0 });
    },
  } as unknown as UploadsRepository;

  const storage = {
    maxUploadBytes: MAX_BYTES,
    presignPut: (key: string, o: { contentLength: number; contentType: string }) => {
      presigned.push({ key, ...o });
      return Promise.resolve({
        url: `http://localhost:9000/pixhaus/${key}?X-Amz-Signature=deadbeef`,
        expiresAt: new Date(Date.now() + 900_000),
        headers: { 'content-type': o.contentType, 'content-length': String(o.contentLength) },
      });
    },
  } as unknown as StorageService;

  return { service: new UploadsService(galleries, assets, storage), created, presigned };
}

async function failure(run: () => Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await run();
  } catch (error) {
    const e = error as ApiException;
    return { code: e.code, status: e.getStatus() };
  }
  throw new Error('expected a rejection');
}

describe('UploadsService — the happy path', () => {
  test('inserts the asset, then presigns the key it just wrote', async () => {
    const { service, created, presigned } = build();

    const ticket = await service.createUpload(verified, GALLERY, VALID);

    assert.equal(created.length, 1);
    assert.equal(presigned.length, 1);
    assert.equal(created[0].storageKey, presigned[0].key, 'the URL must point at the stored key');
    assert.equal(ticket.assetId, created[0].id);
  });

  test('the key is derived from the session studio, never the request', async () => {
    const { service, created } = build();

    await service.createUpload(verified, GALLERY, VALID);

    assert.ok(created[0].storageKey.startsWith(`studios/${STUDIO}/`));
    assert.ok(created[0].storageKey.includes(created[0].id), 'key carries the asset id');
  });

  test('no client-supplied filename reaches the key', async () => {
    const { service, created } = build();

    await service.createUpload(verified, GALLERY, {
      ...VALID,
      filename: '../../etc/passwd',
    });

    assert.ok(!created[0].storageKey.includes('passwd'));
    assert.ok(!created[0].storageKey.includes('..'));
    assert.equal(created[0].originalFilename, '../../etc/passwd', 'but it is recorded as a fact');
  });

  test('returns the exact headers the uploader has to send', async () => {
    const { service } = build();

    const ticket = await service.createUpload(verified, GALLERY, VALID);

    assert.equal(ticket.method, 'PUT');
    assert.equal(ticket.headers['content-type'], 'image/jpeg');
    assert.equal(ticket.headers['content-length'], String(VALID.size));
  });

  test('the declared size scopes the signature and nothing else', async () => {
    const { service, presigned } = build();

    await service.createUpload(verified, GALLERY, VALID);

    assert.equal(presigned[0].contentLength, VALID.size);
    assert.equal(presigned[0].contentType, 'image/jpeg');
  });
});

describe('UploadsService — rejections', () => {
  test('a gallery RLS hid is 404, and nothing is written', async () => {
    const { service, created, presigned } = build(null);

    assert.deepEqual(await failure(() => service.createUpload(verified, GALLERY, VALID)), {
      code: 'gallery_not_found',
      status: 404,
    });
    assert.deepEqual(created, []);
    assert.deepEqual(presigned, []);
  });

  test('unverified email is 403', async () => {
    const { service } = build();

    assert.deepEqual(await failure(() => service.createUpload(unverified, GALLERY, VALID)), {
      code: 'email_unverified',
      status: 403,
    });
  });

  test('an archived gallery takes no new photos', async () => {
    const { service } = build({
      id: GALLERY,
      title: 'g',
      status: 'archived',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    assert.deepEqual(await failure(() => service.createUpload(verified, GALLERY, VALID)), {
      code: 'gallery_archived',
      status: 403,
    });
  });

  test('over the ceiling is 413', async () => {
    const { service, created } = build();

    assert.deepEqual(
      await failure(() =>
        service.createUpload(verified, GALLERY, { ...VALID, size: MAX_BYTES + 1 }),
      ),
      { code: 'file_too_large', status: 413 },
    );
    assert.deepEqual(created, [], 'no row for an upload that cannot happen');
  });

  test('exactly at the ceiling is allowed', async () => {
    const { service } = build();

    await service.createUpload(verified, GALLERY, { ...VALID, size: MAX_BYTES });
  });

  test('a non-image content type is 422', async () => {
    const { service } = build();

    for (const contentType of ['application/pdf', 'text/plain', 'image/svg+xml', 'image/gif']) {
      assert.deepEqual(
        await failure(() => service.createUpload(verified, GALLERY, { ...VALID, contentType })),
        { code: 'unsupported_content_type', status: 422 },
        contentType,
      );
    }
  });

  test('authorization is checked before the size, so probing reveals no limits', async () => {
    const { service } = build();

    // Unverified AND oversized: the answer must be about the account.
    const result = await failure(() =>
      service.createUpload(unverified, GALLERY, { ...VALID, size: MAX_BYTES + 1 }),
    );

    assert.equal(result.code, 'email_unverified');
  });
});

// ---------------------------------------------------------------------------
// finalize — the trust boundary
// ---------------------------------------------------------------------------

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60)]);
const TEXT = Buffer.from('this is not a photo, it is a text file');
const ASSET = 'bbbbbbbb-0000-4000-8000-000000000002';
const KEY = `studios/${STUDIO}/galleries/${GALLERY}/originals/${ASSET}`;

function pendingAsset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: ASSET,
    galleryId: GALLERY,
    status: 'pending',
    storageKey: KEY,
    originalFilename: 'DSC_0001.jpg',
    contentType: null,
    sizeBytes: null,
    position: 0,
    createdAt: new Date(),
    ...overrides,
  };
}

function buildFinalize(options: {
  asset?: Asset | null;
  head?: { sizeBytes: number; contentType: string | null; etag: string | null } | null;
  bytes?: Buffer | null;
  markUploadedWins?: boolean;
}) {
  const removed: string[][] = [];
  const orphaned: string[] = [];
  const uploaded: { contentType: string; sizeBytes: number }[] = [];
  const ranges: { start: number; end: number }[] = [];

  const assets = {
    findById: () => Promise.resolve(options.asset === undefined ? pendingAsset() : options.asset),
    markUploaded: (
      _s: string,
      _a: string,
      observed: { contentType: string; sizeBytes: number },
    ) => {
      uploaded.push(observed);
      return Promise.resolve(options.markUploadedWins ?? true);
    },
    markOrphaned: (_s: string, assetId: string) => {
      orphaned.push(assetId);
      return Promise.resolve();
    },
  } as unknown as UploadsRepository;

  const storage = {
    maxUploadBytes: MAX_BYTES,
    head: () =>
      Promise.resolve(
        options.head === undefined
          ? { sizeBytes: JPEG.length, contentType: 'image/jpeg', etag: 'x' }
          : options.head,
      ),
    getRange: (_key: string, start: number, end: number) => {
      ranges.push({ start, end });
      return Promise.resolve(options.bytes === undefined ? JPEG : options.bytes);
    },
    remove: (keys: string[]) => {
      removed.push(keys);
      return Promise.resolve();
    },
  } as unknown as StorageService;

  const galleries = { findById: () => Promise.resolve(null) } as unknown as GalleriesRepository;

  return {
    service: new UploadsService(galleries, assets, storage),
    removed,
    orphaned,
    uploaded,
    ranges,
    get rangeReads() {
      return ranges.length;
    },
  };
}

describe('finalize — the happy path', () => {
  test('records what the server observed, not what anyone claimed', async () => {
    const { service, uploaded } = buildFinalize({});

    const result = await service.finalize(verified, ASSET);

    assert.deepEqual(result, {
      assetId: ASSET,
      status: 'uploaded',
      contentType: 'image/jpeg',
      sizeBytes: JPEG.length,
    });
    assert.deepEqual(uploaded, [{ contentType: 'image/jpeg', sizeBytes: JPEG.length }]);
  });

  test('the recorded content type comes from the bytes, not the declaration', async () => {
    // Uploaded a PNG through a URL signed for image/jpeg. The bytes win.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(56),
    ]);
    const { service, uploaded } = buildFinalize({
      bytes: png,
      head: { sizeBytes: png.length, contentType: 'image/jpeg', etag: 'x' },
    });

    await service.finalize(verified, ASSET);

    assert.equal(uploaded[0].contentType, 'image/png');
  });

  test('the size recorded is the HEAD size, not the declared one', async () => {
    const { service, uploaded } = buildFinalize({
      head: { sizeBytes: 999, contentType: 'image/jpeg', etag: 'x' },
    });

    await service.finalize(verified, ASSET);

    assert.equal(uploaded[0].sizeBytes, 999);
  });
});

describe('finalize — rejections', () => {
  test('an asset RLS hid is 404', async () => {
    const { service } = buildFinalize({ asset: null });

    assert.deepEqual(await failure(() => service.finalize(verified, ASSET)), {
      code: 'asset_not_found',
      status: 404,
    });
  });

  test('finalizing twice is 409', async () => {
    const { service } = buildFinalize({ asset: pendingAsset({ status: 'uploaded' }) });

    assert.deepEqual(await failure(() => service.finalize(verified, ASSET)), {
      code: 'already_finalized',
      status: 409,
    });
  });

  test('a concurrent finalize loses at the guarded UPDATE', async () => {
    const { service } = buildFinalize({ markUploadedWins: false });

    assert.deepEqual(await failure(() => service.finalize(verified, ASSET)), {
      code: 'already_finalized',
      status: 409,
    });
  });

  test('nothing uploaded is 422, and the asset stays pending for the reaper', async () => {
    const { service, orphaned, removed } = buildFinalize({ head: null });

    assert.deepEqual(await failure(() => service.finalize(verified, ASSET)), {
      code: 'object_missing',
      status: 422,
    });
    assert.deepEqual(orphaned, [], 'still pending — the URL may yet be used');
    assert.deepEqual(removed, []);
  });

  test('a text file named .jpg is rejected AND its bytes are deleted', async () => {
    const { service, removed, orphaned, uploaded } = buildFinalize({
      bytes: TEXT,
      head: { sizeBytes: TEXT.length, contentType: 'image/jpeg', etag: 'x' },
    });

    assert.deepEqual(await failure(() => service.finalize(verified, ASSET)), {
      code: 'upload_rejected',
      status: 422,
    });
    assert.deepEqual(removed, [[KEY]], 'the lie must not buy free storage');
    assert.deepEqual(orphaned, [ASSET]);
    assert.deepEqual(uploaded, [], 'nothing recorded about a rejected object');
  });

  test('an object over the ceiling is rejected even though the signature allowed it', async () => {
    const { service, removed, orphaned } = buildFinalize({
      head: { sizeBytes: MAX_BYTES + 1, contentType: 'image/jpeg', etag: 'x' },
    });

    assert.deepEqual(await failure(() => service.finalize(verified, ASSET)), {
      code: 'upload_rejected',
      status: 422,
    });
    assert.deepEqual(removed, [[KEY]]);
    assert.deepEqual(orphaned, [ASSET]);
  });

  test('a zero-byte object is rejected', async () => {
    const { service, removed } = buildFinalize({
      head: { sizeBytes: 0, contentType: 'image/jpeg', etag: 'x' },
    });

    assert.deepEqual(await failure(() => service.finalize(verified, ASSET)), {
      code: 'upload_rejected',
      status: 422,
    });
    assert.deepEqual(removed, [[KEY]]);
  });

  test('the size check runs before the byte read — no ranged GET on a huge object', async () => {
    const { service, rangeReads } = buildFinalize({
      head: { sizeBytes: MAX_BYTES + 1, contentType: 'image/jpeg', etag: 'x' },
    });

    await failure(() => service.finalize(verified, ASSET));

    assert.equal(rangeReads, 0, 'an oversized object is rejected on HEAD alone');
  });

  test('only the first bytes are read, never the whole object', async () => {
    const { service, ranges } = buildFinalize({});

    await service.finalize(verified, ASSET);

    // The API must not pull a 40 MB original through itself to identify it.
    assert.deepEqual(ranges, [{ start: 0, end: MAGIC_BYTES_NEEDED - 1 }]);
  });
});
