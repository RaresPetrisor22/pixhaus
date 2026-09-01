import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'pixhaus_session';

export function sessionCookieOptions(ttlHours: number, isProduction: boolean): CookieOptions {
  return {
    // Unreadable from JavaScript, so an XSS bug cannot steal the session.
    httpOnly: true,
    // Sent on top-level navigations but not on cross-site POSTs.
    sameSite: 'lax',
    // Would stop the cookie working over plain http in development.
    secure: isProduction,
    path: '/',
    maxAge: ttlHours * 3_600_000,
  };
}

export function readSessionCookie(header: string | undefined): string | null {
  if (!header) {
    return null;
  }

  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (pair.slice(0, separator).trim() === SESSION_COOKIE) {
      return pair.slice(separator + 1).trim() || null;
    }
  }

  return null;
}
