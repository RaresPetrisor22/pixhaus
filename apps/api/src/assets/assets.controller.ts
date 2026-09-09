import { Controller, Get, Header, HttpStatus, Param, Redirect } from '@nestjs/common';
import type { RenditionKind } from '@pixhaus/storage';

import { CurrentUser } from '../auth/current-user.decorator';
import type { StudioUserPrincipal } from '../auth/principal';
import { UuidParam } from '../common/uuid-param.pipe';
import { AssetsService } from './assets.service';
import { RenditionKindParam } from './rendition-kind.pipe';

@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /**
   * 302 to a presigned GET.
   *
   * no-store because the Location is a bearer URL with a five-minute life: a
   * cached redirect would keep sending the browser to a signature that has
   * expired, and a shared cache would hand one studio's URL to whoever asked
   * next.
   */
  @Get(':assetId/renditions/:kind')
  @Header('Cache-Control', 'no-store')
  @Redirect(undefined, HttpStatus.FOUND)
  async rendition(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('assetId', new UuidParam('asset_not_found')) assetId: string,
    @Param('kind', new RenditionKindParam()) kind: RenditionKind,
  ) {
    return { url: await this.assets.renditionUrl(principal, assetId, kind) };
  }
}
