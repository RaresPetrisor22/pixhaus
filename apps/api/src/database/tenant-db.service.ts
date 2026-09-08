import { withTenant, type TenantClient } from '@pixhaus/db';
import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { PG_POOL } from './pg-pool';

export type { TenantClient };

/**
 * Nest's handle on the tenant wall.
 *
 * The wall itself lives in @pixhaus/db so the worker uses the same one. This
 * class only supplies the pool.
 */
@Injectable()
export class TenantDb {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  withTenant<T>(studioId: string, fn: (tx: TenantClient) => Promise<T>): Promise<T> {
    return withTenant(this.pool, studioId, fn);
  }
}
