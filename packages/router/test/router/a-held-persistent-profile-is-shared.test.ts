/**
 * A second acquire of a persistent profile key whose browser is already
 * running gets that same browser back.
 *
 * It never did. `BrowserRouter.doAcquire` calls `profiles.resolve` before
 * `findReusable`, and the real adapter answered a held key with
 * `E_PROFILE_BUSY` on the assumption that the reuse check had already run.
 * So the router's `profile-shared` branch was unreachable in production,
 * and every router test of it passed only because the fake profile port
 * never throws. These tests wire the REAL `ProfileService` and its adapter
 * over a real SQLite store, so the lease the first acquire takes is the
 * lease the second one finds.
 */

import type { AppId, Capability, Principal, Scope, TenantId } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileService } from '../../src/profiles/ProfileService.js';
import { ProfileServicePortAdapter } from '../../src/profiles/adapter.js';
import type { LiveViewerPort } from '../../src/router/types.js';
import { createFakeProfileFs } from '../profiles/support/fakeProfileFs.js';
import { type StoreFixture, freshRouterStore } from '../profiles/support/testStore.js';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';

const KEY = 'shared-demo';

function principalFor(tenantId: string, appId: string, scope: Scope = { kind: 'tenant' }): Principal {
  return {
    tenantId: tenantId as TenantId,
    appId: appId as AppId,
    sub: 'user-1',
    subKind: 'user',
    caps: ['instance.create', 'view', 'control'] as Capability[],
    scope,
    jti: newId('jti'),
    exp: 9_999_999_999,
  };
}

let fixture: StoreFixture | null = null;

afterEach(async () => {
  await fixture?.cleanup();
  fixture = null;
});

async function setUp(opts?: { viewers?: LiveViewerPort }) {
  fixture = await freshRouterStore();
  const store = fixture.store;
  const clock = createFakeClock(Date.now());
  const tenant = await store.createTenant({ name: 'Acme' });
  const app = await store.createApp({ tenantId: tenant.id, name: 'demo-app' });
  const node = await store.registerNode({
    name: 'node-1',
    runtime: 'host',
    address: 'http://127.0.0.1:9000',
    registrationSecretEnc: 'enc',
  });
  const spec = await store.upsertBrowserSpec(tenant.id, {
    engine: 'chromium',
    channel: 'chrome',
    headless: 'new',
    viewportW: 1280,
    viewportH: 720,
    dpr: 1,
    locale: null,
    timezone: null,
    userAgent: null,
    proxy: null,
    args: [],
    extensions: [],
    stealth: 'off',
    limits: {},
  });
  await store.createPool({ tenantId: tenant.id, name: 'default', specId: spec.id });

  const service = new ProfileService({ store, fs: createFakeProfileFs(), clock });
  const t = createTestRouter(clock, {
    store,
    nodeId: node.id,
    profiles: new ProfileServicePortAdapter(service),
    ...(opts?.viewers ? { viewers: opts.viewers } : {}),
  });
  return { ...t, clock, principal: principalFor(tenant.id, app.id) };
}

describe('a persistent profile held by a running browser', () => {
  it('hands the second acquire the same running instance', async () => {
    const { router, nodes, principal } = await setUp();

    const first = await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);
    expect(first.result.reused).toBe(false);

    const second = await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);

    expect(second.result.instanceId).toBe(first.result.instanceId);
    expect(second.result.reused).toBe(true);
    expect(second.result.reuseReason).toBe('profile-shared');
    // Chrome cannot open one user data dir twice, so there must be exactly one launch.
    expect(nodes.launchCount).toBe(1);
  });

  it('refuses with the reason when the request asks for different browser settings', async () => {
    const { router, nodes, principal } = await setUp();
    await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);

    const refused = router.acquire(
      { profile: { mode: 'persistent', key: KEY }, browser: { headless: 'off' } },
      principal,
    );

    await expect(refused).rejects.toMatchObject({
      code: 'E_PROFILE_BUSY',
      message: expect.stringContaining('headless'),
    });
    expect(nodes.launchCount).toBe(1);
  });

  it('refuses with the reason when the holder is at its viewer limit', async () => {
    const { router, principal } = await setUp({ viewers: { countFor: () => 1_000 } });
    await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);

    await expect(
      router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal),
    ).rejects.toMatchObject({
      code: 'E_PROFILE_BUSY',
      message: expect.stringContaining('viewer limit'),
    });
  });

  it('does not hand a narrowed token an instance outside its scope', async () => {
    const { router, principal } = await setUp();
    await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);
    const narrowed = principalFor(principal.tenantId, principal.appId, {
      kind: 'instance',
      instanceId: newId('inst'),
      targets: '*',
    });

    await expect(
      router.acquire({ profile: { mode: 'persistent', key: KEY } }, narrowed),
    ).rejects.toMatchObject({
      code: 'E_PROFILE_BUSY',
      message: expect.stringContaining('scope'),
    });
  });

  it('launches a fresh browser on the profile once the holder is released', async () => {
    const { router, nodes, principal } = await setUp();
    const first = await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);
    await router.release(first.result.instanceId as never, {}, principal);

    const next = await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);

    expect(next.result.instanceId).not.toBe(first.result.instanceId);
    expect(next.result.reused).toBe(false);
    expect(nodes.launchCount).toBe(2);
  });
});
