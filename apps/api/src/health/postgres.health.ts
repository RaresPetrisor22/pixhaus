import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import type pg from 'pg';

import { PG_POOL } from '../database/pg-pool';

/**
 * Connection failures often arrive as an AggregateError (one failure per
 * address the host resolved to) whose own `message` is empty, so unwrap it
 * rather than logging a blank line.
 */
function describe(error: unknown): string {
  if (error instanceof AggregateError) {
    return error.errors.map(describe).join('; ');
  }
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return error.message || code || error.name;
  }
  return String(error);
}

@Injectable()
export class PostgresHealthIndicator {
  private readonly logger = new Logger(PostgresHealthIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const check = this.healthIndicatorService.check(key);

    try {
      await this.pool.query('SELECT 1');
      return check.up();
    } catch (error) {
      // Full detail goes to the logs, where it can name the host, port and
      // role. The response body stays generic — /readyz is unauthenticated, so
      // it should not describe our infrastructure to whoever asks.
      this.logger.error(`readiness check failed: ${describe(error)}`);
      return check.down({ message: 'postgres unreachable' });
    }
  }
}
