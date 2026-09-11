import 'reflect-metadata';

import { existsSync, readFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join } from 'node:path';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';
import type { Env } from './config/env';

/** Paths the server answers itself; everything else is the SPA's. */
const SERVER_PATHS = ['/api', '/healthz', '/readyz', '/scratch'];

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // In production a reverse proxy terminates TLS, so every request arrives from
  // its address. Without this, req.ip is the proxy for everybody and each
  // per-IP rate limit silently becomes one global limit — register would be
  // 5/hour for the entire internet.
  //
  // 1, not true: trust exactly one hop, so a client cannot claim an address by
  // sending its own X-Forwarded-For.
  app.set('trust proxy', 1);

  // JSON lives under /api. The probes stay at the root because whatever polls
  // them will not prepend a prefix.
  app.setGlobalPrefix('api', { exclude: ['healthz', 'readyz'] });

  // Last thing to touch a failed request, so every error leaves in one shape.
  app.useGlobalFilters(new ApiExceptionFilter());

  // Without this, onApplicationShutdown never fires and SIGTERM kills the
  // process with the Postgres pool still open.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });

  // Dev only, and temporary: the probes have to be served from APP_URL or they
  // are not testing the CORS rule the browser will actually hit. A fixed list,
  // never a path from the request. Goes away with the pages, once apps/web
  // exists.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    for (const name of ['upload.html']) {
      const page = join(__dirname, '..', '..', '..', 'scratch', name);

      app.use(`/scratch/${name}`, (_req: unknown, res: ServerResponse) => {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(readFileSync(page, 'utf8'));
      });
    }
  }

  // The built SPA, served from the same origin as the API: one cookie, no CORS.
  // Absent in development when only the API is running, so this is optional.
  const webDist = join(__dirname, '..', '..', 'web', 'dist');

  if (existsSync(webDist)) {
    app.useStaticAssets(webDist, { index: false, maxAge: '1y', immutable: true });

    // Anything else a browser navigates to is a client-side route. Files with
    // an extension are excluded so a missing favicon is a 404, not a page.
    app.use((req: Request, res: Response, next: NextFunction) => {
      const isPage =
        (req.method === 'GET' || req.method === 'HEAD') &&
        req.accepts('html') !== false &&
        extname(req.path) === '' &&
        !SERVER_PATHS.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));

      if (!isPage) {
        return next();
      }

      // Never cached: index.html is what names the hashed assets.
      res.setHeader('cache-control', 'no-cache');
      res.sendFile(join(webDist, 'index.html'));
    });
  }

  // 0.0.0.0, not localhost: inside a container, binding to the loopback
  // interface makes the port unreachable from outside it.
  await app.listen(port, '0.0.0.0');

  Logger.log(`listening on http://localhost:${port}`, 'Bootstrap');
}

void bootstrap();
