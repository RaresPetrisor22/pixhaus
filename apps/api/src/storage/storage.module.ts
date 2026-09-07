import { Global, Module } from '@nestjs/common';

import { StorageService } from './storage.service';

/**
 * Global because uploads, the health check and downloads all need it.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
