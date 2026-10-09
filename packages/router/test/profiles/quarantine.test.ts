/**
 * A lease whose holder never renews becomes `quarantined`, never `free`:
 * freeing a profile whose holder might still be alive behind a network
 * partition would hand the same directory to a second Chrome and corrupt
 * LevelDB. The router's sweeper (`sweepExpiredLeases`) is what makes this
 * happen, since a passive reclaim has no corruption probe to validate the
 * directory the way an active `acquire`'s steal path does.
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

describe('ProfileService quarantine on renew-missed', () => {
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
    await fixture.cleanup();
  });

  it('a lease whose holder never renews goes to quarantined, not free', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_stuck',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:renew-missed' },
      leaseTtlMs: 10_000,
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    // Never renewed. Advance well past ttl + stealGraceMs (default 5000).
    clock.advance(10_000 + 5_000 + 1_000);

    const reclaimed = await service.sweepExpiredLeases(basics.tenantId, 50);
    expect(reclaimed.map((l) => l.id)).toContain(acquired.leaseId);

    const row = await fixture.store.getProfile(basics.tenantId, acquired.profileId);
    expect(row?.state).toBe('quarantined');
    expect(row?.state).not.toBe('free');
    expect(row?.lease).toBeNull(); // the lease itself was released as part of the sweep
  });

  it('a renewed lease is not touched by the sweep', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_healthy',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:renewed-fine' },
      leaseTtlMs: 10_000,
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    clock.advance(5_000);
    const renewed = await service.renew({ leaseId: acquired.leaseId, fence: acquired.fence });
    expect(renewed.ok).toBe(true);

    clock.advance(5_000); // total 10s elapsed, but renewed 5s ago so still well within ttl
    const reclaimed = await service.sweepExpiredLeases(basics.tenantId, 50);
    expect(reclaimed).toHaveLength(0);

    const row = await fixture.store.getProfile(basics.tenantId, acquired.profileId);
    expect(row?.state).toBe('leased');
  });

  it('a quarantined profile refuses further acquire with E_PROFILE_QUARANTINED', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_stuck2',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:renew-missed-2' },
      leaseTtlMs: 10_000,
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    clock.advance(10_000 + 5_000 + 1_000);
    await service.sweepExpiredLeases(basics.tenantId, 50);

    await expect(
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: 'inst_new',
        nodeId: basics.nodeId,
        spec: { mode: 'persistent', key: 'user:renew-missed-2', createIfMissing: false },
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_QUARANTINED' });
  });
});
