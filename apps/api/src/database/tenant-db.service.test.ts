import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type pg from 'pg';

import { TenantDb } from './tenant-db.service';

/**
 * What these tests are for: the order of BEGIN / set_config / COMMIT, and that
 * a connection is always returned to the pool. That the SQL itself scopes a
 * tenant is proved against a real database in packages/db/src/rls.test.ts.
 */
function fakePool() {
  const queries: { text: string; values?: unknown[] }[] = [];
  let releases = 0;

  const client = {
    query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      return Promise.resolve({ rows: [] });
    },
    release() {
      releases += 1;
    },
  };

  return {
    pool: { connect: () => Promise.resolve(client) } as unknown as pg.Pool,
    queries,
    texts: () => queries.map((q) => q.text),
    releases: () => releases,
  };
}

const SET_TENANT = `SELECT set_config('app.studio_id', $1, true)`;

describe('TenantDb.withTenant', () => {
  test('declares the tenant inside the transaction, before anything else runs', async () => {
    const fake = fakePool();

    const result = await new TenantDb(fake.pool).withTenant('studio-1', async (tx) => {
      await tx.query('SELECT 1');
      return 'done';
    });

    assert.equal(result, 'done');
    assert.deepEqual(fake.texts(), ['BEGIN', SET_TENANT, 'SELECT 1', 'COMMIT']);
  });

  test('binds the studio id rather than interpolating it', async () => {
    const fake = fakePool();
    await new TenantDb(fake.pool).withTenant('studio-1', async () => undefined);

    const setTenant = fake.queries[1];
    assert.deepEqual(setTenant.values, ['studio-1']);
    assert.ok(!setTenant.text.includes('studio-1'), 'the id must not reach the SQL text');
  });

  test('rolls back and rethrows the original error', async () => {
    const fake = fakePool();
    const boom = new Error('boom');

    await assert.rejects(
      new TenantDb(fake.pool).withTenant('studio-1', () => Promise.reject(boom)),
      (error: unknown) => error === boom,
    );

    assert.deepEqual(fake.texts(), ['BEGIN', SET_TENANT, 'ROLLBACK']);
  });

  test('returns the connection to the pool on both paths', async () => {
    const committed = fakePool();
    await new TenantDb(committed.pool).withTenant('s', async () => undefined);
    assert.equal(committed.releases(), 1);

    const rolledBack = fakePool();
    await assert.rejects(
      new TenantDb(rolledBack.pool).withTenant('s', () => Promise.reject(new Error('x'))),
    );
    assert.equal(rolledBack.releases(), 1);
  });

  test('refuses an empty studio id without taking a connection', async () => {
    // An empty value would leave current_studio_id() NULL, which reads as a
    // tenant that owns nothing rather than as an error.
    const fake = fakePool();

    await assert.rejects(
      new TenantDb(fake.pool).withTenant('', async () => undefined),
      /requires a studio id/,
    );
    assert.deepEqual(fake.texts(), []);
  });
});
