import { z } from 'zod';

/**
 * Every environment variable the API reads, in one place.
 *
 * This runs once at boot, before Nest wires up a single provider. A missing or
 * malformed variable therefore kills the process immediately with a message
 * naming the variable.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  PORT: z.coerce.number().int().positive().default(3000),

  // The APP role, not the owner. This connection is subject to row-level
  // security, which is the entire point of the two-role setup — see
  // packages/db/migrations/0001_initial_schema.sql.
  DATABASE_URL: z.url(),

  // Where the browser reaches this deployment. Verification and magic links
  // are built from it, so it is the public origin, not the bind address.
  APP_URL: z.url(),

  SMTP_URL: z.url(),
  SMTP_FROM: z.string().min(1).default('Pixhaus <no-reply@pixhaus.local>'),

  SESSION_TTL_HOURS: z.coerce.number().int().positive().default(336),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().int().positive().default(24),

  STORAGE_ENDPOINT: z.url(),

  // What gets baked into a presigned URL. SigV4 signs the Host header, so a URL
  // signed for one origin cannot be rewritten to another — it has to be signed
  // with the origin the browser will actually use. Same value in production.
  STORAGE_PUBLIC_ENDPOINT: z.url().optional(),

  STORAGE_REGION: z.string().min(1).default('us-east-1'),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY: z.string().min(1),
  STORAGE_SECRET_KEY: z.string().min(1),

  STORAGE_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  UPLOAD_URL_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(104_857_600),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Passed to ConfigModule.forRoot({ validate }). Nest calls this with the raw
 * environment and uses whatever it returns as the config object.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid environment:\n${problems}`);
  }

  return result.data;
}
