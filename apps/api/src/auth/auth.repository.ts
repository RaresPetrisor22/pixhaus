import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { PG_POOL } from '../database/pg-pool';
import { TenantDb } from '../database/tenant-db.service';

/** A user resolved from a verification token, before any tenant was known. */
export type VerificationCandidate = {
  userId: string;
  studioId: string;
  emailVerifiedAt: Date | null;
  verificationSentAt: Date | null;
};

type VerificationRow = {
  id: string;
  studio_id: string;
  email_verified_at: Date | null;
  email_verification_sent_at: Date | null;
};

/**
 * All the SQL in the photographer auth plane.
 *
 * Two kinds of method live here
 *
 *   - bootstrap reads go through the pool directly, with no tenant declared,
 *     because the tenant is what they return. They can only call the three
 *     SECURITY DEFINER functions from migration 0002.
 *   - everything else goes through TenantDb, where RLS applies normally.
 */
@Injectable()
export class AuthRepository {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    private readonly db: TenantDb,
  ) {}

  async findUserByVerificationToken(tokenHash: string): Promise<VerificationCandidate | null> {
    const { rows } = await this.pool.query<VerificationRow>(
      'SELECT * FROM auth_lookup_user_by_verification_token($1)',
      [tokenHash],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    // snake_case stops here. The service speaks the application's vocabulary.
    return {
      userId: row.id,
      studioId: row.studio_id,
      emailVerifiedAt: row.email_verified_at,
      verificationSentAt: row.email_verification_sent_at,
    };
  }

  markEmailVerified(studioId: string, userId: string): Promise<void> {
    return this.db.withTenant(studioId, async (tx) => {
      await tx.query(
        `UPDATE users
            SET email_verified_at = now(),
                email_verification_token_hash = NULL,
                email_verification_sent_at = NULL
          WHERE id = $1`,
        [userId],
      );
    });
  }
}
