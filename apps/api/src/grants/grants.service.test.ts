import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { StudioUserPrincipal } from '../auth/principal';
import { hashToken } from '../auth/tokens';
import type { ApiException } from '../common/api-exception';
import type { Gallery, GalleriesRepository } from '../galleries/galleries.repository';
import type { MailService } from '../mail/mail.service';
import { GrantsService } from './grants.service';
import type { Grant, GrantWithGallery, GrantsRepository, NewGrant } from './grants.repository';

const STUDIO = '11111111-1111-1111-1111-111111111111';
const GALLERY = '22222222-2222-2222-2222-222222222222';
const GRANT = '33333333-3333-3333-3333-333333333333';

const YEAR_AWAY = new Date(Date.now() + 365 * 24 * 3600 * 1000);

const principal: StudioUserPrincipal = {
  kind: 'user',
  userId: 'user-1',
  studioId: STUDIO,
  sessionId: 'a'.repeat(64),
  emailVerified: true,
};

const unverified: StudioUserPrincipal = { ...principal, emailVerified: false };

function grantRow(overrides: Partial<GrantWithGallery> = {}): GrantWithGallery {
  return {
    id: GRANT,
    galleryId: GALLERY,
    audienceEmail: 'ana@example.com',
    label: null,
    rights: ['view', 'download'],
    expiresAt: YEAR_AWAY,
    lastSeenAt: null,
    revokedAt: null,
    createdAt: new Date(),
    galleryStatus: 'active',
    ...overrides,
  };
}

function build(
  options: {
    gallery?: Gallery | null;
    grant?: GrantWithGallery | null;
    mailThrows?: boolean;
  } = {},
) {
  const created: NewGrant[] = [];
  const revoked: string[] = [];
  const rotated: { grantId: string; tokenHash: string }[] = [];
  const sent: { to: string; token: string; title: string }[] = [];

  const gallery: Gallery | null =
    options.gallery === undefined
      ? {
          id: GALLERY,
          title: 'Ana & Mihai',
          status: 'draft',
          createdAt: new Date(),
          updatedAt: new Date(),
        }
      : options.gallery;

  const grants = {
    create: (_studioId: string, grant: NewGrant) => {
      created.push(grant);
      return Promise.resolve({
        ...grantRow({ rights: ['view'] }),
        audienceEmail: grant.audienceEmail,
        expiresAt: grant.expiresAt,
        label: grant.label,
      } as Grant);
    },
    listForGallery: () => {
      const { galleryStatus: _ignored, ...grant } = grantRow();
      return Promise.resolve([grant satisfies Grant]);
    },
    findById: () => Promise.resolve(options.grant === undefined ? grantRow() : options.grant),
    revoke: (_studioId: string, grantId: string) => {
      revoked.push(grantId);
      return Promise.resolve();
    },
    rotateToken: (_studioId: string, grantId: string, tokenHash: string) => {
      rotated.push({ grantId, tokenHash });
      return Promise.resolve();
    },
  } as unknown as GrantsRepository;

  const galleries = {
    findById: () => Promise.resolve(gallery),
  } as unknown as GalleriesRepository;

  const mail = {
    sendGrantEmail: (to: string, token: string, title: string) => {
      sent.push({ to, token, title });
      return options.mailThrows ? Promise.reject(new Error('smtp down')) : Promise.resolve();
    },
  } as unknown as MailService;

  return {
    service: new GrantsService(grants, galleries, mail),
    created,
    revoked,
    rotated,
    sent,
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

const body = {
  audienceEmail: 'ana@example.com',
  rights: ['view' as const, 'download' as const],
  expiresAt: YEAR_AWAY,
};

describe('GrantsService — create', () => {
  test('the raw token is returned once and only its hash is stored', async () => {
    const { service, created } = build();
    const { token } = await service.create(principal, GALLERY, body);

    assert.equal(created[0].tokenHash, hashToken(token));
    assert.notEqual(created[0].tokenHash, token);
  });

  test('rights names become the bitmask the column stores', async () => {
    const { service, created } = build();
    await service.create(principal, GALLERY, { ...body, rights: ['view', 'favorite'] });

    assert.equal(created[0].rightsMask, 5);
  });

  test('the link is emailed to the audience, not to the photographer', async () => {
    const { service, sent } = build();
    const { token } = await service.create(principal, GALLERY, body);

    assert.deepEqual(sent, [{ to: 'ana@example.com', token, title: 'Ana & Mihai' }]);
  });

  test('a failed send does not fail the request — resend is the recovery path', async () => {
    const { service } = build({ mailThrows: true });

    assert.ok(await service.create(principal, GALLERY, body));
  });

  test('a gallery RLS hid is 404', async () => {
    const { service } = build({ gallery: null });

    assert.equal(await codeOf(service.create(principal, GALLERY, body)), 'gallery_not_found');
  });

  test('an unverified account cannot share', async () => {
    const { service, created } = build();

    assert.equal(await codeOf(service.create(unverified, GALLERY, body)), 'email_unverified');
    assert.deepEqual(created, []);
  });

  test('an archived gallery can still be shared', async () => {
    const { service } = build({
      gallery: {
        id: GALLERY,
        title: 'Old wedding',
        status: 'archived',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    assert.ok(await service.create(principal, GALLERY, body));
  });
});

describe('GrantsService — list', () => {
  test('a read does not require a verified email', async () => {
    const { service } = build();

    assert.equal((await service.list(unverified, GALLERY)).length, 1);
  });

  test('no token material is in the listing', async () => {
    const { service } = build();
    const [grant] = await service.list(principal, GALLERY);

    assert.deepEqual(Object.keys(grant).sort(), [
      'audienceEmail',
      'createdAt',
      'expiresAt',
      'galleryId',
      'id',
      'label',
      'lastSeenAt',
      'revokedAt',
      'rights',
    ]);
  });
});

describe('GrantsService — revoke', () => {
  test('revokes, and is idempotent', async () => {
    const { service, revoked } = build();

    await service.revoke(principal, GRANT);
    await service.revoke(principal, GRANT);

    assert.deepEqual(revoked, [GRANT, GRANT]);
  });

  test('a grant RLS hid is 404, not 403', async () => {
    const { service } = build({ grant: null });

    assert.equal(await codeOf(service.revoke(principal, GRANT)), 'grant_not_found');
  });

  test('an unverified account cannot revoke', async () => {
    const { service, revoked } = build();

    assert.equal(await codeOf(service.revoke(unverified, GRANT)), 'email_unverified');
    assert.deepEqual(revoked, []);
  });
});

describe('GrantsService — resend', () => {
  test('rotates the token, so the previous link stops working', async () => {
    const { service, rotated } = build();
    const { token } = await service.resend(principal, GRANT);

    assert.equal(rotated[0].tokenHash, hashToken(token));
  });

  test('a revoked grant is 410, and nothing is rotated or sent', async () => {
    const { service, rotated, sent } = build({ grant: grantRow({ revokedAt: new Date() }) });

    assert.equal(await codeOf(service.resend(principal, GRANT)), 'grant_revoked');
    assert.deepEqual(rotated, []);
    assert.deepEqual(sent, []);
  });

  test('an expired grant is 410', async () => {
    const { service } = build({ grant: grantRow({ expiresAt: new Date(Date.now() - 1000) }) });

    assert.equal(await codeOf(service.resend(principal, GRANT)), 'grant_expired');
  });

  test('a grant RLS hid is 404', async () => {
    const { service } = build({ grant: null });

    assert.equal(await codeOf(service.resend(principal, GRANT)), 'grant_not_found');
  });
});
