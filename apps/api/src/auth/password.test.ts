import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hashPassword, verifyDummy, verifyPassword } from './password';

const PASSWORD = 'correct horse battery staple';

describe('password hashing', () => {
  test('produces an argon2id hash carrying its own parameters', async () => {
    const encoded = await hashPassword(PASSWORD);

    assert.match(encoded, /^\$argon2id\$/);
    assert.match(encoded, /m=19456,t=2,p=1/);
  });

  test('never stores the password itself', async () => {
    const encoded = await hashPassword(PASSWORD);

    assert.ok(!encoded.includes(PASSWORD));
  });

  test('salts, so the same password hashes differently every time', async () => {
    const [a, b] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);

    assert.notEqual(a, b);
    // ...and both still verify.
    assert.equal(await verifyPassword(a, PASSWORD), true);
    assert.equal(await verifyPassword(b, PASSWORD), true);
  });

  test('rejects the wrong password', async () => {
    const encoded = await hashPassword(PASSWORD);

    assert.equal(await verifyPassword(encoded, 'correct horse battery stapl'), false);
    assert.equal(await verifyPassword(encoded, ''), false);
  });

  test('treats a malformed hash as a failed login, not a crash', async () => {
    assert.equal(await verifyPassword('not-a-hash', PASSWORD), false);
    assert.equal(await verifyPassword('', PASSWORD), false);
  });

  test('verifyDummy costs about what a real verify costs', async () => {
    const encoded = await hashPassword(PASSWORD);

    const realStart = performance.now();
    await verifyPassword(encoded, 'wrong');
    const real = performance.now() - realStart;

    const dummyStart = performance.now();
    await verifyDummy('wrong');
    const dummy = performance.now() - dummyStart;

    // Loose on purpose — this asserts the same order of magnitude, not a
    // stopwatch. A missing verify would show up as ~0ms against ~50ms.
    assert.ok(dummy > real / 4, `dummy ${dummy.toFixed(1)}ms vs real ${real.toFixed(1)}ms`);
  });
});
