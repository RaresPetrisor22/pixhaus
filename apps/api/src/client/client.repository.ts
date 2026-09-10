import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { PG_POOL } from '../database/pg-pool';
import { TenantDb } from '../database/tenant-db.service';

/** A grant as the client plane sees it: rights as the mask, no audience, no label. */
export type GrantRecord = {
  id: string;
  studioId: string;
  galleryId: string;
  rightsMask: number;
  epoch: number;
  expiresAt: Date;
  revokedAt: Date | null;
};

type GrantRow = {
  id: string;
  studio_id: string;
  gallery_id: string;
  rights_mask: number;
  revocation_epoch: number;
  expires_at: Date;
  revoked_at: Date | null;
};

function toRecord(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    studioId: row.studio_id,
    galleryId: row.gallery_id,
    rightsMask: row.rights_mask,
    epoch: row.revocation_epoch,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Two kinds of read, the same split as AuthRepository:
 *
 *   - the magic link goes through the pool with no tenant declared, because the
 *     tenant is what it returns. It can call one SECURITY DEFINER function.
 *   - everything else goes through TenantDb, where RLS applies normally.
 */
@Injectable()
export class ClientRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly db: TenantDb,
  ) {}

  async findByTokenHash(tokenHash: string): Promise<GrantRecord | null> {
    const { rows } = await this.pool.query<GrantRow>('SELECT * FROM grants_lookup_by_token($1)', [
      tokenHash,
    ]);

    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The refresh read. The token carries studio_id, so no bootstrap needed. */
  findById(studioId: string, grantId: string): Promise<GrantRecord | null> {
    return this.db.withTenant(studioId, async (tx) => {
      const { rows } = await tx.query<GrantRow>(
        `SELECT id, studio_id, gallery_id, rights_mask, revocation_epoch, expires_at, revoked_at
           FROM grants WHERE id = $1`,
        [grantId],
      );

      return rows[0] ? toRecord(rows[0]) : null;
    });
  }

  /** Unthrottled, unlike the session touch: a mint happens once per token TTL. */
  touchLastSeen(studioId: string, grantId: string): Promise<void> {
    return this.db.withTenant(studioId, async (tx) => {
      await tx.query('UPDATE grants SET last_seen_at = now() WHERE id = $1', [grantId]);
    });
  }
}
