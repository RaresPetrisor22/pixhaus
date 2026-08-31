/**
 * What row-level security actually does, asserted against a real database.
 *
 * migrations.test.ts deliberately tests only the half of this package that
 * needs no database. This file is the other half, and it is the reason the
 * two-role setup is worth its complexity: every claim in the header of
 * 0001_initial_schema.sql and 0002_auth_bootstrap.sql is checked here, as the
 * APPLICATION role, against the same Postgres the API talks to.
 *
 * It connects as the app role on purpose. Connecting as the owner would pass
 * every test in this file for the wrong reason -- the owner bypasses the very
 * policies under test.
 *
 * Nothing here is a unit test. If Postgres is not up, or the migrations have
 * not been applied, the whole suite skips with a message saying so rather than
 * failing, so `pnpm test` stays honest on a laptop with nothing running.
 *
 *   docker compose up -d --wait postgres
 *   pnpm db:migrate
 *   pnpm test
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const { Client, Pool } = pg;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

/** SQLSTATE 42501. Both a WITH CHECK violation and a plain privilege denial. */
const INSUFFICIENT_PRIVILEGE = '42501';

/** Every table 0001 created, in the order it created them. */
const TENANT_TABLES = [
  'studios',
  'users',
  'sessions',
  'galleries',
  'assets',
  'renditions',
  'grants',
  'favorites',
];

const BOOTSTRAP_FUNCTIONS = [
  'auth_lookup_user_by_email',
  'auth_lookup_user_by_verification_token',
  'auth_resolve_session',
];

// ---------------------------------------------------------------------------
// Can we run at all?
// ---------------------------------------------------------------------------

/** Same rule as migrate.ts: a repo-root .env if there is one, else the env. */
function loadEnv(): void {
  const envFile = join(REPO_ROOT, '.env');
  if (existsSync(envFile)) {
    process.loadEnvFile(envFile);
  }
}

loadEnv();

/**
 * TEST_DATABASE_URL first so CI can point this somewhere disposable; otherwise
 * the app role's normal connection string. Never MIGRATION_DATABASE_URL -- see
 * the header.
 */
const CONNECTION_STRING = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/** Returns a reason to skip, or false if the database is ready to be tested. */
async function skipReason(): Promise<string | false> {
  if (!CONNECTION_STRING) {
    return 'no TEST_DATABASE_URL or DATABASE_URL — see .env.example';
  }

  const probe = new Client({
    connectionString: CONNECTION_STRING,
    application_name: 'pixhaus-test',
  });
  try {
    await probe.connect();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `postgres unreachable (${message}) — try: docker compose up -d --wait postgres`;
  }

  try {
    const { rows } = await probe.query<{ users: string | null; bootstrap: string | null }>(
      `SELECT to_regclass('public.users')::text            AS users,
              to_regproc('public.auth_resolve_session')::text AS bootstrap`,
    );
    if (!rows[0].users) return 'schema not migrated — run: pnpm db:migrate';
    if (!rows[0].bootstrap) return 'migration 0002 not applied — run: pnpm db:migrate';
    return false;
  } finally {
    await probe.end();
  }
}

// Top-level await: the file is ESM, and knowing the reason before the suite is
// defined is what lets it skip cleanly instead of failing in a hook.
const skip = await skipReason();

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Studio = { studioId: string; userId: string; email: string };

/** A 64-character hex string, the shape every token_hash column insists on. */
function tokenHash(): string {
  return createHash('sha256').update(randomBytes(32)).digest('hex');
}

/** Unique per run, and recognisable if a failure ever leaves one behind. */
function uniqueSuffix(): string {
  return randomBytes(6).toString('hex');
}

let pool: pg.Pool;
const created: string[] = [];

/**
 * Runs fn inside a transaction scoped to one tenant, then rolls back. This is
 * the shape the API's TenantDb service will have, minus the COMMIT -- most
 * assertions below want to observe policy behaviour without leaving rows.
 */
async function inTenant<T>(
  studioId: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (studioId !== null) {
      // set_config(..., true) rather than `SET LOCAL app.studio_id = ...`:
      // SET takes no bind parameters, so using it would mean concatenating a
      // value into SQL. The `true` is what makes it local to the transaction.
      await client.query(`SELECT set_config('app.studio_id', $1, true)`, [studioId]);
    }
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

/**
 * Creates a studio and its first user exactly the way POST /api/auth/register
 * will: choose the uuid in the application, declare it, then insert. No
 * bootstrap function is involved, because registration does not need one.
 */
async function createStudio(): Promise<Studio> {
  const studioId = randomUUID();
  const suffix = uniqueSuffix();
  const email = `rls-test-${suffix}@example.test`;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.studio_id', $1, true)`, [studioId]);
    await client.query(`INSERT INTO studios (id, name, slug) VALUES ($1, $2, $3)`, [
      studioId,
      `RLS Test ${suffix}`,
      `rls-test-${suffix}`,
    ]);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO users (studio_id, email, password_hash)
       VALUES ($1, $2, 'not-a-real-argon2-hash')
       RETURNING id`,
      [studioId, email],
    );
    await client.query('COMMIT');
    created.push(studioId);
    return { studioId, userId: rows[0].id, email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Removes anything a previous run left behind. Needed because a run killed
 * partway through never reaches its after() hook, and the app role cannot find
 * the strays afterwards -- enumerating other tenants is precisely what RLS
 * forbids. So this one sweep uses the owner, and is skipped when that
 * connection string is not available.
 */
async function sweepStrays(): Promise<void> {
  const connectionString = process.env.MIGRATION_DATABASE_URL;
  if (!connectionString) {
    return;
  }

  const owner = new Client({ connectionString, application_name: 'pixhaus-test-sweep' });
  await owner.connect();
  try {
    await owner.query("DELETE FROM studios WHERE slug LIKE 'rls-test-%'");
  } finally {
    await owner.end();
  }
}

/** Deleting the studio cascades to users and sessions. */
async function deleteStudio(studioId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.studio_id', $1, true)`, [studioId]);
    await client.query('DELETE FROM studios WHERE id = $1', [studioId]);
    await client.query('COMMIT');
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------

describe('row-level security', { skip }, () => {
  let alpha: Studio;
  let beta: Studio;

  before(async () => {
    await sweepStrays();
    pool = new Pool({
      connectionString: CONNECTION_STRING,
      application_name: 'pixhaus-test',
      max: 4,
    });
    alpha = await createStudio();
    beta = await createStudio();
  });

  after(async () => {
    for (const studioId of created) {
      await deleteStudio(studioId);
    }
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // The wall
  // -------------------------------------------------------------------------

  describe('with no tenant declared', () => {
    test('every tenant table reads as empty — not an error, empty', async () => {
      for (const table of TENANT_TABLES) {
        const { rows } = await pool.query(`SELECT * FROM ${table}`);
        assert.equal(rows.length, 0, `expected ${table} to be invisible without a tenant`);
      }
    });

    test('this is why login cannot be a plain SELECT', async () => {
      // The row exists. before() just committed it.
      const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [alpha.email]);

      assert.equal(rows.length, 0);
      // studio_id = NULL is NULL, and a policy admits a row only when its
      // USING clause is TRUE. Indistinguishable from "no such user".
    });
  });

  describe('with a tenant declared', () => {
    test('sees its own rows', async () => {
      await inTenant(alpha.studioId, async (client) => {
        const { rows } = await client.query<{ id: string }>('SELECT id FROM users');
        assert.deepEqual(
          rows.map((r) => r.id),
          [alpha.userId],
        );
      });
    });

    test('does not see another tenant’s rows', async () => {
      await inTenant(alpha.studioId, async (client) => {
        const { rows } = await client.query('SELECT id FROM users WHERE id = $1', [beta.userId]);
        assert.equal(rows.length, 0);
      });
    });

    test('cannot insert a row tagged with another tenant — WITH CHECK', async () => {
      await inTenant(alpha.studioId, async (client) => {
        await assert.rejects(
          client.query(
            `INSERT INTO users (studio_id, email, password_hash)
             VALUES ($1, $2, 'x')`,
            [beta.studioId, `smuggled-${uniqueSuffix()}@example.test`],
          ),
          (error: unknown) => {
            assert.equal((error as pg.DatabaseError).code, INSUFFICIENT_PRIVILEGE);
            return true;
          },
        );
      });
    });

    test('cannot update another tenant’s row — and gets no error saying so', async () => {
      // USING filters the row out before the UPDATE can see it, so this is a
      // no-op rather than a failure. That asymmetry with WITH CHECK is the
      // whole reason 0001's policies carry both clauses.
      await inTenant(alpha.studioId, async (client) => {
        const result = await client.query('UPDATE users SET role = $1 WHERE id = $2', [
          'member',
          beta.userId,
        ]);
        assert.equal(result.rowCount, 0);
      });
    });

    test('cannot delete another tenant’s row', async () => {
      await inTenant(alpha.studioId, async (client) => {
        const result = await client.query('DELETE FROM studios WHERE id = $1', [beta.studioId]);
        assert.equal(result.rowCount, 0);
      });
    });
  });

  describe('tenant context', () => {
    test('does not survive the transaction that set it', async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.studio_id', $1, true)`, [alpha.studioId]);
        const inside = await client.query('SELECT id FROM users');
        assert.equal(inside.rows.length, 1);
        await client.query('COMMIT');

        // Same physical connection, next transaction. If SET LOCAL leaked, a
        // pooled connection would hand one tenant's context to the next
        // request that borrowed it.
        const outside = await client.query('SELECT id FROM users');
        assert.equal(outside.rows.length, 0);
      } finally {
        client.release();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Registration: the operation that needs no bootstrap
  // -------------------------------------------------------------------------

  describe('registration', () => {
    test('creates a studio by declaring its id before it exists', async () => {
      const studioId = randomUUID();
      const suffix = uniqueSuffix();

      await inTenant(studioId, async (client) => {
        await client.query('INSERT INTO studios (id, name, slug) VALUES ($1, $2, $3)', [
          studioId,
          `Fresh ${suffix}`,
          `fresh-${suffix}`,
        ]);
        await client.query(
          `INSERT INTO users (studio_id, email, password_hash) VALUES ($1, $2, 'x')`,
          [studioId, `fresh-${suffix}@example.test`],
        );

        const studios = await client.query('SELECT id FROM studios');
        const users = await client.query('SELECT studio_id FROM users');
        assert.deepEqual(
          studios.rows.map((r) => (r as { id: string }).id),
          [studioId],
        );
        assert.equal(users.rows.length, 1);
      });
      // inTenant rolls back, so nothing to clean up.
    });

    test('cannot create a studio under an id it did not declare', async () => {
      await inTenant(randomUUID(), async (client) => {
        const suffix = uniqueSuffix();
        await assert.rejects(
          client.query('INSERT INTO studios (id, name, slug) VALUES ($1, $2, $3)', [
            randomUUID(), // not the declared one
            `Mismatch ${suffix}`,
            `mismatch-${suffix}`,
          ]),
          (error: unknown) => {
            assert.equal((error as pg.DatabaseError).code, INSUFFICIENT_PRIVILEGE);
            return true;
          },
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // The bootstrap functions
  // -------------------------------------------------------------------------

  describe('auth_lookup_user_by_email', () => {
    test('returns the user with no tenant declared — the whole point', async () => {
      const direct = await pool.query('SELECT id FROM users WHERE email = $1', [alpha.email]);
      assert.equal(direct.rows.length, 0, 'precondition: the app role cannot read users directly');

      const { rows } = await pool.query<{ id: string; studio_id: string; password_hash: string }>(
        'SELECT * FROM auth_lookup_user_by_email($1)',
        [alpha.email],
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, alpha.userId);
      assert.equal(rows[0].studio_id, alpha.studioId);
      assert.equal(rows[0].password_hash, 'not-a-real-argon2-hash');
    });

    test('matches case-insensitively, because stored emails are lowercased', async () => {
      const { rows } = await pool.query('SELECT * FROM auth_lookup_user_by_email($1)', [
        alpha.email.toUpperCase(),
      ]);
      assert.equal(rows.length, 1);
    });

    test('returns nothing for an unknown address — no error, no leak', async () => {
      const { rows } = await pool.query('SELECT * FROM auth_lookup_user_by_email($1)', [
        `nobody-${uniqueSuffix()}@example.test`,
      ]);
      assert.equal(rows.length, 0);
    });

    test('cannot be widened — it answers about one address or none', async () => {
      // No wildcard, no clause to inject: the argument is compared with =.
      const { rows } = await pool.query('SELECT * FROM auth_lookup_user_by_email($1)', ['%']);
      assert.equal(rows.length, 0);
    });
  });

  describe('auth_resolve_session', () => {
    let sessionId: string;

    before(async () => {
      sessionId = tokenHash();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.studio_id', $1, true)`, [alpha.studioId]);
        await client.query(
          `INSERT INTO sessions (id, user_id, studio_id, expires_at)
           VALUES ($1, $2, $3, now() + interval '14 days')`,
          [sessionId, alpha.userId, alpha.studioId],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    test('resolves a cookie to its user and tenant with nothing declared', async () => {
      const { rows } = await pool.query<{ user_id: string; studio_id: string; expires_at: Date }>(
        'SELECT * FROM auth_resolve_session($1)',
        [sessionId],
      );

      assert.equal(rows.length, 1);
      assert.equal(rows[0].user_id, alpha.userId);
      assert.equal(rows[0].studio_id, alpha.studioId);
      assert.ok(rows[0].expires_at > new Date(), 'expiry is returned for the guard to judge');
    });

    test('returns nothing for a session id that does not exist', async () => {
      const { rows } = await pool.query('SELECT * FROM auth_resolve_session($1)', [tokenHash()]);
      assert.equal(rows.length, 0);
    });
  });

  describe('auth_lookup_user_by_verification_token', () => {
    let hash: string;

    before(async () => {
      hash = tokenHash();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`SELECT set_config('app.studio_id', $1, true)`, [alpha.studioId]);
        await client.query(
          `UPDATE users
              SET email_verification_token_hash = $1, email_verification_sent_at = now()
            WHERE id = $2`,
          [hash, alpha.userId],
        );
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    });

    test('resolves a verification token to its user and tenant', async () => {
      const { rows } = await pool.query<{
        id: string;
        studio_id: string;
        email_verified_at: Date | null;
        email_verification_sent_at: Date | null;
      }>('SELECT * FROM auth_lookup_user_by_verification_token($1)', [hash]);

      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, alpha.userId);
      assert.equal(rows[0].studio_id, alpha.studioId);
      assert.equal(rows[0].email_verified_at, null);
      assert.ok(rows[0].email_verification_sent_at instanceof Date);
    });

    test('returns nothing for an unknown token', async () => {
      const { rows } = await pool.query(
        'SELECT * FROM auth_lookup_user_by_verification_token($1)',
        [tokenHash()],
      );
      assert.equal(rows.length, 0);
    });

    test('two users cannot hold the same token', async () => {
      await inTenant(beta.studioId, async (client) => {
        await assert.rejects(
          client.query('UPDATE users SET email_verification_token_hash = $1 WHERE id = $2', [
            hash,
            beta.userId,
          ]),
          /users_email_verification_token_hash_idx/,
        );
      });
    });
  });

  // -------------------------------------------------------------------------
  // The facts the bootstrap rests on
  // -------------------------------------------------------------------------

  describe('the load-bearing facts', () => {
    test('every tenant table has RLS enabled', async () => {
      const { rows } = await pool.query<{ relname: string }>(
        `SELECT relname FROM pg_class
          WHERE relname = ANY($1) AND relkind = 'r' AND NOT relrowsecurity`,
        [TENANT_TABLES],
      );
      assert.deepEqual(
        rows.map((r) => r.relname),
        [],
        'a table lost its ENABLE ROW LEVEL SECURITY',
      );
    });

    test('no tenant table FORCEs it — the bootstrap functions depend on this', async () => {
      // FORCE would make the owner subject to the policies too, which reads
      // like a hardening step and would silently break every login.
      const { rows } = await pool.query<{ relname: string }>(
        `SELECT relname FROM pg_class
          WHERE relname = ANY($1) AND relkind = 'r' AND relforcerowsecurity`,
        [TENANT_TABLES],
      );
      assert.deepEqual(
        rows.map((r) => r.relname),
        [],
        'FORCE ROW LEVEL SECURITY breaks the SECURITY DEFINER bootstrap — see 0002',
      );
    });

    test('the bootstrap functions are owned by the role that owns the tables', async () => {
      const { rows } = await pool.query<{ proname: string; fn_owner: string; tbl_owner: string }>(
        `SELECT p.proname,
                pg_get_userbyid(p.proowner) AS fn_owner,
                pg_get_userbyid(c.relowner) AS tbl_owner
           FROM pg_proc p, pg_class c
          WHERE p.proname = ANY($1)
            AND p.pronamespace = 'public'::regnamespace
            AND c.relname = 'users'`,
        [BOOTSTRAP_FUNCTIONS],
      );

      assert.equal(rows.length, BOOTSTRAP_FUNCTIONS.length);
      for (const row of rows) {
        assert.equal(row.fn_owner, row.tbl_owner, `${row.proname} is owned by the wrong role`);
      }
    });

    test('all three are SECURITY DEFINER with a pinned search_path', async () => {
      const { rows } = await pool.query<{
        proname: string;
        prosecdef: boolean;
        proconfig: string[] | null;
      }>(
        `SELECT proname, prosecdef, proconfig FROM pg_proc
          WHERE proname = ANY($1) AND pronamespace = 'public'::regnamespace`,
        [BOOTSTRAP_FUNCTIONS],
      );

      assert.equal(rows.length, BOOTSTRAP_FUNCTIONS.length);
      for (const row of rows) {
        assert.equal(row.prosecdef, true, `${row.proname} is not SECURITY DEFINER`);
        assert.ok(
          row.proconfig?.some((setting) => setting.startsWith('search_path=')),
          `${row.proname} has no pinned search_path`,
        );
      }
    });

    test('PUBLIC cannot execute them, but this role can', async () => {
      for (const name of BOOTSTRAP_FUNCTIONS) {
        const { rows } = await pool.query<{ public_grants: string; mine: boolean }>(
          `SELECT (SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a
                    WHERE p.oid = f.oid AND a.grantee = 0)::text AS public_grants,
                  has_function_privilege(current_user, f.oid, 'EXECUTE') AS mine
             FROM pg_proc f
            WHERE f.proname = $1 AND f.pronamespace = 'public'::regnamespace`,
          [name],
        );

        assert.equal(rows.length, 1);
        assert.equal(rows[0].public_grants, '0', `${name} is still executable by PUBLIC`);
        assert.equal(rows[0].mine, true, `${name} is not executable by the app role`);
      }
    });
  });

  // -------------------------------------------------------------------------
  // What the app role is not
  // -------------------------------------------------------------------------

  describe('the application role owns nothing', () => {
    test('cannot alter a table', async () => {
      await assert.rejects(
        pool.query('ALTER TABLE users ADD COLUMN injected text'),
        /must be owner of table users/,
      );
    });

    test('cannot drop a table', async () => {
      await assert.rejects(pool.query('DROP TABLE sessions'), /must be owner of table sessions/);
    });

    test('cannot create one — which is what makes the pinned search_path belt and braces', async () => {
      await assert.rejects(
        pool.query('CREATE TABLE shadow_users (id uuid)'),
        /permission denied for schema public/,
      );
    });

    test('cannot disable a policy it dislikes', async () => {
      await assert.rejects(
        pool.query('ALTER TABLE users DISABLE ROW LEVEL SECURITY'),
        /must be owner of table users/,
      );
    });
  });
});
