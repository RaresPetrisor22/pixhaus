import { Injectable } from '@nestjs/common';

import type { GalleryStatus } from '../authz/authorize';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { TenantDb } from '../database/tenant-db.service';

export type Gallery = {
  id: string;
  title: string;
  status: GalleryStatus;
  coverAssetId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

type GalleryRow = {
  id: string;
  title: string;
  status: GalleryStatus;
  cover_asset_id: string | null;
  created_at: Date;
  updated_at: Date;
};

export type GalleryPage = { galleries: Gallery[]; nextCursor: string | null };

const COLUMNS = 'id, title, status, cover_asset_id, created_at, updated_at';

function toGallery(row: GalleryRow): Gallery {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    coverAssetId: row.cover_asset_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class GalleriesRepository {
  constructor(private readonly db: TenantDb) {}

  create(studioId: string, title: string): Promise<Gallery> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<GalleryRow>(
        `INSERT INTO galleries (studio_id, title) VALUES ($1, $2) RETURNING ${COLUMNS}`,
        [studioId, title],
      );

      return toGallery(rows[0]);
    });
  }

  list(studioId: string, limit: number, rawCursor?: string): Promise<GalleryPage> {
    const cursor = decodeCursor(rawCursor);

    return this.db.withTenant(studioId, async (tx) => {
      // Fetch one more than asked for: if it comes back, there is a next page,
      // and we know it without a second COUNT query over the whole table.
      const { rows } = cursor
        ? await tx.query<GalleryRow>(
            `SELECT ${COLUMNS} FROM galleries
              WHERE (created_at, id) < ($1::timestamptz, $2::uuid)
              ORDER BY created_at DESC, id DESC
              LIMIT $3`,
            [cursor.sort, cursor.id, limit + 1],
          )
        : await tx.query<GalleryRow>(
            `SELECT ${COLUMNS} FROM galleries
              ORDER BY created_at DESC, id DESC
              LIMIT $1`,
            [limit + 1],
          );

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const last = page.at(-1);

      return {
        galleries: page.map(toGallery),
        nextCursor:
          hasMore && last
            ? encodeCursor({ sort: last.created_at.toISOString(), id: last.id })
            : null,
      };
    });
  }

  findById(studioId: string, galleryId: string): Promise<Gallery | null> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<GalleryRow>(
        `SELECT ${COLUMNS} FROM galleries WHERE id = $1`,
        [galleryId],
      );

      return rows[0] ? toGallery(rows[0]) : null;
    });
  }

  update(
    studioId: string,
    galleryId: string,
    changes: { title?: string; status?: GalleryStatus; coverAssetId?: string | null },
  ): Promise<Gallery | null> {
    return this.db.withTenant(studioId, async (tx) => {
      // The cover needs a flag of its own: null is a value here (clear the
      // cover), so COALESCE cannot tell it from "not provided".
      const { rows } = await tx.query<GalleryRow>(
        `UPDATE galleries
            SET title = COALESCE($2, title),
                status = COALESCE($3, status),
                cover_asset_id = CASE WHEN $4 THEN $5::uuid ELSE cover_asset_id END
          WHERE id = $1
      RETURNING ${COLUMNS}`,
        [
          galleryId,
          changes.title ?? null,
          changes.status ?? null,
          'coverAssetId' in changes,
          changes.coverAssetId ?? null,
        ],
      );

      return rows[0] ? toGallery(rows[0]) : null;
    });
  }

  /** Guards the cover: the FK proves the studio, this proves the gallery. */
  hasReadyAsset(studioId: string, galleryId: string, assetId: string): Promise<boolean> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT 1 FROM assets WHERE id = $1 AND gallery_id = $2 AND status = 'ready'`,
        [assetId, galleryId],
      );

      return rows.length > 0;
    });
  }

  delete(studioId: string, galleryId: string): Promise<boolean> {
    return this.db.withTenant(studioId, async (tx) => {
      const result = await tx.query('DELETE FROM galleries WHERE id = $1', [galleryId]);

      return (result.rowCount ?? 0) > 0;
    });
  }
}
