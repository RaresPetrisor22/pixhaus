import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { generateToken } from './tokens';
import { readSessionCookie, sessionCookieOptions, SESSION_COOKIE } from './session-cookie';

describe('readSessionCookie', () => {
  test('finds the cookie among others', () => {
    assert.equal(readSessionCookie('pixhaus_session=abc'), 'abc');
    assert.equal(readSessionCookie('theme=dark; pixhaus_session=abc; locale=ro'), 'abc');
    assert.equal(readSessionCookie('pixhaus_session=abc; theme=dark'), 'abc');
  });

  test('returns null when it is not there', () => {
    assert.equal(readSessionCookie(undefined), null);
    assert.equal(readSessionCookie(''), null);
    assert.equal(readSessionCookie('theme=dark'), null);
    assert.equal(readSessionCookie('pixhaus_session='), null);
  });

  test('does not match a cookie that merely starts the same', () => {
    assert.equal(readSessionCookie('pixhaus_session_old=abc'), null);
    assert.equal(readSessionCookie('not_pixhaus_session=abc'), null);
  });

  test('survives a real token unchanged', () => {
    const token = generateToken();

    assert.equal(readSessionCookie(`${SESSION_COOKIE}=${token}`), token);
    // base64url needs no percent-encoding, which is why nothing decodes here.
    assert.equal(encodeURIComponent(token), token);
  });

  test('tolerates whitespace and stray fragments', () => {
    assert.equal(readSessionCookie('  pixhaus_session = abc '), 'abc');
    assert.equal(readSessionCookie('broken; pixhaus_session=abc'), 'abc');
  });
});

describe('sessionCookieOptions', () => {
  test('is httpOnly and lax, so script cannot read it and cross-site posts do not send it', () => {
    const options = sessionCookieOptions(336, true);

    assert.equal(options.httpOnly, true);
    assert.equal(options.sameSite, 'lax');
    assert.equal(options.path, '/');
  });

  test('is secure in production only, so http://localhost still works', () => {
    assert.equal(sessionCookieOptions(336, true).secure, true);
    assert.equal(sessionCookieOptions(336, false).secure, false);
  });

  test('expires with the session row', () => {
    assert.equal(sessionCookieOptions(336, true).maxAge, 336 * 3_600_000);
  });
});
