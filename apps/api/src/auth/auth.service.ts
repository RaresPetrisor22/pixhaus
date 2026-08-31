import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import { AuthRepository } from './auth.repository';
import { hashToken } from './tokens';

@Injectable()
export class AuthService {
  private readonly verificationTtlHours: number;

  constructor(
    private readonly repository: AuthRepository,
    config: ConfigService<Env, true>,
  ) {
    this.verificationTtlHours = config.get('EMAIL_VERIFICATION_TTL_HOURS', { infer: true });
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

  private hasExpired(sentAt: Date | null): boolean {
    if (!sentAt) {
      return true;
    }
    return sentAt.getTime() + this.verificationTtlHours * 3_600_000 <= Date.now();
  }
}
