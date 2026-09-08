/**
 * The rendition job, described once.
 */

/** The Redis key prefix BullMQ derives everything else from. */
export const RENDITIONS_QUEUE = 'renditions';

export type RenditionJob = {
  assetId: string;
  /** The worker needs it to open a tenant-scoped transaction. */
  studioId: string;
};

/**
 * Retry policy, owned by the producer.
 */
export const RENDITION_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 1000 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
} as const;
