import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { slugify, withRandomSuffix } from './slug';

/** Copied from studios.slug in 0001_initial_schema.sql. */
const SCHEMA_CHECK = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

describe('slugify', () => {
  test('turns studio names into slugs', () => {
    const cases: [string, string][] = [
      ['Rares Photo', 'rares-photo'],
      ['  Rares   Photo  ', 'rares-photo'],
      ['RARES PHOTO', 'rares-photo'],
      ['Rares & Co.', 'rares-co'],
      ['Ratiu Photographie', 'ratiu-photographie'],
      ['studio-42', 'studio-42'],
      ['A', 'a'],
    ];

    for (const [name, expected] of cases) {
      assert.equal(slugify(name), expected, `slugify(${JSON.stringify(name)})`);
    }
  });

  test('falls back rather than producing something the schema rejects', () => {
    for (const name of ['***', '   ', '-', '...', '?!']) {
      assert.equal(slugify(name), 'studio', `slugify(${JSON.stringify(name)})`);
    }
  });

  test('every output satisfies the schema CHECK', () => {
    const names = [
      'Rares Photo',
      'x'.repeat(200),
      'a b c d e f g h i j k l m n o p q r s t u v w x y z 0 1 2 3 4 5 6 7 8 9 extra',
      '***',
      '9 Lives Studio',
      'Ends With A Hyphen -',
    ];

    for (const name of names) {
      const slug = slugify(name);
      assert.match(slug, SCHEMA_CHECK, `slugify(${JSON.stringify(name.slice(0, 20))})`);
      assert.ok(slug.length <= 63);
    }
  });
});

describe('withRandomSuffix', () => {
  test('stays within the schema CHECK, including at the length limit', () => {
    for (const slug of ['rares-photo', 'studio', 'a', 'x'.repeat(63)]) {
      const suffixed = withRandomSuffix(slug);

      assert.match(suffixed, SCHEMA_CHECK);
      assert.ok(suffixed.length <= 63, `${suffixed.length} chars`);
    }
  });

  test('differs each time, so a retry is worth making', () => {
    const attempts = new Set(Array.from({ length: 100 }, () => withRandomSuffix('rares-photo')));

    assert.equal(attempts.size, 100);
  });
});
