import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';

import { describeError } from '../common/describe-error';
import { QueueService } from '../queue/queue.service';

@Injectable()
export class RedisHealthIndicator {
  private readonly logger = new Logger(RedisHealthIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly queue: QueueService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const check = this.healthIndicatorService.check(key);

    try {
      await this.queue.isReachable();
      return check.up();
    } catch (error) {
      this.logger.error(`redis readiness failed: ${describeError(error)}`);
      return check.down({ message: 'redis unreachable' });
    }
  }
}
