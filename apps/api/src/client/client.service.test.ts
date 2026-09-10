import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ConfigService } from '@nestjs/config';

import type { GrantPrincipal } from '../auth/principal';
import { hashToken } from '../auth/tokens';
import type { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import { ClientService } from './client.service';
import type { ClientRepository, GrantRecord } from './client.repository';
import { verifyClientToken } from './client-token';

const SECRET = 's'.repeat(32);
const TTL = 3600;

const STUDIO = '11111111-1111-1111-1111-111111111111';
const GALLERY = '22222222-2222-2222-2222-222222222222';
const GRANT = '33333333-3333-3333-3333-333333333333';

const RAW = 'a-magic-link-token';
const YEAR_AWAY = new Date(Date.now() + 365 * 24 * 3600 * 1000);

function record(overrides: Partial<GrantRecord> = {}): GrantRecord {
  return {
    id: GRANT,
    studioId: STUDIO,
    galleryId: GALLERY,
    rightsMask: 3,
    epoch: 0,
    expiresAt: YEAR_AWAY,
    revokedAt: null,
    ...overrides,
  };
}

const principal: GrantPrincipal = {
  kind: 'grant',
  grantId: GRANT,
  studioId: STUDIO,
  galleryId: GALLERY,
  rightsMask: 3,
  epoch: 0,
};

function build(row: GrantRecord | null = record()) {
  const askedHashes: string[] = [];
  const touched: string[] = [];

  const grants = {
    findByTokenHash: (hash: string) => {
      askedHashes.push(hash);
      return Promise.resolve(row);
    },
    findById: () => Promise.resolve(row),
    touchLastSeen: (_studioId: string, grantId: string) => {
      touched.push(grantId);
      return Promise.resolve();
    },
  } as unknown as ClientRepository;

  const config = {
    get: (key: string) => (key === 'CLIENT_TOKEN_SECRET' ? SECRET : TTL),
  } as unknown as ConfigService<Env, true>;

  return { service: new ClientService(grants, config), askedHashes, touched };
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

describe('ClientService — exchange', () => {
  test('the raw token is hashed before it reaches the database', async () => {
    const { service, askedHashes } = build();
    await service.exchange(RAW);

    assert.deepEqual(askedHashes, [hashToken(RAW)]);
  });

  test('mints a token carrying the grant, verifiable with the same secret', async () => {
    const { service } = build();
    const session = await service.exchange(RAW);
    const payload = verifyClientToken(session.token, SECRET);

    assert.ok(payload);
    assert.equal(payload.g, GRANT);
    assert.equal(payload.s, STUDIO);
    assert.equal(payload.y, GALLERY);
    assert.equal(payload.r, 3);
    assert.equal(payload.e, 0);
  });

  test('expiresAt matches the token it describes', async () => {
    const { service } = build();
    const session = await service.exchange(RAW);

    assert.equal(session.expiresAt.getTime(), verifyClientToken(session.token, SECRET)!.exp * 1000);
  });

  test('rights come back as names for the client to render against', async () => {
    const { service } = build(record({ rightsMask: 5 }));

    assert.deepEqual((await service.exchange(RAW)).rights, ['view', 'favorite']);
  });

  test('stamps last_seen_at so the photographer can see the link was opened', async () => {
    const { service, touched } = build();
    await service.exchange(RAW);

    assert.deepEqual(touched, [GRANT]);
  });

  test('an unknown token is 404, not 410 — a 410 would confirm it once existed', async () => {
    const { service } = build(null);

    assert.equal(await statusOf(service.exchange(RAW)), 404);
    assert.equal(await codeOf(service.exchange(RAW)), 'grant_not_found');
  });

  test('a revoked grant is 410, and nothing is stamped', async () => {
    const { service, touched } = build(record({ revokedAt: new Date() }));

    assert.equal(await statusOf(service.exchange(RAW)), 410);
    assert.equal(await codeOf(service.exchange(RAW)), 'grant_revoked');
    assert.deepEqual(touched, []);
  });

  test('an expired grant is 410', async () => {
    const { service } = build(record({ expiresAt: new Date(Date.now() - 1000) }));

    assert.equal(await codeOf(service.exchange(RAW)), 'grant_expired');
  });

  test('revocation is answered before expiry', async () => {
    const { service } = build(
      record({ revokedAt: new Date(), expiresAt: new Date(Date.now() - 1000) }),
    );

    assert.equal(await codeOf(service.exchange(RAW)), 'grant_revoked');
  });
});

describe('ClientService — refresh', () => {
  test('mints a fresh token', async () => {
    const { service } = build();
    const session = await service.refresh(principal);

    assert.ok(verifyClientToken(session.token, SECRET));
  });

  test('rights come from the row, not from the token presented', async () => {
    // The reason revocation bites here: a client holding a token that claims
    // download gets a new one carrying whatever the database now says.
    const { service } = build(record({ rightsMask: 1 }));
    const session = await service.refresh({ ...principal, rightsMask: 7 });

    assert.equal(verifyClientToken(session.token, SECRET)!.r, 1);
    assert.deepEqual(session.rights, ['view']);
  });

  test('a revoked grant is 410', async () => {
    const { service } = build(record({ revokedAt: new Date() }));

    assert.equal(await codeOf(service.refresh(principal)), 'grant_revoked');
  });

  test('an expired grant is 410', async () => {
    const { service } = build(record({ expiresAt: new Date(Date.now() - 1000) }));

    assert.equal(await codeOf(service.refresh(principal)), 'grant_expired');
  });

  test('a bumped epoch kills the token even with revoked_at unset', async () => {
    const { service } = build(record({ epoch: 1 }));

    assert.equal(await statusOf(service.refresh(principal)), 410);
    assert.equal(await codeOf(service.refresh(principal)), 'grant_revoked');
  });

  test('a deleted grant is 410, not 404 — the caller already proved access', async () => {
    const { service } = build(null);

    assert.equal(await statusOf(service.refresh(principal)), 410);
    assert.equal(await codeOf(service.refresh(principal)), 'grant_not_found');
  });

  test('the refresh read is tenant-scoped, so it never touches the bootstrap', async () => {
    const { service, askedHashes } = build();
    await service.refresh(principal);

    assert.deepEqual(askedHashes, []);
  });
});
