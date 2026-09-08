import { RENDITIONS_QUEUE, RENDITION_JOB_OPTIONS, type RenditionJob } from '@pixhaus/jobs';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import type { Env } from '../config/env';
import { createRedis } from './redis';

/**
 * The producer side. The API only ever writes jobs; the worker reads them.
 */
@Injectable()
export class QueueService implements OnApplicationShutdown {
  private readonly logger = new Logger(QueueService.name);
  private readonly connection: Redis;
  private readonly renditions: Queue<RenditionJob>;

  constructor(config: ConfigService<Env, true>) {
    this.connection = createRedis(config.get('REDIS_URL', { infer: true }));
    this.renditions = new Queue<RenditionJob>(RENDITIONS_QUEUE, {
      connection: this.connection,
      defaultJobOptions: RENDITION_JOB_OPTIONS,
    });
  }

  async enqueueRendition(job: RenditionJob): Promise<void> {
    try {
      await this.renditions.add('derive', job, { jobId: job.assetId });
    } catch (error) {
      this.logger.error(
        `failed to enqueue rendition for asset ${job.assetId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Readiness. A queue the API cannot write to means uploads go nowhere. */
  async isReachable(): Promise<void> {
    await this.connection.ping();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.renditions.close();
    this.connection.disconnect();
  }
}
