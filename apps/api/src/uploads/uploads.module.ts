import { Module } from '@nestjs/common';

import { GalleriesModule } from '../galleries/galleries.module';
import { GalleryUploadsController } from './uploads.controller';
import { UploadsRepository } from './uploads.repository';
import { UploadsService } from './uploads.service';

@Module({
  // For GalleriesRepository — the gallery has to be loaded and authorized
  // before a URL is minted. StorageModule is @Global, so it is not imported.
  imports: [GalleriesModule],
  controllers: [GalleryUploadsController],
  providers: [UploadsService, UploadsRepository],
  exports: [UploadsRepository],
})
export class UploadsModule {}
