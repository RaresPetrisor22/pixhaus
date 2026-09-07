import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { GalleriesModule } from './galleries/galleries.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';
import { StorageModule } from './storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,

      // Runs the zod schema over process.env at boot.
      validate: validateEnv,

      // In development the variables live in the repo-root .env. In a container
      // they come from the environment and this file simply is not there, which
      // is fine — @nestjs/config skips a missing file.
      envFilePath: [join(__dirname, '..', '..', '..', '.env')],
    }),

    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: seconds(60), limit: 120 }],
      errorMessage: 'Too many attempts. Try again in a little while.',
    }),
    DatabaseModule,
    HealthModule,
    MailModule,
    StorageModule,
    AuthModule,
    GalleriesModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
