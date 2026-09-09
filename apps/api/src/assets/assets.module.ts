import { Module } from '@nestjs/common';

import { AssetsController } from './assets.controller';
import { AssetsRepository } from './assets.repository';
import { AssetsService } from './assets.service';

/**
 * Reading assets, as opposed to creating them — that is UploadsModule.
 * StorageModule is @Global, so it is not imported.
 */
@Module({
  controllers: [AssetsController],
  providers: [AssetsService, AssetsRepository],
  exports: [AssetsRepository],
})
export class AssetsModule {}
