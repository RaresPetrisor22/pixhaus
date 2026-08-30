import { Algorithm, hash, verify } from '@node-rs/argon2';

/** OWASP's argon2id baseline: 19 MiB, two passes, one lane. */
const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Returns the encoded form — algorithm, parameters and salt travel with it. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  try {
    return await verify(encoded, password);
  } catch {
    // Malformed hash. Not a reason to 500 — it is a failed login.
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * Spends the same time a real verify would, so an unknown email and a wrong
 * password cannot be told apart by how long the response took.
 */
export async function verifyDummy(password: string): Promise<void> {
  dummy ??= hashPassword('pixhaus-not-a-real-password');
  await verifyPassword(await dummy, password);
}
