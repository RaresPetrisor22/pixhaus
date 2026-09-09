import { Body, Controller, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import type { StudioUserPrincipal } from '../auth/principal';
import { UuidParam } from '../common/uuid-param.pipe';
import { ZodBody } from '../common/zod-body.pipe';
import { CreateUploadBody, type CreateUploadInput } from './uploads.schemas';
import { UploadsService } from './uploads.service';

/**
 * Mounted under /api/galleries because the gallery is what the upload is
 * authorized against.
 */
@Controller('galleries')
export class GalleryUploadsController {
  constructor(private readonly uploads: UploadsService) {}

  @Post(':galleryId/uploads')
  create(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('galleryId', new UuidParam('gallery_not_found')) galleryId: string,
    @Body(new ZodBody(CreateUploadBody)) body: CreateUploadInput,
  ) {
    return this.uploads.createUpload(principal, galleryId, body);
  }
}

/**
 * Finalize is keyed on the asset, not the gallery: by now the asset id is the
 * subject and its gallery is implied by the row.
 */
@Controller('uploads')
export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  // 202: the bytes are verified and recorded, but the renditions the caller
  // ultimately wants are not made yet — a job is enqueued and the worker
  // answers for them at GET /api/assets/:assetId/renditions/:kind.
  @Post(':assetId/finalize')
  @HttpCode(HttpStatus.ACCEPTED)
  finalize(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('assetId', new UuidParam('asset_not_found')) assetId: string,
  ) {
    return this.uploads.finalize(principal, assetId);
  }
}
