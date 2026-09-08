import type pg from 'pg';

/** Only `query`. Transaction control belongs to withTenant, not to callers. */
export type TenantClient = Pick<pg.PoolClient, 'query'>;

/**
 * Runs `fn` inside a transaction scoped to one studio.
 */
export async function withTenant<T>(
  pool: pg.Pool,
  studioId: string,
  fn: (tx: TenantClient) => Promise<T>,
): Promise<T> {
  if (!studioId) {
    throw new Error('withTenant requires a studio id');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config(..., true) rather than SET LOCAL: SET takes no bind
    // parameters, so it would mean concatenating a value into SQL. The third
    // argument means "local to this transaction" — identical semantics, real
    // parameter.
    await client.query(`SELECT set_config('app.studio_id', $1, true)`, [studioId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Connection already gone.
    }
    throw error;
  } finally {
    client.release();
  }
}
