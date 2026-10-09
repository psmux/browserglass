/**
 * The periodic lease renewal loop: the node holding the lease renews on
 * `profileLeaseRenewIntervalMs`, one third of the TTL so two consecutive
 * renew failures still leave headroom.
 *
 * It was specified and never built. Every grant already advertised a
 * `renewIntervalMs` that nothing acted on, so a lease went stale
 * `profileLeaseTtlMs` (30s) after it was taken, and the instance holding it
 * could never be restarted again: `renewForInstance()` refused with
 * `E_PROFILE_BUSY: ... stale`, surfacing to a viewer as
 * "instance.restart failed: the browser could not be relaunched". A stale
 * lease is also exactly what another node is entitled to take over, so this
 * was a correctness gap and not only an annoyance.
 *
 * `test/e2e/lease-renewal.test.ts` in `@browserglass/conformance` covers the
 * same fix against a real gateway on the real clock; this covers the loop
 * itself, on a fake one, in milliseconds.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileService } from '../../src/profiles/ProfileService.js';
import { type FakeClock, createFakeClock } from '../support/fakeClock.js';
import { type FakeProfileFs, createFakeProfileFs } from './support/fakeProfileFs.js';
import {
  type Basics,
  type StoreFixture,
  freshRouterStore,
  seedBasics,
} from './support/testStore.js';

/**
 * `FakeClock.advance()` fires its timers synchronously, but the renewal
 * tick is async (it awaits a real store write per lease), so the tick
 * started by one advance has not finished when `advance()` returns.
 * Yielding to the real event loop between advances lets each renewal
 * actually land before fake time moves again.
 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('ProfileService lease renewal loop', () => {
  let fixture: StoreFixture;
  let basics: Basics;
  let fs: FakeProfileFs;
  let clock: FakeClock;
  let service: ProfileService;

  beforeEach(async () => {
    fixture = await freshRouterStore();
    basics = await seedBasics(fixture.store);
    fs = createFakeProfileFs();
    clock = createFakeClock(Date.now());
    service = new ProfileService({ store: fixture.store, fs, clock });
  });

  afterEach(async () => {
    service.stopLeaseRenewal();
    await fixture.cleanup();
  });

  it('keeps a lease renewable well past its own TTL, so a long lived instance can still be restarted', async () => {
    service.startLeaseRenewal();

    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    // Four times the 30s default TTL. Without the loop the lease is stale
    // after the first 30s of this and every later assertion fails.
    for (let elapsed = 0; elapsed < 120_000; elapsed += 10_000) {
      clock.advance(10_000);
      await settle();
    }

    // This is the exact call `BrowserRouter.restart()` makes, and the exact
    // one that used to throw `E_PROFILE_BUSY`.
    const renewed = await service.renewForInstance('inst_1', 30_000);
    expect(renewed.profileId).toBe(acquired.profileId);
    expect(renewed.fence).toBe(acquired.fence);
  });

  it('does not renew once the loop is stopped, so a shut down gateway stops holding profiles open', async () => {
    service.startLeaseRenewal();
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_2',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
      leaseTtlMs: 30_000,
    });
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    service.stopLeaseRenewal();

    clock.advance(60_000);
    await settle();

    await expect(service.renewForInstance('inst_2', 30_000)).rejects.toThrow(/stale/);
  });
});
