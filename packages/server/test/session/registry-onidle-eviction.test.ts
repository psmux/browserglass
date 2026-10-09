/**
 * Regression for the second defect reported alongside the placement-queue
 * ticket disguise: `SessionRegistry.evict()` (`registry.ts`) was reachable
 * only from `disposeAll()` (process shutdown), because nothing ever
 * supplied `ManagedSession`'s own `onIdle` construction option
 * (`managed-session.ts`'s `ManagedSessionOptions.onIdle`, fired once
 * `connections.size === 0`). Neither the real factory
 * (`session/factory.ts`'s `createManagedSessionFactory`) nor this suite's
 * own hand rolled one (`test/ws/support/test-gateway.ts`) ever passed it
 * in, so a `ManagedSession` (its `CdpBridge` socket and `TargetRegistry`
 * included) lived for the rest of the process once its last viewer
 * disconnected, on every gateway this build could run.
 *
 * Fixed by adding `ManagedSessionFactoryContext.onIdle` (`registry.ts`,
 * populated by `getOrCreate`) and threading it into `ManagedSession`'s
 * construction in both factories. `onIdle` does NOT evict immediately: a
 * first version of this fix did exactly that, and it broke WS resume
 * outright (`test/ws/shared-control.test.ts`'s resume suite started
 * failing), because a resuming viewer's `getOrCreate` call landed on an
 * already-disposed session and rebuilt a fresh one with none of the
 * original's retained per-viewer bookkeeping (`ManagedSession.resumeViewer`'s
 * own doc: the resume token itself carries no subscription snapshot).
 * `SessionRegistry` now schedules eviction `noViewerGraceMs` after the
 * last viewer leaves (default 120s, matching `resumeWindowMs`), and
 * cancels it if a viewer reattaches first, so a session survives exactly
 * as long as a resume attempt against it could still be valid.
 *
 * This test drives a real WS connection through the real
 * `SessionRegistry`/`ManagedSession`/`CdpBridge` stack (`startTestGateway`,
 * the same harness `conformance.test.ts` uses), not a mock, so it proves
 * the wiring actually fires end to end. `noViewerGraceMs` is set small
 * (tens of milliseconds) so eviction itself is fast to observe; the grace
 * window's actual PURPOSE (surviving a resume within its real, much
 * longer default) is what `shared-control.test.ts`'s own resume suite
 * already covers, unchanged, against the real default.
 */

import { describe, expect, it } from 'vitest';
import {
  type TestGateway,
  nextMessage,
  startTestGateway,
  waitClose,
  waitOpen,
} from '../ws/support/test-gateway.js';

const GRACE_MS = 40;

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    ...overrides,
  };
}

async function connectAndWelcome(
  gw: TestGateway,
): Promise<{ ws: ReturnType<TestGateway['connect']>; welcome: Record<string, unknown> }> {
  const token = await gw.issueToken();
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
  const welcome = await nextMessage(ws);
  return { ws, welcome };
}

/**
 * Polls instead of a single fixed sleep (`conformance.test.ts`'s own
 * `setTimeout(r, 20)` pattern after a close, which this suite's first,
 * cold run showed is occasionally too short under load): `onSocketClosed`
 * runs on the server's own `ws` `'close'` event, a separate event loop
 * turn from this test's `waitClose(ws)` on the client socket, so there is
 * no single await that guarantees it has already run, and eviction itself
 * now additionally waits out `GRACE_MS` on top of that.
 */
async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline)
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('SessionRegistry: onIdle eviction', () => {
  it('disposes the ManagedSession once its last viewer disconnects and the grace window elapses, instead of only at shutdown', async () => {
    const gw = await startTestGateway({ noViewerGraceMs: GRACE_MS });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    try {
      const { ws } = await connectAndWelcome(gw);

      const managed = gw.sessionRegistry.get(gw.instanceId);
      expect(managed).toBeDefined();

      ws.close();
      await waitClose(ws);
      // Before this fix, `evict` was dead outside `disposeAll()`: this
      // would still be the same, never-disposed `ManagedSession`, forever.
      await waitUntil(() => gw.sessionRegistry.get(gw.instanceId) === undefined);
    } finally {
      await gw.close();
    }
  });

  it('a viewer reconnecting after the grace window has fully elapsed gets a genuinely new ManagedSession, not the disposed one', async () => {
    const gw = await startTestGateway({ noViewerGraceMs: GRACE_MS });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    try {
      const { ws: first } = await connectAndWelcome(gw);
      const firstManaged = gw.sessionRegistry.get(gw.instanceId);
      expect(firstManaged).toBeDefined();

      first.close();
      await waitClose(first);
      await waitUntil(() => gw.sessionRegistry.get(gw.instanceId) === undefined);

      const { ws: second } = await connectAndWelcome(gw);
      const secondManaged = gw.sessionRegistry.get(gw.instanceId);
      expect(secondManaged).toBeDefined();
      expect(secondManaged).not.toBe(firstManaged);

      second.close();
      await waitClose(second);
    } finally {
      await gw.close();
    }
  });

  it('a second concurrent viewer keeps the session alive: the first leaving does not evict it', async () => {
    const gw = await startTestGateway({ noViewerGraceMs: GRACE_MS });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    try {
      const { ws: first } = await connectAndWelcome(gw);
      const { ws: second } = await connectAndWelcome(gw);
      const managed = gw.sessionRegistry.get(gw.instanceId);
      expect(managed).toBeDefined();

      first.close();
      await waitClose(first);
      // Proving a negative (still not evicted) cannot be a `waitUntil`
      // poll; a fixed pause well past `GRACE_MS` is deliberate here: with
      // a second viewer still connected, `onIdle` never even fires
      // (`connections.size` never reaches zero), so no grace timer is
      // ever armed for a wrongly-early eviction to show up in.
      await new Promise((r) => setTimeout(r, GRACE_MS * 3));

      // One viewer remains: the session must still be live and the SAME
      // object, not evicted and not rebuilt.
      expect(gw.sessionRegistry.get(gw.instanceId)).toBe(managed);

      second.close();
      await waitClose(second);
      await waitUntil(() => gw.sessionRegistry.get(gw.instanceId) === undefined);
    } finally {
      await gw.close();
    }
  });

  it('a viewer reconnecting WITHIN the grace window keeps the original ManagedSession alive: the pending eviction is cancelled, not just outrun', async () => {
    const gw = await startTestGateway({ noViewerGraceMs: GRACE_MS });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    try {
      const { ws: first } = await connectAndWelcome(gw);
      const firstManaged = gw.sessionRegistry.get(gw.instanceId);
      expect(firstManaged).toBeDefined();

      first.close();
      await waitClose(first);
      // Reconnect well inside the grace window, before its timer could
      // have fired: this is the exact shape of the regression the
      // immediate-eviction version of this fix introduced (a page reload,
      // or WS resume, arriving during what should be a safe window).
      const { ws: second } = await connectAndWelcome(gw);

      expect(gw.sessionRegistry.get(gw.instanceId)).toBe(firstManaged);

      // The reattach must have cancelled the pending eviction outright,
      // not merely raced it: waiting past the original grace deadline
      // proves the timer never fires at all once cancelled, rather than
      // this assertion having gotten lucky on timing.
      await new Promise((r) => setTimeout(r, GRACE_MS * 3));
      expect(gw.sessionRegistry.get(gw.instanceId)).toBe(firstManaged);

      second.close();
      await waitClose(second);
      await waitUntil(() => gw.sessionRegistry.get(gw.instanceId) === undefined);
    } finally {
      await gw.close();
    }
  });
});
