import { withTenant } from '@pixhaus/db';
import type { RenditionKind } from '@pixhaus/storage';
import type pg from 'pg';

import type { DerivedAsset } from './image.ts';

/** What the handler needs to find the bytes and name the derivatives. */
export type ClaimedAsset = {
  id: string;
  galleryId: string;
  storageKey: string;
};

export type StoredRendition = {
  kind: RenditionKind;
  storageKey: string;
  width: number;
  height: number;
  sizeBytes: number;
};

/**
 * Take the asset, or find someone already has.
 *
 * The status guard is the concurrency control: `uploaded` is the normal entry,
 * `processing` is a job that died mid-flight and is being retried, `failed` is
 * a manual requeue. A `ready` asset is already done and a `pending` or
 * `orphaned` one has no verified bytes behind it — both return null and the job
 * ends quietly.
 */
export function claimAsset(
  pool: pg.Pool,
  studioId: string,
  assetId: string,
): Promise<ClaimedAsset | null> {
  return withTenant(pool, studioId, async (tx) => {
    const { rows } = await tx.query<{ id: string; gallery_id: string; storage_key: string }>(
      `UPDATE assets
          SET status = 'processing'
        WHERE id = $1 AND status IN ('uploaded', 'processing', 'failed')
    RETURNING id, gallery_id, storage_key`,
      [assetId],
    );

    return rows[0]
      ? { id: rows[0].id, galleryId: rows[0].gallery_id, storageKey: rows[0].storage_key }
      : null;
  });
}

/**
 * The renditions and the asset's own derived columns, in one upsert transaction.
 */
export function saveRenditions(
  pool: pg.Pool,
  studioId: string,
  assetId: string,
  derived: DerivedAsset,
  stored: StoredRendition[],
): Promise<void> {
  return withTenant(pool, studioId, async (tx) => {
    for (const rendition of stored) {
      await tx.query(
        `INSERT INTO renditions (asset_id, studio_id, kind, storage_key, format,
                                 width, height, size_bytes)
              VALUES ($1, $2, $3, $4, 'webp', $5, $6, $7)
         ON CONFLICT (asset_id, kind) DO UPDATE
                 SET storage_key = EXCLUDED.storage_key,
                     format      = EXCLUDED.format,
                     width       = EXCLUDED.width,
                     height      = EXCLUDED.height,
                     size_bytes  = EXCLUDED.size_bytes,
                     created_at  = now()`,
        [
          assetId,
          studioId,
          rendition.kind,
          rendition.storageKey,
          rendition.width,
          rendition.height,
          rendition.sizeBytes,
        ],
      );
    }

    // Guarded on 'processing' so this cannot resurrect an asset that was
    // deleted and re-created, or one a reaper moved on while we worked.
    await tx.query(
      `UPDATE assets
          SET content_hash = $2, width = $3, height = $4, blurhash = $5, status = 'ready'
        WHERE id = $1 AND status = 'processing'`,
      [assetId, derived.contentHash, derived.width, derived.height, derived.blurhash],
    );
  });
}

/**
 * Retries exhausted. The row stays — with its original still in the bucket — so
 * the failure is visible and the job can be requeued by hand once whatever
 * broke is fixed.
 */
export function markAssetFailed(pool: pg.Pool, studioId: string, assetId: string): Promise<void> {
  return withTenant(pool, studioId, async (tx) => {
    await tx.query(`UPDATE assets SET status = 'failed' WHERE id = $1 AND status = 'processing'`, [
      assetId,
    ]);
  });
}
