import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import type { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // JSON lives under /api. The probes stay at the root because whatever polls
  // them will not prepend a prefix. /g/:token joins this list in M3.
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });

  // Last thing to touch a failed request, so every error leaves in one shape.
  app.useGlobalFilters(new ApiExceptionFilter());

  // Without this, onApplicationShutdown never fires and SIGTERM kills the
  // process with the Postgres pool still open.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  // 0.0.0.0, not localhost: inside a container, binding to the loopback
  // interface makes the port unreachable from outside it.
  await app.listen(port, '0.0.0.0');

  Logger.log(`listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
