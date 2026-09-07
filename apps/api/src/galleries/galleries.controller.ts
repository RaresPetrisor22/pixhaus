import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';

import { CurrentUser } from '../auth/current-user.decorator';
import type { StudioUserPrincipal } from '../auth/principal';
import { UuidParam } from '../common/uuid-param.pipe';
import { ZodBody, ZodQuery } from '../common/zod-body.pipe';
import {
  CreateGalleryBody,
  ListGalleriesQuery,
  UpdateGalleryBody,
  type CreateGalleryInput,
  type ListGalleriesInput,
  type UpdateGalleryInput,
} from './galleries.schemas';
import { GalleriesService } from './galleries.service';

const GALLERY_ID = new UuidParam('gallery_not_found');

@Controller('galleries')
export class GalleriesController {
  constructor(private readonly galleries: GalleriesService) {}

  @Post()
  create(
    @CurrentUser() principal: StudioUserPrincipal,
    @Body(new ZodBody(CreateGalleryBody)) body: CreateGalleryInput,
  ) {
    return this.galleries.create(principal, body);
  }

  @Get()
  list(
    @CurrentUser() principal: StudioUserPrincipal,
    @Query(new ZodQuery(ListGalleriesQuery)) query: ListGalleriesInput,
  ) {
    return this.galleries.list(principal, query);
  }

  @Get(':galleryId')
  findOne(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('galleryId', GALLERY_ID) galleryId: string,
  ) {
    return this.galleries.findOne(principal, galleryId);
  }

  @Patch(':galleryId')
  update(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('galleryId', GALLERY_ID) galleryId: string,
    @Body(new ZodBody(UpdateGalleryBody)) body: UpdateGalleryInput,
  ) {
    return this.galleries.update(principal, galleryId, body);
  }

  @Delete(':galleryId')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(
    @CurrentUser() principal: StudioUserPrincipal,
    @Param('galleryId', GALLERY_ID) galleryId: string,
  ) {
    return this.galleries.remove(principal, galleryId);
  }
}
