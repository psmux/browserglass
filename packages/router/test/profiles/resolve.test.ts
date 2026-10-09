import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileService } from '../../src/profiles/ProfileService.js';
import { type FakeClock, createFakeClock } from '../support/fakeClock.js';
import { type FakeProfileFs, createFakeProfileFs } from './support/fakeProfileFs.js';
import {
  type Basics,
  type StoreFixture,
  createTestInstance,
  freshRouterStore,
  seedBasics,
} from './support/testStore.js';

describe('ProfileService.resolve', () => {
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

  it('defaults dryRun to true and never creates a row', async () => {
    const result = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      spec: { mode: 'persistent', key: 'user:speculative' },
    });
    expect(result.kind).toBe('lease');
    if (result.kind === 'lease') {
      expect(result.profileId).toBeNull();
      expect(result.created).toBe(false);
    }
    const row = await fixture.store.getProfileByKey(
      basics.tenantId,
      basics.appId,
      'user:speculative',
    );
    expect(row).toBeNull();
  });

  it('with dryRun false, creates the row and reports created:true', async () => {
    const result = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      spec: { mode: 'persistent', key: 'user:real' },
      dryRun: false,
    });
    expect(result.kind).toBe('lease');
    if (result.kind === 'lease') {
      expect(result.profileId).not.toBeNull();
      expect(result.created).toBe(true);
    }
    const row = await fixture.store.getProfileByKey(basics.tenantId, basics.appId, 'user:real');
    expect(row).not.toBeNull();
  });

  it('rejects a reserved key prefix as an error result', async () => {
    const result = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      spec: { mode: 'persistent', key: 'eph:not-allowed' },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.code).toBe('E_PROFILE_KEY_RESERVED');
  });

  it('ephemeral mode never looks anything up, key is eph:<instanceId>', async () => {
    const result = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_42',
      spec: { mode: 'ephemeral' },
    });
    expect(result.kind).toBe('lease');
    if (result.kind === 'lease') {
      expect(result.resolved.key).toBe('eph:inst_42');
      expect(result.resolved.destroyOnRelease).toBe(true);
      expect(result.profileId).toBeNull();
    }
  });

  it('a free profile (acquired then released) resolves to lease kind with profileId set', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:free' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind === 'leased') {
      await service.release({ leaseId: acquired.leaseId, fence: acquired.fence, reason: 'normal' });
    }
    const result = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      spec: { mode: 'persistent', key: 'user:free' },
    });
    expect(result.kind).toBe('lease');
    if (result.kind === 'lease') expect(result.profileId).not.toBeNull();
  });

  it('the same raw key in a different app is a distinct profile (app scoped, not tenant scoped)', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_owner',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:shared' },
    });
    expect(acquired.kind).toBe('leased');

    const otherApp = await fixture.store.createApp({
      tenantId: basics.tenantId,
      name: 'other-app',
    });
    const result = await service.resolve({
      tenantId: basics.tenantId,
      appId: otherApp.id,
      instanceId: 'inst_2',
      spec: { mode: 'persistent', key: 'user:shared' },
    });
    // Different app, different key namespace (t:/a:/ scoping), so this
    // simply looks like "not found" rather than busy, proving app scoping.
    expect(result.kind).toBe('lease');
  });

  it('a leased profile resolved by the same app that holds it returns a reuse instruction', async () => {
    await createTestInstance(fixture.store, basics, 'inst_owner');
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_owner',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:shared2' },
    });
    expect(acquired.kind).toBe('leased');

    const result = await service.resolve({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_2',
      spec: { mode: 'persistent', key: 'user:shared2' },
    });
    expect(result.kind).toBe('reuse');
    if (result.kind === 'reuse') expect(result.instanceId).toBe('inst_owner');
  });
});
