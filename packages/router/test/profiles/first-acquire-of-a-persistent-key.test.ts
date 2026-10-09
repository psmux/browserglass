/**
 * The first acquire of a persistent key, which did not work at all.
 *
 * `BrowserRouter.doAcquire` calls `profiles.resolve({ dryRun: false })`
 * with `false` written as a literal, on every acquire. On a persistent key
 * with no row that INSERTs the row (`Store.createProfile` hard codes
 * `state = 'creating'`) and materialises nothing. Placement then calls
 * `lease`, which reached `acquirePersistent`, which materialised only when
 * IT had created the row. It had not, so nothing was made, and the fence
 * write opened `<udd>/.bgls-fence` inside a directory that did not exist:
 *
 *   E_LAUNCH_FAILED: every placement candidate failed:
 *     ENOENT: no such file or directory,
 *     open '...\profiles\prf_...\udd\.bgls-fence'
 *
 * It then compounded twice. The row stayed in `creating`, so every later
 * acquire answered `E_PROFILE_BUSY` for ever; and the lease row had
 * already been INSERTed but was only TRACKED after the fence write, so the
 * release path (which finds a lease through an in-memory instance to lease
 * map that `trackLease` alone populates) could never see it, and neither
 * `loadLiveLease` nor `findReusable` tests expiry, so nothing reaped it.
 *
 * These tests drive the real two step shape, `resolve({dryRun:false})`
 * then `acquire`, rather than `acquire` alone, because `acquire` alone was
 * never the broken path.
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

describe('the first acquire of a persistent key', () => {
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

  const spec = { mode: 'persistent' as const, key: 'user:alice' };

  async function resolveThenAcquire(instanceId: string) {
    const resolved = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec,
      dryRun: false,
    });
    if (resolved.kind !== 'lease')
      throw new Error(`resolve did not return a lease: ${JSON.stringify(resolved)}`);
    return service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId,
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });
  }

  it('materialises the directory resolve created a row for, and grants the lease', async () => {
    const grant = await resolveThenAcquire('inst_first');

    expect(grant.kind).toBe('leased');
    // The directory really was made, and the fence really landed in it.
    // Before the fix this call threw ENOENT from the fence write.
    expect(fs.dirs.has(grant.path)).toBe(true);
    expect(fs.fences.get(grant.path)).toBe(grant.fence);
    expect(grant.materialisation).toBe('empty');

    const row = await fixture.store.getProfile(basics.tenantId, grant.profileId);
    expect(row?.state).toBe('leased');
  });

  it('heals a key already poisoned into creating by the old failure', async () => {
    // Exactly the residue the defect left behind: a row that exists, in
    // `creating`, with nothing on disk. Produced here the same way it was
    // produced in the field, by resolve alone.
    const resolved = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec,
      dryRun: false,
    });
    if (resolved.kind !== 'lease') throw new Error('resolve did not return a lease');
    const profileId = resolved.resolved.profileId as string;
    expect((await fixture.store.getProfile(basics.tenantId, profileId))?.state).toBe('creating');
    expect(fs.dirs.size).toBe(0);

    // A later acquire, by a different instance, on the same poisoned key.
    const grant = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId: 'inst_later',
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });

    expect(grant.kind).toBe('leased');
    expect(grant.profileId).toBe(profileId);
    expect(fs.dirs.has(grant.path)).toBe(true);
  });

  it('releases the lease it took when the fence write fails, so the key is not left held', async () => {
    // The lease is INSERTed before the fence is written. Track it only
    // afterwards, as the old code did, and a fence failure leaves a row
    // with `released_at` null that nothing can find: the release path
    // looks the lease up by instance id in a map only `trackLease` fills.
    const resolved = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec,
      dryRun: false,
    });
    if (resolved.kind !== 'lease') throw new Error('resolve did not return a lease');
    const profileId = resolved.resolved.profileId as string;

    // Make the fence write fail the way a full disk or a vanished
    // directory does, AFTER materialisation has succeeded.
    const realWriteFence = fs.writeFence.bind(fs);
    let failed = false;
    fs.writeFence = (path: string, fence: number): Promise<void> => {
      if (!failed) {
        failed = true;
        return Promise.reject(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        );
      }
      return realWriteFence(path, fence);
    };

    await expect(
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        spec: resolved.resolved,
        instanceId: 'inst_fence_fail',
        nodeId: basics.nodeId,
        ttlMs: 30_000,
      }),
    ).rejects.toThrow(/EACCES/);

    // The lease it took on the way through is released, not stranded.
    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease ?? null).toBeNull();

    // And because it was released rather than stranded, the very next
    // acquire succeeds instead of answering E_PROFILE_BUSY for ever.
    const grant = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId: 'inst_retry',
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });
    expect(grant.kind).toBe('leased');
  });
});
