import type { Request } from 'express';

/**
 * A photographer, resolved from a session cookie. In M3 a second principal
 * type joins it — a capability grant — and `kind` is what tells them apart in
 * authorize().
 */
export type StudioUserPrincipal = {
  kind: 'user';
  userId: string;
  studioId: string;
  sessionId: string;
};

/** What the guard attaches, and @CurrentUser() reads back. */
export type AuthenticatedRequest = Request & { principal?: StudioUserPrincipal };
