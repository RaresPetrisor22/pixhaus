import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { generateToken, hashToken } from './tokens';

describe('tokens', () => {
  test('generates 256 bits, url- and cookie-safe', () => {
    const token = generateToken();

    assert.equal(token.length, 43);
    assert.match(token, /^[A-Za-z0-9_-]+$/);
    assert.equal(encodeURIComponent(token), token);
  });

  test('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 1000 }, generateToken));

    assert.equal(tokens.size, 1000);
  });

  test('hashes to exactly what the schema CHECKs for', () => {
    const hash = hashToken(generateToken());

    assert.equal(hash.length, 64);
    assert.match(hash, /^[0-9a-f]{64}$/);
  });

  test('hashing is deterministic, which is what makes lookup by hash work', () => {
    const token = generateToken();

    assert.equal(hashToken(token), hashToken(token));
  });
});
