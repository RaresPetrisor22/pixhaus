import { RENDITIONS_QUEUE, type RenditionJob } from '@pixhaus/jobs';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';

import { readEnv } from './env.ts';
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

/**
 * The consumer.
 */
const worker = new Worker<RenditionJob>(
  RENDITIONS_QUEUE,
  async (job) => handleRendition(pool, job.data),
  { connection, concurrency: env.concurrency },
);

worker.on('completed', (job) => console.log(`completed job ${job.id}`));

worker.on('failed', (job, error) => {
  const attempts = job ? `${job.attemptsMade}/${job.opts.attempts ?? 1}` : 'unknown';
  console.error(`failed job ${job?.id} (attempt ${attempts}): ${error.message}`);
});

// Fires when Redis itself is unreachable, not when a job fails.
worker.on('error', (error) => console.error(`worker error: ${error.message}`));

console.log(`worker listening on "${RENDITIONS_QUEUE}", concurrency ${env.concurrency}`);

/**
 * Graceful shutdown. worker.close() lets in-flight jobs finish rather than
 * killing them mid-transaction.
 */
async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, finishing in-flight jobs`);
  await worker.close();
  await pool.end();
  connection.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
