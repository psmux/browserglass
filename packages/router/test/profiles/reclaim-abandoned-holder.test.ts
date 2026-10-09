/**
 * `reclaimFromHolderInstanceId`: the router has established that a lease
 * holder is a row left behind by a gateway that is gone, so its unexpired
 * lease may be taken over now. The steal path's own checks still apply: a
 * Chrome still holding the profile's singleton lock refuses the takeover.
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

describe('ProfileService: reclaiming the lease of an abandoned holder', () => {
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

  async function holdKey(key: string, instanceId: string) {
    const held = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId,
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key },
      leaseTtlMs: 30_000,
    });
    if (held.kind !== 'leased') throw new Error('unreachable');
    return held;
  }

  it('takes over an unexpired lease when the caller names its holder', async () => {
    const old = await holdKey('user:crash', 'inst_dead_gateway');

    const fresh = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_fresh',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:crash' },
      reclaimFromHolderInstanceId: 'inst_dead_gateway',
    });

    expect(fresh.kind).toBe('leased');
    if (fresh.kind !== 'leased') throw new Error('unreachable');
    expect(fresh.fence).toBeGreaterThan(old.fence);
    const row = await fixture.store.getProfile(basics.tenantId, fresh.profileId);
    expect(row?.lease?.holderInstanceId).toBe('inst_fresh');
  });

  it('still answers busy for a holder the caller did not name', async () => {
    await holdKey('user:alive', 'inst_alive');

    await expect(
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: 'inst_fresh',
        nodeId: basics.nodeId,
        spec: { mode: 'persistent', key: 'user:alive' },
        reclaimFromHolderInstanceId: 'inst_somebody_else',
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_BUSY' });
  });

  it('refuses the takeover when a live Chrome still holds the profile', async () => {
    await holdKey('user:survivor', 'inst_dead_gateway');
    fs.refuseNextClearSingleton(4242);

    await expect(
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: 'inst_fresh',
        nodeId: basics.nodeId,
        spec: { mode: 'persistent', key: 'user:survivor' },
        reclaimFromHolderInstanceId: 'inst_dead_gateway',
      }),
    ).rejects.toMatchObject({ code: 'E_PROFILE_UNREACHABLE' });
  });
});
