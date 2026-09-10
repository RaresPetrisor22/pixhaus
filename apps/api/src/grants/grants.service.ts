import { HttpStatus, Injectable, Logger } from '@nestjs/common';

import type { StudioUserPrincipal } from '../auth/principal';
import { generateToken, hashToken } from '../auth/tokens';
import { authorize, type Action, type GalleryStatus } from '../authz/authorize';
import { maskFromRights } from '../authz/rights';
import { ApiException } from '../common/api-exception';
import { describeError } from '../common/describe-error';
import { GalleriesRepository } from '../galleries/galleries.repository';
import { MailService } from '../mail/mail.service';
import { GrantsRepository, type Grant } from './grants.repository';
import type { CreateGrantInput } from './grants.schemas';

/** The raw token appears here and is never retrievable again. */
export type IssuedGrant = { grant: Grant; token: string };

function notFound(): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'grant_not_found', 'No such share link.');
}

function denied(reason: string): ApiException {
  if (reason === 'email_unverified') {
    return new ApiException(
      HttpStatus.FORBIDDEN,
      'email_unverified',
      'Verify your email address before sharing a gallery.',
    );
  }

  return new ApiException(HttpStatus.FORBIDDEN, 'forbidden', 'Not allowed.');
}

@Injectable()
export class GrantsService {
  private readonly logger = new Logger(GrantsService.name);

  constructor(
    private readonly grants: GrantsRepository,
    private readonly galleries: GalleriesRepository,
    private readonly mail: MailService,
  ) {}

  private must(principal: StudioUserPrincipal, action: Action, status: GalleryStatus): void {
    const decision = authorize(principal, action, {
      kind: 'gallery',
      studioId: principal.studioId,
      status,
    });

    if (!decision.allow) {
      throw denied(decision.reason);
    }
  }

  async create(
    principal: StudioUserPrincipal,
    galleryId: string,
    input: CreateGrantInput,
  ): Promise<IssuedGrant> {
    const gallery = await this.galleries.findById(principal.studioId, galleryId);

    if (!gallery) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'gallery_not_found', 'No such gallery.');
    }

    this.must(principal, 'gallery.manage', gallery.status);

    const token = generateToken();

    const grant = await this.grants.create(principal.studioId, {
      galleryId,
      tokenHash: hashToken(token),
      audienceEmail: input.audienceEmail,
      rightsMask: maskFromRights(input.rights),
      expiresAt: input.expiresAt,
      label: input.label ?? null,
    });

    await this.send(grant, token, gallery.title);

    return { grant, token };
  }

  async list(principal: StudioUserPrincipal, galleryId: string): Promise<Grant[]> {
    const gallery = await this.galleries.findById(principal.studioId, galleryId);

    if (!gallery) {
      throw new ApiException(HttpStatus.NOT_FOUND, 'gallery_not_found', 'No such gallery.');
    }

    this.must(principal, 'gallery.view', gallery.status);

    return this.grants.listForGallery(principal.studioId, galleryId);
  }

  async revoke(principal: StudioUserPrincipal, grantId: string): Promise<void> {
    const grant = await this.grants.findById(principal.studioId, grantId);

    if (!grant) {
      throw notFound();
    }

    this.must(principal, 'gallery.manage', grant.galleryStatus);

    // Idempotent: revoking twice is still 204.
    await this.grants.revoke(principal.studioId, grantId);
  }

  /**
   * A resend cannot re-send the old link — only its hash was kept — so it
   * issues a new one, and the previous link stops working.
   */
  async resend(principal: StudioUserPrincipal, grantId: string): Promise<IssuedGrant> {
    const grant = await this.grants.findById(principal.studioId, grantId);

    if (!grant) {
      throw notFound();
    }

    this.must(principal, 'gallery.manage', grant.galleryStatus);

    if (grant.revokedAt) {
      throw new ApiException(HttpStatus.GONE, 'grant_revoked', 'This share link was revoked.');
    }

    if (grant.expiresAt <= new Date()) {
      throw new ApiException(HttpStatus.GONE, 'grant_expired', 'This share link has expired.');
    }

    const gallery = await this.galleries.findById(principal.studioId, grant.galleryId);

    if (!gallery) {
      throw notFound();
    }

    const token = generateToken();

    await this.grants.rotateToken(principal.studioId, grantId, hashToken(token));
    await this.send(grant, token, gallery.title);

    return { grant, token };
  }

  /**
   * After commit, and failure is logged rather than thrown: the grant exists
   * and resend is the recovery path. Same trade registration makes.
   */
  private async send(grant: Grant, token: string, galleryTitle: string): Promise<void> {
    try {
      await this.mail.sendGrantEmail(grant.audienceEmail, token, galleryTitle, grant.expiresAt);
    } catch (error) {
      this.logger.error(`failed to send share link: ${describeError(error)}`);
    }
  }
}
