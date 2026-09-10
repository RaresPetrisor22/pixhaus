import { Module } from '@nestjs/common';

import { ClientController, MagicLinkController } from './client.controller';
import { ClientGuard } from './client.guard';
import { ClientRepository } from './client.repository';
import { ClientService } from './client.service';

@Module({
  controllers: [MagicLinkController, ClientController],
  providers: [ClientService, ClientRepository, ClientGuard],
  exports: [ClientGuard],
})
export class ClientModule {}
