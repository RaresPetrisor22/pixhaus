import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { isWithinStudio, originalKey, renditionKey, studioPrefix } from './storage-key';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const GALLERY = 'aaaaaaaa-0000-4000-8000-000000000001';
const ASSET = 'bbbbbbbb-0000-4000-8000-000000000002';

describe('storage keys', () => {
  test('an original lands under its studio, gallery and asset', () => {
    assert.equal(
      originalKey(A, GALLERY, ASSET),
      `studios/${A}/galleries/${GALLERY}/originals/${ASSET}`,
    );
  });

  test('renditions sit beside the original, one per kind', () => {
    assert.equal(
      renditionKey(A, GALLERY, ASSET, 'grid'),
      `studios/${A}/galleries/${GALLERY}/renditions/${ASSET}/grid.webp`,
    );

    const kinds = (['thumb', 'grid', 'preview'] as const).map((k) =>
      renditionKey(A, GALLERY, ASSET, k),
    );
    assert.equal(new Set(kinds).size, 3);
  });

  test('the asset id makes the key unique without a unique index', () => {
    assert.notEqual(originalKey(A, GALLERY, ASSET), originalKey(A, GALLERY, B));
  });

  test('two studios never share a prefix', () => {
    assert.ok(!originalKey(A, GALLERY, ASSET).startsWith(studioPrefix(B)));
  });

  test('isWithinStudio accepts its own and rejects everything else', () => {
    const key = originalKey(A, GALLERY, ASSET);

    assert.ok(isWithinStudio(key, A));
    assert.ok(!isWithinStudio(key, B));
  });

  test('a key cannot escape its prefix with traversal', () => {
    // Nothing builds a key from user input today; this is the regression guard
    // for the day someone tries.
    assert.ok(!isWithinStudio(`studios/${B}/../${A}/x`, A));
    assert.ok(!isWithinStudio(`../studios/${A}/x`, A));
  });

  test('keys are url-safe — no escaping needed to sign or fetch one', () => {
    assert.match(originalKey(A, GALLERY, ASSET), /^[A-Za-z0-9/._-]+$/);
    assert.match(renditionKey(A, GALLERY, ASSET, 'thumb'), /^[A-Za-z0-9/._-]+$/);
  });
});
