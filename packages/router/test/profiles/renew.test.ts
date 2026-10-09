/**
 * `renew`: fence conditional, and the stale-fence protocol's part
 * `ProfileService` owns (steps 4 through 7): it never touches the profile
 * directory, reports via `onFenceLost`, and completes well inside
 * `fenceLostReactionBudgetMs` (500 ms).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileService } from '../../src/profiles/ProfileService.js';
import type { FenceLostReport } from '../../src/profiles/types.js';
import { type FakeClock, createFakeClock } from '../support/fakeClock.js';
import { type FakeProfileFs, createFakeProfileFs } from './support/fakeProfileFs.js';
import {
  type Basics,
  type StoreFixture,
  freshRouterStore,
  seedBasics,
} from './support/testStore.js';

describe('ProfileService.renew', () => {
  let fixture: StoreFixture;
  let basics: Basics;
  let fs: FakeProfileFs;
  let clock: FakeClock;
  let fenceLostReports: FenceLostReport[];
  let service: ProfileService;

  beforeEach(async () => {
    fixture = await freshRouterStore();
    basics = await seedBasics(fixture.store);
    fs = createFakeProfileFs();
    clock = createFakeClock(Date.now());
    fenceLostReports = [];
    service = new ProfileService({
      store: fixture.store,
      fs,
      clock,
      onFenceLost: (r) => fenceLostReports.push(r),
    });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('extends the lease and returns a new expiresAt on a matching fence', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    clock.advance(5_000);
    const result = await service.renew({ leaseId: acquired.leaseId, fence: acquired.fence });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.expiresAt).toBeGreaterThan(acquired.expiresAt);
  });

  it('a mismatched fence is treated as stale, triggers the report, and touches no file', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    const callsBefore = fs.callCount();
    const startedAt = performance.now();
    const result = await service.renew({ leaseId: acquired.leaseId, fence: acquired.fence + 1 });
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(elapsedMs).toBeLessThan(500);
    expect(fs.callCount()).toBe(callsBefore); // step 4: do not touch the directory
    expect(fenceLostReports).toHaveLength(1);
    expect(fenceLostReports[0]?.reason).toBe('stale');
    expect(fenceLostReports[0]?.leaseId).toBe(acquired.leaseId);
  });

  it('an already-expired lease (fence otherwise correct) is treated as stale without a false renewal, and touches no file', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
      leaseTtlMs: 10_000,
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    clock.advance(20_000); // well past the 10s TTL
    const callsBefore = fs.callCount();
    const startedAt = performance.now();
    const result = await service.renew({ leaseId: acquired.leaseId, fence: acquired.fence });
    const elapsedMs = performance.now() - startedAt;

    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(elapsedMs).toBeLessThan(500);
    expect(fs.callCount()).toBe(callsBefore);
    expect(fenceLostReports).toHaveLength(1);

    // A second renew of the same (now untracked) lease reports 'gone', still no file access.
    const second = await service.renew({ leaseId: acquired.leaseId, fence: acquired.fence });
    expect(second).toEqual({ ok: false, reason: 'gone' });
    expect(fs.callCount()).toBe(callsBefore);
  });

  it('renewing a lease that was stolen (released by the store) reports released/no-longer-tracked, and touches no file', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');

    // Simulate a steal happening entirely out of band (another node's
    // ProfileService instance released this exact lease row).
    await fixture.store.releaseProfileLease(acquired.leaseId, 'stolen');

    const callsBefore = fs.callCount();
    const result = await service.renew({ leaseId: acquired.leaseId, fence: acquired.fence });
    expect(result.ok).toBe(false);
    expect(fs.callCount()).toBe(callsBefore);
  });

  it('renewing an untracked lease id reports gone without any store or filesystem call for a real lookup', async () => {
    const result = await service.renew({ leaseId: 'plse_never_existed', fence: 1 });
    expect(result).toEqual({ ok: false, reason: 'gone' });
  });
});
