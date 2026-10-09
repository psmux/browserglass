/**
 * A gateway was killed mid run and a new one started against the same
 * store. The dead gateway's instance row still read `ready`, and its
 * profile lease had not expired yet, so an acquire naming the same
 * persistent key reused that row. The caller then failed to attach with
 * "driven by node X, not this gateway": node X was the dead process.
 *
 * Reuse now asks whether the row's owner is a node this router can serve
 * from. On a standalone gateway (`reachesPeerNodes: false`) another node's
 * row never is, so the acquire launches fresh, takes the abandoned lease
 * over without waiting for it to expire, and retires the old row. With a
 * peer link, another node's row is only reused while that node is alive.
 */

import type {
  Capability,
  InstanceId,
  NodeId,
  Principal,
  ProfileLease,
} from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, newId } from '@browserglass/protocol';
import { describe, expect, it, vi } from 'vitest';
import { toStoredSpecInput } from '../../src/router/specMapping.js';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

const KEY = 'user:alice';

function principalFor(tenantId: string, appId: string): Principal {
  return {
    tenantId,
    appId,
    sub: 'user-1',
    subKind: 'user',
    caps: ['instance.create', 'view', 'control'] as Capability[],
    scope: { kind: 'tenant' },
    jti: newId('jti'),
    exp: 9_999_999_999,
  };
}

async function setUp(opts: { reachesPeerNodes: boolean }) {
  const clock = createFakeClock(1_000_000);
  const t = createTestRouter(clock, { reachesPeerNodes: opts.reachesPeerNodes });
  const { store } = t;
  const { tenantId, appId, poolId } = seedBasics(store);
  const principal = principalFor(tenantId, appId);

  // The dead gateway's node, registered and heartbeating until it died.
  const deadNode = (
    await store.registerNode({
      name: 'previous-gateway',
      runtime: 'host',
      address: 'http://127.0.0.1:0',
      dataAddress: null,
      registrationSecretEnc: 'x',
    })
  ).id as NodeId;
  await store.setNodeStatus(deadNode, 'ready');

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
  const stale = await store.createInstance({
    tenantId,
    appId,
    poolId,
    nodeId: deadNode,
    specId,
    profileId: profile.id,
    createdBySub: 'user-1',
    metadata: {},
    lifetime: 'viewer-bound',
  });
  await store.transitionInstance(tenantId, stale.id, ['launching'], 'live');
  const lease: ProfileLease = {
    id: newId('plse'),
    profileId: profile.id,
    tenantId,
    holderInstanceId: stale.id,
    holderNodeId: deadNode,
    holderPid: null,
    fence: 1,
    acquiredAt: clock.now(),
    heartbeatAt: clock.now(),
    // Not expired: the restart came seconds after the crash.
    expiresAt: clock.now() + 30_000,
    releasedAt: null,
    releaseReason: null,
  };
  (await store.getProfile(tenantId, profile.id))!.lease = lease;

  return { ...t, clock, tenantId, principal, deadNode, staleId: stale.id as InstanceId };
}

describe('acquire after a gateway crash', () => {
  it('a standalone gateway launches fresh instead of handing out the dead gateway row', async () => {
    const { router, nodes, profiles, store, tenantId, principal, staleId } = await setUp({
      reachesPeerNodes: false,
    });
    const leaseSpy = vi.spyOn(profiles, 'lease');

    const handle = await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);

    expect(handle.result.instanceId).not.toBe(staleId);
    expect(handle.result.reused).toBe(false);
    expect(nodes.launchCount).toBe(1);
    // The abandoned lease is taken over now, not after it expires.
    expect(leaseSpy.mock.calls[0]?.[0].reclaimFromHolderInstanceId).toBe(staleId);
    // And the dead row no longer counts as live.
    const stale = await store.getInstance(tenantId, staleId);
    expect(stale?.state).toBe('failed');
    expect(stale?.stateReason).toBe('owner_gone');
  });

  it('with a peer link, a row on a live peer is still shared', async () => {
    const { router, nodes, principal, staleId, store, deadNode, clock } = await setUp({
      reachesPeerNodes: true,
    });
    await store.heartbeatNode({
      nodeId: deadNode,
      beatAt: new Date(clock.now()).toISOString(),
      seq: 1,
      liveInstances: 1,
    } as never);

    const handle = await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);

    expect(handle.result.instanceId).toBe(staleId);
    expect(handle.result.reuseReason).toBe('profile-shared');
    expect(nodes.launchCount).toBe(0);
  });

  it('with a peer link, a row on a peer whose heartbeat went stale is not shared', async () => {
    const { router, principal, staleId, clock, profiles, nodeRegistry } = await setUp({
      reachesPeerNodes: true,
    });
    // Past `nodeStaleMs` since the peer last beat, while this router's own
    // node keeps beating.
    clock.advance(60_000);
    nodeRegistry.heartbeat({});

    const leaseSpy = vi.spyOn(profiles, 'lease');

    const handle = await router.acquire({ profile: { mode: 'persistent', key: KEY } }, principal);

    expect(handle.result.instanceId).not.toBe(staleId);
    // No early takeover with a peer link: a stale heartbeat may be a
    // partition rather than a death, so only the lease expiry decides.
    expect(leaseSpy.mock.calls[0]?.[0].reclaimFromHolderInstanceId).toBeUndefined();
  });

  it('sticky skips a row owned by an unreachable node', async () => {
    const { router, nodes, principal, staleId } = await setUp({ reachesPeerNodes: false });

    const handle = await router.acquire({ sticky: { subject: 'user-1' } }, principal);

    expect(handle.result.instanceId).not.toBe(staleId);
    expect(nodes.launchCount).toBe(1);
  });

  it('a standalone gateway sends the terminate for such a row to its own node', async () => {
    // Addressed to the dead node id, LocalNodeTransport refused the call
    // and the release failed with E_TERMINATE_FAILED every time.
    const { router, nodes, principal, staleId, nodeRegistry } = await setUp({
      reachesPeerNodes: false,
    });

    const result = await router.release(staleId, {}, principal);

    expect(result.outcome).toBe('terminated');
    expect(nodes.terminateCalls[0]?.nodeId).toBe(nodeRegistry.id());
  });

  it('with a peer link, the terminate still goes to the row own node', async () => {
    const { router, nodes, principal, staleId, deadNode } = await setUp({ reachesPeerNodes: true });

    await router.release(staleId, {}, principal);

    expect(nodes.terminateCalls[0]?.nodeId).toBe(deadNode);
  });
});
