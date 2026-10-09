/**
 * The node holding a profile lease renews it every
 * `profileLeaseRenewIntervalMs`, one third of `profileLeaseTtlMs`.
 *
 * That loop was specified and never built. Every grant advertised a
 * `renewIntervalMs` nothing acted on, so a lease went stale 30 seconds
 * after it was taken, and from then on the instance holding it could never
 * be restarted: `renewForInstance()` refused with `E_PROFILE_BUSY: stale`
 * and the viewer saw `instance.restart failed: the browser could not be
 * relaunched`. A stale lease is also precisely what another node is
 * entitled to steal, so this was a correctness gap and not only a
 * nuisance.
 *
 * This waits past the real 30 second TTL, on the real clock, and then
 * restarts. Slow by nature: the thing under test is what elapsed time does
 * to a lease, so there is nothing here to speed up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

/** `DEFAULT_ROUTER_CONFIG.profileLeaseTtlMs` is 30s; this clears it with room to spare. */
const PAST_THE_LEASE_TTL_MS = 40_000;

let gateway: RealGateway;

beforeAll(async () => {
  gateway = await startRealGateway({ headless: 'new' });
}, 180_000);

afterAll(async () => {
  await gateway?.close();
}, 120_000);

describe('profile lease renewal', () => {
  it('an instance still restarts after it has been alive for longer than the profile lease TTL', async () => {
    const acquired = await gateway.acquireInstance();
    const client = await gateway.makeClient(acquired.instanceId);
    await client.connect();

    await new Promise((resolve) => setTimeout(resolve, PAST_THE_LEASE_TTL_MS));

    // Before the renewal loop existed this threw
    // `bgls.error.instance.unrecoverable`, every time, for any instance
    // older than the TTL.
    const result = await client.restart({
      reason: 'lease renewal conformance',
      timeoutMs: 120_000,
    });
    expect(result.initiated).toBe(true);

    // And the instance is genuinely usable afterwards, not merely
    // reported as restarted.
    const tabs = await client.tabs.list();
    expect(tabs.length).toBeGreaterThan(0);

    client.destroy();
    await gateway.releaseInstance(acquired.instanceId);
  }, 240_000);
});
