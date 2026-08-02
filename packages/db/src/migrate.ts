/**
 * Forward-only migration runner.
 *
 *   pnpm db:migrate          apply every pending migration
 *   pnpm db:status           show what has and has not been applied
 *
 * Rules it enforces, and why:
 *
 *   - Files are applied in filename order (0001, 0002, ...). Ordering is the
 *     filename, not a timestamp in the file, so `ls` tells you the truth.
 *   - Each file runs inside its own transaction together with the row that
 *     records it. A migration cannot half-apply, and it cannot apply without
 *     being recorded.
 *   - The sha256 of each file is stored. Editing an already-applied migration
 *     is refused, loudly — your database and your repo have diverged and only
 *     you know which one is right.
 *   - A session-level advisory lock serialises concurrent runners, so two API
 *     containers booting at once do not both try to create the same table.
 *   - There are no down migrations. Rolling back a schema change in production
 *     by running untested reverse SQL is worse than writing a new forward
 *     migration. To undo 0007, write 0008.
 *
 * It connects as the database OWNER (MIGRATION_DATABASE_URL), not as the
 * application role. The owner creates the tables, which is precisely what makes
 * the non-owning application role subject to the row-level security policies
 * those tables carry.
 *
 * Because every file runs inside a transaction, migrations may not contain
 * statements Postgres refuses to run in one -- `CREATE INDEX CONCURRENTLY`,
 * `CREATE DATABASE`, `ALTER TYPE ... ADD VALUE` on older servers. If you ever
 * need one, it gets its own file and this runner needs a per-file opt-out flag.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(HERE, '..', 'migrations');
const REPO_ROOT = join(HERE, '..', '..', '..');

/** `0001_initial_schema.sql` -> version `0001`, name `initial_schema`. */
const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const ADVISORY_LOCK_KEY = 4073218001;

const REGISTRY_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version     text PRIMARY KEY,
    name        text        NOT NULL,
    checksum    text        NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer     NOT NULL
  )
`;

type Migration = {
  version: string;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
};

type AppliedMigration = {
  version: string;
  name: string;
  checksum: string;
  applied_at: Date;
};

function loadEnv(): void {
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

async function loadMigrations(): Promise<Migration[]> {
  if (!existsSync(MIGRATIONS_DIR)) {
    throw new Error(`no migrations directory at ${MIGRATIONS_DIR}`);
  }

  const filenames = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const versionOwner = new Map<string, string>();
  const migrations: Migration[] = [];

  for (const filename of filenames) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new Error(`migration "${filename}" must be named like 0001_snake_case_name.sql`);
    }

    const version = match[1];
    const name = match[2];

    const duplicate = versionOwner.get(version);
    if (duplicate !== undefined) {
      throw new Error(`version ${version} is claimed by both ${duplicate} and ${filename}`);
    }
    versionOwner.set(version, filename);

    const sql = await readFile(join(MIGRATIONS_DIR, filename), 'utf8');
    migrations.push({
      version,
      name,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations;
}

async function fetchApplied(client: pg.Client): Promise<Map<string, AppliedMigration>> {
  const { rows } = await client.query<AppliedMigration>(
    'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
  );
  return new Map(rows.map((row) => [row.version, row]));
}

/**
 * Refuses to continue if the repo and the database disagree about history:
 * a recorded migration whose file has been deleted, or whose contents have
 * changed since it ran.
 */
function assertNoDrift(migrations: Migration[], applied: Map<string, AppliedMigration>): void {
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
function assertNoBackfill(migrations: Migration[], applied: Map<string, AppliedMigration>): void {
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

async function up(client: pg.Client): Promise<void> {
  const migrations = await loadMigrations();

  await client.query(REGISTRY_DDL);
  const applied = await fetchApplied(client);

  assertNoDrift(migrations, applied);
  assertNoBackfill(migrations, applied);

  const pending = migrations.filter((m) => !applied.has(m.version));
  if (pending.length === 0) {
    console.log(`nothing to do — ${applied.size} migration(s) already applied`);
    return;
  }

  for (const migration of pending) {
    process.stdout.write(`applying ${migration.filename} ... `);
    const startedAt = Date.now();

    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      const durationMs = Date.now() - startedAt;
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum, duration_ms)
         VALUES ($1, $2, $3, $4)`,
        [migration.version, migration.name, migration.checksum, durationMs],
      );
      await client.query('COMMIT');
      console.log(`ok (${durationMs} ms)`);
    } catch (error) {
      await client.query('ROLLBACK');
      console.log('failed — rolled back');
      throw error;
    }
  }

  console.log(`applied ${pending.length} migration(s)`);
}

async function status(client: pg.Client): Promise<void> {
  const migrations = await loadMigrations();

  const { rows } = await client.query<{ present: string | null }>(
    "SELECT to_regclass('public.schema_migrations')::text AS present",
  );
  const applied = rows[0].present
    ? await fetchApplied(client)
    : new Map<string, AppliedMigration>();

  if (migrations.length === 0) {
    console.log('no migration files found');
    return;
  }

  for (const migration of migrations) {
    const row = applied.get(migration.version);
    const state = !row
      ? 'pending'
      : row.checksum === migration.checksum
        ? `applied ${row.applied_at.toISOString()}`
        : 'CHANGED SINCE APPLIED';
    console.log(`${migration.filename.padEnd(40)} ${state}`);
  }
}

async function main(): Promise<void> {
  loadEnv();

  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'MIGRATION_DATABASE_URL is not set — it must point at the database OWNER role, ' +
        'not the application role (see .env.example)',
    );
  }

  const command = process.argv[2] ?? 'up';
  if (command !== 'up' && command !== 'status') {
    throw new Error(`unknown command "${command}" — expected "up" or "status"`);
  }

  const client = new Client({ connectionString, application_name: 'pixhaus-migrate' });
  await client.connect();

  try {
    if (command === 'up') {
      // Session-scoped: released when the connection closes below, including
      // if this process dies.
      await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
      await up(client);
    } else {
      await status(client);
    }
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(`\nmigration failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
