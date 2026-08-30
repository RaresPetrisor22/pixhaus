import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { z } from 'zod';

import { ApiException } from './api-exception';
import { ZodBody } from './zod-body.pipe';

const Body = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(12),
});

const pipe = new ZodBody(Body);

describe('ZodBody', () => {
  test('returns the parsed value, not the raw one', () => {
    const result = pipe.transform({ email: 'ME@Example.COM', password: 'a'.repeat(12) });

    assert.equal(result.email, 'me@example.com');
  });

  test('names the offending field', () => {
    assert.throws(
      () => pipe.transform({ email: 'not-an-email', password: 'a'.repeat(12) }),
      (error: unknown) => {
        assert.ok(error instanceof ApiException);
        assert.equal(error.getStatus(), 400);
        assert.equal(error.code, 'invalid_request');
        assert.match(error.message, /email/);
        return true;
      },
    );
  });

  test('names every offending field once', () => {
    assert.throws(
      () => pipe.transform({}),
      (error: unknown) => {
        assert.ok(error instanceof ApiException);
        assert.match(error.message, /email/);
        assert.match(error.message, /password/);
        return true;
      },
    );
  });

  test('does not echo the submitted values back', () => {
    const password = 'hunter2hunter2';

    assert.throws(
      () => pipe.transform({ email: 'nope', password }),
      (error: unknown) => {
        assert.ok(error instanceof ApiException);
        assert.ok(!error.message.includes(password));
        return true;
      },
    );
  });

  test('rejects a body that is not an object at all', () => {
    assert.throws(() => pipe.transform('nope'), ApiException);
    assert.throws(() => pipe.transform(null), ApiException);
  });
});
