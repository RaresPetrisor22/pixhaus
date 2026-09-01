import { randomUUID } from 'node:crypto';

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import { uniqueViolation } from '../database/pg-errors';
import { MailService } from '../mail/mail.service';
import { AuthRepository, UNIQUE_EMAIL, UNIQUE_SLUG, type Profile } from './auth.repository';
import type { LoginInput, RegisterInput } from './auth.schemas';
import { hashPassword, verifyDummy, verifyPassword } from './password';
import type { StudioUserPrincipal } from './principal';
import { SessionService, type SessionContext } from './session.service';
import { slugify, withRandomSuffix } from './slug';
import { generateToken, hashToken } from './tokens';

const SLUG_ATTEMPTS = 5;

export type LoggedIn = { token: string; profile: Profile };

export type RegisteredStudio = {
  user: { id: string; email: string; emailVerified: boolean };
  studio: { id: string; name: string; slug: string };
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly verificationTtlHours: number;

  constructor(
    private readonly repository: AuthRepository,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
    config: ConfigService<Env, true>,
  ) {
    this.verificationTtlHours = config.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true });
  }

  /**
   * Creates a studio and its first owner in one transaction.
   */
  async register(input: RegisterInput): Promise<RegisteredStudio> {
    const passwordHash = await hashPassword(input.password);
    const studioId = randomUUID();
    const token = generateToken();
    const base = slugify(input.studioName);

    let slug = base;

    for (let attempt = 0; attempt < SLUG_ATTEMPTS; attempt += 1) {
      try {
        const { userId } = await this.repository.createStudioWithOwner({
          studioId,
          studioName: input.studioName,
          slug,
          email: input.email,
          passwordHash,
          verificationTokenHash: hashToken(token),
        });

        await this.sendVerification(input.email, token);

        return {
          user: { id: userId, email: input.email, emailVerified: false },
          studio: { id: studioId, name: input.studioName, slug },
        };
      } catch (error) {
        const constraint = uniqueViolation(error);

        if (constraint === UNIQUE_EMAIL) {
          throw new ApiException(
            HttpStatus.CONFLICT,
            'email_taken',
            'An account already exists for that email address.',
          );
        }

        if (constraint === UNIQUE_SLUG) {
          slug = withRandomSuffix(base);
          continue;
        }

        throw error;
      }
    }

    throw new Error(`could not find a free studio slug for "${base}" in ${SLUG_ATTEMPTS} attempts`);
  }

  /**
   * An unknown email and a wrong password give the same answer, and take about
   * the same time to give it -- hence verifyDummy on the branch with no hash to
   * check against.
   */
  async login(input: LoginInput, context: SessionContext): Promise<LoggedIn> {
    const user = await this.repository.findUserByEmail(input.email);

    if (!user) {
      await verifyDummy(input.password);
      throw invalidCredentials();
    }

    if (!(await verifyPassword(user.passwordHash, input.password))) {
      throw invalidCredentials();
    }

    const token = await this.sessions.issue(user.userId, user.studioId, context);
    const profile = await this.repository.findProfile(user.studioId, user.userId);

    if (!profile) {
      throw new Error(`session issued for user ${user.userId} but no profile was visible`);
    }

    return { token, profile };
  }

  logout(principal: StudioUserPrincipal): Promise<void> {
    return this.sessions.revoke(principal);
  }

  logoutEverywhere(principal: StudioUserPrincipal): Promise<number> {
    return this.sessions.revokeAll(principal);
  }

  async me(principal: StudioUserPrincipal): Promise<Profile> {
    const profile = await this.repository.findProfile(principal.studioId, principal.userId);

    // The session resolved, so this user existed moments ago. Deleted since.
    if (!profile) {
      throw new ApiException(HttpStatus.UNAUTHORIZED, 'unauthenticated', 'Sign in to continue.');
    }

    return profile;
  }

  /**
   * Resends a verification email to the user.
   */
  async resendVerification(email: string): Promise<void> {
    const user = await this.repository.findUserByEmail(email);

    if (!user || user.emailVerifiedAt) {
      return;
    }

    const token = generateToken();
    await this.repository.setVerificationToken(user.studioId, user.userId, hashToken(token));
    await this.sendVerification(email, token);
  }

  /**
   * The email link carries the raw token; the database holds only its hash, so
   * the lookup is by hash and there is never a comparison to get wrong.
   */
  async verifyEmail(token: string): Promise<void> {
    const candidate = await this.repository.findUserByVerificationToken(hashToken(token));

    if (!candidate) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'invalid_token',
        'That confirmation link is not valid. Request a new one.',
      );
    }

    if (candidate.emailVerifiedAt) {
      return;
    }

    if (this.hasExpired(candidate.verificationSentAt)) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'token_expired',
        'That confirmation link has expired. Request a new one.',
      );
    }

    await this.repository.markEmailVerified(candidate.studioId, candidate.userId);
  }

  private async sendVerification(email: string, token: string): Promise<void> {
    try {
      await this.mail.sendVerificationEmail(email, token, this.verificationTtlHours);
    } catch (error) {
      this.logger.error(
        `could not send verification email to ${email}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private hasExpired(sentAt: Date | null): boolean {
    if (!sentAt) {
      return true;
    }
    return sentAt.getTime() + this.verificationTtlHours * 3_600_000 <= Date.now();
  }
}

function invalidCredentials(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'invalid_credentials',
    'That email and password do not match.',
  );
}
