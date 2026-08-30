import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

import { HttpStatus, Logger, NotFoundException } from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';

import { ApiException } from './api-exception';
import { ApiExceptionFilter, type ErrorBody } from './api-exception.filter';

function fakeHost() {
  let status = 0;
  let body: ErrorBody | undefined;

  const response = {
    status(code: number) {
      status = code;
      return this;
    },
    json(payload: ErrorBody) {
      body = payload;
      return this;
    },
  };

  return {
    host: {
      switchToHttp: () => ({
        getResponse: () => response,
        getRequest: () => ({ method: 'POST', url: '/api/auth/register' }),
      }),
    } as unknown as ArgumentsHost,
    sent: () => ({ status, body }),
  };
}

/** Runs one exception through the filter and returns what would be sent. */
function through(exception: unknown) {
  const fake = fakeHost();
  new ApiExceptionFilter().catch(exception, fake.host);
  return fake.sent();
}

describe('ApiExceptionFilter', () => {
  before(() => {
    // The unhandled-error case logs a stack on purpose; keep it out of the run.
    Logger.overrideLogger(false);
  });

  test('renders an ApiException with its own status and code', () => {
    const { status, body } = through(
      new ApiException(HttpStatus.CONFLICT, 'email_taken', 'That email is already registered.'),
    );

    assert.equal(status, 409);
    assert.deepEqual(body, {
      error: { code: 'email_taken', message: 'That email is already registered.' },
    });
  });

  test('gives Nest’s own exceptions a code derived from the status', () => {
    const { status, body } = through(new NotFoundException('Cannot GET /nope'));

    assert.equal(status, 404);
    assert.equal(body?.error.code, 'not_found');
  });

  test('turns anything unexpected into a generic 500', () => {
    const { status, body } = through(new Error('duplicate key value violates unique constraint'));

    assert.equal(status, 500);
    assert.deepEqual(body, {
      error: { code: 'internal_error', message: 'Something went wrong.' },
    });
  });

  test('never lets an unexpected error describe itself to the client', () => {
    const leak = 'relation "users" does not exist';
    const { body } = through(new Error(leak));

    assert.ok(!JSON.stringify(body).includes(leak));
  });

  test('survives a thrown non-Error', () => {
    const { status, body } = through('just a string');

    assert.equal(status, 500);
    assert.equal(body?.error.code, 'internal_error');
  });

  test('always produces the documented shape', () => {
    for (const exception of [
      new ApiException(HttpStatus.GONE, 'grant_revoked', 'This link was revoked.'),
      new NotFoundException(),
      new Error('boom'),
    ]) {
      const { body } = through(exception);

      assert.deepEqual(Object.keys(body ?? {}), ['error']);
      assert.deepEqual(Object.keys(body?.error ?? {}).sort(), ['code', 'message']);
    }
  });
});
