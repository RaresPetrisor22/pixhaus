import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { GrantPrincipal } from '../auth/principal';
import { hashToken } from '../auth/tokens';
import { rightsFromMask, type RightName } from '../authz/rights';
import { ApiException } from '../common/api-exception';
import type { Env } from '../config/env';
import { ClientRepository, type GrantRecord } from './client.repository';
import { clientTokenPayload, signClientToken } from './client-token';

export type ClientSession = {
  token: string;
  expiresAt: Date;
  rights: RightName[];
};

function gone(code: 'grant_revoked' | 'grant_expired' | 'grant_not_found'): ApiException {
  const message =
    code === 'grant_expired'
      ? 'This gallery link has expired.'
      : 'This gallery link is no longer active.';

  return new ApiException(HttpStatus.GONE, code, message);
}

@Injectable()
export class ClientService {
  private readonly secret: string;
  private readonly ttlSeconds: number;

  constructor(
    private readonly grants: ClientRepository,
    config: ConfigService<Env, true>,
  ) {
    this.secret = config.get('CLIENT_TOKEN_SECRET', { infer: true });
    this.ttlSeconds = config.get('CLIENT_TOKEN_TTL_SECONDS', { infer: true });
  }

  /**
   * The magic link, and the only place the long-lived credential is used.
   * Everything after this runs on the token minted here.
   */
  async exchange(rawToken: string): Promise<ClientSession> {
    const grant = await this.grants.findByTokenHash(hashToken(rawToken));

    // 404, not 410: a 410 would confirm the token had once been real.
    if (!grant) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'grant_not_found',
        'This gallery link is not valid.',
      );
    }

    this.mustBeLive(grant);
    await this.grants.touchLastSeen(grant.studioId, grant.id);

    return this.mint(grant);
  }

  /**
   * The one route in the client plane that reads the database, and therefore
   * the point where revocation actually bites. Every other request is a
   * signature check against a token minted here or by exchange().
   */
  async refresh(principal: GrantPrincipal): Promise<ClientSession> {
    const grant = await this.grants.findById(principal.studioId, principal.grantId);

    // The gallery was deleted, and the grant cascaded with it. The caller holds
    // a valid token, so there is nothing left to conceal — 410, not 404.
    if (!grant) {
      throw gone('grant_not_found');
    }

    this.mustBeLive(grant);

    // The epoch catches a revocation that has not also set revoked_at, and any
    // future change that should invalidate outstanding tokens. Mismatched means
    // dead: the client re-opens their link and gets a token on current terms.
    if (grant.epoch !== principal.epoch) {
      throw gone('grant_revoked');
    }

    return this.mint(grant);
  }

  private mustBeLive(grant: GrantRecord): void {
    if (grant.revokedAt) {
      throw gone('grant_revoked');
    }

    if (grant.expiresAt <= new Date()) {
      throw gone('grant_expired');
    }
  }

  /** Rights and epoch come from the row just read, never from the old token. */
  private mint(grant: GrantRecord): ClientSession {
    const payload = clientTokenPayload(
      {
        grantId: grant.id,
        studioId: grant.studioId,
        galleryId: grant.galleryId,
        rightsMask: grant.rightsMask,
        epoch: grant.epoch,
      },
      this.ttlSeconds,
    );

    return {
      token: signClientToken(payload, this.secret),
      expiresAt: new Date(payload.exp * 1000),
      rights: rightsFromMask(grant.rightsMask),
    };
  }
}
