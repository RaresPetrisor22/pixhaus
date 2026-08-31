import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import type { MailService } from '../mail/mail.service';
import {
  UNIQUE_EMAIL,
  UNIQUE_SLUG,
  type AuthRepository,
  type NewStudioOwner,
  type UserCredentials,
  type VerificationCandidate,
} from './auth.repository';
import { AuthService } from './auth.service';
import { verifyPassword } from './password';
import { generateToken, hashToken } from './tokens';

const TTL_HOURS = 24;
const hoursAgo = (n: number) => new Date(Date.now() - n * 3_600_000);

function databaseError(constraint: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
}

/**
 * No database and no SMTP server: everything the service depends on sits behind
 * an interface, so the policy can be exercised on its own.
 */
function build(
  options: {
    candidate?: VerificationCandidate | null;
    credentials?: UserCredentials | null;
    /** Constraint names to fail on, one per successive insert attempt. */
    insertFailures?: string[];
    mailThrows?: boolean;
  } = {},
) {
  const inserts: NewStudioOwner[] = [];
  const tokensSet: { studioId: string; userId: string; tokenHash: string }[] = [];
  const marked: { studioId: string; userId: string }[] = [];
  const lookedUpWith: string[] = [];
  const sent: { to: string; token: string; ttlHours: number }[] = [];
  const failures = [...(options.insertFailures ?? [])];

  const repository = {
    createStudioWithOwner: (input: NewStudioOwner) => {
      inserts.push(input);
      const constraint = failures.shift();
      if (constraint) {
        return Promise.reject(databaseError(constraint));
      }
      return Promise.resolve({ userId: 'user-1' });
    },
    findUserByEmail: () => Promise.resolve(options.credentials ?? null),
    findUserByVerificationToken: (hash: string) => {
      lookedUpWith.push(hash);
      return Promise.resolve(options.candidate ?? null);
    },
    setVerificationToken: (studioId: string, userId: string, tokenHash: string) => {
      tokensSet.push({ studioId, userId, tokenHash });
      return Promise.resolve();
    },
    markEmailVerified: (studioId: string, userId: string) => {
      marked.push({ studioId, userId });
      return Promise.resolve();
    },
  } as unknown as AuthRepository;

  const mail = {
    sendVerificationEmail: (to: string, token: string, ttlHours: number) => {
      if (options.mailThrows) {
        return Promise.reject(new Error('smtp is down'));
      }
      sent.push({ to, token, ttlHours });
      return Promise.resolve();
    },
  } as unknown as MailService;

  const config = { get: () => TTL_HOURS } as unknown as ConfigService<Env, true>;

  return {
    service: new AuthService(repository, mail, config),
    inserts,
    tokensSet,
    marked,
    lookedUpWith,
    sent,
  };
}

const REGISTRATION = {
  studioName: 'Rares Photo',
  email: 'me@example.com',
  password: 'correct horse battery staple',
};

describe('AuthService.register', () => {
  before(() => Logger.overrideLogger(false));

  test('creates the studio and its owner, and reports them back', async () => {
    const { service, inserts } = build();

    const result = await service.register(REGISTRATION);

    assert.equal(inserts.length, 1);
    assert.equal(result.user.id, 'user-1');
    assert.equal(result.user.email, 'me@example.com');
    assert.equal(result.user.emailVerified, false);
    assert.equal(result.studio.id, inserts[0].studioId);
    assert.equal(result.studio.slug, 'rares-photo');
  });

  test('generates the studio id itself, since RLS depends on knowing it first', async () => {
    const { service, inserts } = build();

    const result = await service.register(REGISTRATION);

    assert.match(inserts[0].studioId, /^[0-9a-f-]{36}$/);
    assert.equal(inserts[0].studioId, result.studio.id);
  });

  test('stores a verifiable hash, never the password', async () => {
    const { service, inserts } = build();

    await service.register(REGISTRATION);

    const { passwordHash } = inserts[0];
    assert.ok(!passwordHash.includes(REGISTRATION.password));
    assert.equal(await verifyPassword(passwordHash, REGISTRATION.password), true);
  });

  test('emails the raw token but stores only its hash', async () => {
    const { service, inserts, sent } = build();

    await service.register(REGISTRATION);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'me@example.com');
    assert.equal(sent[0].ttlHours, TTL_HOURS);
    assert.equal(inserts[0].verificationTokenHash, hashToken(sent[0].token));
    assert.notEqual(inserts[0].verificationTokenHash, sent[0].token);
  });

  test('turns a duplicate email into 409, without retrying', async () => {
    const { service, inserts } = build({ insertFailures: [UNIQUE_EMAIL] });

    await assert.rejects(service.register(REGISTRATION), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.getStatus(), 409);
      assert.equal(error.code, 'email_taken');
      return true;
    });
    assert.equal(inserts.length, 1);
  });

  test('retries a taken slug with a suffix rather than rejecting the name', async () => {
    const { service, inserts } = build({ insertFailures: [UNIQUE_SLUG] });

    const result = await service.register(REGISTRATION);

    assert.equal(inserts.length, 2);
    assert.equal(inserts[0].slug, 'rares-photo');
    assert.match(inserts[1].slug, /^rares-photo-[0-9a-f]{6}$/);
    assert.equal(result.studio.slug, inserts[1].slug);
    // The name the photographer typed is untouched.
    assert.equal(result.studio.name, 'Rares Photo');
  });

  test('gives up after a bounded number of slug attempts', async () => {
    const { service, inserts } = build({ insertFailures: Array<string>(10).fill(UNIQUE_SLUG) });

    await assert.rejects(service.register(REGISTRATION), /could not find a free studio slug/);
    assert.equal(inserts.length, 5);
  });

  test('does not interpret errors that are not ours', async () => {
    const { service } = build({ insertFailures: ['users_studio_id_fkey'] });

    await assert.rejects(service.register(REGISTRATION), (error: unknown) => {
      assert.ok(!(error instanceof ApiException));
      return true;
    });
  });

  test('still succeeds when the email cannot be sent', async () => {
    const { service } = build({ mailThrows: true });

    const result = await service.register(REGISTRATION);

    assert.equal(result.user.id, 'user-1');
  });
});

describe('AuthService.resendVerification', () => {
  const unverified: UserCredentials = {
    userId: 'user-1',
    studioId: 'studio-1',
    passwordHash: 'irrelevant',
    emailVerifiedAt: null,
  };

  test('rotates the token and sends a new link', async () => {
    const { service, tokensSet, sent } = build({ credentials: unverified });

    await service.resendVerification('me@example.com');

    assert.equal(sent.length, 1);
    assert.deepEqual(tokensSet, [
      { studioId: 'studio-1', userId: 'user-1', tokenHash: hashToken(sent[0].token) },
    ]);
  });

  test('says nothing different when the address is unknown', async () => {
    const { service, tokensSet, sent } = build({ credentials: null });

    // Resolves, exactly as it does above. That is the entire point.
    await service.resendVerification('nobody@example.com');

    assert.deepEqual(tokensSet, []);
    assert.deepEqual(sent, []);
  });

  test('says nothing different when the address is already verified', async () => {
    const { service, sent } = build({
      credentials: { ...unverified, emailVerifiedAt: hoursAgo(1) },
    });

    await service.resendVerification('me@example.com');

    assert.deepEqual(sent, []);
  });
});

describe('AuthService.verifyEmail', () => {
  const fresh: VerificationCandidate = {
    userId: 'user-1',
    studioId: 'studio-1',
    emailVerifiedAt: null,
    verificationSentAt: hoursAgo(1),
  };

  test('looks the user up by the hash, never by the raw token', async () => {
    const token = generateToken();
    const { service, lookedUpWith } = build({ candidate: fresh });

    await service.verifyEmail(token);

    assert.deepEqual(lookedUpWith, [hashToken(token)]);
  });

  test('marks the user verified within their own tenant', async () => {
    const { service, marked } = build({ candidate: fresh });

    await service.verifyEmail(generateToken());

    assert.deepEqual(marked, [{ studioId: 'studio-1', userId: 'user-1' }]);
  });

  test('rejects a token that resolves to nobody', async () => {
    const { service, marked } = build({ candidate: null });

    await assert.rejects(service.verifyEmail(generateToken()), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.getStatus(), 422);
      assert.equal(error.code, 'invalid_token');
      return true;
    });
    assert.deepEqual(marked, []);
  });

  test('rejects a token older than the TTL', async () => {
    const { service, marked } = build({
      candidate: { ...fresh, verificationSentAt: hoursAgo(TTL_HOURS + 1) },
    });

    await assert.rejects(service.verifyEmail(generateToken()), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.code, 'token_expired');
      return true;
    });
    assert.deepEqual(marked, []);
  });

  test('accepts a token that is only just inside the TTL', async () => {
    const { service, marked } = build({
      candidate: { ...fresh, verificationSentAt: hoursAgo(TTL_HOURS - 0.01) },
    });

    await service.verifyEmail(generateToken());

    assert.equal(marked.length, 1);
  });

  test('treats a missing sent_at as expired rather than as forever', async () => {
    const { service } = build({ candidate: { ...fresh, verificationSentAt: null } });

    await assert.rejects(service.verifyEmail(generateToken()), /expired/);
  });

  test('is idempotent for an already-verified user', async () => {
    const { service, marked } = build({ candidate: { ...fresh, emailVerifiedAt: hoursAgo(5) } });

    await service.verifyEmail(generateToken());

    assert.deepEqual(marked, []);
  });
});
