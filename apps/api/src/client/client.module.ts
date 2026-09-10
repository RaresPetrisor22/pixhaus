import { Module } from '@nestjs/common';

import { AssetsModule } from '../assets/assets.module';
import { GalleriesModule } from '../galleries/galleries.module';
import { ClientGalleryService } from './client-gallery.service';
import { ClientController, MagicLinkController } from './client.controller';
import { ClientGuard } from './client.guard';
import { ClientRepository } from './client.repository';
import { ClientService } from './client.service';

@Module({
  imports: [AssetsModule, GalleriesModule],
  controllers: [MagicLinkController, ClientController],
  providers: [ClientService, ClientGalleryService, ClientRepository, ClientGuard],
  exports: [ClientGuard],
})
export class ClientModule {}
