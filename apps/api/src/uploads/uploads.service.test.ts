import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StudioUserPrincipal } from '../auth/principal';
import type { ApiException } from '../common/api-exception';
import type { Gallery, GalleriesRepository } from '../galleries/galleries.repository';
import type { StorageService } from '../storage/storage.service';
import type { NewAsset, UploadsRepository } from './uploads.repository';
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
