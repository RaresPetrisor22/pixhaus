import { Module } from '@nestjs/common';

import { GalleriesController } from './galleries.controller';
import { GalleriesRepository } from './galleries.repository';
import { GalleriesService } from './galleries.service';

@Module({
  controllers: [GalleriesController],
  providers: [GalleriesService, GalleriesRepository],
  exports: [GalleriesRepository],
})
export class GalleriesModule {}
