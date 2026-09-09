import { Module } from '@nestjs/common';

import { GalleriesModule } from '../galleries/galleries.module';
import { AssetsController, GalleryAssetsController } from './assets.controller';
import { AssetsRepository } from './assets.repository';
import { AssetsService } from './assets.service';

/** Reading and deleting assets. Creating them is UploadsModule. */
@Module({
  imports: [GalleriesModule],
  controllers: [GalleryAssetsController, AssetsController],
  providers: [AssetsService, AssetsRepository],
  exports: [AssetsRepository],
})
export class AssetsModule {}
