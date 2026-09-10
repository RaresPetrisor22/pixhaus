import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { GrantRequest } from '../auth/principal';
import type { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import { ClientGuard, readBearer } from './client.guard';
import { clientTokenPayload, signClientToken } from './client-token';

const SECRET = 's'.repeat(32);

const grant = {
  grantId: '11111111-1111-1111-1111-111111111111',
  studioId: '22222222-2222-2222-2222-222222222222',
  galleryId: '33333333-3333-3333-3333-333333333333',
  rightsMask: 3,
  epoch: 0,
};

function guard(): ClientGuard {
  return new ClientGuard({ get: () => SECRET } as unknown as ConfigService<Env, true>);
}

function contextFor(authorization?: string): { context: ExecutionContext; request: GrantRequest } {
  const request = { headers: authorization ? { authorization } : {} } as GrantRequest;

  return {
    request,
    context: {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
}

function validToken(ttlSeconds = 3600): string {
  return signClientToken(clientTokenPayload(grant, ttlSeconds), SECRET);
}

describe('readBearer', () => {
  test('accepts a well-formed header', () => {
    assert.equal(readBearer('Bearer abc'), 'abc');
  });

  test('rejects everything else', () => {
    for (const header of [undefined, '', 'abc', 'Basic abc', 'bearer abc', 'Bearer ', 'Bearer  ']) {
      assert.equal(readBearer(header), null, `accepted ${JSON.stringify(header)}`);
    }
  });
});

describe('ClientGuard', () => {
  test('attaches the grant principal a valid token describes', () => {
    const { context, request } = contextFor(`Bearer ${validToken()}`);

    assert.equal(guard().canActivate(context), true);
    assert.deepEqual(request.grant, { kind: 'grant', ...grant });
  });

  test('a missing, forged or expired token is the same 401', () => {
    const expired = signClientToken(
      clientTokenPayload(grant, 3600, Date.now() - 7200 * 1000),
      SECRET,
    );
    const forged = signClientToken(clientTokenPayload(grant, 3600), 'x'.repeat(32));

    for (const header of [undefined, 'Bearer nonsense', `Bearer ${expired}`, `Bearer ${forged}`]) {
      const { context, request } = contextFor(header);

      try {
        guard().canActivate(context);
        assert.fail(`accepted ${String(header)}`);
      } catch (error) {
        assert.equal((error as ApiException).getStatus(), 401);
        assert.equal((error as ApiException).code, 'unauthenticated');
      }

      assert.equal(request.grant, undefined);
    }
  });

  test('a session cookie is not a client credential', () => {
    const { context } = contextFor();

    assert.throws(() => guard().canActivate(context));
  });
});
