/**
 * Releasing a profile lease this process cannot vouch for from memory.
 *
 * `ProfileService` tracks granted leases in an in memory map, and every
 * path that resolved a lease through it (`release()`'s own lookup,
 * `leaseIdForInstance`, and therefore `ProfileServicePortAdapter.
 * releaseLeaseQuietly`) treated a cache miss as "nothing to do". The map is
 * empty after a restart, so a lease granted before one was a permanent
 * miss and its store row was never closed. Measured on the demo
 * deployment: 48 of 50 `profile_leases` rows still marked held, 47
 * profiles still reading `leased`, by instances released hours earlier.
 * That is not cosmetic, because `Store.getProfile` reports a profile's
 * single unreleased lease, so the next acquire on the same persistent key
 * fails `E_PROFILE_BUSY` against a holder that stopped existing.
 *
 * A real `store-sqlite` store throughout, not a mock: the whole question
 * is what the store actually says about a lease row, and the lease
 * resolution being exercised (`SELECT ... WHERE profile_id = ? AND
 * released_at IS NULL`) belongs to the store rather than to this package.
 *
 * A restart is simulated the way it really happens: a second
 * `ProfileService` over the same store, with its own empty lease map.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileService } from '../../src/profiles/ProfileService.js';
import { ProfileServicePortAdapter } from '../../src/profiles/adapter.js';
import type { RouterLogFields, RouterLogger } from '../../src/router/logger.js';
import { type FakeClock, createFakeClock } from '../support/fakeClock.js';
import { type FakeProfileFs, createFakeProfileFs } from './support/fakeProfileFs.js';
import {
  type Basics,
  type StoreFixture,
  freshRouterStore,
  seedBasics,
} from './support/testStore.js';

const TTL_MS = 30_000;

interface RecordingLogger extends RouterLogger {
  readonly warns: { fields: RouterLogFields; message: string }[];
}

function createRecordingLogger(): RecordingLogger {
  const warns: { fields: RouterLogFields; message: string }[] = [];
  return {
    warns,
    warn(fields, message) {
      warns.push({ fields, message });
    },
  };
}

describe('releasing an untracked profile lease', () => {
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

  /** Leases a fresh persistent profile for `instanceId` and returns its id. */
  async function leaseFor(instanceId: string, key: string): Promise<string> {
    const resolved = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'persistent', key },
      dryRun: false,
    });
    const grant = await adapter.lease({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId,
      nodeId: basics.nodeId,
      ttlMs: TTL_MS,
    });
    return grant.profileId;
  }

  /** A second service and adapter over the same store, with an empty lease map: what a process restart leaves behind. */
  function afterRestart(logger?: RouterLogger): ProfileServicePortAdapter {
    const restarted = new ProfileService({ store: fixture.store, fs, clock });
    return new ProfileServicePortAdapter(restarted, logger);
  }

  it('closes the store row for a lease granted before a restart, and puts the profile back to free', async () => {
    const profileId = await leaseFor('inst_restart', 'user:restart');
    const beforeRelease = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(beforeRelease?.lease).not.toBeNull();
    expect(beforeRelease?.state).toBe('leased');

    // The lease is now untracked and its TTL has run out, since nothing
    // renewed it across the restart.
    clock.advance(TTL_MS + 1_000);
    await afterRestart().releaseLeaseQuietly('inst_restart', {
      tenantId: basics.tenantId,
      profileId,
    });

    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease).toBeNull();
    expect(after?.state).toBe('free');
  });

  it('still does nothing when the caller cannot say which profile the lease is on', async () => {
    // A bare instance id is all the old signature carried, and a lease id
    // alone cannot be checked against anything: `Store` has no lookup by
    // lease id. Releasing blind on that basis is the one genuinely unsafe
    // move here, so this case is deliberately unchanged.
    const profileId = await leaseFor('inst_blind', 'user:blind');
    clock.advance(TTL_MS + 1_000);

    await afterRestart().releaseLeaseQuietly('inst_blind');

    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease).not.toBeNull();
  });

  it('leaves the lease alone when another instance has since taken it', async () => {
    // Releasing here would let a third party materialise onto a directory
    // the new holder's browser is writing to, which is the corruption the
    // lease exists to prevent.
    const profileId = await leaseFor('inst_first', 'user:contended');
    await adapter.releaseLeaseQuietly('inst_first', {
      tenantId: basics.tenantId,
      profileId,
      browserConfirmedGone: true,
    });
    const resolved = await adapter.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: { mode: 'persistent', key: 'user:contended' },
      dryRun: false,
    });
    await adapter.lease({
      tenantId: basics.tenantId,
      appId: basics.appId,
      spec: resolved.resolved,
      instanceId: 'inst_second',
      nodeId: basics.nodeId,
      ttlMs: TTL_MS,
    });

    clock.advance(TTL_MS + 1_000);
    const logger = createRecordingLogger();
    // The first instance's release arrives late, after the second has the lease.
    await afterRestart(logger).releaseLeaseQuietly('inst_first', {
      tenantId: basics.tenantId,
      profileId,
      browserConfirmedGone: true,
    });

    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease).not.toBeNull();
    expect(after?.lease?.holderInstanceId).toBe('inst_second');
    expect(logger.warns[0]?.message).toMatch(/another instance now holds it/);
  });

  it('leaves an unexpired lease alone when the caller cannot confirm the browser is gone, and says so', async () => {
    // The TTL is the only signal available to a caller that has not killed
    // the process itself, and something may still be renewing this lease.
    const profileId = await leaseFor('inst_maybe_live', 'user:maybe-live');
    const logger = createRecordingLogger();

    await afterRestart(logger).releaseLeaseQuietly('inst_maybe_live', {
      tenantId: basics.tenantId,
      profileId,
    });

    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease).not.toBeNull();
    expect(logger.warns).toHaveLength(1);
    expect(logger.warns[0]?.message).toMatch(/has not expired and the caller could not confirm/);
    expect(logger.warns[0]?.fields['profileId']).toBe(profileId);
  });

  it('releases that same unexpired lease when the caller HAS confirmed the browser is gone', async () => {
    // `BrowserRouter.release()` reaches its lease release only after
    // `terminateGraceThenForce` confirmed the process is gone, which is
    // stronger information than the TTL carries. Without this the window
    // that a restart followed promptly by a release lands in, one lease
    // TTL wide, would keep leaking, and nothing revisits a released
    // instance to try again.
    const profileId = await leaseFor('inst_confirmed', 'user:confirmed');
    const logger = createRecordingLogger();

    await afterRestart(logger).releaseLeaseQuietly('inst_confirmed', {
      tenantId: basics.tenantId,
      profileId,
      browserConfirmedGone: true,
    });

    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease).toBeNull();
    expect(after?.state).toBe('free');
    expect(logger.warns).toEqual([]);
  });

  it('does not overwrite a deleting profile with free', async () => {
    // `BrowserRouter.release()` step 6 runs `applyReleaseAction` first,
    // which for a destroy has already trashed the directory and set
    // `'deleting'`. Marking it `'free'` afterwards would advertise a
    // profile whose bytes are gone as available for reuse.
    const profileId = await leaseFor('inst_deleting', 'user:deleting');
    await fixture.store.setProfileState(basics.tenantId, profileId, 'deleting');
    clock.advance(TTL_MS + 1_000);

    await afterRestart().releaseLeaseQuietly('inst_deleting', {
      tenantId: basics.tenantId,
      profileId,
    });

    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease).toBeNull();
    expect(after?.state).toBe('deleting');
  });

  it('is idempotent and does not disturb an already released lease', async () => {
    const profileId = await leaseFor('inst_twice', 'user:twice');
    clock.advance(TTL_MS + 1_000);
    const restarted = afterRestart();

    await restarted.releaseLeaseQuietly('inst_twice', { tenantId: basics.tenantId, profileId });
    const afterFirst = await fixture.store.getProfile(basics.tenantId, profileId);
    await restarted.releaseLeaseQuietly('inst_twice', { tenantId: basics.tenantId, profileId });
    const afterSecond = await fixture.store.getProfile(basics.tenantId, profileId);

    expect(afterFirst?.lease).toBeNull();
    expect(afterSecond?.lease).toBeNull();
    expect(afterSecond?.state).toBe(afterFirst?.state);
  });

  it('trashes the directory of a profile released after a restart, which the in memory tenant lookup silently skipped', async () => {
    // The disk half of the same defect. `applyReleaseActionForInstance`
    // recovered the tenant from the in memory lease map and returned
    // silently when it came up empty, so a profile released after a
    // restart never had `trash()` called on it at all. That is why 51 of
    // the demo's 54 profile directories were still full rather than empty
    // shells: they were never handed to the filesystem to reclaim.
    const profileId = await leaseFor('inst_disk', 'user:disk');
    const restarted = afterRestart();
    const trashedBefore = fs.trashed.size;

    await restarted.applyReleaseAction({
      instanceId: 'inst_disk',
      profileId,
      action: 'destroy',
      tenantId: basics.tenantId,
    });

    expect(fs.trashed.size).toBe(trashedBefore + 1);
    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.state).toBe('deleting');
  });

  it('still skips the directory when no tenant is supplied and the lease is untracked, which is the old behaviour and all it can honestly do', async () => {
    const profileId = await leaseFor('inst_disk_blind', 'user:disk-blind');
    const restarted = afterRestart();
    const trashedBefore = fs.trashed.size;

    await restarted.applyReleaseAction({
      instanceId: 'inst_disk_blind',
      profileId,
      action: 'destroy',
    });

    expect(fs.trashed.size).toBe(trashedBefore);
  });

  it('ProfileService.release reports what it did with an untracked lease rather than claiming it was already released', async () => {
    const profileId = await leaseFor('inst_warned', 'user:warned');
    clock.advance(TTL_MS + 1_000);
    const restarted = new ProfileService({ store: fixture.store, fs, clock });

    const blind = await restarted.release({
      leaseId: 'plse_does_not_matter',
      fence: -1,
      reason: 'normal',
    });
    expect(blind.warnings[0]).toMatch(/no profile identity supplied/);

    const informed = await restarted.release({
      leaseId: 'plse_does_not_matter',
      fence: -1,
      reason: 'normal',
      identity: { tenantId: basics.tenantId, profileId, instanceId: 'inst_warned' },
    });
    expect(informed.warnings[0]).toMatch(/resolved as released/);
    const after = await fixture.store.getProfile(basics.tenantId, profileId);
    expect(after?.lease).toBeNull();
  });
});
