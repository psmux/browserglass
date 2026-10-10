/**
 * Two scripts started together with one persistent profile key. The first
 * acquire takes the lease and starts launching; the second finds that
 * holder still `launching`. It used to be refused `E_PROFILE_BUSY` a
 * moment before the browser it should have shared became ready. It now
 * waits, up to `profileShareWaitMs`, and shares.
 */

import type { Capability, InstanceId, Principal, ProfileLease } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { toStoredSpecInput } from '../../src/router/specMapping.js';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

const KEY = 'shared-demo';

async function setUp() {
  const clock = createFakeClock(1_000_000);
  const nodeId = newId('nod');
  const t = createTestRouter(clock, { nodeId });
  const { store } = t;
  const { tenantId, appId, poolId } = seedBasics(store);
  const specId = (await store.upsertBrowserSpec(tenantId, toStoredSpecInput(DEFAULT_BROWSER_SPEC)))
    .id;
  const profile = await store.createProfile({
    tenantId,
    appId,
    key: KEY,
    mode: 'persistent',
    templateId: null,
    storagePath: `/fake/${KEY}/udd`,
    ttlMs: null,
  });
  // The first acquire's instance, still launching.
  const holder = await store.createInstance({
    tenantId,
    appId,
    poolId,
    nodeId,
    specId,
    profileId: profile.id,
    createdBySub: 'user-1',
    metadata: {},
    lifetime: 'viewer-bound',
  });
  const lease: ProfileLease = {
    id: newId('plse'),
    profileId: profile.id,
    tenantId,
    holderInstanceId: holder.id,
    holderNodeId: nodeId,
    holderPid: null,
    fence: 1,
    acquiredAt: clock.now(),
    heartbeatAt: clock.now(),
    expiresAt: clock.now() + 30_000,
    releasedAt: null,
    releaseReason: null,
  };
  (await store.getProfile(tenantId, profile.id))!.lease = lease;
  const principal: Principal = {
    tenantId,
    appId,
    sub: 'user-2',
    subKind: 'user',
    caps: ['instance.create', 'view', 'control'] as Capability[],
    scope: { kind: 'tenant' },
    jti: newId('jti'),
    exp: 9_999_999_999,
  };
  return { ...t, clock, tenantId, principal, holderId: holder.id as InstanceId };
}

/** Lets the pending acquire run up to its next timer. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('a persistent profile whose holder is still launching', () => {
  it('waits for the holder and shares it once it is ready', async () => {
    const { router, store, nodes, clock, tenantId, principal, holderId } = await setUp();

    const pending = router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);
    await settle();
    clock.advance(250);
    await settle();
    await store.transitionInstance(tenantId, holderId, ['launching'], 'live');
    clock.advance(250);

    const handle = await pending;
    expect(handle.result.instanceId).toBe(holderId);
    expect(handle.result.reuseReason).toBe('profile-shared');
    expect(nodes.launchCount).toBe(0);
  });

  it('gives up after profileShareWaitMs and says the holder is still launching', async () => {
    const { router, clock, principal } = await setUp();

    const pending = router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);
    const outcome = pending.then(
      () => null,
      (e: unknown) => e,
    );
    for (let waited = 0; waited <= 30_000; waited += 250) {
      await settle();
      clock.advance(250);
    }

    expect(await outcome).toMatchObject({
      code: 'E_PROFILE_BUSY',
      message: expect.stringContaining('launching'),
      retryAfterMs: 1000,
    });
  });
});
