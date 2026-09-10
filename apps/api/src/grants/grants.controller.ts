import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { Throttle, minutes } from '@nestjs/throttler';

import { CurrentUser } from '../auth/current-user.decorator';
import type { StudioUserPrincipal } from '../auth/principal';
import { UuidParam } from '../common/uuid-param.pipe';
import { ZodBody } from '../common/zod-body.pipe';
import { GrantsService } from './grants.service';
import { CreateGrantBody, type CreateGrantInput } from './grants.schemas';

const GALLERY_ID = new UuidParam('gallery_not_found');
const GRANT_ID = new UuidParam('grant_not_found');

/** Share links hang off the gallery, the way uploads and assets do. */
@Controller('galleries')
export class GalleryGrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Post(':galleryId/grants')
  create(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('galleryId', GALLERY_ID) galleryId: string,
    @Body(new ZodBody(CreateGrantBody)) body: CreateGrantInput,
  ) {
    return this.grants.create(principal, galleryId, body);
  }

  @Get(':galleryId/grants')
  list(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('galleryId', GALLERY_ID) galleryId: string,
  ) {
    return this.grants.list(principal, galleryId);
  }
}

@Controller('grants')
export class GrantsController {
  constructor(private readonly grants: GrantsService) {}

  @Delete(':grantId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revoke(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('grantId', GRANT_ID) grantId: string,
  ) {
    return this.grants.revoke(principal, grantId);
  }

  // Sends mail to an address the caller supplied, so it is throttled the way
  // resend-verification is.
  @Throttle({ default: { limit: 10, ttl: minutes(60) } })
  @Post(':grantId/resend')
  @HttpCode(HttpStatus.OK)
  resend(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('grantId', GRANT_ID) grantId: string,
  ) {
    return this.grants.resend(principal, grantId);
  }
}
