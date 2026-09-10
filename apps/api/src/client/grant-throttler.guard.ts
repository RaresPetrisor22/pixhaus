import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, minutes } from '@nestjs/throttler';

import { hashToken } from '../auth/tokens';
import { readBearer } from './client.guard';

/**
 * Counts client-plane requests per credential rather than per IP, because a
 * grant's whole audience is often behind one address.
 *
 * It keys on the hash, never the credential itself, so the in-memory counter
 * map holds nothing usable.
 */
@Injectable()
export class GrantThrottlerGuard extends ThrottlerGuard {
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = [{ name: 'grant', ttl: minutes(60), limit: 30 }];
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const params = req.params as { token?: unknown } | undefined;
    const headers = req.headers as { authorization?: string } | undefined;

    const credential =
      typeof params?.token === 'string' ? params.token : readBearer(headers?.authorization);

    if (credential && credential.length <= 512) {
      return Promise.resolve(`grant:${hashToken(credential)}`);
    }

    return Promise.resolve(`ip:${String(req.ip ?? 'unknown')}`);
  }
}
