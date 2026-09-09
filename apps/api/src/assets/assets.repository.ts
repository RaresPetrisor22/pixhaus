import { Injectable } from '@nestjs/common';
import type { RenditionKind } from '@pixhaus/storage';

import type { AssetStatus, GalleryStatus } from '../authz/authorize';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { TenantDb } from '../database/tenant-db.service';

export type Asset = {
  id: string;
  status: AssetStatus;
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  position: number;
  createdAt: Date;
};

type AssetRow = {
  id: string;
  status: AssetStatus;
  original_filename: string;
  content_type: string | null;
  size_bytes: string | null;
  width: number | null;
  height: number | null;
  blurhash: string | null;
  position: number;
  created_at: Date;
};

export type AssetPage = { assets: Asset[]; nextCursor: string | null };

/** What a delete needs: the gallery to authorize against, and the keys to sweep. */
export type AssetObjects = {
  galleryStatus: GalleryStatus;
  storageKey: string;
  renditionKeys: string[];
};

const LIST_COLUMNS =
  'id, status, original_filename, content_type, size_bytes, width, height, blurhash, position, created_at';

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    status: row.status,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    width: row.width,
    height: row.height,
    blurhash: row.blurhash,
    position: row.position,
    createdAt: row.created_at,
  };
}

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

  /** Keyset on (position, id) — the order assets_gallery_position_idx stores. */
  list(studioId: string, galleryId: string, limit: number, rawCursor?: string): Promise<AssetPage> {
    const cursor = decodeCursor(rawCursor);

    return this.db.withTenant(studioId, async (tx) => {
      // One more than asked for: if it comes back there is a next page.
      const { rows } = cursor
        ? await tx.query<AssetRow>(
            `SELECT ${LIST_COLUMNS} FROM assets
              WHERE gallery_id = $1 AND (position, id) > ($2::integer, $3::uuid)
              ORDER BY position, id
              LIMIT $4`,
            [galleryId, cursor.sort, cursor.id, limit + 1],
          )
        : await tx.query<AssetRow>(
            `SELECT ${LIST_COLUMNS} FROM assets
              WHERE gallery_id = $1
              ORDER BY position, id
              LIMIT $2`,
            [galleryId, limit + 1],
          );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        assets: page.map(toAsset),
        nextCursor:
          hasMore && last ? encodeCursor({ sort: String(last.position), id: last.id }) : null,
      };
    });
  }

  /** The keys to delete, read before the row goes. */
  findObjects(studioId: string, assetId: string): Promise<AssetObjects | null> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<{
        gallery_status: GalleryStatus;
        storage_key: string;
        rendition_keys: string[] | null;
      }>(
        `SELECT g.status AS gallery_status,
                a.storage_key,
                array_remove(array_agg(r.storage_key), NULL) AS rendition_keys
           FROM assets a
           JOIN galleries g ON g.id = a.gallery_id
      LEFT JOIN renditions r ON r.asset_id = a.id
          WHERE a.id = $1
       GROUP BY g.status, a.storage_key`,
        [assetId],
      );

      const row = rows[0];

      return row
        ? {
            galleryStatus: row.gallery_status,
            storageKey: row.storage_key,
            renditionKeys: row.rendition_keys ?? [],
          }
        : null;
    });
  }

  /** Renditions go with it, by the composite FK's ON DELETE CASCADE. */
  delete(studioId: string, assetId: string): Promise<boolean> {
    return this.db.withTenant(studioId, async (tx) => {
      const result = await tx.query('DELETE FROM assets WHERE id = $1', [assetId]);

      return (result.rowCount ?? 0) > 0;
    });
  }
}
