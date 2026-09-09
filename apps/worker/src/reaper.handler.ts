import { withTenant } from '@pixhaus/db';
import { REAPER_PENDING_AFTER } from '@pixhaus/jobs';
import type { ObjectStore } from '@pixhaus/storage';
import type pg from 'pg';

type Stale = { id: string; studio_id: string; storage_key: string };

/**
 * Every presigned PUT creates a row that may never be finalized. Sweeping them
 * is cross-tenant, which the app role cannot do — hence the SECURITY DEFINER
 * function from 0004. It returns ids only; the writes go back through
 * withTenant, one transaction per studio.
 */
export async function handleReaper(
  pool: pg.Pool,
  store: ObjectStore,
): Promise<{ swept: number; studios: number }> {
  const { rows } = await pool.query<Stale>('SELECT * FROM assets_sweep_pending($1::interval)', [
    REAPER_PENDING_AFTER,
  ]);

  const byStudio = new Map<string, Stale[]>();
  for (const row of rows) {
    byStudio.set(row.studio_id, [...(byStudio.get(row.studio_id) ?? []), row]);
  }

  for (const [studioId, stale] of byStudio) {
    const ids = stale.map((row) => row.id);

    // Objects after the row, and still guarded on 'pending' — an upload that
    // finalized between the sweep and now must not be reaped.
    const orphaned = await withTenant(pool, studioId, async (tx) => {
      const result = await tx.query<{ id: string }>(
        `UPDATE assets SET status = 'orphaned'
          WHERE id = ANY($1::uuid[]) AND status = 'pending'
      RETURNING id`,
        [ids],
      );

      return new Set(result.rows.map((row) => row.id));
    });

    const keys = stale.filter((row) => orphaned.has(row.id)).map((row) => row.storage_key);

    if (keys.length > 0) {
      await store.remove(keys);
    }
  }

  return { swept: rows.length, studios: byStudio.size };
}
