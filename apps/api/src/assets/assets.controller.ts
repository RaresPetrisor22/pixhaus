import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Query,
  Redirect,
} from '@nestjs/common';
import type { RenditionKind } from '@pixhaus/storage';

import { CurrentUser } from '../auth/current-user.decorator';
import type { StudioUserPrincipal } from '../auth/principal';
import { UuidParam } from '../common/uuid-param.pipe';
import { ZodQuery } from '../common/zod-body.pipe';
import { ListAssetsQuery, type ListAssetsInput } from './assets.schemas';
import { AssetsService } from './assets.service';
import { RenditionKindParam } from './rendition-kind.pipe';

/** Listing hangs off the gallery, the way uploads do. */
@Controller('galleries')
export class GalleryAssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get(':galleryId/assets')
  list(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('galleryId', new UuidParam('gallery_not_found')) galleryId: string,
    @Query(new ZodQuery(ListAssetsQuery)) query: ListAssetsInput,
  ) {
    return this.assets.list(principal, galleryId, query);
  }
}

@Controller('assets')
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  /** no-store: the Location is a bearer URL that expires in five minutes. */
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

  @Delete(':assetId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('assetId', new UuidParam('asset_not_found')) assetId: string,
  ) {
    return this.assets.remove(principal, assetId);
  }
}
