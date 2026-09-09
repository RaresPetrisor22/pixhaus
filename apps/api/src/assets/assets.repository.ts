import { Injectable } from '@nestjs/common';
import type { RenditionKind } from '@pixhaus/storage';

import type { AssetStatus, GalleryStatus } from '../authz/authorize';
import { TenantDb } from '../database/tenant-db.service';

/**
 * One asset, the gallery that decides its rights, and the one rendition asked
 * for — which may not exist yet.
 */
export type AssetRendition = {
  assetStatus: AssetStatus;
  galleryStatus: GalleryStatus;
  originalFilename: string;
  storageKey: string | null;
};

type AssetRenditionRow = {
  asset_status: AssetStatus;
  gallery_status: GalleryStatus;
  original_filename: string;
  storage_key: string | null;
};

@Injectable()
export class AssetsRepository {
  constructor(private readonly db: TenantDb) {}

  /**
   * One round trip for the whole decision. A LEFT JOIN rather than two queries
   * so that "no such asset" and "asset exists, rendition not made yet" are
   * distinguishable — they are a 404 and a 409, and answering the second with
   * the first would tell a caller their own upload had vanished.
   */
  findRendition(
    studioId: string,
    assetId: string,
    kind: RenditionKind,
  ): Promise<AssetRendition | null> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<AssetRenditionRow>(
        `SELECT a.status            AS asset_status,
                g.status            AS gallery_status,
                a.original_filename AS original_filename,
                r.storage_key       AS storage_key
           FROM assets a
           JOIN galleries g ON g.id = a.gallery_id
      LEFT JOIN renditions r ON r.asset_id = a.id AND r.kind = $2
          WHERE a.id = $1`,
        [assetId, kind],
      );

      const row = rows[0];

      return row
        ? {
            assetStatus: row.asset_status,
            galleryStatus: row.gallery_status,
            originalFilename: row.original_filename,
            storageKey: row.storage_key,
          }
        : null;
    });
  }
}
