import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { hashToken } from '../auth/tokens';
import { GrantThrottlerGuard } from './grant-throttler.guard';

/** getTracker is protected; this is the seam the guard exists to provide. */
class Exposed extends GrantThrottlerGuard {
  track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

function guard(): Exposed {
  return Object.create(Exposed.prototype) as Exposed;
}

describe('GrantThrottlerGuard.getTracker', () => {
  test('the exchange is keyed on the hash of the body token, never the token', async () => {
    const key = await guard().track({ body: { token: 'magic' }, headers: {}, ip: '1.1.1.1' });

    assert.equal(key, `grant:${hashToken('magic')}`);
    assert.doesNotMatch(key, /magic/);
  });

  test('every other client route is keyed on the hash of the badge', async () => {
    const key = await guard().track({ headers: { authorization: 'Bearer badge' }, ip: '1.1.1.1' });

    assert.equal(key, `grant:${hashToken('badge')}`);
  });

  test('falls back to the address when there is no credential at all', async () => {
    assert.equal(await guard().track({ headers: {}, ip: '1.1.1.1' }), 'ip:1.1.1.1');
  });

  test('an absurdly long token is not hashed, it is treated as no credential', async () => {
    const key = await guard().track({ body: { token: 'x'.repeat(600) }, headers: {}, ip: '2.2.2.2' });

    assert.equal(key, 'ip:2.2.2.2');
  });
});
