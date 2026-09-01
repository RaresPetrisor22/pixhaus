import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EmailThrottlerGuard } from './email-throttler.guard';

/** getTracker is protected; this is the seam the guard exists to provide. */
class Probe extends EmailThrottlerGuard {
  track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

const guard = new Probe({ throttlers: [] }, {} as never, {} as never);

describe('EmailThrottlerGuard.getTracker', () => {
  test('buckets by the email being attempted', async () => {
    assert.equal(
      await guard.track({ body: { email: 'me@example.com' }, ip: '1.2.3.4' }),
      'email:me@example.com',
    );
  });

  test('is case-insensitive, so casing does not buy a fresh budget', async () => {
    const lower = await guard.track({ body: { email: 'me@example.com' } });
    const upper = await guard.track({ body: { email: 'ME@Example.COM' } });

    assert.equal(lower, upper);
  });

  test('separates different accounts', async () => {
    const a = await guard.track({ body: { email: 'a@example.com' } });
    const b = await guard.track({ body: { email: 'b@example.com' } });

    assert.notEqual(a, b);
  });

  test('falls back to the IP when the body has no usable email', async () => {
    // The body is unvalidated here: guards run before pipes.
    for (const body of [undefined, {}, { email: 42 }, { email: '' }, { email: 'x'.repeat(300) }]) {
      assert.equal(await guard.track({ body, ip: '1.2.3.4' }), 'ip:1.2.3.4');
    }
  });

  test('never throws on a hostile body', async () => {
    assert.equal(await guard.track({ body: null, ip: '1.2.3.4' }), 'ip:1.2.3.4');
    assert.equal(await guard.track({}), 'ip:unknown');
  });
});
