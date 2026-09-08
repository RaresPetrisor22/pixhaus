/** The worker's whole configuration. Fail at boot, not on the first job. */
export type WorkerEnv = {
  databaseUrl: string;
  redisUrl: string;
  concurrency: number;
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
  };
}
