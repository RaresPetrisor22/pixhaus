import {
  REAPER_JOB_OPTIONS,
  REAPER_QUEUE,
  REAPER_REPEAT,
  REAPER_SCHEDULER_ID,
  RENDITIONS_QUEUE,
  type RenditionJob,
} from '@pixhaus/jobs';
import { createObjectStore } from '@pixhaus/storage';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import sharp from 'sharp';

import { markAssetFailed } from './assets.repository.ts';
import { readEnv } from './env.ts';
import { handleReaper } from './reaper.handler.ts';
import { handleRendition } from './renditions.handler.ts';

const env = readEnv();

const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  application_name: 'pixhaus-worker',
  max: 5,
});

pool.on('error', (error) => console.error(`idle client error: ${error.message}`));

// maxRetriesPerRequest: null is mandatory for a BullMQ Worker
const connection = new Redis(env.redisUrl, { maxRetriesPerRequest: null });

const store = createObjectStore(env.storage);

/**
 * cache(false) turns off libvips' operation cache. It exists to make repeated
 * work on the same image cheap; a worker never sees the same image twice, so
 * all it would do is hold decoded buffers alive after the job that made them.
 */
sharp.concurrency(1);
sharp.cache(false);

const worker = new Worker<RenditionJob>(
  RENDITIONS_QUEUE,
  async (job) => handleRendition({ pool, store }, job.data),
  { connection, concurrency: env.concurrency },
);

worker.on('completed', (job) => console.log(`completed job ${job.id}`));

worker.on('failed', (job, error) => {
  const attempts = job?.opts.attempts ?? 1;
  console.error(
    `failed job ${job?.id} (attempt ${job?.attemptsMade}/${attempts}): ${error.message}`,
  );

  if (job && job.attemptsMade >= attempts) {
    void markAssetFailed(pool, job.data.studioId, job.data.assetId).catch((markError: unknown) =>
      console.error(
        `could not mark asset ${job.data.assetId} failed: ${
          markError instanceof Error ? markError.message : String(markError)
        }`,
      ),
    );
  }
});

// Fires when Redis itself is unreachable, not when a job fails.
worker.on('error', (error) => console.error(`worker error: ${error.message}`));

/**
 * The reaper. Scheduled here rather than by the API: it is the worker's own
 * housekeeping, and upsert means restarting does not stack duplicates.
 */
const reaperQueue = new Queue(REAPER_QUEUE, {
  connection,
  defaultJobOptions: REAPER_JOB_OPTIONS,
});

await reaperQueue.upsertJobScheduler(REAPER_SCHEDULER_ID, REAPER_REPEAT);

const reaper = new Worker(
  REAPER_QUEUE,
  async () => {
    const { orphaned, deleted, studios } = await handleReaper(pool, store);
    if (orphaned > 0 || deleted > 0) {
      console.log(
        `reaper: orphaned ${orphaned}, deleted objects for ${deleted}, across ${studios} studio(s)`,
      );
    }
  },
  { connection, concurrency: 1 },
);

reaper.on('failed', (job, error) => console.error(`reaper failed (${job?.id}): ${error.message}`));
reaper.on('error', (error) => console.error(`reaper error: ${error.message}`));

console.log(`worker listening on "${RENDITIONS_QUEUE}", concurrency ${env.concurrency}`);
console.log(`reaper scheduled on "${REAPER_QUEUE}" (${REAPER_REPEAT.pattern})`);

/**
 * Graceful shutdown. worker.close() lets in-flight jobs finish rather than
 * killing them mid-transaction.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, finishing in-flight jobs`);
  await worker.close();
  await reaper.close();
  await reaperQueue.close();
  await pool.end();
  connection.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
