import { Controller, Get } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';

import { PostgresHealthIndicator } from './postgres.health';

/**
 * Two probes that answer two different questions.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly postgres: PostgresHealthIndicator,
  ) {}

  /**
   * Liveness: "is this process alive?" — checks nothing else, on purpose.
   *
   * An orchestrator restarts a container that fails its liveness probe. If this
   * checked Postgres, then Postgres going down would restart every API
   * container in a loop, which helps nobody and destroys the sessions and
   * in-flight work of the one dependency that was still fine.
   */
  @Get('healthz')
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  /**
   * Readiness: "should traffic be routed here?" — checks the dependencies the
   * API cannot serve a request without.
   *
   * Failing this pulls the instance out of the load balancer without killing
   * it, so it recovers on its own when the dependency comes back. Terminus
   * turns a failed check into a 503 automatically.
   *
   * Postgres only for now. Redis and object storage get added when M1 and M2
   * introduce the clients that actually use them.
   */
  @Get('readyz')
  @HealthCheck()
  readiness() {
    return this.health.check([() => this.postgres.isHealthy('postgres')]);
  }
}
