import type { Store } from '@browserglass/protocol';
/**
 * `release`'s deliberate step order: the trash rename
 * strictly before the store update. A crash injected between them must
 * leave a sweepable trashed directory and no live directory the store
 * believes is gone (the store still, correctly, believes the lease and
 * profile are live; the sweeper's reconciliation pass is what later
 * notices the directory already moved).
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

/** Wraps a real `Store` so its `releaseProfileLease` throws exactly once, simulating a crash between the trash rename and the store update. */
function withReleaseCrashOnce(store: Store): Store {
  let armed = true;
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === 'releaseProfileLease' && armed) {
        armed = false;
        return () =>
          Promise.reject(new Error('simulated crash between trash rename and store update'));
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

describe('ProfileService.release crash injection', () => {
  let fixture: StoreFixture;
  let basics: Basics;
  let fs: FakeProfileFs;
  let clock: FakeClock;

  beforeEach(async () => {
    fixture = await freshRouterStore();
    basics = await seedBasics(fixture.store);
    fs = createFakeProfileFs();
    clock = createFakeClock(Date.now());
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('a crash between the trash rename and the store update leaves a sweepable directory and no live directory the store believes is gone', async () => {
    const crashingStore = withReleaseCrashOnce(fixture.store);
    const service = new ProfileService({ store: crashingStore, fs, clock });

    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    const dirsBefore = new Set(fs.dirs);
    expect(dirsBefore.has(acquired.path)).toBe(true);

    await expect(
      service.release({ leaseId: acquired.leaseId, fence: acquired.fence, reason: 'normal' }),
    ).rejects.toThrow();

    // The trash rename already happened (step 5): the directory is gone
    // from the live set and present in trash, so it is sweepable.
    expect(fs.dirs.has(acquired.path)).toBe(false);
    expect([...fs.trashed.values()]).toContain('ephemeral');

    // The store update (step 6) never ran: it still believes the profile
    // is leased and the lease is still live. This is NOT a leak (a live
    // directory the store thinks is gone); it is a harmless orphaned
    // trash entry the sweeper will find and unlink.
    const row = await fixture.store.getProfile(basics.tenantId, acquired.profileId);
    expect(row?.state).toBe('leased');
    expect(row?.lease).not.toBeNull();
    expect(row?.lease?.id).toBe(acquired.leaseId);
  });

  it('without the injected crash, release completes normally: trashed, and the store shows free/deleting with no live lease', async () => {
    const service = new ProfileService({ store: fixture.store, fs, clock });
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    await service.release({ leaseId: acquired.leaseId, fence: acquired.fence, reason: 'normal' });

    expect(fs.dirs.has(acquired.path)).toBe(false);
    const row = await fixture.store.getProfile(basics.tenantId, acquired.profileId);
    expect(row?.lease).toBeNull();
    expect(row?.state).toBe('deleting'); // ephemeral: destroyed, never simply 'free'
  });
});
