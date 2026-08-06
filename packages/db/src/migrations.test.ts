import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import {
  assertNoBackfill,
  assertNoDrift,
  checksum,
  loadMigrations,
  parseMigrationFilename,
  type AppliedMigration,
  type Migration,
} from './migrations.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function migration(version: string, name: string, sql = `-- ${version}\nSELECT 1;\n`): Migration {
  return { version, name, filename: `${version}_${name}.sql`, sql, checksum: checksum(sql) };
}

function appliedFrom(
  migrations: Migration[],
  overrides: Partial<AppliedMigration> = {},
): Map<string, AppliedMigration> {
  return new Map(
    migrations.map((m) => [
      m.version,
      {
        version: m.version,
        name: m.name,
        checksum: m.checksum,
        applied_at: new Date('2026-01-01T00:00:00.000Z'),
        ...overrides,
      },
    ]),
  );
}

/** A throwaway migrations directory, removed when the test finishes. */
async function fixtureDir(
  t: { after: (fn: () => Promise<void>) => void },
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'pixhaus-migrations-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  for (const [filename, contents] of Object.entries(files)) {
    await writeFile(join(dir, filename), contents, 'utf8');
  }
  return dir;
}

// ---------------------------------------------------------------------------
// parseMigrationFilename
// ---------------------------------------------------------------------------

describe('parseMigrationFilename', () => {
  test('splits a well-formed name into version and name', () => {
    assert.deepEqual(parseMigrationFilename('0001_initial_schema.sql'), {
      version: '0001',
      name: 'initial_schema',
    });
  });

  test('rejects names that would break ordering or parsing', () => {
    const bad = [
      '1_initial_schema.sql', // not zero-padded to 4
      '00001_initial_schema.sql', // too many digits
      '0001-initial-schema.sql', // hyphens, not snake_case
      '0001_Initial_Schema.sql', // uppercase
      'initial_schema.sql', // no version
      '0001_initial_schema.txt', // wrong extension
      '0001_initial_schema.sql.bak', // trailing junk
    ];

    for (const filename of bad) {
      assert.throws(
        () => parseMigrationFilename(filename),
        /must be named like 0001_snake_case_name\.sql/,
        `expected "${filename}" to be rejected`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// checksum
// ---------------------------------------------------------------------------

describe('checksum', () => {
  test('is stable for identical contents and differs for any change', () => {
    const sql = 'CREATE TABLE studios (id uuid PRIMARY KEY);\n';

    assert.equal(checksum(sql), checksum(sql));
    // A single appended comment must change it — this is what makes editing an
    // applied migration detectable.
    assert.notEqual(checksum(sql), checksum(`${sql}-- tampered\n`));
  });
});

// ---------------------------------------------------------------------------
// loadMigrations
// ---------------------------------------------------------------------------

describe('loadMigrations', () => {
  test('returns migrations in version order regardless of directory order', async (t) => {
    const dir = await fixtureDir(t, {
      '0003_third.sql': 'SELECT 3;',
      '0001_first.sql': 'SELECT 1;',
      '0002_second.sql': 'SELECT 2;',
    });

    const migrations = await loadMigrations(dir);

    assert.deepEqual(
      migrations.map((m) => m.version),
      ['0001', '0002', '0003'],
    );
    assert.deepEqual(
      migrations.map((m) => m.name),
      ['first', 'second', 'third'],
    );
  });

  test('reads file contents and checksums them', async (t) => {
    const sql = 'CREATE TABLE studios (id uuid PRIMARY KEY);\n';
    const dir = await fixtureDir(t, { '0001_initial_schema.sql': sql });

    const [migration] = await loadMigrations(dir);

    assert.equal(migration.sql, sql);
    assert.equal(migration.checksum, checksum(sql));
    assert.equal(migration.filename, '0001_initial_schema.sql');
  });

  test('ignores files that are not .sql', async (t) => {
    const dir = await fixtureDir(t, {
      '0001_first.sql': 'SELECT 1;',
      'README.md': '# notes',
      '.gitkeep': '',
    });

    const migrations = await loadMigrations(dir);

    assert.equal(migrations.length, 1);
  });

  test('rejects a malformed filename rather than silently skipping it', async (t) => {
    const dir = await fixtureDir(t, { 'add-favorites.sql': 'SELECT 1;' });

    await assert.rejects(loadMigrations(dir), /must be named like 0001_snake_case_name\.sql/);
  });

  test('rejects two files claiming the same version', async (t) => {
    const dir = await fixtureDir(t, {
      '0002_add_favorites.sql': 'SELECT 1;',
      '0002_add_grants.sql': 'SELECT 2;',
    });

    await assert.rejects(
      loadMigrations(dir),
      /version 0002 is claimed by both 0002_add_favorites\.sql and 0002_add_grants\.sql/,
    );
  });

  test('rejects a missing directory', async () => {
    await assert.rejects(
      loadMigrations(join(tmpdir(), 'pixhaus-does-not-exist')),
      /no migrations directory at/,
    );
  });

  test('returns an empty list for an empty directory', async (t) => {
    const dir = await fixtureDir(t, {});

    assert.deepEqual(await loadMigrations(dir), []);
  });
});

// ---------------------------------------------------------------------------
// assertNoDrift
// ---------------------------------------------------------------------------

describe('assertNoDrift', () => {
  test('passes when every applied migration matches its file', () => {
    const migrations = [migration('0001', 'initial_schema'), migration('0002', 'add_favorites')];

    assert.doesNotThrow(() => assertNoDrift(migrations, appliedFrom(migrations)));
  });

  test('passes when nothing has been applied yet', () => {
    const migrations = [migration('0001', 'initial_schema')];

    assert.doesNotThrow(() => assertNoDrift(migrations, new Map()));
  });

  test('passes when a migration exists on disk but has not been applied', () => {
    const applied = migration('0001', 'initial_schema');
    const pending = migration('0002', 'add_favorites');

    assert.doesNotThrow(() => assertNoDrift([applied, pending], appliedFrom([applied])));
  });

  test('throws when an applied migration file has been deleted', () => {
    const gone = migration('0002', 'add_favorites');

    assert.throws(
      () => assertNoDrift([migration('0001', 'initial_schema')], appliedFrom([gone])),
      /0002_add_favorites is recorded as applied but its file no longer exists/,
    );
  });

  test('throws when an applied migration file has been edited', () => {
    const original = migration('0001', 'initial_schema', 'SELECT 1;');
    const edited = migration('0001', 'initial_schema', 'SELECT 1;\n-- tampered\n');

    assert.throws(
      () => assertNoDrift([edited], appliedFrom([original])),
      /0001_initial_schema\.sql has changed since it was applied on 2026-01-01T00:00:00\.000Z/,
    );
  });
});

// ---------------------------------------------------------------------------
// assertNoBackfill
// ---------------------------------------------------------------------------

describe('assertNoBackfill', () => {
  test('passes when nothing has been applied yet', () => {
    const migrations = [migration('0001', 'initial_schema'), migration('0002', 'add_favorites')];

    assert.doesNotThrow(() => assertNoBackfill(migrations, new Map()));
  });

  test('passes when the pending migration sorts after the highest applied', () => {
    const applied = migration('0001', 'initial_schema');
    const pending = migration('0002', 'add_favorites');

    assert.doesNotThrow(() => assertNoBackfill([applied, pending], appliedFrom([applied])));
  });

  test('passes when everything on disk is already applied', () => {
    const migrations = [migration('0001', 'initial_schema'), migration('0002', 'add_favorites')];

    assert.doesNotThrow(() => assertNoBackfill(migrations, appliedFrom(migrations)));
  });

  test('throws when a pending migration sorts before the highest applied', () => {
    // The merge accident: two branches each added a migration, and the one
    // numbered lower merged second.
    const lateArrival = migration('0001', 'late_arrival');
    const alreadyApplied = migration('0002', 'add_favorites');

    assert.throws(
      () => assertNoBackfill([lateArrival, alreadyApplied], appliedFrom([alreadyApplied])),
      /0001_late_arrival\.sql is pending but 0002 has already been applied — renumber it/,
    );
  });

  test('compares versions as zero-padded strings, not numbers', () => {
    // '0010' > '0009' lexicographically only because of the zero padding, which
    // is exactly why parseMigrationFilename insists on four digits.
    const applied = migration('0009', 'ninth');
    const pending = migration('0010', 'tenth');

    assert.doesNotThrow(() => assertNoBackfill([applied, pending], appliedFrom([applied])));
  });
});
