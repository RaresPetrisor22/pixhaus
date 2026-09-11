import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle, minutes, seconds } from '@nestjs/throttler';
import type { RenditionKind } from '@pixhaus/storage';

import type { GrantPrincipal } from '../auth/principal';
import { Public } from '../auth/public.decorator';
import { RenditionKindParam } from '../assets/rendition-kind.pipe';
import { UuidParam } from '../common/uuid-param.pipe';
import { ZodBody, ZodQuery } from '../common/zod-body.pipe';
import { ClientGalleryService } from './client-gallery.service';
import { ClientService } from './client.service';
import { ClientGuard } from './client.guard';
import {
  ClientGalleryQuery,
  ExchangeBody,
  type ClientGalleryInput,
  type ExchangeInput,
} from './client.schemas';
import { Grant } from './grant.decorator';
import { GrantThrottlerGuard } from './grant-throttler.guard';

/**
 * The magic link's exchange. The link itself — /g/:token — is a page served by
 * the SPA, which posts the token here. In the body, not the path: a proxy logs
 * paths and a Referer header leaks them.
 */
@Controller('client')
export class ClientSessionController {
  constructor(private readonly client: ClientService) {}

  // The unauthenticated door, keyed on a secret, so the tightest budget in
  // the plane.
  @Public()
  @UseGuards(GrantThrottlerGuard)
  @Throttle({ grant: { limit: 20, ttl: minutes(60) } })
  @Post('session')
  @HttpCode(HttpStatus.OK)
  exchange(@Body(new ZodBody(ExchangeBody)) body: ExchangeInput) {
    return this.client.exchange(body.token);
  }
}

/**
 * @Public() on every route below means "not a photographer session", not "no
 * credential" — ClientGuard demands a bearer token underneath it.
 */
@Public()
@UseGuards(ClientGuard, GrantThrottlerGuard)
@Controller('client')
export class ClientController {
  constructor(
    private readonly client: ClientService,
    private readonly content: ClientGalleryService,
  ) {}

  @Throttle({ grant: { limit: 30, ttl: minutes(60) } })
  @Post('token')
  @HttpCode(HttpStatus.OK)
  refresh(@Grant() principal: GrantPrincipal) {
    return this.client.refresh(principal);
  }

  // No :galleryId anywhere in this plane: the grant names exactly one gallery,
  // so there is no parameter to tamper with.
  @Throttle({ grant: { limit: 60, ttl: seconds(60) } })
  @Get('gallery')
  gallery(
    @Grant() principal: GrantPrincipal,
    @Query(new ZodQuery(ClientGalleryQuery)) query: ClientGalleryInput,
  ) {
    return this.content.gallery(principal, query);
  }

  @Throttle({ default: { limit: 300, ttl: seconds(60) }, grant: { limit: 300, ttl: seconds(60) } })
  @Get('assets/:assetId/renditions/:kind')
  @Header('Cache-Control', 'no-store')
  rendition(
    @Grant() principal: GrantPrincipal,
    @Param('assetId', new UuidParam('asset_not_found')) assetId: string,
    @Param('kind', new RenditionKindParam()) kind: RenditionKind,
  ) {
    return this.content.renditionUrl(principal, assetId, kind);
  }

  @Throttle({ grant: { limit: 60, ttl: seconds(60) } })
  @Post('assets/:assetId/download')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  download(
    @Grant() principal: GrantPrincipal,
    @Param('assetId', new UuidParam('asset_not_found')) assetId: string,
  ) {
    return this.content.downloadUrl(principal, assetId);
  }
}
