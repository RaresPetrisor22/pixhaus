import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { decodeCursor, encodeCursor } from './cursor';

describe('cursors', () => {
  test('round-trip', () => {
    const cursor = { sort: '2026-09-07T10:00:00.000Z', id: 'ec1f0c9e-0000-4000-8000-000000000001' };

    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  });

  test('is url-safe — no +, / or = to be mangled in a query string', () => {
    for (let i = 0; i < 200; i++) {
      const encoded = encodeCursor({ sort: `2026-09-07T10:00:00.${i}Z`, id: `id-${i}-~?&=` });

      assert.doesNotMatch(encoded, /[+/=]/);
      assert.equal(encodeURIComponent(encoded), encoded);
    }
  });

  test('does not read as plain text, so nobody builds a client on the format', () => {
    const encoded = encodeCursor({ sort: '2026-09-07T10:00:00.000Z', id: 'abc' });

    assert.doesNotMatch(encoded, /2026/);
  });

  test('malformed input is page one, not an error', () => {
    for (const bad of [undefined, '', 'not-base64!!', 'bm8tc2VwYXJhdG9y', '|', 'fA==', 'YXwx']) {
      const decoded = decodeCursor(bad);

      if (bad === 'YXwx') {
        // "a|1" — the one genuinely valid string in this list.
        assert.deepEqual(decoded, { sort: 'a', id: '1' });
      } else {
        assert.equal(decoded, null, `decodeCursor(${JSON.stringify(bad)})`);
      }
    }
  });

  test('an id containing the separator survives — only the first | splits', () => {
    const cursor = { sort: '2026-09-07T10:00:00.000Z', id: 'a|b|c' };

    assert.deepEqual(decodeCursor(encodeCursor(cursor)), cursor);
  });
});
