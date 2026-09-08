import { Injectable } from '@nestjs/common';

import type { AssetStatus } from '../authz/authorize';
import { TenantDb } from '../database/tenant-db.service';

export type NewAsset = {
  id: string;
  galleryId: string;
  studioId: string;
  storageKey: string;
  originalFilename: string;
};

export type Asset = {
  id: string;
  galleryId: string;
  status: AssetStatus;
  storageKey: string;
  originalFilename: string;
  contentType: string | null;
  sizeBytes: number | null;
  position: number;
  createdAt: Date;
};

type AssetRow = {
  id: string;
  gallery_id: string;
  status: AssetStatus;
  storage_key: string;
  original_filename: string;
  content_type: string | null;
  size_bytes: string | null;
  position: number;
  created_at: Date;
};

const COLUMNS =
  'id, gallery_id, status, storage_key, original_filename, content_type, size_bytes, position, created_at';

function toAsset(row: AssetRow): Asset {
  return {
    id: row.id,
    galleryId: row.gallery_id,
    status: row.status,
    storageKey: row.storage_key,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    // bigint arrives as a string from pg — it can exceed Number.MAX_SAFE_INTEGER
    // in general, though not for a file size.
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    position: row.position,
    createdAt: row.created_at,
  };
}

@Injectable()
export class UploadsRepository {
  constructor(private readonly db: TenantDb) {}

  create(asset: NewAsset): Promise<Asset> {
    return this.db.withTenant(asset.studioId, async (tx) => {
      const { rows } = await tx.query<AssetRow>(
        `INSERT INTO assets (id, gallery_id, studio_id, storage_key, original_filename, position)
         VALUES ($1, $2, $3, $4, $5,
                 (SELECT coalesce(max(position), -1) + 1 FROM assets WHERE gallery_id = $2))
         RETURNING ${COLUMNS}`,
        [asset.id, asset.galleryId, asset.studioId, asset.storageKey, asset.originalFilename],
      );

      return toAsset(rows[0]);
    });
  }

  findById(studioId: string, assetId: string): Promise<Asset | null> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<AssetRow>(`SELECT ${COLUMNS} FROM assets WHERE id = $1`, [
        assetId,
      ]);

      return rows[0] ? toAsset(rows[0]) : null;
    });
  }
}
