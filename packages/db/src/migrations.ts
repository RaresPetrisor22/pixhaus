/**
 * Everything the migration runner knows that does not need a database.
 *
 * Split out from migrate.ts so it can be tested without Docker: each function
 * here takes plain values and either returns one or throws. The database work
 * — transactions, the advisory lock, the schema_migrations table — stays in
 * migrate.ts.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Default location of migration files. Tests override it with a temp dir. */
export const MIGRATIONS_DIR = join(HERE, '..', 'migrations');

/** `0001_initial_schema.sql` -> version `0001`, name `initial_schema`. */
const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** One migration file on disk. */
export type Migration = {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
};

/** One row read back out of schema_migrations. */
export type AppliedMigration = {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
};

export function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

export function parseMigrationFilename(filename: string): { version: string; name: string } {
  const match = FILENAME_PATTERN.exec(filename);
  if (!match) {
    throw new Error(`migration "${filename}" must be named like 0001_snake_case_name.sql`);
  }
  return { version: match[1], name: match[2] };
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  if (!existsSync(dir)) {
    throw new Error(`no migrations directory at ${dir}`);
  }

  const filenames = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const versionOwner = new Map<string, string>();
  const migrations: Migration[] = [];

  for (const filename of filenames) {
    const { version, name } = parseMigrationFilename(filename);

    const duplicate = versionOwner.get(version);
    if (duplicate !== undefined) {
      throw new Error(`version ${version} is claimed by both ${duplicate} and ${filename}`);
    }
    versionOwner.set(version, filename);

    const sql = await readFile(join(dir, filename), 'utf8');
    migrations.push({ version, name, filename, sql, checksum: checksum(sql) });
  }

  return migrations;
}

/**
 * Refuses to continue if the repo and the database disagree about history:
 * a recorded migration whose file has been deleted, or whose contents have
 * changed since it ran. Either way the schema in front of you is not the schema
 * the files describe, and quietly carrying on would bake that in.
 */
export function assertNoDrift(
  migrations: Migration[],
  applied: Map<string, AppliedMigration>,
): void {
  const byVersion = new Map(migrations.map((m) => [m.version, m]));

  for (const row of applied.values()) {
    const migration = byVersion.get(row.version);
    if (!migration) {
      throw new Error(
        `${row.version}_${row.name} is recorded as applied but its file no longer exists — ` +
          `restore it, or remove the row if the database was rebuilt from elsewhere`,
      );
    }
    if (migration.checksum !== row.checksum) {
      throw new Error(
        `${migration.filename} has changed since it was applied on ` +
          `${row.applied_at.toISOString()} — write a new migration instead of editing this one`,
      );
    }
  }
}

/**
 * Refuses to apply a migration that sorts before one already applied. This
 * happens when two branches both add 000N and one merges after the other has
 * already run; applying them out of order gives two databases different
 * schemas from the same files. Renumber the newcomer.
 */
export function assertNoBackfill(
  migrations: Migration[],
  applied: Map<string, AppliedMigration>,
): void {
  const highestApplied = [...applied.keys()].sort().at(-1);
  if (highestApplied === undefined) return;

  for (const migration of migrations) {
    if (!applied.has(migration.version) && migration.version < highestApplied) {
      throw new Error(
        `${migration.filename} is pending but ${highestApplied} has already been applied — ` +
          `renumber it to sort after ${highestApplied}`,
      );
    }
  }
}
