import { Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, minutes } from '@nestjs/throttler';

import type { GrantPrincipal } from '../auth/principal';
import { Public } from '../auth/public.decorator';
import { ClientService } from './client.service';
import { ClientGuard } from './client.guard';
import { Grant } from './grant.decorator';
import { GrantThrottlerGuard } from './grant-throttler.guard';

/**
 * At the root, not under /api, because this URL is typed and clicked by a
 * human: nothing in an email prepends a prefix. main.ts excludes it.
 */
@Controller('g')
export class MagicLinkController {
  constructor(private readonly client: ClientService) {}

  // The unauthenticated door, keyed on a secret in a URL, so the tightest
  // budget in the plane.
  @Public()
  @UseGuards(GrantThrottlerGuard)
  @Throttle({ grant: { limit: 20, ttl: minutes(60) } })
  @Get(':token')
  exchange(@Param('token') token: string) {
    return this.client.exchange(token);
  }
}

@Controller('client')
export class ClientController {
  constructor(private readonly client: ClientService) {}

  /**
   * @Public() means "not a photographer session", not "no credential" —
   * ClientGuard demands a bearer token below it.
   */
  @Public()
  @UseGuards(ClientGuard, GrantThrottlerGuard)
  @Throttle({ grant: { limit: 30, ttl: minutes(60) } })
  @Post('token')
  @HttpCode(HttpStatus.OK)
  refresh(@Grant() principal: GrantPrincipal) {
    return this.client.refresh(principal);
  }
}
