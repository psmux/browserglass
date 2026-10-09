/**
 * Fencing: strictly increases across release and re-acquire, and never
 * decreases across a simulated restore (the directory bytes changing
 * underneath the profile does not reset the fence, since the fence lives
 * in the store, never in the directory itself).
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

describe('ProfileService fencing', () => {
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

  it('strictly increases across release and re-acquire', async () => {
    const key = 'user:fence-cycle';
    const fences: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const acquired = await service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: `inst_${i}`,
        nodeId: basics.nodeId,
        spec: { mode: 'persistent', key },
      });
      expect(acquired.kind).toBe('leased');
      if (acquired.kind !== 'leased') throw new Error('unreachable');
      fences.push(acquired.fence);
      await service.release({ leaseId: acquired.leaseId, fence: acquired.fence, reason: 'normal' });
    }
    for (let i = 1; i < fences.length; i += 1) {
      expect(fences[i]).toBeGreaterThan(fences[i - 1] as number);
    }
  });

  it('never decreases across a simulated restore (fence lives in the store, not the directory)', async () => {
    const key = 'user:fence-restore';
    const first = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key },
    });
    expect(first.kind).toBe('leased');
    if (first.kind !== 'leased') throw new Error('unreachable');
    await service.release({ leaseId: first.leaseId, fence: first.fence, reason: 'normal' });

    // Simulate a restore: the on-disk .bgls-fence marker is wiped, as an
    // interrupted or replaced materialisation would leave it (absent is
    // treated as fence 0), but the store's fence sequence is
    // untouched.
    for (const path of fs.fences.keys()) fs.fences.set(path, null);

    const second = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_2',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key },
    });
    expect(second.kind).toBe('leased');
    if (second.kind !== 'leased') throw new Error('unreachable');
    expect(second.fence).toBeGreaterThan(first.fence);
  });

  it('writes .bgls-fence before returning, and it reads back the granted fence', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');
    expect(fs.fences.get(acquired.path)).toBe(acquired.fence);
  });
});
