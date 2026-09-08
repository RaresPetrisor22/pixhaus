import { Redis } from 'ioredis';

/**
 * BullMQ requires `maxRetriesPerRequest: null`.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}
