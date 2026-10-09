/**
 * The `LiveViewerPort` `src/index.ts` injects into `BrowserRouter` through
 * `runStart` and `buildRouterWiring`.
 *
 * `BrowserRouter.release()` is viewer aware, but it reads the count through
 * an injected port that defaults to a constant zero, because
 * `@browserglass/router` holds no viewer sockets and cannot honestly count
 * them. Left uninjected, viewer aware release does nothing at all: the
 * first tab to close still takes the browser down while a second tab is
 * still streaming. So the thing worth testing is not the router's branch,
 * which router's own suite covers, but that the port THIS package wires
 * actually moves, and actually changes the outcome.
 *
 * The viewers here are real: a real `ws` client, the real `bgls.v1`
 * handshake, a real `ManagedSession` whose `connections` map is written by
 * `attachViewer` and deleted by `detachViewer` from `ws/connection.ts`'s
 * `onSocketClosed`. The store and node transport under the router are
 * fakes, since `release()`'s other eight steps are not what is under test.
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import type {
  AppId,
  Instance,
  InstanceId,
  NodeTransport,
  Store,
  TenantId,
} from '@browserglass/protocol';
import {
  BrowserRouter,
  type LiveViewerPort,
  type NodeRegistry,
  type PlacementPolicy,
  type Principal,
  type ProfileServicePort,
  systemClock,
} from '@browserglass/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopAuditSink, noopMetricsSink } from '../../src/lifecycle/wiring.js';
import {
  type TestGateway,
  nextMessage,
  startTestGateway,
  waitOpen,
} from '../ws/support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

let gw: TestGateway;

beforeEach(async () => {
  gw = await startTestGateway();
  gw.addTarget({
    targetId: 'cdp-a',
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
  });
});

afterEach(async () => {
  await gw.close();
});

function hello(token: string, id: string): string {
  return JSON.stringify({
    v: 1,
    t: 'hello',
    id,
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    auth: { scheme: 'bearer', token },
  });
}

/** Opens one real viewer socket and waits for its `welcome`, which is the point `attachViewer` has run. */
async function openViewer(viewerId: string): Promise<import('ws').default> {
  const token = await gw.issueToken({ viewerId });
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(hello(token, `h_${viewerId}`));
  const welcome = await nextMessage(ws);
  expect(welcome['t']).toBe('welcome');
  return ws;
}

/** Waits until the wired port reports `expected`, so the assertion does not race the socket close event. */
async function waitForCount(
  port: LiveViewerPort,
  instanceId: string,
  expected: number,
): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (port.countFor(instanceId as InstanceId) === expected) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  expect(port.countFor(instanceId as InstanceId)).toBe(expected);
}

/** A `BrowserRouter` with just enough underneath it for `release()` to run, and the terminate calls it made. */
function routerOver(
  viewers: LiveViewerPort,
  instanceId: string,
  tenantId: TenantId,
): { router: BrowserRouter; terminated: string[]; transitions: string[] } {
  const terminated: string[] = [];
  const transitions: string[] = [];

  const instance = {
    id: instanceId,
    tenantId,
    state: 'ready',
    nodeId: 'nod_local',
    poolId: null,
    profileId: null,
    profileSpec: { mode: 'ephemeral' },
    acquiredAt: Date.now(),
  } as unknown as Instance;

  const store = {
    getInstance: async () => instance,
    transitionInstance: async (_t: string, _id: string, _from: string[], to: string) => {
      transitions.push(to);
      return true;
    },
  } as unknown as Store;

  const nodes = {
    terminate: async (_nodeId: string, id: string) => {
      terminated.push(id);
      return {
        mode: 'graceful',
        effective: 'graceful',
        exitCode: 0,
        signal: null,
        durationMs: 1,
        locksCleared: [],
        warnings: [],
      };
    },
  } as unknown as NodeTransport;

  const profiles = {
    releaseLeaseQuietly: async () => undefined,
    applyReleaseAction: async () => undefined,
  } as unknown as ProfileServicePort;

  const router = new BrowserRouter({
    store,
    nodes,
    nodeRegistry: { id: () => 'nod_local' } as unknown as NodeRegistry,
    placement: {} as unknown as PlacementPolicy,
    profiles,
    quotas: { limits: async () => ({}) } as never,
    audit: noopAuditSink,
    metrics: noopMetricsSink,
    clock: systemClock,
    viewers,
  });

  return { router, terminated, transitions };
}

describe('the LiveViewerPort src/index.ts wires into BrowserRouter', () => {
  it('reports the real viewer count, and a release with a viewer attached does not terminate', async () => {
    // Exactly the expression `src/index.ts` builds. If this ever diverges
    // from that line, the test is measuring the wrong thing, which is why
    // it is written out rather than imported: there is nothing to import,
    // the port is three tokens long and belongs at the wiring site.
    const port: LiveViewerPort = {
      countFor: (instanceId) => gw.sessionRegistry.get(instanceId)?.viewerCount ?? 0,
    };
    const principal = {
      tenantId: gw.tenantId,
      appId: gw.appId,
      sub: 'u1',
      caps: [],
    } as unknown as Principal;

    // Before anybody connects there is no session at all, and the absent
    // session reads as zero viewers. That is the deliberate choice, not an
    // accident of `?? 0`: `SessionRegistry` evicts a session the moment its
    // last connection closes, which is precisely when a closing tab's
    // release request lands, so any non zero fallback would make an
    // ordinary release report `detached` forever.
    expect(port.countFor(gw.instanceId as InstanceId)).toBe(0);

    const first = await openViewer('viewer-one');
    const second = await openViewer('viewer-two');
    await waitForCount(port, gw.instanceId, 2);

    const wired = routerOver(port, gw.instanceId, gw.tenantId as TenantId);
    const stillWatched = await wired.router.release(
      gw.instanceId as InstanceId,
      { reason: 'user_closed' },
      principal,
    );

    expect(stillWatched.outcome).toBe('detached');
    expect(stillWatched.remainingViewers).toBe(2);
    expect(wired.terminated).toEqual([]);
    expect(wired.transitions).toEqual([]);

    // One tab leaves. The other is still streaming, so the browser must
    // still survive a release.
    first.close();
    await waitForCount(port, gw.instanceId, 1);
    const oneLeft = await wired.router.release(
      gw.instanceId as InstanceId,
      { reason: 'user_closed' },
      principal,
    );
    expect(oneLeft.outcome).toBe('detached');
    expect(oneLeft.remainingViewers).toBe(1);
    expect(wired.terminated).toEqual([]);

    // The last tab leaves, and only now does a release actually tear the
    // browser down.
    second.close();
    await waitForCount(port, gw.instanceId, 0);
    const lastOut = await wired.router.release(
      gw.instanceId as InstanceId,
      { reason: 'user_closed' },
      principal,
    );
    expect(lastOut.outcome).toBe('terminated');
    expect(wired.terminated).toEqual([gw.instanceId]);
    expect(wired.transitions).toEqual(['draining', 'released']);
  });

  it('an unwired router terminates with viewers still attached, which is the defect the wiring closes', async () => {
    // The control case. `viewers` left out entirely is what
    // `buildRouterWiring` produced before the fix, and the router's own
    // default is a constant zero.
    const principal = {
      tenantId: gw.tenantId,
      appId: gw.appId,
      sub: 'u1',
      caps: [],
    } as unknown as Principal;
    const viewer = await openViewer('viewer-one');
    const port: LiveViewerPort = {
      countFor: (instanceId) => gw.sessionRegistry.get(instanceId)?.viewerCount ?? 0,
    };
    await waitForCount(port, gw.instanceId, 1);

    const unwired = routerOver({ countFor: () => 0 }, gw.instanceId, gw.tenantId as TenantId);
    const result = await unwired.router.release(
      gw.instanceId as InstanceId,
      { reason: 'user_closed' },
      principal,
    );

    expect(result.outcome).toBe('terminated');
    expect(unwired.terminated).toEqual([gw.instanceId]);
    viewer.close();
  });
});
