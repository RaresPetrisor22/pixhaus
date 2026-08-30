import { createHash, randomBytes } from 'node:crypto';

/**
 * 256 bits of entropy, base64url so it is safe in a URL and a cookie without
 * escaping.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * What the database stores instead.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
