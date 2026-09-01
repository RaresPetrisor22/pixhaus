import { Injectable } from '@nestjs/common';
import { ThrottlerGuard, minutes } from '@nestjs/throttler';

/**
 * Counts login attempts per email address.
 *
 * Per-IP alone is not enough: an attacker with a proxy pool gets a fresh
 * budget per address, and every one of them can target the same account. This
 * caps attempts on an account no matter where they come from.
 */
@Injectable()
export class EmailThrottlerGuard extends ThrottlerGuard {
  /**
   * This guard answers to a throttler named 'email', so it has a budget of its
   * own rather than sharing the per-IP one. Routes tune it with
   * `@Throttle({ email: { ... } })`.
   */
  override async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = [{ name: 'email', ttl: minutes(15), limit: 10 }];
  }

  protected override getTracker(req: Record<string, unknown>): Promise<string> {
    const body = req.body as { email?: unknown } | undefined;
    const email = body?.email;

    if (typeof email === 'string' && email.length > 0 && email.length <= 254) {
      return Promise.resolve(`email:${email.toLowerCase()}`);
    }

    return Promise.resolve(`ip:${String(req.ip ?? 'unknown')}`);
  }
}
