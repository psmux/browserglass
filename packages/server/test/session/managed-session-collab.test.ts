/**
 * Two collaboration defects a security audit found alongside the raw CDP
 * proxy work (`ws/cdp-upgrade.test.ts`), both in
 * `session/managed-session.ts`, and both the same
 * underlying problem the CDP proxy work fixes: something can drive Chrome
 * without a lease and without being visible.
 *
 * ITEM A: `ManagedSession.sendCdp()`'s `Input.*` methods (the four the REST
 * allowlisted passthrough grants, `rest/cdp-passthrough-allowlist.ts`) used
 * to reach `this.bridge.send()` directly, four lines, no lease check at
 * all, while `clickTarget()`/`typeTarget()` two screens away in the same
 * class borrow a lease under `REST_VIEWER_ID` (`withRestControl()`) for the
 * exact same CDP domain. A `cdp`-capable token could inject
 * `Input.dispatchKeyEvent` into a target a human currently holds the lease
 * on. `sendCdp()` now routes every `Input.*` method through
 * `withRestControl()`, which refuses (throws) when another viewer already
 * holds the target, exactly like `clickTarget()` already does.
 *
 * ITEM B: a lease held under `REST_VIEWER_ID` (no `ConnectionSink`, so no
 * entry in `presenceEntries`) used to be entirely invisible to
 * `presence.state`: `REST_VIEWER_ID`'s own doc comment used to say so
 * explicitly. `broadcastPresence()` now projects a synthetic `kind:
 * 'service'` row for any lease holder with no live connection, for exactly
 * as long as it actually holds the lease.
 *
 * Built against `test/ws/support/test-gateway.ts`'s real harness (a real
 * `SessionRegistry`, a real `ManagedSession`, a real `CdpBridge` against
 * `FakeChromeServer`): both defects live in the interaction between a real
 * `ControlLeaseEngine` and a real `ManagedSession`, not in either one
 * alone, so a hand rolled fake of either would not have caught the
 * original bug.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestGateway, startTestGateway } from '../ws/support/test-gateway.js';

/** Local, minimal stand-in for `shared-control.test.ts`'s own `connectViewer`: joins, drains `welcome`, and returns the first target's id. This suite never needs `welcome`'s other fields or a view-only variant, so it does not import that file's helper (a test-only module, not a shared library this suite should depend on). */
async function connectHumanAndGetTarget(
  gw: TestGateway,
  viewerId: string,
): Promise<{ ws: ReturnType<TestGateway['connect']>; targetId: string }> {
  const token = await gw.issueToken({ viewerId });
  const ws = gw.connect();
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const helloMsg = {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: {
      codecs: ['jpeg'],
      binaryFrames: true,
      input: ['mouse', 'key', 'text', 'touch', 'scroll'],
    },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    auth: { scheme: 'bearer', token },
  };
  ws.send(JSON.stringify(helloMsg));
  const welcome = await new Promise<Record<string, unknown>>((resolve) => {
    ws.once('message', (data) =>
      resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>),
    );
  });
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

describe('ManagedSession.sendCdp: Input.* is gated on the control lease (audit item A)', () => {
  let gw: TestGateway;

  beforeEach(async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
  });

  afterEach(async () => {
    await gw.close();
  });

  it('refuses Input.dispatchKeyEvent when a human already holds the target, instead of injecting it unfenced', async () => {
    const { ws, targetId } = await connectHumanAndGetTarget(gw, 'vwr_human');
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const granted = await new Promise<Record<string, unknown>>((resolve) => {
      const onMessage = (data: Buffer): void => {
        const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (msg['t'] === 'control.granted') {
          ws.off('message', onMessage);
          resolve(msg);
        }
      };
      ws.on('message', onMessage);
    });
    expect(granted['t']).toBe('control.granted');

    const managed = gw.sessionRegistry.get(gw.instanceId);
    if (!managed) throw new Error('expected a live ManagedSession');

    // This is exactly the exploit the audit named: a `cdp`-capable REST
    // caller injecting a keystroke into a target a human is driving, with
    // no lease of its own.
    await expect(
      managed.sendCdp(targetId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a' }),
    ).rejects.toThrow(/controlled by another viewer/);

    ws.close();
  });

  it('allows Input.dispatchMouseEvent through when nobody else holds the target, the ordinary REST driving path', async () => {
    gw.addTarget({
      targetId: 'cdp-b',
      type: 'page',
      title: 'B',
      url: 'https://b.example',
      attached: false,
      windowId: 1,
    });
    const managed = await gw.sessionRegistry.getOrCreate(gw.instanceId, {
      tenantId: gw.tenantId,
      appId: gw.appId,
    });
    const targetId = managed.listTargets(['page'])[0]!.targetId;

    // No prior throw: `withRestControl` grants `REST_VIEWER_ID` the lease
    // synchronously (nobody else holds it) and releases it again once the
    // dispatch settles.
    await expect(
      managed.sendCdp(targetId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: 1,
        y: 1,
        button: 'none',
        buttons: 0,
      }),
    ).resolves.toBeDefined();
  });

  it('leaves non-Input methods unaffected by lease state: a read reaches CDP regardless of who is driving', async () => {
    const { ws, targetId } = await connectHumanAndGetTarget(gw, 'vwr_human2');
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    await new Promise<void>((resolve) => {
      const onMessage = (data: Buffer): void => {
        const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        if (msg['t'] === 'control.granted') {
          ws.off('message', onMessage);
          resolve();
        }
      };
      ws.on('message', onMessage);
    });

    const managed = gw.sessionRegistry.get(gw.instanceId);
    if (!managed) throw new Error('expected a live ManagedSession');

    // `Page.getLayoutMetrics` is not `control`-gated: gating it on the
    // lease would refuse a harmless read merely because somebody else is
    // driving, which is not what the lease model protects (this file's own
    // module doc, `sendCdp()`'s own comment).
    await expect(managed.sendCdp(targetId, 'Page.getLayoutMetrics', {})).resolves.toBeDefined();
    ws.close();
  });
});

describe('ManagedSession.broadcastPresence: a connection-less lease holder is visible (audit item B)', () => {
  let gw: TestGateway;

  beforeEach(async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
  });

  afterEach(async () => {
    await gw.close();
  });

  it('shows REST_VIEWER_ID as a kind:"service" presence row for exactly as long as it holds the lease', async () => {
    const { ws, targetId } = await connectHumanAndGetTarget(gw, 'vwr_watcher');

    // Every `presence.state` this connection has received so far, in
    // order. A `requestControl()` call can produce more than one lease
    // effect (a direct grant plus a broadcast), each triggering its own
    // `broadcastPresence()`, so a "wait for exactly the next message"
    // helper risks consuming a message that is not yet the SETTLED state
    // an assertion cares about. Recording every one and reading `.at(-1)`
    // (after `expect.poll` confirms one has actually arrived since the
    // last check) is immune to exactly how many broadcasts one action
    // happened to produce.
    const received: Array<Record<string, unknown>> = [];
    ws.on('message', (data: Buffer) => {
      const msg = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (msg['t'] === 'presence.state') received.push(msg);
    });

    const managed = gw.sessionRegistry.get(gw.instanceId);
    if (!managed) throw new Error('expected a live ManagedSession');

    const countBeforeGrant = received.length;
    // Borrows the lease directly under `REST_VIEWER_ID`, the same identity
    // `withRestControl()` uses, without going through a real `Input.*`
    // dispatch: this isolates the PRESENCE projection from the dispatch
    // timing, which `withRestControl`'s own `finally` releases far too
    // quickly for a test to reliably observe the broadcast in between.
    managed.requestControl(
      {
        viewerId: 'bgls:rest',
        identity: 'bgls:rest',
        label: 'REST',
        kind: 'agent',
        capabilities: ['control'],
        isAdmin: false,
      },
      targetId,
      { queue: false },
    );

    await expect.poll(() => received.length > countBeforeGrant).toBe(true);
    const viewers = received.at(-1)!['viewers'] as Array<{
      viewerId: string;
      label: string;
      kind: string;
      controlling: string[];
    }>;
    const restRow = viewers.find((v) => v.viewerId === 'bgls:rest');
    expect(
      restRow,
      'a REST-borrowed lease must be visible in presence.state, not a ghost driver',
    ).toBeDefined();
    expect(restRow?.kind).toBe('service');
    expect(restRow?.controlling).toEqual([targetId]);

    // Release it, and the roster settles back to omitting it: the row is
    // derived fresh from the engine's own holder list on every broadcast,
    // never a permanent addition once seen.
    const engine = managed.coreSession.leaseEngineFor(targetId);
    const holder = engine.holderFor('bgls:rest');
    if (!holder) throw new Error('expected bgls:rest to hold the lease it just requested');
    await engine.release('bgls:rest', holder.leaseId);

    await expect
      .poll(() => {
        const last = received.at(-1);
        const lastViewers = (last?.['viewers'] as Array<{ viewerId: string }> | undefined) ?? [];
        return lastViewers.some((v) => v.viewerId === 'bgls:rest');
      })
      .toBe(false);

    ws.close();
  });
});
