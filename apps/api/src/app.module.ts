import { join } from 'node:path';

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule, seconds } from '@nestjs/throttler';

import { AuthModule } from './auth/auth.module';
import { validateEnv } from './config/env';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { MailModule } from './mail/mail.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,

      // Runs the zod schema over process.env at boot. Nest treats a throw here
      // as fatal, which is what we want: fail loudly at startup, not on the
      // first request that needed the missing variable.
      validate: validateEnv,

      // In development the variables live in the repo-root .env. In a container
      // they come from the environment and this file simply is not there, which
      // is fine — @nestjs/config skips a missing file.
      envFilePath: [join(__dirname, '..', '..', '..', '.env')],
    }),
    // A blanket per-IP ceiling. Individual routes tighten it with @Throttle.
    // Storage is in-memory, so limits are per API process -- correct enough for
    // a single self-hosted instance, and a Redis store is a one-line swap.
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'default', ttl: seconds(60), limit: 120 }],
      errorMessage: 'Too many attempts. Try again in a little while.',
    }),
    DatabaseModule,
    HealthModule,
    MailModule,
    AuthModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
