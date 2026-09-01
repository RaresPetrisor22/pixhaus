import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions } from 'express';

import type { Env } from '../config/env';
import { AuthRepository } from './auth.repository';
import type { StudioUserPrincipal } from './principal';
import { sessionCookieOptions } from './session-cookie';
import { generateToken, hashToken } from './tokens';

/** How stale last_seen_at must be before a read is allowed to cause a write. */
const TOUCH_INTERVAL_MS = 3_600_000;

export type SessionContext = { ip?: string; userAgent?: string };

@Injectable()
export class SessionService {
  private readonly ttlHours: number;
  readonly cookieOptions: CookieOptions;

  constructor(
    private readonly repository: AuthRepository,
    config: ConfigService<Env, true>,
  ) {
    this.ttlHours = config.get('SESSION_TTL_HOURS', { infer: true });
    this.cookieOptions = sessionCookieOptions(
      this.ttlHours,
      config.get('NODE_ENV', { infer: true }) === 'production',
    );
  }

  /** Returns the raw token for the cookie. Only its hash is stored. */
  async issue(userId: string, studioId: string, context: SessionContext = {}): Promise<string> {
    const token = generateToken();

    await this.repository.createSession({
      id: hashToken(token),
      userId,
      studioId,
      ip: context.ip ?? null,
      userAgent: context.userAgent?.slice(0, 512) ?? null,
      ttlHours: this.ttlHours,
    });

    return token;
  }

  async resolve(token: string): Promise<StudioUserPrincipal | null> {
    const sessionId = hashToken(token);
    const session = await this.repository.findSession(sessionId);

    if (!session || session.expiresAt <= new Date()) {
      return null;
    }

    // Throttled: writing on every request would mean a row update per image
    // thumbnail in M2.
    if (session.lastSeenAt.getTime() + TOUCH_INTERVAL_MS <= Date.now()) {
      await this.repository.touchSession(session.studioId, sessionId, this.ttlHours);
    }

    return {
      kind: 'user',
      userId: session.userId,
      studioId: session.studioId,
      sessionId,
    };
  }

  revoke(principal: StudioUserPrincipal): Promise<void> {
    return this.repository.deleteSession(principal.studioId, principal.sessionId);
  }

  revokeAll(principal: StudioUserPrincipal): Promise<number> {
    return this.repository.deleteSessionsForUser(principal.studioId, principal.userId);
  }
}
