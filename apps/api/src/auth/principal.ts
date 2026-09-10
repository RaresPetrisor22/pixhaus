import type { Request } from 'express';

/**
 * A photographer, resolved from a session cookie. `kind` is what tells it apart
 * from a grant in authorize().
 */
export type StudioUserPrincipal = {
  kind: 'user';
  userId: string;
  studioId: string;
  sessionId: string;

  emailVerified: boolean;
};

/**
 * A client, resolved from a capability token.
 */
export type GrantPrincipal = {
  kind: 'grant';
  grantId: string;
  studioId: string;
  galleryId: string;

  /** Bitmask: 1 view, 2 download, 4 favorite. See authz/rights.ts. */
  rightsMask: number;

  /** The revocation epoch this token was minted under. */
  epoch: number;
};

export type Principal = StudioUserPrincipal | GrantPrincipal;

/** What the guard attaches, and @CurrentUser() reads back. */
export type AuthenticatedRequest = Request & { principal?: StudioUserPrincipal };

/** The client-plane equivalent: what ClientGuard attaches, read by @Grant(). */
export type GrantRequest = Request & { grant?: GrantPrincipal };
