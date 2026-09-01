import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { Public } from '../auth/public.decorator';
import { PostgresHealthIndicator } from './postgres.health';

/**
 * Two probes that answer two different questions.
 */
// Probes carry no credential, and SessionGuard would otherwise 401 them.
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
  ) {}

  /**
   * Liveness: "is this process alive?" — checks nothing else, on purpose.
   */
  @Get('healthz')
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  /**
   * Readiness: "should traffic be routed here?" — checks the dependencies the
   * API cannot serve a request without.
   */
  @Get('readyz')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.postgres.isHealthy('postgres')]);
  }
}
