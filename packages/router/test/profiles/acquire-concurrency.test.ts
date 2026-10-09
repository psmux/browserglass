/**
 * The primary "Done when" criterion: two concurrent `acquire` calls for
 * the same profile key, driven as genuine concurrent async calls against
 * the real `store-sqlite` `Store` (never sequential calls dressed up as
 * concurrent), produce exactly one lease and one `E_PROFILE_BUSY`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileService } from '../../src/profiles/ProfileService.js';
import { ProfileServiceError } from '../../src/profiles/errors.js';
import { type FakeClock, createFakeClock } from '../support/fakeClock.js';
import { type FakeProfileFs, createFakeProfileFs } from './support/fakeProfileFs.js';
import {
  type Basics,
  type StoreFixture,
  freshRouterStore,
  seedBasics,
} from './support/testStore.js';

describe('ProfileService.acquire concurrency', () => {
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

  it('two real concurrent acquires for one persistent key produce exactly one lease and one E_PROFILE_BUSY', async () => {
    const key = 'user:contended';
    const results = await Promise.allSettled([
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: 'inst_a',
        nodeId: basics.nodeId,
        spec: { mode: 'persistent', key },
      }),
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: 'inst_b',
        nodeId: basics.nodeId,
        spec: { mode: 'persistent', key },
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<typeof service.acquire>>
    >[];
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]?.value.kind).toBe('leased');
    expect(rejected[0]?.reason).toBeInstanceOf(ProfileServiceError);
    expect((rejected[0]?.reason as ProfileServiceError).code).toBe('E_PROFILE_BUSY');

    // Exactly one live lease row for the profile in the store.
    const row = await fixture.store.getProfileByKey(basics.tenantId, basics.appId, key);
    expect(row).not.toBeNull();
    expect(row?.lease).not.toBeNull();
  });

  it('two real concurrent acquires for two different ephemeral instances never collide', async () => {
    const results = await Promise.all([
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: 'inst_x',
        nodeId: basics.nodeId,
        spec: { mode: 'ephemeral' },
      }),
      service.acquire({
        tenantId: basics.tenantId,
        appId: basics.appId,
        instanceId: 'inst_y',
        nodeId: basics.nodeId,
        spec: { mode: 'ephemeral' },
      }),
    ]);
    expect(results[0].kind).toBe('leased');
    expect(results[1].kind).toBe('leased');
    if (results[0].kind === 'leased' && results[1].kind === 'leased') {
      expect(results[0].profileId).not.toBe(results[1].profileId);
    }
  });
});
