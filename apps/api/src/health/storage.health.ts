import { Injectable, Logger } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';

import { describeError } from '../common/describe-error';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class StorageHealthIndicator {
  private readonly logger = new Logger(StorageHealthIndicator.name);

  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly storage: StorageService,
  ) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const check = this.healthIndicatorService.check(key);

    try {
      await this.storage.bucketReachable();
      return check.up();
    } catch (error) {
      // Detail to the logs; /readyz is unauthenticated, so the body stays
      // generic rather than naming our endpoint or bucket.
      this.logger.error(`storage readiness failed: ${describeError(error)}`);
      return check.down({ message: 'storage unreachable' });
    }
  }
}
