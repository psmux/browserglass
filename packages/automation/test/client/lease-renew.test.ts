import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFakeClient, tick } from '../helpers.js';

/**
 * The real gateway answers `control.renew` with a `control.granted` that has
 * no `re`, so a client that waits for a correlated reply never sees one. Its
 * local `expiresAt` then stays put and every verb fails with
 * `LEASE_NOT_HELD` 30 seconds in, while the server still holds the lease for
 * it. The fake gateway now answers the way the real one does.
 */
describe('lease renewal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the new expiry from an uncorrelated control.granted', async () => {
    const { client } = await connectFakeClient();
    const leasePromise = client.acquireControl({ waitMs: 5000, autoRenew: false });
    await tick();
    const lease = await leasePromise;
    const before = lease.expiresAt;

    await tick(1000);
    await lease.renew(90000);

    expect(lease.expiresAt).toBeGreaterThan(before);
    expect(lease.isValid).toBe(true);
    client.close();
  });

  it('keeps the lease valid well past its first expiry when auto-renew is on', async () => {
    const { client, gateway } = await connectFakeClient();
    const leasePromise = client.acquireControl({ waitMs: 5000, durationMs: 30000 });
    await tick();
    const lease = await leasePromise;

    await tick(120000);

    expect(
      gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'control.renew').length,
    ).toBeGreaterThan(0);
    expect(lease.isValid).toBe(true);
    client.close();
  });
});
