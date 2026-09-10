import { Injectable } from '@nestjs/common';

import type { GalleryStatus } from '../authz/authorize';
import { rightsFromMask, type RightName } from '../authz/rights';
import { TenantDb } from '../database/tenant-db.service';

/** What the photographer sees. `token_hash` is never in it. */
export type Grant = {
  id: string;
  galleryId: string;
  audienceEmail: string;
  label: string | null;
  rights: RightName[];
  expiresAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
};

type GrantRow = {
  id: string;
  gallery_id: string;
  audience_email: string;
  label: string | null;
  rights_mask: number;
  expires_at: Date;
  last_seen_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
};

export type NewGrant = {
  galleryId: string;
  tokenHash: string;
  audienceEmail: string;
  rightsMask: number;
  expiresAt: Date;
  label: string | null;
};

/** A grant plus the gallery status authorize() decides on. */
export type GrantWithGallery = Grant & { galleryStatus: GalleryStatus };

const COLUMNS =
  'id, gallery_id, audience_email, label, rights_mask, expires_at, last_seen_at, revoked_at, created_at';

function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    galleryId: row.gallery_id,
    audienceEmail: row.audience_email,
    label: row.label,
    rights: rightsFromMask(row.rights_mask),
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

@Injectable()
export class GrantsRepository {
  constructor(private readonly db: TenantDb) {}

  create(studioId: string, grant: NewGrant): Promise<Grant> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<GrantRow>(
        `INSERT INTO grants (studio_id, gallery_id, token_hash, audience_email,
                             rights_mask, expires_at, label)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING ${COLUMNS}`,
        [
          studioId,
          grant.galleryId,
          grant.tokenHash,
          grant.audienceEmail,
          grant.rightsMask,
          grant.expiresAt,
          grant.label,
        ],
      );

      await tx.query(`UPDATE galleries SET status = 'active' WHERE id = $1 AND status = 'draft'`, [
        grant.galleryId,
      ]);

      return toGrant(rows[0]);
    });
  }

  listForGallery(studioId: string, galleryId: string): Promise<Grant[]> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<GrantRow>(
        `SELECT ${COLUMNS} FROM grants WHERE gallery_id = $1 ORDER BY created_at DESC, id DESC`,
        [galleryId],
      );

      return rows.map(toGrant);
    });
  }

  findById(studioId: string, grantId: string): Promise<GrantWithGallery | null> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<GrantRow & { gallery_status: GalleryStatus }>(
        `SELECT g.id, g.gallery_id, g.audience_email, g.label, g.rights_mask,
                g.expires_at, g.last_seen_at, g.revoked_at, g.created_at,
                gal.status AS gallery_status
           FROM grants g
           JOIN galleries gal ON gal.id = g.gallery_id
          WHERE g.id = $1`,
        [grantId],
      );

      const row = rows[0];

      return row ? { ...toGrant(row), galleryStatus: row.gallery_status } : null;
    });
  }

  /**
   * Both halves of revocation. revoked_at kills the magic link; the epoch kills
   * tokens already in a browser. COALESCE keeps the first revocation's time if
   * this runs twice.
   */
  revoke(studioId: string, grantId: string): Promise<void> {
    return this.db.withTenant(studioId, async (tx) => {
      await tx.query(
        `UPDATE grants
            SET revoked_at = COALESCE(revoked_at, now()),
                revocation_epoch = revocation_epoch + 1
          WHERE id = $1`,
        [grantId],
      );
    });
  }

  /** Only the hash is stored, so a resend cannot re-send — it replaces. */
  rotateToken(studioId: string, grantId: string, tokenHash: string): Promise<void> {
    return this.db.withTenant(studioId, async (tx) => {
      await tx.query('UPDATE grants SET token_hash = $2 WHERE id = $1', [grantId, tokenHash]);
    });
  }
}
