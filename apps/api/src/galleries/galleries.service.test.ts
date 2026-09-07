import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StudioUserPrincipal } from '../auth/principal';
import type { ApiException } from '../common/api-exception';
import type { Gallery, GalleriesRepository } from './galleries.repository';
import { GalleriesService } from './galleries.service';

const STUDIO = '11111111-1111-1111-1111-111111111111';
const GALLERY_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

const verified: StudioUserPrincipal = {
  kind: 'user',
  userId: 'user-1',
  studioId: STUDIO,
  sessionId: 'a'.repeat(64),
  emailVerified: true,
};

const unverified: StudioUserPrincipal = { ...verified, emailVerified: false };

function gallery(overrides: Partial<Gallery> = {}): Gallery {
  return {
    id: GALLERY_ID,
    title: 'Ana & Mihai',
    status: 'draft',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function build(stored: Gallery | null = gallery()) {
  const calls: string[] = [];

  const repository = {
    create: (studioId: string, title: string) => {
      calls.push(`create:${studioId}:${title}`);
      return Promise.resolve(gallery({ title }));
    },
    list: () => Promise.resolve({ galleries: [], nextCursor: null }),
    findById: () => Promise.resolve(stored),
    update: (_s: string, _g: string, changes: Partial<Gallery>) => {
      calls.push(`update:${JSON.stringify(changes)}`);
      return Promise.resolve(stored ? gallery({ ...stored, ...changes }) : null);
    },
    delete: () => {
      calls.push('delete');
      return Promise.resolve(stored !== null);
    },
  } as unknown as GalleriesRepository;

  return { service: new GalleriesService(repository), calls };
}

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    return (error as ApiException).code;
  }

  throw new Error('expected a rejection');
}

describe('GalleriesService — tenant scoping', () => {
  test('studio_id comes from the principal, never from the caller', async () => {
    const { service, calls } = build();

    await service.create(verified, { title: 'Ana & Mihai' });

    assert.deepEqual(calls, [`create:${STUDIO}:Ana & Mihai`]);
  });

  test('a gallery RLS hid is 404, not 403 — existence is not confirmed', async () => {
    const { service } = build(null);

    for (const run of [
      () => service.findOne(verified, GALLERY_ID),
      () => service.update(verified, GALLERY_ID, { title: 'x' }),
      () => service.remove(verified, GALLERY_ID),
    ]) {
      assert.equal(await codeOf(run), 'gallery_not_found');
    }
  });
});

describe('GalleriesService — verification gate', () => {
  test('an unverified account cannot create or change', async () => {
    const { service } = build();

    assert.equal(
      await codeOf(() => service.create(unverified, { title: 'x' })),
      'email_unverified',
    );
    assert.equal(
      await codeOf(() => service.update(unverified, GALLERY_ID, { title: 'x' })),
      'email_unverified',
    );
    assert.equal(await codeOf(() => service.remove(unverified, GALLERY_ID)), 'email_unverified');
  });

  test('but can still read — M1 issues sessions to unverified accounts on purpose', async () => {
    const { service } = build();

    assert.equal((await service.findOne(unverified, GALLERY_ID)).id, GALLERY_ID);
  });
});

describe('GalleriesService — archived', () => {
  test('un-archiving works: manage is not blocked by the state it undoes', async () => {
    const { service } = build(gallery({ status: 'archived' }));

    const updated = await service.update(verified, GALLERY_ID, { status: 'active' });

    assert.equal(updated.status, 'active');
  });

  test('an archived gallery can still be deleted', async () => {
    const { service } = build(gallery({ status: 'archived' }));

    await service.remove(verified, GALLERY_ID);
  });
});

describe('GalleriesService — update', () => {
  test('passes only what the caller sent, so omitted fields keep their value', async () => {
    const { service, calls } = build();

    await service.update(verified, GALLERY_ID, { status: 'active' });

    assert.deepEqual(calls, ['update:{"status":"active"}']);
  });
});
