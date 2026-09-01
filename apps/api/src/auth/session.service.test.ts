import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import type { AuthRepository, NewSession, SessionRecord } from './auth.repository';
import { SessionService } from './session.service';
import { hashToken } from './tokens';

const TTL_HOURS = 336;
const minutesFromNow = (n: number) => new Date(Date.now() + n * 60_000);

function build(session?: SessionRecord | null) {
  const created: NewSession[] = [];
  const touched: { studioId: string; sessionId: string }[] = [];
  const deleted: string[] = [];
  const deletedForUser: string[] = [];

  const repository = {
    createSession: (input: NewSession) => {
      created.push(input);
      return Promise.resolve();
    },
    findSession: () => Promise.resolve(session ?? null),
    touchSession: (studioId: string, sessionId: string) => {
      touched.push({ studioId, sessionId });
      return Promise.resolve();
    },
    deleteSession: (_studioId: string, sessionId: string) => {
      deleted.push(sessionId);
      return Promise.resolve();
    },
    deleteSessionsForUser: (_studioId: string, userId: string) => {
      deletedForUser.push(userId);
      return Promise.resolve(3);
    },
  } as unknown as AuthRepository;

  const config = {
    get: (key: string) => (key === 'SESSION_TTL_HOURS' ? TTL_HOURS : 'development'),
  } as unknown as ConfigService<Env, true>;

  return {
    sessions: new SessionService(repository, config),
    created,
    touched,
    deleted,
    deletedForUser,
  };
}

const live: SessionRecord = {
  userId: 'user-1',
  studioId: 'studio-1',
  expiresAt: minutesFromNow(60),
  lastSeenAt: new Date(),
};

describe('SessionService.issue', () => {
  test('stores the hash and returns the raw token', async () => {
    const { sessions, created } = build();

    const token = await sessions.issue('user-1', 'studio-1');

    assert.equal(created.length, 1);
    assert.equal(created[0].id, hashToken(token));
    assert.notEqual(created[0].id, token);
    assert.equal(created[0].id.length, 64);
  });

  test('records where the session came from', async () => {
    const { sessions, created } = build();

    await sessions.issue('user-1', 'studio-1', { ip: '127.0.0.1', userAgent: 'curl/8' });

    assert.equal(created[0].ip, '127.0.0.1');
    assert.equal(created[0].userAgent, 'curl/8');
  });

  test('truncates an absurd user agent rather than storing it whole', async () => {
    const { sessions, created } = build();

    await sessions.issue('user-1', 'studio-1', { userAgent: 'x'.repeat(5000) });

    assert.equal(created[0].userAgent?.length, 512);
  });

  test('stores null rather than undefined when there is no context', async () => {
    const { sessions, created } = build();

    await sessions.issue('user-1', 'studio-1');

    assert.equal(created[0].ip, null);
    assert.equal(created[0].userAgent, null);
  });
});

describe('SessionService.resolve', () => {
  test('looks up by hash and returns a principal', async () => {
    const { sessions } = build(live);

    const principal = await sessions.resolve('the-raw-token');

    assert.deepEqual(principal, {
      kind: 'user',
      userId: 'user-1',
      studioId: 'studio-1',
      sessionId: hashToken('the-raw-token'),
    });
  });

  test('returns null for a token that resolves to nothing', async () => {
    const { sessions } = build(null);

    assert.equal(await sessions.resolve('nonsense'), null);
  });

  test('returns null for an expired session, without deleting it', async () => {
    const { sessions, deleted } = build({ ...live, expiresAt: minutesFromNow(-1) });

    assert.equal(await sessions.resolve('the-raw-token'), null);
    assert.deepEqual(deleted, []);
  });

  test('does not write on a recently seen session', async () => {
    const { sessions, touched } = build({ ...live, lastSeenAt: new Date() });

    await sessions.resolve('the-raw-token');

    assert.deepEqual(touched, []);
  });

  test('slides the expiry once the session has gone quiet for an hour', async () => {
    const { sessions, touched } = build({
      ...live,
      lastSeenAt: new Date(Date.now() - 61 * 60_000),
    });

    await sessions.resolve('the-raw-token');

    assert.deepEqual(touched, [{ studioId: 'studio-1', sessionId: hashToken('the-raw-token') }]);
  });
});

describe('SessionService revocation', () => {
  test('revoke deletes this session only', async () => {
    const { sessions, deleted, deletedForUser } = build();

    await sessions.revoke({
      kind: 'user',
      userId: 'user-1',
      studioId: 'studio-1',
      sessionId: 'session-id',
    });

    assert.deepEqual(deleted, ['session-id']);
    assert.deepEqual(deletedForUser, []);
  });

  test('revokeAll deletes every session the user has', async () => {
    const { sessions, deletedForUser } = build();

    const count = await sessions.revokeAll({
      kind: 'user',
      userId: 'user-1',
      studioId: 'studio-1',
      sessionId: 'session-id',
    });

    assert.equal(count, 3);
    assert.deepEqual(deletedForUser, ['user-1']);
  });
});
