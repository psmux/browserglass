/**
 * GC steps 1 through 4 work (dryRun defaults true); steps 5 through 7,
 * and every method the task marks stubbed, throw `E_NOT_IMPLEMENTED`.
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

describe('ProfileService.gc and stubbed methods', () => {
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

  it('gc defaults dryRun to true and runs steps 1 through 4 without throwing', async () => {
    const result = await service.gc({ tenantId: basics.tenantId });
    expect(result.dryRun).toBe(true);
    expect(result.plan.map((p) => p.step).sort()).toEqual(
      ['excess-snapshots', 'expired-ephemeral', 'lru-ephemeral', 'trash'].sort(),
    );
    for (const entry of result.plan) expect(entry.applied).toBe(false);
  });

  it('gc({dryRun:false}) applies and actually trashes an expired ephemeral profile', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'ephemeral', destroyOnRelease: true },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');
    // Release without destroying via the normal path first is not
    // possible for ephemeral (always destroyed); instead simulate an
    // ephemeral profile that survived release by directly flipping it
    // free in the store so gc's expired-ephemeral step has something to
    // find, matching "TTL expiry fires regardless of node beliefs".
    await fixture.store.releaseProfileLease(acquired.leaseId, 'normal');
    await fixture.store.updateProfile(basics.tenantId, acquired.profileId, {
      state: 'free',
      expiresAt: clock.now() - 1,
    });

    const result = await service.gc({
      tenantId: basics.tenantId,
      dryRun: false,
      steps: ['expired-ephemeral'],
    });
    expect(result.plan[0]?.applied).toBe(true);
    expect(result.plan[0]?.profileIds).toContain(acquired.profileId);
    const row = await fixture.store.getProfile(basics.tenantId, acquired.profileId);
    expect(row?.state).toBe('deleting');
  });

  it('gc throws E_NOT_IMPLEMENTED for cache-trim, stale-persistent, or unused-templates', async () => {
    for (const step of ['cache-trim', 'stale-persistent', 'unused-templates'] as const) {
      await expect(service.gc({ tenantId: basics.tenantId, steps: [step] })).rejects.toMatchObject({
        code: 'E_NOT_IMPLEMENTED',
      });
    }
  });

  it('snapshot, export, import, restore, salvage, migrate, storageState, and seed all throw E_NOT_IMPLEMENTED', async () => {
    const stubbed = [
      service.snapshot(),
      service.export(),
      service.import(),
      service.restore(),
      service.salvage(),
      service.migrate(),
      service.storageState(),
      service.seed(),
    ];
    for (const p of stubbed) {
      await expect(p).rejects.toBeInstanceOf(ProfileServiceError);
      await expect(p).rejects.toMatchObject({ code: 'E_NOT_IMPLEMENTED' });
    }
  });

  it('applyReleaseAction throws E_NOT_IMPLEMENTED for snapshotThenKeep/snapshotThenDestroy', async () => {
    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_1',
      nodeId: basics.nodeId,
      spec: { mode: 'persistent', key: 'user:snap-stub' },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');
    await expect(
      service.applyReleaseActionForInstance('inst_1', acquired.profileId, 'snapshotThenKeep'),
    ).rejects.toMatchObject({ code: 'E_NOT_IMPLEMENTED' });
  });

  it('materialising from an existing frozen template directory IS implemented (not a stub)', async () => {
    // Bake a "frozen template" by hand: a profiles row with mode='template' and a path.
    const template = await fixture.store.createProfile({
      tenantId: basics.tenantId,
      appId: basics.appId,
      key: 'tpl:base',
      mode: 'template',
      storagePath: 'tenants/x/templates/tpl_base/udd',
    });
    await fixture.store.setProfileState(basics.tenantId, template.id, 'free');

    const acquired = await service.acquire({
      tenantId: basics.tenantId,
      appId: basics.appId,
      instanceId: 'inst_from_template',
      nodeId: basics.nodeId,
      spec: { mode: 'template', templateId: template.id },
    });
    expect(acquired.kind).toBe('leased');
    if (acquired.kind !== 'leased') throw new Error('unreachable');
    expect(acquired.materialisation).toBe('template-clone');
    const materialiseCall = fs.calls.find((c) => c.method === 'materialise');
    expect(materialiseCall).toBeDefined();
    const req = materialiseCall?.args[0] as { from: { kind: string; templateDir?: string } };
    expect(req.from.kind).toBe('template');
    expect(req.from.templateDir).toBe(template.path);
  });
});
