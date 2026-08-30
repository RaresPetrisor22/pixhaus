import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { PG_POOL } from './pg-pool';

/** Only `query`. Transaction control belongs to withTenant, not to callers. */
export type TenantClient = Pick<pg.PoolClient, 'query'>;

@Injectable()
export class TenantDb {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * Runs fn inside a transaction scoped to one studio. Every tenant-owned query
   * in the API goes through here, and there is no un-scoped alternative to
   * reach for — the only other database access is AuthBootstrapRepository,
   * which can call three named functions and nothing else.
   */
  async withTenant<T>(studioId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    // An empty tenant makes current_studio_id() NULL, which does not fail — it
    // makes every query return nothing. Far better to stop here.
    if (!studioId) {
      throw new Error('withTenant requires a studio id');
    }

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
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
}
