import { withTenant } from '@pixhaus/db';
import { REAPER_PENDING_AFTER } from '@pixhaus/jobs';
import type { ObjectStore } from '@pixhaus/storage';
import type pg from 'pg';

type Stale = { id: string; studio_id: string; storage_key: string; status: string };

/**
 * Every presigned PUT creates a row that may never be finalized. Sweeping them
 * is cross-tenant, which the app role cannot do — hence the SECURITY DEFINER
 * function from 0004. It returns ids only; the writes go back through
 * withTenant, one transaction per studio.
 *
 * Three steps per studio, in this order because each guards the next: flip the
 * status, delete the objects, record that the delete happened. A crash at any
 * point leaves the row unstamped, and the next sweep picks it up again.
 */
export async function handleReaper(
  pool: pg.Pool,
  store: ObjectStore,
): Promise<{ orphaned: number; deleted: number; studios: number }> {
  const { rows } = await pool.query<Stale>('SELECT * FROM assets_sweep_pending($1::interval)', [
    REAPER_PENDING_AFTER,
  ]);

  const byStudio = new Map<string, Stale[]>();
  for (const row of rows) {
    byStudio.set(row.studio_id, [...(byStudio.get(row.studio_id) ?? []), row]);
  }

  let orphaned = 0;
  let deleted = 0;

  for (const [studioId, stale] of byStudio) {
    // Guarded on 'pending' — an upload that finalized since the sweep read it
    // must not be reaped. Rows already orphaned are retries owed a delete.
    const pending = stale.filter((row) => row.status === 'pending');

    const flipped = await withTenant(pool, studioId, async (tx) => {
      if (pending.length === 0) {
        return new Set<string>();
      }

      const result = await tx.query<{ id: string }>(
        `UPDATE assets SET status = 'orphaned'
          WHERE id = ANY($1::uuid[]) AND status = 'pending'
      RETURNING id`,
        [pending.map((row) => row.id)],
      );

      return new Set(result.rows.map((row) => row.id));
    });

    orphaned += flipped.size;

    const owed = stale.filter((row) => row.status === 'orphaned' || flipped.has(row.id));

    if (owed.length === 0) {
      continue;
    }

    // Throws unless every key is gone, which leaves the rows unstamped for the
    // next sweep rather than recording a delete that did not happen.
    await store.remove(owed.map((row) => row.storage_key));

    await withTenant(pool, studioId, async (tx) => {
      await tx.query(`UPDATE assets SET objects_deleted_at = now() WHERE id = ANY($1::uuid[])`, [
        owed.map((row) => row.id),
      ]);
    });

    deleted += owed.length;
  }

  return { orphaned, deleted, studios: byStudio.size };
}
