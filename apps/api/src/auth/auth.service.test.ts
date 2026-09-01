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
  type Profile,
  type UserCredentials,
  type VerificationCandidate,
} from './auth.repository';
import { AuthService } from './auth.service';
import { hashPassword, verifyPassword } from './password';
import type { StudioUserPrincipal } from './principal';
import type { SessionService } from './session.service';
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
    profile?: Profile | null;
  } = {},
) {
  const inserts: NewStudioOwner[] = [];
  const tokensSet: { studioId: string; userId: string; tokenHash: string }[] = [];
  const marked: { studioId: string; userId: string }[] = [];
  const lookedUpWith: string[] = [];
  const sent: { to: string; token: string; ttlHours: number }[] = [];
  const issued: { userId: string; studioId: string }[] = [];
  const revoked: StudioUserPrincipal[] = [];
  const revokedAll: StudioUserPrincipal[] = [];
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
    findProfile: () => Promise.resolve(options.profile === undefined ? PROFILE : options.profile),
  } as unknown as AuthRepository;

  const sessions = {
    issue: (userId: string, studioId: string) => {
      issued.push({ userId, studioId });
      return Promise.resolve('session-token');
    },
    revoke: (principal: StudioUserPrincipal) => {
      revoked.push(principal);
      return Promise.resolve();
    },
    revokeAll: (principal: StudioUserPrincipal) => {
      revokedAll.push(principal);
      return Promise.resolve(3);
    },
  } as unknown as SessionService;

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
    service: new AuthService(repository, sessions, mail, config),
    inserts,
    tokensSet,
    marked,
    lookedUpWith,
    sent,
    issued,
    revoked,
    revokedAll,
  };
}

const PROFILE: Profile = {
  user: { id: 'user-1', email: 'me@example.com', role: 'owner', emailVerified: true },
  studio: { id: 'studio-1', name: 'Rares Photo', slug: 'rares-photo' },
};

const PRINCIPAL: StudioUserPrincipal = {
  kind: 'user',
  userId: 'user-1',
  studioId: 'studio-1',
  sessionId: 'a'.repeat(64),
};

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

describe('AuthService.login', () => {
  let passwordHash: string;

  before(async () => {
    passwordHash = await hashPassword(REGISTRATION.password);
  });

  const credentials = (hash: string): UserCredentials => ({
    userId: 'user-1',
    studioId: 'studio-1',
    passwordHash: hash,
    emailVerifiedAt: null,
  });

  test('issues a session and returns the profile', async () => {
    const { service, issued } = build({ credentials: credentials(passwordHash) });

    const result = await service.login(
      { email: 'me@example.com', password: REGISTRATION.password },
      {},
    );

    assert.deepEqual(issued, [{ userId: 'user-1', studioId: 'studio-1' }]);
    assert.equal(result.token, 'session-token');
    assert.deepEqual(result.profile, PROFILE);
  });

  test('rejects a wrong password without issuing anything', async () => {
    const { service, issued } = build({ credentials: credentials(passwordHash) });

    await assert.rejects(
      service.login({ email: 'me@example.com', password: 'not the password' }, {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiException);
        assert.equal(error.getStatus(), 401);
        assert.equal(error.code, 'invalid_credentials');
        return true;
      },
    );
    assert.deepEqual(issued, []);
  });

  test('gives an unknown email the identical error', async () => {
    const { service, issued } = build({ credentials: null });

    await assert.rejects(
      service.login({ email: 'nobody@example.com', password: REGISTRATION.password }, {}),
      (error: unknown) => {
        assert.ok(error instanceof ApiException);
        assert.equal(error.getStatus(), 401);
        assert.equal(error.code, 'invalid_credentials');
        return true;
      },
    );
    assert.deepEqual(issued, []);
  });

  test('takes comparable time whether the email exists or not', async () => {
    const known = build({ credentials: credentials(passwordHash) });
    const unknown = build({ credentials: null });

    const t1 = performance.now();
    await assert.rejects(known.service.login({ email: 'me@example.com', password: 'wrong' }, {}));
    const wrongPassword = performance.now() - t1;

    const t2 = performance.now();
    await assert.rejects(
      unknown.service.login({ email: 'nobody@example.com', password: 'wrong' }, {}),
    );
    const unknownEmail = performance.now() - t2;

    // Skipping verifyDummy would make the unknown-email branch return in
    // microseconds against tens of milliseconds, which is what an attacker
    // measures. Loose bound, not a stopwatch.
    assert.ok(
      unknownEmail > wrongPassword / 4,
      `unknown email ${unknownEmail.toFixed(1)}ms vs wrong password ${wrongPassword.toFixed(1)}ms`,
    );
  });

  test('does not let a login succeed with no profile behind it', async () => {
    const { service } = build({ credentials: credentials(passwordHash), profile: null });

    await assert.rejects(
      service.login({ email: 'me@example.com', password: REGISTRATION.password }, {}),
      /no profile was visible/,
    );
  });
});

describe('AuthService sessions', () => {
  test('logout revokes only the current session', async () => {
    const { service, revoked, revokedAll } = build();

    await service.logout(PRINCIPAL);

    assert.deepEqual(revoked, [PRINCIPAL]);
    assert.deepEqual(revokedAll, []);
  });

  test('logoutEverywhere revokes them all and reports how many', async () => {
    const { service, revoked, revokedAll } = build();

    const count = await service.logoutEverywhere(PRINCIPAL);

    assert.equal(count, 3);
    assert.deepEqual(revokedAll, [PRINCIPAL]);
    assert.deepEqual(revoked, []);
  });

  test('me returns the profile for the principal tenant', async () => {
    const { service } = build();

    assert.deepEqual(await service.me(PRINCIPAL), PROFILE);
  });

  test('me 401s if the user vanished since the session resolved', async () => {
    const { service } = build({ profile: null });

    await assert.rejects(service.me(PRINCIPAL), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.getStatus(), 401);
      return true;
    });
  });
});
