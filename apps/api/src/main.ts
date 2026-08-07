import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import type { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

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
