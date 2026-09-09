import type { ObjectStoreConfig } from '@pixhaus/storage';

/** The worker's whole configuration. Fail at boot, not on the first job. */
export type WorkerEnv = {
  databaseUrl: string;
  redisUrl: string;
  concurrency: number;
  storage: ObjectStoreConfig;
};

export function readEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const required = (name: string): string => {
    const value = source[name];
    if (!value) {
      throw new Error(`${name} is not set`);
    }
    return value;
  };

  return {
    databaseUrl: required('DATABASE_URL'),
    redisUrl: required('REDIS_URL'),
    concurrency: Number(source.WORKER_CONCURRENCY ?? 2),
    storage: {
      endpoint: required('STORAGE_ENDPOINT'),
      region: source.STORAGE_REGION ?? 'us-east-1',
      bucket: required('STORAGE_BUCKET'),
      accessKeyId: required('STORAGE_ACCESS_KEY'),
      secretAccessKey: required('STORAGE_SECRET_KEY'),
      forcePathStyle: (source.STORAGE_FORCE_PATH_STYLE ?? 'true') === 'true',
    },
  };
}
