import type { RenditionJob } from '@pixhaus/jobs';
import { renditionKey, type ObjectStore } from '@pixhaus/storage';
import type pg from 'pg';

import { claimAsset, saveRenditions, type StoredRendition } from './assets.repository.ts';
import { deriveFromStream, RENDITION_CONTENT_TYPE } from './image.ts';

export type Deps = { pool: pg.Pool; store: ObjectStore };

/**
 * uploaded → processing → ready, with three renditions and four derived columns
 * written along the way.
 */
export async function handleRendition(deps: Deps, job: RenditionJob): Promise<void> {
  const asset = await claimAsset(deps.pool, job.studioId, job.assetId);

  if (!asset) {
    console.log(`asset ${job.assetId} is not awaiting renditions — nothing to do`);
    return;
  }

  const source = await deps.store.getStream(asset.storageKey);
  const derived = await deriveFromStream(source);

  // Objects first, rows second. The failure this ordering allows is an object
  // with no row pointing at it, which the next run overwrites at the same key;
  // the other ordering allows a row promising a rendition that is not there,
  // which a client would see as a broken image.
  const stored: StoredRendition[] = await Promise.all(
    derived.renditions.map(async (rendition) => {
      const key = renditionKey(job.studioId, asset.galleryId, asset.id, rendition.kind);
      await deps.store.put(key, rendition.body, RENDITION_CONTENT_TYPE);

      return {
        kind: rendition.kind,
        storageKey: key,
        width: rendition.width,
        height: rendition.height,
        sizeBytes: rendition.sizeBytes,
      };
    }),
  );

  await saveRenditions(deps.pool, job.studioId, asset.id, derived, stored);

  console.log(
    `asset ${asset.id} ready — ${derived.width}×${derived.height}, ` +
      `${stored.map((r) => `${r.kind} ${r.width}×${r.height}`).join(', ')}`,
  );
}
