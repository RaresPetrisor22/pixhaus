import { withTenant } from '@pixhaus/db';
import type { RenditionJob } from '@pixhaus/jobs';
import type pg from 'pg';

/**
 * The trivial job. It does no image work on purpose.
 */
export async function handleRendition(pool: pg.Pool, job: RenditionJob): Promise<void> {
  console.log(`I got asset ${job.assetId}`);

  await withTenant(pool, job.studioId, async (tx) => {
    // Guarded on the status we expect. A job that fires twice — a retry after a
    // timeout, say — updates zero rows the second time instead of dragging a
    // finished asset backwards.
    const claimed = await tx.query(
      `UPDATE assets SET status = 'processing' WHERE id = $1 AND status = 'uploaded'`,
      [job.assetId],
    );

    if (claimed.rowCount === 0) {
      console.log(`  asset ${job.assetId} was not in 'uploaded' — nothing to do`);
      return;
    }

    await tx.query(`UPDATE assets SET status = 'ready' WHERE id = $1`, [job.assetId]);
  });

  console.log(`  asset ${job.assetId} marked processed`);
}
