import 'reflect-metadata';

import { readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import type { Env } from './config/env';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // JSON lives under /api. The rest stay at the root because whatever reaches
  // them will not prepend a prefix: a health probe, or a human clicking a link
  // in an email.
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz', 'g/:token'] });

  // Last thing to touch a failed request, so every error leaves in one shape.
  app.useGlobalFilters(new ApiExceptionFilter());

  // Without this, onApplicationShutdown never fires and SIGTERM kills the
  // process with the Postgres pool still open.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  // Dev only, and temporary: scratch/upload.html has to be served from APP_URL
  // or it is not testing the CORS rule the browser will actually hit. Goes away
  // with the page, once apps/web exists.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const page = join(__dirname, '..', '..', '..', 'scratch', 'upload.html');

    app.use('/scratch/upload.html', (_req: unknown, res: ServerResponse) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(readFileSync(page, 'utf8'));
    });
  }

  // 0.0.0.0, not localhost: inside a container, binding to the loopback
  // interface makes the port unreachable from outside it.
  await app.listen(port, '0.0.0.0');

  Logger.log(`listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
