import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { uniqueViolation } from './pg-errors';

/** Shaped like what pg actually throws. */
function databaseError(code: string, constraint?: string) {
  return Object.assign(new Error('duplicate key value violates unique constraint'), {
    code,
    constraint,
  });
}

describe('uniqueViolation', () => {
  test('names the constraint that was broken', () => {
    assert.equal(uniqueViolation(databaseError('23505', 'users_email_key')), 'users_email_key');
    assert.equal(uniqueViolation(databaseError('23505', 'studios_slug_key')), 'studios_slug_key');
  });

  test('returns null for anything that is not a unique violation', () => {
    assert.equal(uniqueViolation(databaseError('23503', 'users_studio_id_fkey')), null);
    assert.equal(uniqueViolation(databaseError('42501')), null);
    assert.equal(uniqueViolation(new Error('boom')), null);
    assert.equal(uniqueViolation('boom'), null);
    assert.equal(uniqueViolation(null), null);
    assert.equal(uniqueViolation(undefined), null);
  });

  test('still reports a unique violation that arrives unnamed', () => {
    // Truthy, so `if (uniqueViolation(e))` holds — it just will not match a
    // constraint the caller is looking for, and falls through to a rethrow.
    assert.equal(uniqueViolation(databaseError('23505')), 'unknown');
  });
});
