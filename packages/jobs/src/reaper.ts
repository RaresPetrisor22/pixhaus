/** Sweeps `pending` assets whose upload never arrived. */

export const REAPER_QUEUE = 'reaper';

export const REAPER_SCHEDULER_ID = 'sweep-pending';

/** Every 15 minutes; anything pending for an hour is given up on. */
export const REAPER_REPEAT = { pattern: '*/15 * * * *' } as const;

export const REAPER_PENDING_AFTER = '1 hour';

export const REAPER_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 50 },
  removeOnFail: { count: 50 },
} as const;
