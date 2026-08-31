import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ConfigService } from '@nestjs/config';

import { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import type { AuthRepository, VerificationCandidate } from './auth.repository';
import { AuthService } from './auth.service';
import { generateToken, hashToken } from './tokens';

const TTL_HOURS = 24;
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

/**
 * The service never touches a database in these tests. That is the point of
 * putting the SQL behind AuthRepository: the policy is testable on its own.
 */
function build(candidate: VerificationCandidate | null) {
  const lookedUpWith: string[] = [];
  const marked: { studioId: string; userId: string }[] = [];

  const repository = {
    findUserByVerificationToken: (hash: string) => {
      lookedUpWith.push(hash);
      return Promise.resolve(candidate);
    },
    markEmailVerified: (studioId: string, userId: string) => {
      marked.push({ studioId, userId });
      return Promise.resolve();
    },
  } as unknown as AuthRepository;

  const config = { get: () => TTL_HOURS } as unknown as ConfigService<Env, true>;

  return { service: new AuthService(repository, config), lookedUpWith, marked };
}

const fresh: VerificationCandidate = {
  userId: 'user-1',
  studioId: 'studio-1',
  emailVerifiedAt: null,
  verificationSentAt: hoursAgo(1),
};

describe('AuthService.verifyEmail', () => {
  test('looks the user up by the hash, never by the raw token', async () => {
    const token = generateToken();
    const { service, lookedUpWith } = build(fresh);

    await service.verifyEmail(token);

    assert.deepEqual(lookedUpWith, [hashToken(token)]);
    assert.ok(!lookedUpWith[0].includes(token));
  });

  test('marks the user verified within their own tenant', async () => {
    const { service, marked } = build(fresh);

    await service.verifyEmail(generateToken());

    assert.deepEqual(marked, [{ studioId: 'studio-1', userId: 'user-1' }]);
  });

  test('rejects a token that resolves to nobody', async () => {
    const { service, marked } = build(null);

    await assert.rejects(service.verifyEmail(generateToken()), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.getStatus(), 422);
      assert.equal(error.code, 'invalid_token');
      return true;
    });
    assert.deepEqual(marked, []);
  });

  test('rejects a token older than the TTL', async () => {
    const { service, marked } = build({ ...fresh, verificationSentAt: hoursAgo(TTL_HOURS + 1) });

    await assert.rejects(service.verifyEmail(generateToken()), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.code, 'token_expired');
      return true;
    });
    assert.deepEqual(marked, []);
  });

  test('accepts a token that is only just inside the TTL', async () => {
    const { service, marked } = build({ ...fresh, verificationSentAt: hoursAgo(TTL_HOURS - 0.01) });

    await service.verifyEmail(generateToken());

    assert.equal(marked.length, 1);
  });

  test('treats a missing sent_at as expired rather than as forever', async () => {
    const { service } = build({ ...fresh, verificationSentAt: null });

    await assert.rejects(service.verifyEmail(generateToken()), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.code, 'token_expired');
      return true;
    });
  });

  test('is idempotent for an already-verified user', async () => {
    const { service, marked } = build({ ...fresh, emailVerifiedAt: hoursAgo(5) });

    await service.verifyEmail(generateToken());

    // No error, and no pointless write.
    assert.deepEqual(marked, []);
  });
});
