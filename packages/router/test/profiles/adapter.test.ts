/**
 * `ProfileServicePortAdapter`: the seam `BrowserRouter` and `LocalNode`
 * consume (`../../src/router/types.ts`'s `ProfileServicePort`). A round trip through `resolve` -> `lease` ->
 * `materialisedPathFor` -> `releaseLeaseQuietly` exercises the adapter the
 * same way `BrowserRouter.acquire`/`release` do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileService } from '../../src/profiles/ProfileService.js';
import { ProfileServicePortAdapter } from '../../src/profiles/adapter.js';
import { type FakeClock, createFakeClock } from '../support/fakeClock.js';
import { type FakeProfileFs, createFakeProfileFs } from './support/fakeProfileFs.js';
import {
  type Basics,
  type StoreFixture,
  createTestInstance,
  freshRouterStore,
  seedBasics,
} from './support/testStore.js';

describe('ProfileServicePortAdapter', () => {
  let fixture: StoreFixture;
  let basics: Basics;
  let fs: FakeProfileFs;
  let clock: FakeClock;
  let service: ProfileService;
  let adapter: ProfileServicePortAdapter;

  beforeEach(async () => {
    fixture = await freshRouterStore();
    basics = await seedBasics(fixture.store);
    fs = createFakeProfileFs();
    clock = createFakeClock(Date.now());
    service = new ProfileService({ store: fixture.store, fs, clock });
    adapter = new ProfileServicePortAdapter(service);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('resolve -> lease -> materialisedPathFor -> releaseLeaseQuietly round trips', async () => {
    const resolved = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'persistent', key: 'user:port-test' },
      dryRun: false,
    });
    expect(resolved.created).toBe(true);
    expect(resolved.resolved.profileId).not.toBeNull();

    const grant = await adapter.lease({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId: 'inst_port',
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });
    expect(grant.fence).toBeGreaterThan(0);
    expect(grant.storedKey).toBe(`t:${basics.tenantId}/a:${basics.appId}/user:port-test`);

    const materialised = await adapter.materialisedPathFor(grant.storedKey);
    expect(materialised.path).toMatch(/udd$/);

    // Idempotent: releasing twice never throws (port contract).
    await adapter.releaseLeaseQuietly('inst_port');
    await adapter.releaseLeaseQuietly('inst_port');

    const row = await fixture.store.getProfile(
      basics.tenantId,
      resolved.resolved.profileId as string,
    );
    expect(row?.lease).toBeNull();
  });

  it('resolve names a profile held by a live instance of the same app instead of refusing it', async () => {
    // Sharing that holder, or refusing it with a reason, is the router's
    // `findReusable` decision, which runs AFTER resolve. Throwing here made
    // every second acquire of a held persistent key fail E_PROFILE_BUSY.
    await createTestInstance(fixture.store, basics, 'inst_holder');
    const first = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'persistent', key: 'user:held' },
      dryRun: false,
    });
    await adapter.lease({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: first.resolved,
      instanceId: 'inst_holder',
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });

    const again = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'persistent', key: 'user:held' },
      dryRun: false,
    });

    expect(again.created).toBe(false);
    expect(again.resolved.key).toBe('user:held');
    expect(again.resolved.profileId).toBe(first.resolved.profileId);
  });

  it('releaseLeaseQuietly reports a swallowed release failure instead of discarding it', async () => {
    // `ProfileService.release()` trashes an ephemeral profile's directory
    // BEFORE its store write, so anything that throws in that trash also
    // skips `store.releaseProfileLease` and leaves the lease row marked
    // held forever. The adapter's contract is still "never throw" (a throw
    // here would strand the instance row in `draining`), so the only way
    // that failure can ever be seen is this log line. Measured on the demo
    // database: 46 of 48 lease rows were still marked held, by instances
    // released hours earlier, and nothing anywhere had said a word.
    const warns: { fields: Readonly<Record<string, unknown>>; message: string }[] = [];
    const failingFs = {
      ...fs,
      trash: (): Promise<string> =>
        Promise.reject(
          Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' }),
        ),
    };
    const failingService = new ProfileService({ store: fixture.store, fs: failingFs, clock });
    const failingAdapter = new ProfileServicePortAdapter(failingService, {
      warn(fields, message) {
        warns.push({ fields, message });
      },
    });

    const resolved = await failingAdapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'ephemeral' },
      dryRun: false,
    });
    await failingAdapter.lease({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId: 'inst_noisy',
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });

    // Contract preserved: it does not throw.
    await expect(failingAdapter.releaseLeaseQuietly('inst_noisy')).resolves.toBeUndefined();

    expect(warns).toHaveLength(1);
    expect(warns[0]?.message).toMatch(/profile lease release failed/);
    expect(warns[0]?.fields['instanceId']).toBe('inst_noisy');
    expect(warns[0]?.fields['errorCode']).toBe('EPERM');
  });

  it('hasShareGrant reflects grants recorded via ProfileService.grantShare', async () => {
    const resolved = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'persistent', key: 'user:grant-test' },
      dryRun: false,
    });
    const profileId = resolved.resolved.profileId as string;
    expect(await adapter.hasShareGrant(profileId, 'app_other', 'read')).toBe(false);
    service.grantShare(profileId, 'app_other', 'read');
    expect(await adapter.hasShareGrant(profileId, 'app_other', 'read')).toBe(true);
    expect(await adapter.hasShareGrant(profileId, 'app_other', 'write')).toBe(false);
  });

  it('applyReleaseAction(destroy) trashes the directory before the lease is released', async () => {
    const resolved = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'persistent', key: 'user:destroy-test' },
      dryRun: false,
    });
    const grant = await adapter.lease({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId: 'inst_destroy',
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });
    await adapter.applyReleaseAction({
      instanceId: 'inst_destroy',
      profileId: grant.profileId,
      action: 'destroy',
    });
    const row = await fixture.store.getProfile(basics.tenantId, grant.profileId);
    expect(row?.state).toBe('deleting');
    // A persistent profile keeps the 7 day `'deleted'` window: that window
    // is the only chance to undo an explicit destroy of something durable.
    expect([...fs.trashed.values()]).toEqual(['deleted']);
  });

  it('trashes a destroyed ephemeral profile into the ephemeral retention bucket, not the 7 day one', async () => {
    // The kind decides how long the sweeper leaves the directory in
    // `trash/`. Tagging a browser that lived for a minute as `'deleted'`
    // parked its bytes there for a week, which turns a fixed leak back
    // into a slower one.
    const resolved = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'ephemeral' },
      dryRun: false,
    });
    const grant = await adapter.lease({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId: 'inst_eph_destroy',
      nodeId: basics.nodeId,
      ttlMs: 30_000,
    });
    await adapter.applyReleaseAction({
      instanceId: 'inst_eph_destroy',
      profileId: grant.profileId,
      action: 'destroy',
    });
    expect([...fs.trashed.values()]).toEqual(['ephemeral']);
  });
});
