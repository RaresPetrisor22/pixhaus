import { Global, Inject, Logger, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import pg from 'pg';

import type { Env } from '../config/env';

const { Pool } = pg;

/**
 * DI token for the connection pool. A symbol rather than a string so nothing
 * else can collide with it by accident.
 */
export const PG_POOL = Symbol('PG_POOL');

/**
 * The one Postgres pool the API uses.
 *
 * It connects as the *application* role, which owns no tables and is therefore
 * bound by row-level security. Every query through this pool sees only the
 * tenant named by `SET LOCAL app.studio_id` — and nothing at all if that was
 * never set.
 *
 * M1 puts the tenant-scoped repository layer on top of this. For now the only
 * consumer is the readiness probe, which is still worth having: it proves the
 * app role can actually connect and that the RLS setup did not lock us out.
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

        // Not optional. A pg Pool emits 'error' when an *idle* client's
        // connection dies — Postgres restarted, a network blip, someone ran
        // `docker compose stop postgres`. Node's default for an 'error' event
        // with no listener is to throw, so without this the API process dies
        // from precisely the outage /readyz exists to report.
        //
        // pg has already discarded the broken client by this point; the only
        // job here is to not crash.
        pool.on('error', (error: Error) => {
          new Logger(DatabaseModule.name).error(`idle client error: ${error.message}`);
        });

        return pool;
      },
    },
  ],
  exports: [PG_POOL],
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
