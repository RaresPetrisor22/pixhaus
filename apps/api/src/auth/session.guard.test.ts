import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';

import { ApiException } from '../common/api-exception';
import type { AuthenticatedRequest, StudioUserPrincipal } from './principal';
import { SessionGuard } from './session.guard';
import type { SessionService } from './session.service';

const PRINCIPAL: StudioUserPrincipal = {
  kind: 'user',
  userId: 'user-1',
  studioId: 'studio-1',
  sessionId: 'a'.repeat(64),
};

function build(options: { isPublic?: boolean; cookie?: string; resolves?: boolean } = {}) {
  const request = {
    headers: options.cookie ? { cookie: options.cookie } : {},
  } as AuthenticatedRequest;
  const resolvedWith: string[] = [];

  const reflector = {
    getAllAndOverride: () => options.isPublic ?? false,
  } as unknown as Reflector;

  const sessions = {
    resolve: (token: string) => {
      resolvedWith.push(token);
      return Promise.resolve(options.resolves === false ? null : PRINCIPAL);
    },
  } as unknown as SessionService;

  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { guard: new SessionGuard(reflector, sessions), context, request, resolvedWith };
}

describe('SessionGuard', () => {
  test('lets a @Public() route through without looking at cookies', async () => {
    const { guard, context, request, resolvedWith } = build({ isPublic: true });

    assert.equal(await guard.canActivate(context), true);
    assert.deepEqual(resolvedWith, []);
    assert.equal(request.principal, undefined);
  });

  test('attaches the principal when the cookie resolves', async () => {
    const { guard, context, request, resolvedWith } = build({
      cookie: 'pixhaus_session=the-raw-token',
    });

    assert.equal(await guard.canActivate(context), true);
    assert.deepEqual(resolvedWith, ['the-raw-token']);
    assert.deepEqual(request.principal, PRINCIPAL);
  });

  test('401s when there is no cookie at all', async () => {
    const { guard, context, resolvedWith } = build();

    await assert.rejects(guard.canActivate(context), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.getStatus(), 401);
      assert.equal(error.code, 'unauthenticated');
      return true;
    });
    // Nothing was even looked up.
    assert.deepEqual(resolvedWith, []);
  });

  test('401s identically when the cookie does not resolve', async () => {
    const { guard, context, request } = build({
      cookie: 'pixhaus_session=stale-or-forged',
      resolves: false,
    });

    await assert.rejects(guard.canActivate(context), (error: unknown) => {
      assert.ok(error instanceof ApiException);
      assert.equal(error.code, 'unauthenticated');
      return true;
    });
    assert.equal(request.principal, undefined);
  });

  test('ignores other cookies on the same request', async () => {
    const { guard, context, resolvedWith } = build({
      cookie: 'theme=dark; pixhaus_session=the-raw-token; locale=ro',
    });

    await guard.canActivate(context);

    assert.deepEqual(resolvedWith, ['the-raw-token']);
  });
});
