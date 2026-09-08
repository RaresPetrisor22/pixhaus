import { Inject, Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import type pg from 'pg';

import { describeError } from '../common/describe-error';
import { PG_POOL } from '../database/pg-pool';

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
      this.logger.error(`readiness check failed: ${describeError(error)}`);
      return check.down({ message: 'postgres unreachable' });
    }
  }
}
