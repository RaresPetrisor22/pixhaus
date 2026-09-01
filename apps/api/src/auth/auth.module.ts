import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { MailModule } from '../mail/mail.module';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';

@Module({
  imports: [MailModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    AuthRepository,
    SessionService,
    // APP_GUARD applies this to every route in the application, not just this
    // module's. Declaring it here is what lets it inject SessionService.
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AuthModule {}
