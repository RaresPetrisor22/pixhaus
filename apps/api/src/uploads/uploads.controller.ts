import { Body, Controller, Param, Post } from '@nestjs/common';

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
