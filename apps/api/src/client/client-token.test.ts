import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  clientTokenPayload,
  principalFromPayload,
  signClientToken,
  verifyClientToken,
  type ClientTokenPayload,
} from './client-token';

const SECRET = 'a'.repeat(32);
const OTHER_SECRET = 'b'.repeat(32);
const NOW = 1_800_000_000_000;

const grant = {
  grantId: '11111111-1111-1111-1111-111111111111',
  studioId: '22222222-2222-2222-2222-222222222222',
  galleryId: '33333333-3333-3333-3333-333333333333',
  rightsMask: 3,
  epoch: 0,
};

function payload(overrides: Partial<ClientTokenPayload> = {}): ClientTokenPayload {
  return { ...clientTokenPayload(grant, 3600, NOW), ...overrides };
}

describe('client tokens — round trip', () => {
  test('a signed token verifies back to the same payload', () => {
    const original = payload();
    const verified = verifyClientToken(signClientToken(original, SECRET), SECRET, NOW);

    assert.deepEqual(verified, original);
  });

  test('the payload carries everything a decision needs and nothing else', () => {
    assert.deepEqual(Object.keys(payload()).sort(), ['e', 'exp', 'g', 'r', 's', 'y']);
  });

  test('a payload becomes the principal authorize() takes', () => {
    assert.deepEqual(principalFromPayload(payload()), { kind: 'grant', ...grant });
  });

  test('exp is ttl seconds from now', () => {
    assert.equal(clientTokenPayload(grant, 3600, NOW).exp, NOW / 1000 + 3600);
  });
});

describe('client tokens — rejection', () => {
  const token = signClientToken(payload(), SECRET);

  test('a token signed with another secret is rejected', () => {
    assert.equal(verifyClientToken(token, OTHER_SECRET, NOW), null);
  });

  test('a tampered payload is rejected', () => {
    // The attack this exists for: award yourself the download bit.
    const forged = Buffer.from(JSON.stringify(payload({ r: 7 }))).toString('base64url');

    assert.equal(verifyClientToken(`${forged}.${token.split('.')[1]}`, SECRET, NOW), null);
  });

  test('a tampered signature is rejected', () => {
    const [body, signature] = token.split('.');
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);

    assert.equal(verifyClientToken(`${body}.${flipped}`, SECRET, NOW), null);
  });

  test('a truncated signature is rejected rather than throwing', () => {
    const [body, signature] = token.split('.');

    assert.equal(verifyClientToken(`${body}.${signature.slice(0, -1)}`, SECRET, NOW), null);
  });

  test('a malformed token is rejected', () => {
    for (const bad of ['', '.', 'nodot', 'a.b.c', `.${token.split('.')[1]}`]) {
      assert.equal(verifyClientToken(bad, SECRET, NOW), null, `accepted ${JSON.stringify(bad)}`);
    }
  });

  test('an expired token is rejected', () => {
    assert.equal(verifyClientToken(token, SECRET, NOW + 3600 * 1000), null);
    assert.notEqual(verifyClientToken(token, SECRET, NOW + 3599 * 1000), null);
  });

  test('a validly signed token over the wrong shape is rejected', () => {
    // A secret leak is not the only way to hold a real signature: an older
    // format signed with the same key is one too.
    const body = Buffer.from(JSON.stringify({ grantId: grant.grantId })).toString('base64url');
    const forged = signClientToken({ g: 'x' } as unknown as ClientTokenPayload, SECRET);

    assert.equal(verifyClientToken(`${body}.${forged.split('.')[1]}`, SECRET, NOW), null);
    assert.equal(verifyClientToken(forged, SECRET, NOW), null);
  });

  test('a non-integer rights mask is rejected', () => {
    assert.equal(
      verifyClientToken(signClientToken(payload({ r: 1.5 }), SECRET), SECRET, NOW),
      null,
    );
  });
});
