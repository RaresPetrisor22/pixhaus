import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';

import type { Env } from '../config/env';
import { PG_POOL } from './pg-pool';
import { TenantDb } from './tenant-db.service';

const { Pool } = pg;

/**
 * The one Postgres pool the API uses.
 *
 * It connects as the *application* role, which owns no tables and is therefore
 * bound by row-level security.
 */
@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const pool = new Pool({
          connectionString: config.get('DATABASE_URL', { infer: true }),
          application_name: 'pixhaus-api',
          max: 10,
        });
        // pg has already discarded the broken client by this point; the only
        // job here is to not crash.
        pool.on('error', (error: Error) => {
          new Logger(DatabaseModule.name).error(`idle client error: ${error.message}`);
        });

        return pool;
      },
    },
    TenantDb,
  ],
  exports: [PG_POOL, TenantDb],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /**
   * Closes the pool on SIGTERM so a `docker compose down` does not leave
   * connections hanging until Postgres times them out. Only fires because
   * main.ts calls enableShutdownHooks().
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
