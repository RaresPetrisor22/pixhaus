import { Module } from '@nestjs/common';

import { GalleriesModule } from '../galleries/galleries.module';
import { MailModule } from '../mail/mail.module';
import { GalleryGrantsController, GrantsController } from './grants.controller';
import { GrantsRepository } from './grants.repository';
import { GrantsService } from './grants.service';

@Module({
  imports: [GalleriesModule, MailModule],
  controllers: [GalleryGrantsController, GrantsController],
  providers: [GrantsService, GrantsRepository],
  exports: [GrantsRepository],
})
export class GrantsModule {}
