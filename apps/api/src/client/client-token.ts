import { createHmac, timingSafeEqual } from 'node:crypto';

import type { GrantPrincipal } from '../auth/principal';

/**
 * The short-lived credential a client holds. Single-letter keys because this
 * travels in a header on every request.
 */
export type ClientTokenPayload = {
  g: string; // grant id
  s: string; // studio id
  y: string; // gallery id
  r: number; // rights mask
  e: number; // revocation epoch
  exp: number; // unix seconds
};

/**
 * There is no `alg` field, and that is the point: one algorithm exists, so
 * there is nothing to negotiate and nothing to downgrade.
 */
function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function isPayload(value: unknown): value is ClientTokenPayload {
  const p = value as Partial<ClientTokenPayload> | null;

  return (
    typeof p === 'object' &&
    p !== null &&
    typeof p.g === 'string' &&
    typeof p.s === 'string' &&
    typeof p.y === 'string' &&
    Number.isInteger(p.r) &&
    Number.isInteger(p.e) &&
    Number.isInteger(p.exp)
  );
}

export function signClientToken(payload: ClientTokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');

  return `${body}.${sign(body, secret)}`;
}

/** Null for anything not currently valid: forged, malformed, or expired. */
export function verifyClientToken(
  token: string,
  secret: string,
  now = Date.now(),
): ClientTokenPayload | null {
  const parts = token.split('.');

  if (parts.length !== 2) {
    return null;
  }

  const [body, signature] = parts;
  const expected = sign(body, secret);

  // timingSafeEqual throws on a length mismatch, so that case is answered first.
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }

  // Only now, past the signature, do untrusted bytes reach a parser.
  let parsed: unknown;

  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (!isPayload(parsed) || parsed.exp * 1000 <= now) {
    return null;
  }

  return parsed;
}

/**
 * The payload/principal mapping lives here with the format, so the field
 * letters appear in exactly one file.
 */
export function clientTokenPayload(
  grant: Omit<GrantPrincipal, 'kind'>,
  ttlSeconds: number,
  now = Date.now(),
): ClientTokenPayload {
  return {
    g: grant.grantId,
    s: grant.studioId,
    y: grant.galleryId,
    r: grant.rightsMask,
    e: grant.epoch,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
}

export function principalFromPayload(payload: ClientTokenPayload): GrantPrincipal {
  return {
    kind: 'grant',
    grantId: payload.g,
    studioId: payload.s,
    galleryId: payload.y,
    rightsMask: payload.r,
    epoch: payload.e,
  };
}
