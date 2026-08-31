import { Inject, Injectable } from '@nestjs/common';
import type pg from 'pg';

import { PG_POOL } from '../database/pg-pool';
import { TenantDb } from '../database/tenant-db.service';

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

/** What login and resend-verification need, resolved from an email address. */
export type UserCredentials = {
  userId: string;
  studioId: string;
  passwordHash: string;
  emailVerifiedAt: Date | null;
};

type CredentialsRow = {
  id: string;
  studio_id: string;
  password_hash: string;
  email_verified_at: Date | null;
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
   * The studio and its first user, in one transaction.
   */
  createStudioWithOwner(input: NewStudioOwner): Promise<{ userId: string }> {
    return this.db.withTenant(input.studioId, async (tx) => {
      await tx.query('INSERT INTO studios (id, name, slug) VALUES ($1, $2, $3)', [
        input.studioId,
        input.studioName,
        input.slug,
      ]);

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

  async findUserByEmail(email: string): Promise<UserCredentials | null> {
    const { rows } = await this.pool.query<CredentialsRow>(
      'SELECT * FROM auth_lookup_user_by_email($1)',
      [email],
    );

    const row = rows[0];
    if (!row) {
      return null;
    }

    return {
      userId: row.id,
      studioId: row.studio_id,
      passwordHash: row.password_hash,
      emailVerifiedAt: row.email_verified_at,
    };
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

    return {
      userId: row.id,
      studioId: row.studio_id,
      emailVerifiedAt: row.email_verified_at,
      verificationSentAt: row.email_verification_sent_at,
    };
  }

  /** Issuing a new link invalidates the previous one: same column, new hash. */
  setVerificationToken(studioId: string, userId: string, tokenHash: string): Promise<void> {
    return this.db.withTenant(studioId, async (tx) => {
      await tx.query(
        `UPDATE users
            SET email_verification_token_hash = $1,
                email_verification_sent_at = now()
          WHERE id = $2`,
        [tokenHash, userId],
      );
    });
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
