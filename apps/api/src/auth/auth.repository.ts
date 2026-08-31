import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { PG_POOL } from '../database/pg-pool';
import { TenantDb } from '../database/tenant-db.service';

/**
 * Constraint names from 0001_initial_schema.sql. They live here because they
 * are schema knowledge, and the service should not hardcode database
 * identifiers to work out what went wrong.
 */
export const UNIQUE_EMAIL = 'users_email_key';
export const UNIQUE_SLUG = 'studios_slug_key';

/** Everything registration needs to write, with nothing left to decide. */
export type NewStudioOwner = {
  studioId: string;
  studioName: string;
  slug: string;
  email: string;
  passwordHash: string;
  verificationTokenHash: string;
};

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

  /**
   * The studio and its first user, in one transaction. `studioId` is generated
   * by the caller rather than by the database: declaring it up front is what
   * lets `WITH CHECK (id = current_studio_id())` pass on a tenant that does not
   * exist yet.
   *
   * A unique violation propagates. Whether a duplicate email is a 409 and a
   * duplicate slug is a retry is policy, and policy is the service's job.
   */
  createStudioWithOwner(input: NewStudioOwner): Promise<{ userId: string }> {
    return this.db.withTenant(input.studioId, async (tx) => {
      await tx.query('INSERT INTO studios (id, name, slug) VALUES ($1, $2, $3)', [
        input.studioId,
        input.studioName,
        input.slug,
      ]);

      // `role` is omitted: the column defaults to 'owner'.
      // `now()` rather than a JS timestamp, so the expiry clock is the
      // database's and cannot drift with the API host's.
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO users (studio_id, email, password_hash,
                            email_verification_token_hash, email_verification_sent_at)
         VALUES ($1, $2, $3, $4, now())
         RETURNING id`,
        [input.studioId, input.email, input.passwordHash, input.verificationTokenHash],
      );

      return { userId: rows[0].id };
    });
  }

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
