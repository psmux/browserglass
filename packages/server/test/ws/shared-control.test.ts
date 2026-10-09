import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * The server leg of shared control: the
 * behaviour that has to hold once several viewers can drive ONE target at
 * once, exercised through the real `bgls.v1` gateway over a real socket.
 *
 * Three separate contracts live here, and they fail in three different ways:
 *
 *  1. VIEW ONLY IS A STATE, NOT A RACE. A viewer that declared itself
 *     view-only in `hello` (empty `capabilities.input[]`) must be refused
 *     input and refused the lease itself, and must stay refused across a
 *     reauth that hands it a `control`-carrying token. The failure mode this
 *     guards against is the quiet one: "view only" implemented as "did not
 *     happen to win the lease" looks identical to this on a calm session and
 *     silently becomes control the instant anything grants one.
 *
 *  2. REPLY BEFORE BROADCAST. A lease broadcast must never precede the reply
 *     to the request that caused it. This codebase has hit that bug class
 *     before: `subscribe()` broadcast `target.updated` ahead of its own
 *     `stream.subscribed` reply and broke three suites, because a client's
 *     `request()` helper correlates strictly on `re` and a broadcast carries
 *     none, so the broadcast is read as the reply. Shared control adds new
 *     grant paths to the same emitter, so the ordering is pinned here as an
 *     observable server-level contract rather than left as an implementation
 *     detail of whichever engine path happened to be written first.
 *
 *  3. PROMOTION DAMPING. `promoteOnInput` makes the tab a viewer is driving
 *     the live one for its own OS window. Two viewers driving two tabs of
 *     the SAME window de-activate each other on every pointer event, and at
 *     input rates that is a `Page.bringToFront` plus a session-wide
 *     `target.updated` broadcast per event. See
 *     `ManagedSession.promoteOnInput`'s doc for why the answer is a damper
 *     rather than arbitration.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitClose,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

/**
 * `input` defaults to the same full list every real client in this repo
 * sends (`BrowserGlassClient`, the conformance vectors); pass `input: []` to
 * declare a view-only viewer.
 */
function hello(
  overrides: Record<string, unknown> = {},
  input: string[] = ['mouse', 'key', 'text', 'touch', 'scroll'],
): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    ...overrides,
  };
}

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

/**
 * Connects one viewer and drains through its `welcome` and the unprompted
 * `presence.state` that always follows it.
 *
 * `opts.viewerId` is the token's `sub`, which is NOT what the connection ends
 * up being called: `resolveCredential` mints a fresh `vwr_` id per
 * connection. The server-assigned id is read back off `welcome.viewerId` and
 * returned, because that is the id every lease and presence message is keyed
 * by and the only one a test can meaningfully assert against.
 */
async function connectViewer(
  gw: TestGateway,
  opts: { readonly viewerId: string; readonly input?: string[]; readonly caps?: string[] },
): Promise<{ ws: WebSocket; welcome: Record<string, unknown>; token: string; viewerId: string }> {
  const token = await gw.issueToken({
    viewerId: opts.viewerId,
    ...(opts.caps !== undefined ? { caps: opts.caps } : {}),
  });
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } }, opts.input)));
  const welcome = await nextMessage(ws);
  expect(welcome['t']).toBe('welcome');
  const presence = await nextMessage(ws);
  expect(presence['t']).toBe('presence.state');
  return { ws, welcome, token, viewerId: welcome['viewerId'] as string };
}

describe('shared control: view-only is an enforced connection state', () => {
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

  it('strips control from welcome.granted even though the token carries it', async () => {
    // `issueToken()`'s default caps include `control`, so this is genuinely
    // the connection narrowing a capability the credential grants, not a
    // token that never had it. That distinction is the whole point: the
    // choice is made by the person joining, at join time, not by whoever
    // minted the token.
    const { ws, welcome } = await connectViewer(gw, { viewerId: 'vwr_viewonly', input: [] });
    const granted = welcome['granted'] as string[];
    expect(granted).not.toContain('control');
    // Watching is untouched. View-only means not driving the page, not
    // being a second-class viewer.
    expect(granted).toContain('view');
    ws.close();
  });

  it('refuses input.mouse from a view-only viewer with cap.missing, naming control', async () => {
    const { ws, welcome } = await connectViewer(gw, { viewerId: 'vwr_viewonly', input: [] });
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    ws.send(
      JSON.stringify({
        v: 1,
        t: 'input.mouse',
        id: 'i1',
        ts: Date.now(),
        targetId,
        kind: 'move',
        x: 5,
        y: 5,
        fw: 800,
        fh: 600,
        buttons: 0,
        modifiers: 0,
      }),
    );
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.cap.missing');
    expect(reply['context']).toMatchObject({ required: 'control' });
    ws.close();
  });

  it('refuses input.drag from a view-only viewer with cap.missing, naming control, same as input.mouse', async () => {
    const { ws, welcome } = await connectViewer(gw, { viewerId: 'vwr_viewonly_drag', input: [] });
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    ws.send(
      JSON.stringify({
        v: 1,
        t: 'input.drag',
        id: 'i1',
        ts: Date.now(),
        targetId,
        kind: 'over',
        x: 5,
        y: 5,
        fw: 800,
        fh: 600,
        modifiers: 0,
        leaseId: 'lse_x',
        gen: 0,
      }),
    );
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.cap.missing');
    expect(reply['context']).toMatchObject({ required: 'control' });
    ws.close();
  });

  it('refuses control.request from a view-only viewer, so nothing can promote it into a holder', async () => {
    // Requirement 6's sharper half. Blocking input alone would leave a
    // view-only viewer able to acquire the lease and then sit there holding
    // it: visible to everyone else in `presence.state.controlling`, counted
    // as a driver, and one reauth away from actually driving.
    const { ws, welcome } = await connectViewer(gw, { viewerId: 'vwr_viewonly', input: [] });
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.cap.missing');
    expect(reply['re']).toBe('c1');
    ws.close();
  });

  it('keeps a view-only viewer view-only across a reauth that hands it a control-carrying token', async () => {
    // A reauth replaces `granted` wholesale from a freshly resolved token.
    // Without the narrowing being re-applied, an ordinary credential refresh
    // silently promotes a view-only viewer into a driver, which is exactly
    // the "must not be silently promoted into control by ANYTHING" clause.
    const { ws } = await connectViewer(gw, { viewerId: 'vwr_viewonly', input: [] });
    const fresh = await gw.issueToken({ viewerId: 'vwr_viewonly' });

    ws.send(
      JSON.stringify(
        hello({ id: 'h2', reauth: true, auth: { scheme: 'bearer', token: fresh } }, []),
      ),
    );
    const welcome2 = await nextMessageSkipping(ws, UNSOLICITED);
    expect(welcome2['t']).toBe('welcome');
    expect(welcome2['reauth']).toBe(true);
    expect(welcome2['granted']).not.toContain('control');

    const targetId = (welcome2['targets'] as Array<{ targetId: string }>)[0]!.targetId;
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'input.mouse',
        id: 'i2',
        ts: Date.now(),
        targetId,
        kind: 'move',
        x: 5,
        y: 5,
        fw: 800,
        fh: 600,
        buttons: 0,
        modifiers: 0,
      }),
    );
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.cap.missing');
    ws.close();
  });

  it('leaves an ordinary viewer completely alone: a non-empty input list changes nothing', async () => {
    // The regression guard. Every client in this repo declares the full
    // input list, so if this narrowing ever widened to "not all kinds
    // declared" it would silently disable control for the entire product.
    const { ws, welcome } = await connectViewer(gw, { viewerId: 'vwr_driver' });
    expect(welcome['granted']).toContain('control');
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('control.granted');
    ws.close();
  });

  it('does not confine a client that omitted capabilities.input entirely', async () => {
    // Only a present, empty array is a declaration. A malformed or partial
    // `hello` has said nothing, and must not be read as a choice the person
    // never made.
    const token = await gw.issueToken({ viewerId: 'vwr_sloppy' });
    const ws = gw.connect();
    await waitOpen(ws);
    const h = hello({ auth: { scheme: 'bearer', token } });
    // biome-ignore lint/performance/noDelete: the case under test is a hello with the input key omitted entirely.
    delete (h['capabilities'] as Record<string, unknown>)['input'];
    ws.send(JSON.stringify(h));
    const welcome = await nextMessage(ws);
    expect(welcome['t']).toBe('welcome');
    expect(welcome['granted']).toContain('control');
    ws.close();
  });
});

describe('shared control: lease broadcasts never precede the reply that caused them', () => {
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

  it('the requester sees control.granted (carrying re) strictly before the control.state broadcast', async () => {
    const { ws, welcome } = await connectViewer(gw, { viewerId: 'vwr_a' });
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'req-1', ts: Date.now(), targetId }));

    // Collect both lease messages in arrival order, reading past the
    // presence broadcasts that follow every lease effect.
    const seen: Record<string, unknown>[] = [];
    while (seen.length < 2) {
      const msg = await nextMessage(ws);
      if (msg['t'] === 'control.granted' || msg['t'] === 'control.state') seen.push(msg);
    }

    expect(seen[0]!['t']).toBe('control.granted');
    expect(seen[0]!['re']).toBe('req-1');
    expect(seen[1]!['t']).toBe('control.state');
    // `sq` is stamped per connection at send time, so this is the same
    // assertion made independently of how the test happened to read the
    // socket: the reply really was written first, not merely observed first.
    expect(seen[0]!['sq'] as number).toBeLessThan(seen[1]!['sq'] as number);
    // A broadcast must not be correlatable to somebody else's request. If
    // `re` ever leaked onto `control.state`, every viewer's `request()`
    // would resolve on another viewer's grant.
    expect(seen[1]!['re']).toBeUndefined();
    ws.close();
  });

  it('a second viewer sees the control.state broadcast describing the first viewer as holder', async () => {
    // The broadcast half of "every viewer can see who else is driving".
    // Exclusive mode carries one holder here; shared mode carries several,
    // and this is the message that has to grow to say so.
    const a = await connectViewer(gw, { viewerId: 'vwr_a' });
    const b = await connectViewer(gw, { viewerId: 'vwr_b' });
    const targetId = (a.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    a.ws.send(
      JSON.stringify({ v: 1, t: 'control.request', id: 'req-1', ts: Date.now(), targetId }),
    );

    const state = await nextMessageSkipping(b.ws, [
      'presence.state',
      'target.updated',
      'stream.stats',
    ]);
    expect(state['t']).toBe('control.state');
    const leases = state['leases'] as Array<{ targetId: string; holderViewerId: string | null }>;
    expect(leases.find((l) => l.targetId === targetId)?.holderViewerId).toBe(a.viewerId);

    a.ws.close();
    b.ws.close();
  });
});

describe('shared control: promoteOnInput damping', () => {
  let gw: TestGateway;

  beforeEach(async () => {
    gw = await startTestGateway();
    // Two tabs in ONE OS window: the shape where two drivers genuinely
    // contend, because the window composites only one of them.
    gw.addTarget({
      targetId: 'cdp-a1',
      type: 'page',
      title: 'A1',
      url: 'https://a1.example',
      attached: false,
      windowId: 1,
    });
    gw.addTarget({
      targetId: 'cdp-a2',
      type: 'page',
      title: 'A2',
      url: 'https://a2.example',
      attached: false,
      windowId: 1,
    });
  });

  afterEach(async () => {
    await gw.close();
  });

  it('a burst of input on a contested target promotes once, not once per event', async () => {
    const { ws, welcome, viewerId } = await connectViewer(gw, { viewerId: 'vwr_a' });
    const targets = welcome['targets'] as Array<{ targetId: string; title: string }>;
    const idA2 = targets.find((t) => t.title === 'A2')!.targetId;

    const managed = gw.sessionRegistry.all()[0]!;
    // Spied rather than counted off the wire: `activateTarget` is the exact
    // decision under test, and stubbing it also holds `activeTargetIds`
    // still, which isolates the damper from the unrelated early return that
    // would otherwise absorb the burst for the wrong reason.
    const activate = vi.spyOn(managed, 'activateTarget').mockResolvedValue(undefined);
    const event = {
      t: 'input.mouse',
      targetId: idA2,
      kind: 'move',
      x: 5,
      y: 5,
      fw: 800,
      fh: 600,
      buttons: 0,
      modifiers: 0,
      leaseId: 'stale',
    };

    for (let i = 0; i < 12; i++) managed.dispatchInput(viewerId, { ...event, ts: Date.now() });

    // Twelve events in well under the 250ms damper: exactly one promotion.
    // Undamped this was twelve `Page.bringToFront` round trips and twelve
    // session-wide `target.updated` broadcasts.
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate).toHaveBeenCalledWith(idA2);

    activate.mockRestore();
    ws.close();
  });

  it('the damper lapses rather than latching, so the last driver still wins', async () => {
    // The failure this rules out is a damper that suppresses forever. Last
    // input wins is the intended semantics for two tabs in one window; the
    // damper is only allowed to slow the contest down, never to freeze the
    // winner in place.
    const { ws, welcome, viewerId } = await connectViewer(gw, { viewerId: 'vwr_a' });
    const targets = welcome['targets'] as Array<{ targetId: string; title: string }>;
    const idA2 = targets.find((t) => t.title === 'A2')!.targetId;

    const managed = gw.sessionRegistry.all()[0]!;
    const activate = vi.spyOn(managed, 'activateTarget').mockResolvedValue(undefined);
    const event = {
      t: 'input.mouse',
      targetId: idA2,
      kind: 'move',
      x: 5,
      y: 5,
      fw: 800,
      fh: 600,
      buttons: 0,
      modifiers: 0,
      leaseId: 'stale',
    };

    managed.dispatchInput(viewerId, { ...event, ts: Date.now() });
    expect(activate).toHaveBeenCalledTimes(1);

    // A real wait, not fake timers: the damper compares against
    // `monotonicNow()` and never schedules anything, so there is no timer
    // for a fake clock to advance.
    await new Promise((resolve) => setTimeout(resolve, 320));

    managed.dispatchInput(viewerId, { ...event, ts: Date.now() });
    expect(activate).toHaveBeenCalledTimes(2);

    activate.mockRestore();
    ws.close();
  });

  it('several viewers driving the SAME target promote it once between them', async () => {
    // Case 1 of `promoteOnInput`'s doc, and the case shared control makes
    // ordinary. N drivers agreeing on one tab must not cost N promotions.
    const a = await connectViewer(gw, { viewerId: 'vwr_a' });
    const b = await connectViewer(gw, { viewerId: 'vwr_b' });
    const targets = a.welcome['targets'] as Array<{ targetId: string; title: string }>;
    const idA2 = targets.find((t) => t.title === 'A2')!.targetId;

    const managed = gw.sessionRegistry.all()[0]!;
    const activate = vi.spyOn(managed, 'activateTarget').mockResolvedValue(undefined);
    const event = {
      t: 'input.mouse',
      targetId: idA2,
      kind: 'move',
      x: 5,
      y: 5,
      fw: 800,
      fh: 600,
      buttons: 0,
      modifiers: 0,
      leaseId: 'stale',
    };

    for (let i = 0; i < 6; i++) {
      managed.dispatchInput(a.viewerId, { ...event, ts: Date.now() });
      managed.dispatchInput(b.viewerId, { ...event, ts: Date.now() });
    }
    expect(activate).toHaveBeenCalledTimes(1);

    activate.mockRestore();
    a.ws.close();
    b.ws.close();
  });
});

/**
 * The end of the config chain, asserted as behaviour rather than as a
 * resolved field: `session.control.mode` -> `ResolvedConfig` ->
 * `createManagedSessionFactory` -> `ManagedSessionOptions.control` ->
 * `core.Session`'s `SessionOptions.control` -> `ControlLeaseEngine.mode`.
 *
 * `resolve.test.ts` proves the config layer produces the value. This proves
 * the value CHANGES WHAT HAPPENS, which is the half that was missing: every
 * link in that chain typechecked, the key was accepted, and shared control
 * still ran exclusive. A test asserting only `resolved.session.control.mode
 * === 'shared'` would have passed throughout.
 *
 * The exclusive case is asserted alongside it, not as padding: "the second
 * viewer is granted" is only evidence of anything if the same fixture,
 * built exclusive, queues them.
 */
describe('shared control: session.control.mode reaches the lease engine', () => {
  it("mode 'shared': a second viewer asking for control is granted immediately, not queued", async () => {
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const a = await connectViewer(gw, { viewerId: 'vwr_a' });
      const b = await connectViewer(gw, { viewerId: 'vwr_b' });
      const targetId = (a.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

      a.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'req-a', ts: Date.now(), targetId }),
      );
      const grantedA = await nextMessageSkipping(a.ws, UNSOLICITED);
      expect(grantedA['t']).toBe('control.granted');

      b.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'req-b', ts: Date.now(), targetId }),
      );
      const grantedB = await nextMessageSkipping(b.ws, [...UNSOLICITED, 'control.state']);
      // The exact failure an end to end run hit ten times was this message
      // arriving as `control.queued`, which on the wire reads
      // `{"granted":false,"queued":true,"position":1}`.
      expect(grantedB['t']).toBe('control.granted');
      expect(grantedB['re']).toBe('req-b');
      expect(grantedB['mode']).toBe('shared');
      // Per holder leaseIds, not one shared id: fencing matches an inbound
      // `leaseId` against each holder's own, so one driver can be revoked
      // without invalidating anybody else's in-flight input.
      expect(grantedB['leaseId']).not.toBe(grantedA['leaseId']);

      a.ws.close();
      b.ws.close();
    } finally {
      await gw.close();
    }
  });

  it('mode unset: the second viewer queues, exactly as every existing deployment expects', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const a = await connectViewer(gw, { viewerId: 'vwr_a' });
      const b = await connectViewer(gw, { viewerId: 'vwr_b' });
      const targetId = (a.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

      a.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'req-a', ts: Date.now(), targetId }),
      );
      const grantedA = await nextMessageSkipping(a.ws, UNSOLICITED);
      expect(grantedA['t']).toBe('control.granted');
      expect(grantedA['mode']).toBe('exclusive');

      b.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'req-b', ts: Date.now(), targetId }),
      );
      const queuedB = await nextMessageSkipping(b.ws, [...UNSOLICITED, 'control.state']);
      expect(queuedB['t']).toBe('control.queued');
      expect(queuedB['position']).toBe(1);

      a.ws.close();
      b.ws.close();
    } finally {
      await gw.close();
    }
  });
});

/**
 * `control.yield`: a person asks the AGENT holders of a shared target to
 * stand down, and every HUMAN holder keeps driving.
 *
 * `ControlLeaseEngine.requestAgentYield()` was implemented, typechecked and
 * unit tested before any of this existed, and could not be reached from a
 * socket at all: there was no `ManagedSession` method, no handler, and no
 * entry in the capability table. A feature that works and is only callable
 * from tests is indistinguishable, from the outside, from a feature that was
 * never built, so these tests go through the real `bgls.v1` loop rather than
 * calling the engine.
 *
 * Two things are asserted that are easy to get subtly wrong and impossible
 * to notice afterwards. The gate is `control`, NOT `admin`: the humans these
 * tests use hold no `admin` capability at all, so a route mistakenly gated
 * on `admin` fails them. And the two refusals carry their OWN error codes:
 * answering `not_shared` with `not_held` would be a lie about which
 * precondition failed, and answering `not_human` with `cap.missing` would
 * name a capability the sender demonstrably holds.
 */
describe('shared control: control.yield stands the agents down', () => {
  /** Enough to drive, and deliberately no `admin`: the gate under test is `control`. */
  const HUMAN_CAPS = ['view', 'control'];
  /** The same, plus `automation`, which is the ONE thing that makes a viewer an agent. */
  const AGENT_CAPS = ['view', 'control', 'automation'];

  async function sharedGatewayWithOneTarget(): Promise<TestGateway> {
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    return gw;
  }

  /** Sends `control.request` and drains through the `control.granted` reply, returning its `leaseId`. */
  async function acquire(ws: WebSocket, targetId: string, id: string): Promise<string> {
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id, ts: Date.now(), targetId }));
    const granted = await nextMessageSkipping(ws, [...UNSOLICITED, 'control.state']);
    expect(granted['t']).toBe('control.granted');
    return granted['leaseId'] as string;
  }

  it('reaches the engine: the agent holder is asked to stand down, naming its own leaseId', async () => {
    const gw = await sharedGatewayWithOneTarget();
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human', caps: HUMAN_CAPS });
      const agent = await connectViewer(gw, { viewerId: 'vwr_agent', caps: AGENT_CAPS });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

      const agentLeaseId = await acquire(agent.ws, targetId, 'req-agent');
      const humanLeaseId = await acquire(human.ws, targetId, 'req-human');
      // Shared mode, so both hold at once and each has its own leaseId.
      expect(humanLeaseId).not.toBe(agentLeaseId);

      human.ws.send(
        JSON.stringify({
          v: 1,
          t: 'control.yield',
          id: 'y1',
          ts: Date.now(),
          targetId,
          reason: 'taking over',
        }),
      );

      // `control.contention` joins the skip list alongside `control.state`:
      // the human's own `acquire()` above crosses the target from one
      // holder (the agent) to two, which broadcasts `control.contention`
      // to every viewer of the target, including this agent's own socket,
      // ahead of the `control.yield.request` this assertion is waiting for.
      const notice = await nextMessageSkipping(agent.ws, [
        ...UNSOLICITED,
        'control.state',
        'control.contention',
        'control.granted',
      ]);
      expect(notice['t']).toBe('control.yield.request');
      // The agent's OWN lease id, the one it must release. Sending it
      // anybody else's would tell it to release a lease it does not hold.
      expect(notice['leaseId']).toBe(agentLeaseId);
      expect(notice['byViewerId']).toBe(human.viewerId);
      expect(notice['reason']).toBe('taking over');
      expect(notice['graceMs']).toBeGreaterThan(0);
      expect(notice['deadline']).toBeGreaterThan(Date.now());

      human.ws.close();
      agent.ws.close();
    } finally {
      await gw.close();
    }
  });

  it('an agent that does not stand down is revoked with human_takeover, and the human keeps driving', async () => {
    // The enforcement half, end to end and in real time. This is the message
    // an `AutomationClient` has to handle, and the reason the reason
    // code is `human_takeover` rather than `admin`: an automation client
    // that logs or retries on one should not have to guess which happened.
    const gw = await sharedGatewayWithOneTarget();
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human', caps: HUMAN_CAPS });
      const agent = await connectViewer(gw, { viewerId: 'vwr_agent', caps: AGENT_CAPS });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

      const agentLeaseId = await acquire(agent.ws, targetId, 'req-agent');
      await acquire(human.ws, targetId, 'req-human');

      human.ws.send(
        JSON.stringify({ v: 1, t: 'control.yield', id: 'y1', ts: Date.now(), targetId }),
      );

      // The agent deliberately ignores the notice, which is exactly the case
      // the grace timer exists for.
      for (;;) {
        const msg = await nextMessage(agent.ws);
        if (msg['t'] !== 'control.revoked') continue;
        expect(msg['reason']).toBe('human_takeover');
        expect(msg['leaseId']).toBe(agentLeaseId);
        break;
      }

      // The human was never disturbed. A yield that took the requester's own
      // lease down with the agent's would be worse than no yield at all.
      const state = await (async (): Promise<Record<string, unknown>> => {
        for (;;) {
          const msg = await nextMessage(human.ws);
          if (msg['t'] === 'control.state') return msg;
        }
      })();
      const lease = (
        state['leases'] as Array<{ targetId: string; holderViewerId: string | null }>
      ).find((l) => l.targetId === targetId);
      expect(lease?.holderViewerId).toBe(human.viewerId);

      human.ws.close();
      agent.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('no agent driving is a SUCCESS, not an error: nothing comes back at all', async () => {
    // "No automation on this page" is the state the caller wanted. Asserted
    // by sending a `ping` straight after and requiring the very next message
    // to be its `pong`: an error reply would have been written to the socket
    // first and would land ahead of it.
    const gw = await sharedGatewayWithOneTarget();
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human', caps: HUMAN_CAPS });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      await acquire(human.ws, targetId, 'req-human');

      human.ws.send(
        JSON.stringify({ v: 1, t: 'control.yield', id: 'y1', ts: Date.now(), targetId }),
      );
      human.ws.send(JSON.stringify({ v: 1, t: 'ping', id: 'p1', ts: Date.now(), cts: Date.now() }));

      const next = await nextMessageSkipping(human.ws, [...UNSOLICITED, 'control.state']);
      expect(next['t']).toBe('pong');

      human.ws.close();
    } finally {
      await gw.close();
    }
  });

  it('refuses a yield on an EXCLUSIVE target with not_shared, not with not_held', async () => {
    // A client that sent the wrong message for the mode should learn so.
    // Exclusive control already lets a person take a target off an agent
    // through `control.request`, which gives that agent the same grace.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human', caps: HUMAN_CAPS });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      await acquire(human.ws, targetId, 'req-human');

      human.ws.send(
        JSON.stringify({ v: 1, t: 'control.yield', id: 'y1', ts: Date.now(), targetId }),
      );
      const reply = await nextMessageSkipping(human.ws, [...UNSOLICITED, 'control.state']);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.control.not_shared');
      expect(reply['category']).toBe('control');
      expect(reply['retryable']).toBe(false);
      expect(reply['re']).toBe('y1');

      human.ws.close();
    } finally {
      await gw.close();
    }
  });

  it('refuses a yield SENT BY an automation client with not_human', async () => {
    // Agent versus agent is already arbitrated by the priority ladder. This
    // also pins the human/agent inference itself: the only difference
    // between this viewer and the one in the passing cases above is the
    // `automation` capability in its token.
    const gw = await sharedGatewayWithOneTarget();
    try {
      const agent = await connectViewer(gw, { viewerId: 'vwr_agent', caps: AGENT_CAPS });
      const targetId = (agent.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      await acquire(agent.ws, targetId, 'req-agent');

      agent.ws.send(
        JSON.stringify({ v: 1, t: 'control.yield', id: 'y1', ts: Date.now(), targetId }),
      );
      const reply = await nextMessageSkipping(agent.ws, [...UNSOLICITED, 'control.state']);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.control.not_human');
      expect(reply['re']).toBe('y1');

      agent.ws.close();
    } finally {
      await gw.close();
    }
  });

  it('is gated on control: a view-only viewer cannot send it', async () => {
    // The narrowing that makes view-only a real state also closes this
    // route, because `control.yield` maps to `control` in the capability
    // table. A view-only viewer asking the automation to stand down would be
    // driving the page by proxy.
    const gw = await sharedGatewayWithOneTarget();
    try {
      const viewer = await connectViewer(gw, { viewerId: 'vwr_viewonly', input: [] });
      const targetId = (viewer.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

      viewer.ws.send(
        JSON.stringify({ v: 1, t: 'control.yield', id: 'y1', ts: Date.now(), targetId }),
      );
      const reply = await nextMessageSkipping(viewer.ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect(reply['context']).toMatchObject({ required: 'control' });

      viewer.ws.close();
    } finally {
      await gw.close();
    }
  });
});

/**
 * The two client-visible lease projections that were not projections at all:
 * `welcome.lease.byTarget`, hardcoded `{}`, and `resumed.lease`, hand built
 * from values invented at resume time.
 *
 * `resumed.lease` is the one that could actually hurt somebody, and the
 * arithmetic is worth spelling out because it is what makes the test below
 * a real assertion rather than a tautology.
 *
 * The old code sent `expiresAt: Date.now() + 60_000`, reading `60_000` as
 * "the lease TTL". A lease does not expire at its TTL. `computeExpiresAt`
 * returns `min(lastRenewAt + leaseTtlMs, lastInputAt + idleExpiryMs)`, and
 * `idleExpiryMs` is 30000 against `leaseTtlMs`'s 60000, so a holder who has
 * not sent input expires in THIRTY seconds, not sixty. `BrowserGlassClient`
 * schedules its `control.renew` off `expiresAt`, so a resuming client was
 * being told to renew at a moment roughly fifteen seconds after its lease
 * had already gone. The fabricated number was not merely inaccurate, it was
 * wrong in the one direction that breaks renewal.
 *
 * That thirty second gap is also what makes this testable without any
 * timing sensitivity: the honest answer and the fabricated one differ by
 * about half a minute, so no tolerance window has to be tuned.
 */
describe('shared control: welcome and resumed carry real lease projections', () => {
  /** Connects, subscribes (so the resume path has a target to restore), and takes control. */
  async function connectSubscribeAndHold(
    gw: TestGateway,
    viewerId: string,
  ): Promise<{
    ws: WebSocket;
    welcome: Record<string, unknown>;
    viewerId: string;
    targetId: string;
    granted: Record<string, unknown>;
  }> {
    const v = await connectViewer(gw, { viewerId });
    const targetId = (v.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
    v.ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
    const subscribed = await nextMessageSkipping(v.ws, UNSOLICITED);
    expect(subscribed['t']).toBe('stream.subscribed');
    v.ws.send(
      JSON.stringify({ v: 1, t: 'control.request', id: 'req-1', ts: Date.now(), targetId }),
    );
    const granted = await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']);
    expect(granted['t']).toBe('control.granted');
    return { ws: v.ws, welcome: v.welcome, viewerId: v.viewerId, targetId, granted };
  }

  /** Drops `ws` and reconnects with `welcome.resume`'s token, returning the `resumed` envelope. */
  async function resumeWith(
    gw: TestGateway,
    ws: WebSocket,
    welcome: Record<string, unknown>,
    viewerId: string,
  ): Promise<{ ws2: WebSocket; resumed: Record<string, unknown> }> {
    const sessionId = welcome['sessionId'] as string;
    const resumeToken = (welcome['resume'] as { token: string }).token;
    ws.close();
    await waitClose(ws);
    // Let the server's own close handler run before reconnecting, matching
    // `conformance.test.ts`'s resume case.
    await new Promise((r) => setTimeout(r, 20));

    const secondToken = await gw.issueToken({ viewerId });
    const ws2 = gw.connect();
    await waitOpen(ws2);
    ws2.send(
      JSON.stringify(
        hello({
          auth: { scheme: 'bearer', token: secondToken },
          resume: { token: resumeToken, sessionId, viewerId, lastSeq: {}, lastControlSq: 0 },
        }),
      ),
    );
    const welcome2 = await nextMessage(ws2);
    expect(welcome2['t']).toBe('welcome');
    expect(welcome2['resumed']).toBe(true);
    const resumed = await nextMessage(ws2);
    expect(resumed['t']).toBe('resumed');
    return { ws2, resumed };
  }

  it("resumed.lease.expiresAt is the engine's real deadline, not a wall clock offset computed at resume time", async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const held = await connectSubscribeAndHold(gw, 'vwr_a');
      const grantedExpiresAt = held.granted['expiresAt'] as number;

      // A real gap between the grant and the resume, so `grantedAt` cannot
      // pass by accidentally coinciding with `Date.now()` at resume time.
      await new Promise((r) => setTimeout(r, 300));

      const { ws2, resumed } = await resumeWith(gw, held.ws, held.welcome, held.viewerId);
      expect(resumed['leaseRestored']).toBe(true);
      const lease = resumed['lease'] as Record<string, unknown> | null;
      expect(lease).not.toBeNull();
      expect(lease!['targetId']).toBe(held.targetId);

      const expiresAt = lease!['expiresAt'] as number;
      const grantedAt = lease!['grantedAt'] as number;
      const now = Date.now();

      // THE assertion. The fabricated value was `Date.now() + 60_000`. The
      // real deadline is the idle expiry, thirty seconds out, because this
      // holder has sent no input. Half a minute of daylight between the two,
      // so this cannot pass by coincidence and needs no tuned tolerance.
      expect(expiresAt).toBeLessThan(now + 45_000);
      expect(expiresAt).toBeGreaterThan(now + 15_000);

      // And it agrees with what the engine itself would project right now,
      // which is the property that actually matters: welcome, resumed and
      // `control.state` all come from one projection and cannot disagree.
      const engine = gw.sessionRegistry.all()[0]!.coreSession.leaseEngineFor(held.targetId);
      const live = engine.projectState(held.viewerId);
      expect(Math.abs(expiresAt - (live.expiresAt ?? 0))).toBeLessThan(500);

      // `grantedAt` is when the tenure actually began, comfortably in the
      // past, not `Date.now()` stamped as the resume was assembled.
      expect(grantedAt).toBeLessThan(now - 200);
      // The grant's own `expiresAt`, observed on the wire before the
      // disconnect, sits within a few hundred ms of the resumed one: the
      // deadline did not move because the socket did.
      expect(Math.abs(expiresAt - grantedExpiresAt)).toBeLessThan(1_000);

      ws2.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it("resumed.lease.mode reports the target's real mode, and holders survives the reconnect", async () => {
    // `mode` was a TypeScript literal `'exclusive'` on the hand built
    // object, so this assertion was unreachable by construction: a resuming
    // viewer on a shared target was told the target was exclusive, and
    // `holders` did not exist at all, so it learned nothing about the people
    // still driving alongside it.
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const held = await connectSubscribeAndHold(gw, 'vwr_a');
      const { ws2, resumed } = await resumeWith(gw, held.ws, held.welcome, held.viewerId);

      const lease = resumed['lease'] as Record<string, unknown>;
      expect(lease['mode']).toBe('shared');
      const holders = lease['holders'] as Array<{ viewerId: string; connected: boolean }>;
      expect(holders.map((h) => h.viewerId)).toContain(held.viewerId);
      expect(lease['holderCount']).toBe(holders.length);
      // Per recipient: this viewer IS one of the drivers, so its own
      // holding is what `holderViewerId` reports back to it.
      expect(lease['holderViewerId']).toBe(held.viewerId);

      ws2.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('welcome.lease.byTarget describes the target somebody is already driving, instead of being empty', async () => {
    // Hardcoded `{}` since it was written, so a viewer joining a session
    // where somebody was already driving learned nothing from the handshake
    // and had to wait for whatever `control.state` fired next.
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const driver = await connectSubscribeAndHold(gw, 'vwr_driver');

      // A SECOND viewer joins after the first is already driving. This is
      // the case the field exists for.
      const joiner = await connectViewer(gw, { viewerId: 'vwr_joiner' });
      const byTarget = (
        joiner.welcome['lease'] as { byTarget: Record<string, Record<string, unknown>> }
      ).byTarget;

      const summary = byTarget[driver.targetId];
      expect(summary).toBeDefined();
      expect(summary!['mode']).toBe('shared');
      // Somebody is driving, and the joiner can see that before any
      // broadcast arrives.
      expect(summary!['holderCount']).toBe(1);
      // Per recipient, exactly as `control.state` is: the joiner is NOT a
      // holder, so its own holding is null. `holderCount` is the
      // recipient-independent answer to "is anyone driving".
      expect(summary!['holderViewerId']).toBeNull();
      expect(typeof summary!['expiresAt']).toBe('number');

      // The summary and the state come from one projection, so they agree.
      // This is the property that makes keeping `LeaseState` and
      // `LeaseSummary` as separate types safe.
      const engine = gw.sessionRegistry.all()[0]!.coreSession.leaseEngineFor(driver.targetId);
      const state = engine.projectState(joiner.viewerId);
      expect(summary!['holderCount']).toBe(state.holderCount);
      expect(summary!['mode']).toBe(state.mode);
      expect(summary!['queueLength']).toBe(state.queueLength);

      driver.ws.close();
      joiner.ws.close();
    } finally {
      await gw.close();
    }
  });

  it('welcome.lease.byTarget omits targets this session has no lease engine for, rather than inventing entries', async () => {
    // Absence and emptiness have to say different things. A target the
    // session has never seen a target-scoped action for is absent; a known
    // target nobody is driving is present with `holderCount: 0`. Scoping
    // this to known targets is also what stops building a handshake message
    // from acquiring an `InstanceStreamCounter` slot for every tab in the
    // browser, which is what iterating `listTargets()` would have done.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.addTarget({
      targetId: 'cdp-b',
      type: 'page',
      title: 'B',
      url: 'https://b.example',
      attached: false,
      windowId: 2,
    });
    try {
      const first = await connectViewer(gw, { viewerId: 'vwr_a' });
      const targets = first.welcome['targets'] as Array<{ targetId: string; title: string }>;
      const idA = targets.find((t) => t.title === 'A')!.targetId;
      const idB = targets.find((t) => t.title === 'B')!.targetId;
      // A fresh session has touched no target yet, so nothing is known.
      expect((first.welcome['lease'] as { byTarget: Record<string, unknown> }).byTarget).toEqual(
        {},
      );

      // Touch only A.
      first.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'req-1', ts: Date.now(), targetId: idA }),
      );
      const granted = await nextMessageSkipping(first.ws, [...UNSOLICITED, 'control.state']);
      expect(granted['t']).toBe('control.granted');

      const second = await connectViewer(gw, { viewerId: 'vwr_b' });
      const byTarget = (
        second.welcome['lease'] as { byTarget: Record<string, Record<string, unknown>> }
      ).byTarget;
      expect(Object.keys(byTarget)).toEqual([idA]);
      expect(byTarget[idA]!['holderCount']).toBe(1);
      expect(byTarget[idB]).toBeUndefined();

      first.ws.close();
      second.ws.close();
    } finally {
      await gw.close();
    }
  });

  it('welcome is still the FIRST frame on a resumed socket, even when restoring a lease broadcasts', async () => {
    // The regression guard for an older bug that lease restore exposed.
    // Restoring a control lease makes the engine emit a
    // BROADCAST `control.state`, and it used to run with the resuming
    // connection already registered, so that broadcast was written to the
    // brand new socket ahead of its own `welcome`. `welcome` lost its
    // guaranteed `sq: 1` and any client reading
    // the handshake positionally, as `conformance.test.ts` and every helper
    // in this file do, read a broadcast where the handshake should be.
    //
    // It went unnoticed because no existing test held a lease ACROSS a
    // resume: the conformance resume case restores a subscription only, and
    // subscription restore emits nothing to the resuming socket.
    //
    // Asserted with a raw `nextMessage`, never `nextMessageSkipping`. The
    // whole point is what arrives FIRST, so a helper that reads past
    // unsolicited traffic would defeat the test completely.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const held = await connectSubscribeAndHold(gw, 'vwr_a');
      const sessionId = held.welcome['sessionId'] as string;
      const resumeToken = (held.welcome['resume'] as { token: string }).token;
      held.ws.close();
      await waitClose(held.ws);
      await new Promise((r) => setTimeout(r, 20));

      const secondToken = await gw.issueToken({ viewerId: held.viewerId });
      const ws2 = gw.connect();
      await waitOpen(ws2);
      ws2.send(
        JSON.stringify(
          hello({
            auth: { scheme: 'bearer', token: secondToken },
            resume: {
              token: resumeToken,
              sessionId,
              viewerId: held.viewerId,
              lastSeq: {},
              lastControlSq: 0,
            },
          }),
        ),
      );

      const first = await nextMessage(ws2);
      expect(first['t']).toBe('welcome');
      expect(first['sq']).toBe(1);
      const second = await nextMessage(ws2);
      expect(second['t']).toBe('resumed');
      expect(second['leaseRestored']).toBe(true);

      ws2.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('restores a lease on a target the viewer was NOT subscribed to', async () => {
    // The old loop iterated the resuming viewer's restored SUBSCRIPTIONS,
    // so a lease held on a target nobody was watching was silently dropped
    // on reconnect. A lease and a subscription are different things: REST
    // driving takes control of a target it never subscribes to, and so does
    // any client driving a tab it is not currently displaying.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.addTarget({
      targetId: 'cdp-b',
      type: 'page',
      title: 'B',
      url: 'https://b.example',
      attached: false,
      windowId: 2,
    });
    try {
      const v = await connectViewer(gw, { viewerId: 'vwr_a' });
      const targets = v.welcome['targets'] as Array<{ targetId: string; title: string }>;
      const idA = targets.find((t) => t.title === 'A')!.targetId;
      const idB = targets.find((t) => t.title === 'B')!.targetId;

      // Subscribe to A, but take control of B.
      v.ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId: idA }));
      expect((await nextMessageSkipping(v.ws, UNSOLICITED))['t']).toBe('stream.subscribed');
      v.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'r1', ts: Date.now(), targetId: idB }),
      );
      expect((await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']))['t']).toBe(
        'control.granted',
      );

      const { ws2, resumed } = await resumeWith(gw, v.ws, v.welcome, v.viewerId);
      expect(resumed['leaseRestored']).toBe(true);
      const lease = resumed['lease'] as Record<string, unknown>;
      expect(lease['targetId']).toBe(idB);
      expect(lease['holderViewerId']).toBe(v.viewerId);

      ws2.close();
    } finally {
      await gw.close();
    }
  }, 15_000);
});

/**
 * The two defects that meant an `AutomationClient`'s input had never worked
 * by default. Both were measured against a real page in an agent-and-human
 * end to end run, and both were invisible to every existing test because every
 * existing test drives through a SUBSCRIBED viewer.
 *
 * A subscribed viewer gets its generation from `stream.subscribed` and its
 * frame dimensions from the stream itself, so both wrong values were routed
 * around. An `AutomationClient` has no subscription: it reads its generation
 * from `target.probe` and its `fw`/`fh` from `welcome.instance.viewport`,
 * which were a hardcoded `0` and a hardcoded 1440x900 respectively.
 *
 * These tests assert on `gw.chrome.inputCalls`, the CDP commands that
 * actually reached the browser, and that choice is load bearing. A gen-stale
 * drop is reported through `InputDispatcher.onSignal`, and `core`'s
 * `Session` wires `onSignal` to an empty function, so a dropped input
 * produces no error reply, no log line, and no wire traffic whatsoever.
 * Asserting "no error came back" would pass just as happily against the
 * broken code.
 */
describe('agent input: probe reports the live generation', () => {
  /** Waits until `predicate` holds over the recorded CDP input calls, or throws. Input dispatch is fire and forget on the wire, so there is no reply to await. */
  async function waitForInput(
    gw: TestGateway,
    predicate: (calls: readonly { method: string; params: Record<string, unknown> }[]) => boolean,
    what: string,
  ): Promise<void> {
    for (let i = 0; i < 200; i++) {
      if (predicate(gw.chrome.inputCalls)) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(`timed out waiting for ${what}; saw ${JSON.stringify(gw.chrome.inputCalls)}`);
  }

  it('target.probed.gen matches the generation the input dispatcher fences against', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const v = await connectViewer(gw, { viewerId: 'vwr_a' });
      const targetId = (v.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

      // Subscribing is what gives the target a `Stream`, and `Stream.gen`
      // seeds at 1. Before the fix the probe answered 0 here.
      v.ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
      expect((await nextMessageSkipping(v.ws, UNSOLICITED))['t']).toBe('stream.subscribed');

      v.ws.send(
        JSON.stringify({
          v: 1,
          t: 'target.probe',
          id: 'p1',
          ts: Date.now(),
          targetId,
          x: 5,
          y: 5,
          fw: 800,
          fh: 600,
        }),
      );
      const probed = await nextMessageSkipping(v.ws, UNSOLICITED);
      expect(probed['t']).toBe('target.probed');

      const managed = gw.sessionRegistry.all()[0]!;
      expect(probed['gen']).toBe(managed.currentGenFor(targetId));
      // Stated separately and deliberately: `Stream.gen` seeds at 1, so a
      // subscribed target can never honestly report 0, and 0 is the value
      // that poisoned `AutomationCore.ensureGen()`'s permanent cache.
      expect(probed['gen']).toBeGreaterThanOrEqual(1);

      v.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('input stamped with the probed gen actually reaches CDP, and input stamped with 0 does not', async () => {
    // The end to end proof, and the pair is the point: "the good one lands"
    // means nothing unless the broken one demonstrably does not.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const v = await connectViewer(gw, { viewerId: 'vwr_a' });
      const targetId = (v.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      v.ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
      expect((await nextMessageSkipping(v.ws, UNSOLICITED))['t']).toBe('stream.subscribed');

      v.ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
      const granted = await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']);
      expect(granted['t']).toBe('control.granted');
      const leaseId = granted['leaseId'] as string;

      v.ws.send(
        JSON.stringify({
          v: 1,
          t: 'target.probe',
          id: 'p1',
          ts: Date.now(),
          targetId,
          x: 5,
          y: 5,
          fw: 800,
          fh: 600,
        }),
      );
      // `control.state` is in the skip list because `control.request` above
      // broadcasts one after its `control.granted` reply. Reading it as the
      // probe reply yields `gen: undefined`, which then rides onto the input
      // message and is rejected as malformed, which looks exactly like the
      // defect under test passing.
      const probed = await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']);
      const gen = probed['gen'] as number;
      expect(probed['t']).toBe('target.probed');
      expect(typeof gen).toBe('number');

      // Exactly what `AutomationClient.click()` builds: the gen it got back
      // from `ensureGen()`, its lease id, and the instance viewport as
      // `fw`/`fh`.
      const base = {
        v: 1,
        t: 'input.mouse',
        ts: Date.now(),
        targetId,
        fw: 800,
        fh: 600,
        gen,
        leaseId,
        modifiers: 0,
      };
      v.ws.send(
        JSON.stringify({
          ...base,
          kind: 'down',
          x: 41,
          y: 42,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        }),
      );
      await waitForInput(
        gw,
        (calls) =>
          calls.some(
            (c) => c.method === 'Input.dispatchMouseEvent' && c.params['type'] === 'mousePressed',
          ),
        'a mousePressed carrying the probed gen',
      );

      // Now the broken shape, on the same live target and the same lease.
      // `resolveGenFencing` returns `drop_with_error` for a stale
      // `mouse.down`, so this must NOT reach the page.
      //
      // This assertion originally required the next frame to be the `pong`,
      // on the reasoning that nothing came back at all. That mirrored the
      // implementation rather than any contract: `onSignal` was wired to an
      // empty function in `core`, so silence was not a decision, it was an
      // omission. The contract is that the input does not dispatch, and
      // that is asserted on `inputCalls` below exactly as before. The drop
      // is now also explained on the wire, which is the whole point of the
      // signal work, so the reply is asserted rather than its absence.
      const before = gw.chrome.inputCalls.length;
      v.ws.send(
        JSON.stringify({
          ...base,
          gen: 0,
          kind: 'down',
          x: 91,
          y: 92,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        }),
      );
      const explained = await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']);
      expect(explained['t']).toBe('error');
      expect(explained['code']).toBe('bgls.error.input.gen_stale');
      // A round trip after it, so the input above has certainly been fully
      // processed before the dispatch count is read.
      v.ws.send(JSON.stringify({ v: 1, t: 'ping', id: 'pg', ts: Date.now(), cts: Date.now() }));
      expect((await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']))['t']).toBe(
        'pong',
      );
      expect(gw.chrome.inputCalls.length).toBe(before);

      v.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);
});

describe('agent input: welcome.instance.viewport is the real viewport', () => {
  it("reports the browser's actual rendered size, not a hardcoded 1440x900", async () => {
    // 762 by 427 is the real page the end to end run measured against. The agent
    // believed the page was 1440 wide, aimed at 720 for the middle of a text
    // box whose real centre is 381, and the press landed on the block below
    // and blurred the box.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.chrome.setLayoutViewport(762, 427);
    try {
      const v = await connectViewer(gw, { viewerId: 'vwr_a' });
      const instance = v.welcome['instance'] as {
        viewport: { width: number; height: number; dpr: number };
      };
      expect(instance.viewport.width).toBe(762);
      expect(instance.viewport.height).toBe(427);
      // An `AutomationClient` stamps exactly this onto `fw`/`fh`, so the
      // number it divides by to find the middle of anything is now the real
      // page width.
      expect(instance.viewport.width).not.toBe(1440);
      v.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('falls back to the documented default when the browser cannot answer', async () => {
    // `Page.getLayoutMetrics` replying with no `cssLayoutViewport` is real
    // Chrome's shape for a target whose metrics were never computed. The
    // fallback is the same 1440x900 as before, but it is now reached only
    // when nothing better exists rather than unconditionally.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const v = await connectViewer(gw, { viewerId: 'vwr_a' });
      const instance = v.welcome['instance'] as {
        viewport: { width: number; height: number; dpr: number };
      };
      expect(instance.viewport.width).toBe(1440);
      expect(instance.viewport.height).toBe(900);
      v.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('resolves the viewport once per session, not once per connection', async () => {
    // It costs a CDP round trip on the handshake path, so it is cached. A
    // second viewer joining must not pay for it again.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.chrome.setLayoutViewport(762, 427);
    try {
      const a = await connectViewer(gw, { viewerId: 'vwr_a' });
      const b = await connectViewer(gw, { viewerId: 'vwr_b' });
      for (const w of [a.welcome, b.welcome]) {
        expect((w['instance'] as { viewport: { width: number } }).viewport.width).toBe(762);
      }
      a.ws.close();
      b.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);
});

/**
 * REST driving on a SHARED target: the "an agent fills the form while a
 * person watches and occasionally takes the wheel" flow, which is the exact
 * use case shared control exists for.
 *
 * `withRestControl` borrows a lease under a synthetic REST viewer and stamps
 * its id onto every input it dispatches. It used to take that id from
 * `getSnapshot().leaseId`, which is a getter over `holders[0].leaseId`, the
 * PRIMARY holder's. Shared mode mints one leaseId per holder, so whenever a
 * person had been granted first, REST stamped the PERSON's lease id onto its
 * own input and `resolveInputFencing` dropped every message as stale.
 *
 * The failure had no symptom. The REST caller got a success, the page did
 * not move, and nothing was logged, because `InputDispatcher` reports the
 * drop through `onSignal` and `core`'s `Session` wires `onSignal` to an
 * empty function. So these tests assert on `gw.chrome.inputCalls`, the CDP
 * commands that actually reached the browser: nothing weaker can tell a
 * dispatched input from a discarded one.
 */
describe('shared control: REST input reaches the page while a person is also driving', () => {
  it('dispatches to CDP when a human already holds the same shared target', async () => {
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.chrome.setLayoutViewport(762, 427);
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human' });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

      // The person takes control FIRST, so they become `holders[0]` and
      // their lease id becomes the one `Lease.leaseId` reports. That
      // ordering is the whole bug: REST granted second read the person's id.
      human.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }),
      );
      const granted = await nextMessageSkipping(human.ws, [...UNSOLICITED, 'control.state']);
      expect(granted['t']).toBe('control.granted');
      const humanLeaseId = granted['leaseId'] as string;

      const managed = gw.sessionRegistry.all()[0]!;
      const before = gw.chrome.inputCalls.length;
      await managed.clickTarget(targetId, { x: 120, y: 64 });

      const dispatched = gw.chrome.inputCalls.slice(before);
      const pressed = dispatched.find(
        (c) => c.method === 'Input.dispatchMouseEvent' && c.params['type'] === 'mousePressed',
      );
      expect(pressed).toBeDefined();
      expect(pressed!.params['x']).toBe(120);
      expect(pressed!.params['y']).toBe(64);
      // A real click is a move, then a press, then a release. All three have
      // to survive fencing, not just the press.
      expect(dispatched.some((c) => c.params['type'] === 'mouseMoved')).toBe(true);
      expect(dispatched.some((c) => c.params['type'] === 'mouseReleased')).toBe(true);

      // The person is untouched: still a holder, still on their own lease.
      const engine = managed.coreSession.leaseEngineFor(targetId);
      expect(engine.holderFor(human.viewerId)?.leaseId).toBe(humanLeaseId);

      human.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('still dispatches when the human takes control BETWEEN two REST calls', async () => {
    // The takeover flow in miniature, and the ordering that decides which
    // holder is primary. The first REST call runs on an unheld target (REST
    // is `holders[0]`); the person then grabs the wheel; the second REST
    // call now runs with a person ahead of it in `holders`. Both must land.
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.chrome.setLayoutViewport(762, 427);
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human' });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      const managed = gw.sessionRegistry.all()[0]!;

      await managed.clickTarget(targetId, { x: 10, y: 11 });
      expect(gw.chrome.inputCalls.some((c) => c.params['x'] === 10 && c.params['y'] === 11)).toBe(
        true,
      );

      human.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }),
      );
      expect((await nextMessageSkipping(human.ws, [...UNSOLICITED, 'control.state']))['t']).toBe(
        'control.granted',
      );

      await managed.clickTarget(targetId, { x: 30, y: 31 });
      expect(gw.chrome.inputCalls.some((c) => c.params['x'] === 30 && c.params['y'] === 31)).toBe(
        true,
      );

      human.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('types text through to CDP on a shared target a human also holds', async () => {
    // `typeTarget` borrows a lease the same way `clickTarget` does, so it had
    // the same defect. `Input.insertText` carries no coordinates, which
    // makes the recorded call the only evidence it arrived.
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human' });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      human.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }),
      );
      expect((await nextMessageSkipping(human.ws, [...UNSOLICITED, 'control.state']))['t']).toBe(
        'control.granted',
      );

      const managed = gw.sessionRegistry.all()[0]!;
      await managed.typeTarget(targetId, 'hello from the agent');

      const inserted = gw.chrome.inputCalls.find((c) => c.method === 'Input.insertText');
      expect(inserted).toBeDefined();
      expect(inserted!.params['text']).toBe('hello from the agent');

      human.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it("REST borrows its OWN lease id, never the primary holder's", async () => {
    // The mechanism, asserted directly rather than only through its effect.
    // `Lease.leaseId` (the primary holder's) and the REST viewer's own id
    // must be different numbers on a shared target somebody else holds, and
    // it is the second that REST has to stamp.
    const gw = await startTestGateway({ control: { mode: 'shared' } });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const human = await connectViewer(gw, { viewerId: 'vwr_human' });
      const targetId = (human.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      human.ws.send(
        JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }),
      );
      const granted = await nextMessageSkipping(human.ws, [...UNSOLICITED, 'control.state']);
      const humanLeaseId = granted['leaseId'] as string;

      const managed = gw.sessionRegistry.all()[0]!;
      const engine = managed.coreSession.leaseEngineFor(targetId);

      // Grant the REST viewer alongside, exactly as `withRestControl` does.
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
      const restLeaseId = engine.holderFor('bgls:rest')?.leaseId;
      expect(restLeaseId).toBeDefined();
      expect(restLeaseId).not.toBe(humanLeaseId);
      // The singular field REST used to read really is the OTHER holder's,
      // which is precisely how its input came to be fenced out.
      expect(engine.getSnapshot().leaseId).toBe(humanLeaseId);

      human.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);
});

/**
 * Dropped input is observable.
 *
 * `InputDispatcher` reported every drop through `onSignal` and `core`'s
 * `Session` wired `onSignal` to an empty function, so a dropped input
 * produced no error reply, no wire traffic and no log line anywhere, and
 * `bgls.error.input.gen_stale` sat in the error registry having never been
 * emitted by anything. That silence is what hid the probe-gen defect, the
 * viewport defect and the REST lease-id defect, each of which presented as
 * "the page does not move" with nothing to go on.
 *
 * Two instruments here, and both are needed. `gw.chrome.inputCalls` proves
 * whether the input reached CDP, and `gw.logLines` proves whether the drop
 * was reported. Asserting only the first cannot tell a correct dispatch from
 * a silent discard; asserting only the second cannot tell a report from a
 * drop that should never have happened.
 */
describe('input signals: a dropped input is observable', () => {
  /** Subscribes, takes control, and returns the ids an input message needs. */
  async function driver(gw: TestGateway): Promise<{
    ws: WebSocket;
    viewerId: string;
    targetId: string;
    leaseId: string;
    gen: number;
  }> {
    const v = await connectViewer(gw, { viewerId: 'vwr_a' });
    const targetId = (v.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
    v.ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
    expect((await nextMessageSkipping(v.ws, UNSOLICITED))['t']).toBe('stream.subscribed');
    v.ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const granted = await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']);
    expect(granted['t']).toBe('control.granted');
    v.ws.send(
      JSON.stringify({
        v: 1,
        t: 'target.probe',
        id: 'p1',
        ts: Date.now(),
        targetId,
        x: 1,
        y: 1,
        fw: 800,
        fh: 600,
      }),
    );
    const probed = await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']);
    expect(probed['t']).toBe('target.probed');
    return {
      ws: v.ws,
      viewerId: v.viewerId,
      targetId,
      leaseId: granted['leaseId'] as string,
      gen: probed['gen'] as number,
    };
  }

  /** Waits until a log line matching `needle` appears, or throws with everything that was logged. */
  async function waitForLog(
    gw: TestGateway,
    needle: string,
  ): Promise<{ level: string; message: string }> {
    for (let i = 0; i < 200; i++) {
      const hit = gw.logLines.find((l) => l.message.includes(needle));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error(
      `no log line containing ${JSON.stringify(needle)}; saw ${JSON.stringify(gw.logLines)}`,
    );
  }

  it('a stale generation is logged with BOTH values and answered on the wire', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const d = await driver(gw);
      const before = gw.chrome.inputCalls.length;

      // `gen: 0` against a live target on generation 1: exactly the shape
      // the probe defect produced for every automation client.
      d.ws.send(
        JSON.stringify({
          v: 1,
          t: 'input.mouse',
          ts: Date.now(),
          targetId: d.targetId,
          fw: 800,
          fh: 600,
          gen: 0,
          leaseId: d.leaseId,
          modifiers: 0,
          kind: 'down',
          x: 5,
          y: 6,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        }),
      );

      const line = await waitForLog(gw, 'stale target generation');
      expect(line.level).toBe('warn');
      // The comparison, not just the verdict. "expected 1, received 0" is
      // the sentence that would have ended the probe-gen hunt in a minute.
      expect(line.message).toContain(`expected ${d.gen}`);
      expect(line.message).toContain('received 0');
      expect(line.message).toContain(d.targetId);
      expect(line.message).toContain(d.viewerId);

      const err = await nextMessageSkipping(d.ws, [...UNSOLICITED, 'control.state']);
      expect(err['t']).toBe('error');
      expect(err['code']).toBe('bgls.error.input.gen_stale');
      expect(err['retryable']).toBe(false);

      // And it really was dropped, not merely complained about.
      expect(gw.chrome.inputCalls.length).toBe(before);
      d.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('a wrong lease id is reported as lease_stale, naming both ids', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const d = await driver(gw);
      d.ws.send(
        JSON.stringify({
          v: 1,
          t: 'input.mouse',
          ts: Date.now(),
          targetId: d.targetId,
          fw: 800,
          fh: 600,
          gen: d.gen,
          leaseId: 'lse-not-mine',
          modifiers: 0,
          kind: 'down',
          x: 5,
          y: 6,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        }),
      );

      const line = await waitForLog(gw, 'lease id is not current');
      expect(line.level).toBe('warn');
      // This viewer DOES hold a lease, it just named the wrong id, which is
      // a different fault from holding none and needs different advice.
      expect(line.message).toContain(`expected ${d.leaseId}`);
      expect(line.message).toContain('received lse-not-mine');

      const err = await nextMessageSkipping(d.ws, [...UNSOLICITED, 'control.state']);
      expect(err['code']).toBe('bgls.error.control.lease_stale');
      d.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('driving with no lease at all is reported as not_held, a different fact', async () => {
    // The four reasons have to be four reasons. A viewer that never asked
    // for control needs "call control.request", not "use the newest id".
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const v = await connectViewer(gw, { viewerId: 'vwr_a' });
      const targetId = (v.welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
      v.ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
      expect((await nextMessageSkipping(v.ws, UNSOLICITED))['t']).toBe('stream.subscribed');

      v.ws.send(
        JSON.stringify({
          v: 1,
          t: 'input.mouse',
          ts: Date.now(),
          targetId,
          fw: 800,
          fh: 600,
          gen: 1,
          leaseId: 'lse-invented',
          modifiers: 0,
          kind: 'down',
          x: 5,
          y: 6,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        }),
      );

      const line = await waitForLog(gw, 'no control lease held');
      expect(line.level).toBe('warn');
      const err = await nextMessageSkipping(v.ws, [...UNSOLICITED, 'control.state']);
      expect(err['code']).toBe('bgls.error.control.not_held');
      v.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('a release on a dead lease is DISPATCHED and reported as nothing at all', async () => {
    // Requirement three, and the one most easily broken by a change that
    // "reports every drop". `ALWAYS_DISPATCHED_KINDS` exists so a departing
    // driver never leaves a button held down for everybody else, so a
    // `mouse.up` on a stale lease is dispatched, not dropped. Reporting it
    // as a failure would teach whoever reads these lines to ignore them,
    // which is how a signal channel dies.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const d = await driver(gw);
      const before = gw.chrome.inputCalls.length;

      d.ws.send(
        JSON.stringify({
          v: 1,
          t: 'input.mouse',
          ts: Date.now(),
          targetId: d.targetId,
          fw: 800,
          fh: 600,
          gen: d.gen,
          leaseId: 'lse-long-dead',
          modifiers: 0,
          kind: 'up',
          x: 5,
          y: 6,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        }),
      );

      // It reaches CDP: the button is released for everyone.
      for (let i = 0; i < 200 && gw.chrome.inputCalls.length === before; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const dispatched = gw.chrome.inputCalls.slice(before);
      expect(dispatched.some((c) => c.params['type'] === 'mouseReleased')).toBe(true);

      // And it is not reported as a fault.
      expect(gw.logLines.filter((l) => l.message.includes('input dropped'))).toEqual([]);
      d.ws.close();
    } finally {
      await gw.close();
    }
  }, 15_000);

  it('a flood is coalesced into one line carrying the suppressed count', async () => {
    // A control handoff turns a departing driver's in-flight moves into
    // hundreds of stale-lease drops a second. Reporting each would put more
    // traffic on the socket than the input did, on the socket already
    // carrying video, which is the ack-limiter stall again.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const d = await driver(gw);
      for (let i = 0; i < 25; i++) {
        d.ws.send(
          JSON.stringify({
            v: 1,
            t: 'input.mouse',
            ts: Date.now(),
            targetId: d.targetId,
            fw: 800,
            fh: 600,
            gen: 0,
            leaseId: d.leaseId,
            modifiers: 0,
            kind: 'down',
            x: i,
            y: i,
            button: 'left',
            buttons: 1,
            clickCount: 1,
          }),
        );
      }
      await waitForLog(gw, 'stale target generation');
      // Round trip so every one of the 25 has certainly been processed.
      d.ws.send(JSON.stringify({ v: 1, t: 'ping', id: 'pg', ts: Date.now(), cts: Date.now() }));
      for (let i = 0; i < 200; i++) {
        const msg = await nextMessageSkipping(d.ws, [...UNSOLICITED, 'control.state']);
        if (msg['t'] === 'pong') break;
      }

      const stale = gw.logLines.filter((l) => l.message.includes('stale target generation'));
      expect(stale.length).toBe(1);
      d.ws.close();
    } finally {
      await gw.close();
    }
  }, 20_000);

  it('backpressure is reported at debug and never as an error frame', async () => {
    // `queue_shed` is not a fault: the cursor has moved on and the shed
    // frame would have been overwritten before it painted. It is reported so
    // a stuttering drag can be told from a fencing fault, and at debug so it
    // does not read as one.
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const d = await driver(gw);
      // Well past the default `maxQueueDepth` of 10, sent in one burst so
      // the chain cannot drain between them.
      for (let i = 0; i < 120; i++) {
        d.ws.send(
          JSON.stringify({
            v: 1,
            t: 'input.mouse',
            ts: Date.now(),
            targetId: d.targetId,
            fw: 800,
            fh: 600,
            gen: d.gen,
            leaseId: d.leaseId,
            modifiers: 0,
            kind: 'move',
            x: i,
            y: i,
            button: 'none',
            buttons: 0,
          }),
        );
      }
      const line = await waitForLog(gw, 'move shed under backpressure');
      expect(line.level).toBe('debug');
      expect(line.message).toContain('chain depth');
      d.ws.close();
    } finally {
      await gw.close();
    }
  }, 20_000);
});
