import type { BrowserGlassClient, StreamHandle, TargetSummary } from '@browserglass/client';
/**
 * The acceptance gate for simultaneous driving of several browsers.
 *
 * `parallel-multi-instance.test.ts` already proves that *input* fans out
 * correctly: nine tabs across three Chromes clicked, typed into and
 * navigated at the same moment, every effect landing in exactly its own
 * tab. It reads every effect back through `client.probe()`, a hit test,
 * and so it passes even when not one of those nine tabs is producing a
 * single video frame. That is precisely the hole this file closes.
 *
 * The user visible bug it exists for: on the demo wall, exactly one pane
 * was ever badged LIVE and every other pane sat frozen on a 1500ms poll,
 * and clicking any pane stole the live slot from whichever pane had it.
 * Driving two browsers at once was impossible, not merely slow.
 *
 * Root cause, measured rather than guessed
 * ----------------------------------------
 * Chromium composites only a window's *visible* tab. A backgrounded tab
 * emits a hard zero frames, not a reduced rate (measured in the window
 * isolation spike referenced below). Every target used to be a tab of one window, so one live
 * stream per Instance was the architectural ceiling no amount of tuning
 * could raise.
 *
 * `packages/runtime-host/test/spike/spike-window-isolation.ts` measured the
 * way out, against real Chrome 151, using the same `CdpScreencastSource`
 * this pipeline uses, N=4, 5 second windows:
 *
 *   Arm A, 4 tabs in ONE window:    [0, 0, 0, 98.9] fps, 1 distinct windowId
 *   Arm B, 4 tabs in FOUR windows:  [81.6, 81.8, 82.4, 81.0] fps, 4 windowIds
 *   Arm C, arm B after focus was forced onto window 0:
 *                                   [89.6, 89.8, 89.8, 89.6] fps
 *
 * Arm C is the one that makes the fix safe to ship: an unfocused, partly
 * occluded OS window keeps painting at full rate, so window isolation does
 * not trade one stall for another. The numbers were identical under
 * `headless: 'new'`, which is why this suite can run unattended.
 *
 * What this file asserts, and why each assertion is here
 * -----------------------------------------------------
 * 1. Three targets in one Instance report three DISTINCT `windowId`s, and
 *    all three report `active: true`. Under the old per-instance policy at
 *    most one target could ever be active, so this alone is a regression
 *    guard on the policy change.
 * 2. All three produce frames CONCURRENTLY, measured over one shared wall
 *    clock window. Two panes taking turns would satisfy a per pane
 *    assertion and is exactly the bug; only a single shared window can
 *    tell those apart.
 * 3. Input into targets 0 and 2 does not stall target 1. This is the
 *    literal failure the user reported: touching one pane froze another.
 * 4. Every verb the user listed (navigate, reload, click, drag, type,
 *    copy and paste, close, reopen) is issued across all three targets
 *    through `Promise.all`, never in a per target loop, while the frame
 *    counters keep running. A serialisation bug anywhere in the input,
 *    control or CDP path shows up here as a stalled counter rather than as
 *    a slow demo later.
 *
 * Frames are counted on the wire, not through the renderer. `StreamHandle`
 * only emits its `frame` event from a `CanvasRenderer`'s `onPaint`, and
 * there is no canvas in Node, so a renderer based count would read zero for
 * a perfectly healthy stream. `TransportSocketOptions.WebSocketImpl` is the
 * documented seam for exactly this ("Node passes `ws`; tests pass a
 * scripted fake"), so this file passes a `ws` subclass that decodes each
 * binary message's header with the protocol's own `decodeBinaryHeader` and
 * tallies it by `streamId`. That counts real bytes that really crossed the
 * socket.
 */
import { type InstanceId, decodeBinaryHeader } from '@browserglass/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

/**
 * Three targets: the smallest number that can tell "one live stream" from
 * "one live stream plus a promoted one" from "all of them at once". Two
 * would pass under a policy that merely swapped the live slot faster.
 */
const TARGETS = 3;

/** Long enough for a stalled stream to be unambiguous rather than unlucky, short enough to keep the suite usable. */
const MEASURE_MS = 5000;

/**
 * The floor a stream must clear to count as live, in frames per second.
 *
 * The spike measured 81 to 103 fps per stream for a `requestAnimationFrame`
 * page, and the old broken path produced a hard zero, so the two
 * populations sit two orders of magnitude apart and the exact threshold
 * hardly matters. It sits at 2 rather than near the observed rate on
 * purpose: this suite is asserting that a stream is ALIVE, not policing a
 * frame rate, and a machine under load has every right to deliver 20fps
 * instead of 100. What must never happen is zero.
 *
 * The panes all run `fixture.animatedUrl`, never `pageUrl`. Chrome's
 * screencast is change driven, so a static page reports zero frames whether
 * streaming is healthy or completely broken and cannot tell the two apart.
 * An earlier version of this file used the static page and measured
 * {"pane-0":0,"pane-1":0,"pane-2":0} against a working pipeline.
 */
const LIVE_FPS_FLOOR = 2;

let gateway: RealGateway;
let fixture: FixtureServer;

/** Per `streamId` tally of binary frames that really arrived on the socket. */
const framesByStream = new Map<number, number>();

/**
 * A `ws` subclass that tallies every binary message by the `streamId` in
 * its header before handing it on untouched. Installed through
 * `TransportSocketOptions.WebSocketImpl`, the seam that option exists for.
 * It changes nothing about the connection: the client still parses, acks
 * and dispatches every frame exactly as it would with plain `ws`.
 */
class CountingWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        const header = decodeBinaryHeader(data);
        framesByStream.set(header.streamId, (framesByStream.get(header.streamId) ?? 0) + 1);
      } catch {
        // A malformed frame is the binary codec suite's problem, not this
        // file's; never let a decode failure here take down the socket.
      }
    });
  }
}

/** One target under test, with everything an input envelope for it needs. */
interface Pane {
  readonly label: string;
  readonly targetId: string;
  readonly stream: StreamHandle;
  readonly windowId: number | null;
  readonly fw: number;
  readonly fh: number;
  readonly gen: number;
}

let client: BrowserGlassClient;
let instanceId: InstanceId;
let panes: Pane[] = [];

/**
 * The subject every acquire in this file is made for.
 *
 * Since browser affinity landed, this suite reaches its instance the way
 * a returning user does: an acquire that launches, then a SECOND acquire
 * with the same `sticky.subject` that must reattach to it. Every
 * assertion below then runs against a browser the router handed back by
 * reuse rather than one it had just launched, which is the point. The
 * concurrent-streaming and parallel-driving guarantees this file exists
 * for are worth nothing if they only hold on a freshly launched Chrome,
 * because after the affinity fix a returning user's browser is never
 * freshly launched.
 */
const STICKY_SUBJECT = 'parallel-live-streams:user';

/** The first acquire's result, and the second's. Asserted in this file's own first case, before anything is built on top of them. */
let firstVisit: Awaited<ReturnType<RealGateway['acquireInstance']>>;
let reattached: Awaited<ReturnType<RealGateway['acquireInstance']>>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The common half of every input envelope for `pane`. `leaseId` is stamped by `client.sendInput()` itself from the pane's live lease. */
function inputBase(pane: Pane): {
  v: 1;
  targetId: string;
  fw: number;
  fh: number;
  gen: number;
  leaseId: string;
} {
  return { v: 1, targetId: pane.targetId, fw: pane.fw, fh: pane.fh, gen: pane.gen, leaseId: '' };
}

/** A real move, press and release at frame-space `(x, y)`. */
async function click(pane: Pane, x: number, y: number): Promise<void> {
  const base = inputBase(pane);
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'move',
    x,
    y,
    buttons: 0,
    modifiers: 0,
  });
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'down',
    x,
    y,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await sleep(20);
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'up',
    x,
    y,
    button: 'left',
    buttons: 0,
    modifiers: 0,
    clickCount: 1,
  });
}

/** A real press, several intermediate moves, and a release: a drag Chrome will treat as a selection gesture rather than two unrelated clicks. */
async function drag(pane: Pane, from: [number, number], to: [number, number]): Promise<void> {
  const base = inputBase(pane);
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'move',
    x: from[0],
    y: from[1],
    buttons: 0,
    modifiers: 0,
  });
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'down',
    x: from[0],
    y: from[1],
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  for (let step = 1; step <= 4; step++) {
    const x = Math.round(from[0] + ((to[0] - from[0]) * step) / 4);
    const y = Math.round(from[1] + ((to[1] - from[1]) * step) / 4);
    client.sendInput({
      ...base,
      t: 'input.mouse',
      ts: Date.now(),
      kind: 'move',
      x,
      y,
      buttons: 1,
      modifiers: 0,
    });
    await sleep(10);
  }
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'up',
    x: to[0],
    y: to[1],
    button: 'left',
    buttons: 0,
    modifiers: 0,
    clickCount: 1,
  });
}

/** Types `text` as a real client would for a paste or an IME commit. */
function typeText(pane: Pane, text: string): void {
  client.sendInput({ ...inputBase(pane), t: 'input.text', ts: Date.now(), text });
}

/**
 * CDP's modifier bitmask, from `packages/core/src/input/key-events.ts`:
 * 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
 */
const CTRL = 2;

/**
 * A real chord, as a keyboard produces it: the modifier goes down, the
 * letter goes down and up while it is held, then the modifier comes up.
 *
 * This is how the suite exercises copy and paste. There is no
 * `clipboard.read`/`clipboard.write` on the wire (the gateway answers
 * `Unknown message type` for both, which is how an earlier version of this
 * file discovered it), and the client's own `clipboard` helpers speak that
 * unimplemented pair. Ctrl+C and Ctrl+V through `input.key` are what a
 * viewer driving a pane actually sends, so they are what this asserts on.
 */
async function chord(pane: Pane, key: string, code: string): Promise<void> {
  const base = inputBase(pane);
  client.sendInput({
    ...base,
    t: 'input.key',
    ts: Date.now(),
    kind: 'down',
    key: 'Control',
    code: 'ControlLeft',
    modifiers: CTRL,
  });
  client.sendInput({
    ...base,
    t: 'input.key',
    ts: Date.now(),
    kind: 'down',
    key,
    code,
    modifiers: CTRL,
  });
  client.sendInput({
    ...base,
    t: 'input.key',
    ts: Date.now(),
    kind: 'up',
    key,
    code,
    modifiers: CTRL,
  });
  client.sendInput({
    ...base,
    t: 'input.key',
    ts: Date.now(),
    kind: 'up',
    key: 'Control',
    code: 'ControlLeft',
    modifiers: 0,
  });
  await sleep(20);
}

/**
 * Frames counted for every pane across one shared wall clock window,
 * returned as frames per second. One window for all panes, deliberately:
 * measuring each pane in its own window would let three panes that take
 * turns being live pass a test that only "all three at once" should pass.
 */
async function measureConcurrentFps(ms: number): Promise<Map<string, number>> {
  const before = new Map<string, number>();
  for (const pane of panes) before.set(pane.label, framesByStream.get(pane.stream.streamId) ?? 0);

  const start = Date.now();
  await sleep(ms);
  const elapsedSec = (Date.now() - start) / 1000;

  const out = new Map<string, number>();
  for (const pane of panes) {
    const delta = (framesByStream.get(pane.stream.streamId) ?? 0) - (before.get(pane.label) ?? 0);
    out.set(pane.label, delta / elapsedSec);
  }
  return out;
}

/** Subscribes, takes control, and records everything an input envelope for this target needs. */
async function makePane(label: string, targetId: string): Promise<Pane> {
  const outcome = await client.requestControl(targetId);
  if (!outcome.granted)
    throw new Error(`control not granted on ${label}: ${JSON.stringify(outcome)}`);
  const stream = await client.subscribe(targetId);
  // Asked of the server rather than read off `client.targets`. A target's
  // window is resolved lazily, on the subscribe that also promotes it, so
  // the summary the client cached at `welcome` predates it. The server
  // re-sends `windowId` on the `target.updated` that follows a subscribe,
  // but a round trip here is not racing that broadcast at all.
  const summary = (await client.tabs.list()).find((t: TargetSummary) => t.targetId === targetId);
  return {
    label,
    targetId,
    stream,
    windowId: summary?.windowId ?? null,
    fw: stream.width,
    fh: stream.height,
    gen: stream.gen,
  };
}

beforeAll(async () => {
  [gateway, fixture] = await Promise.all([
    // `isolation: 'window'` is the whole point of this suite: it is what
    // puts each target in its own OS window. Every other e2e file in this
    // directory leaves it at the default 'tab'.
    startRealGateway({ headless: 'new', isolation: 'window' }),
    startFixtureServer(),
  ]);

  // Two acquires for one user, the demo's own request shape both times:
  // an ephemeral profile plus `sticky`, with `subject` beside it (the
  // router stamps `subject` onto the instance row and matches
  // `sticky.subject` against that column, so both fields are needed;
  // `sticky-affinity.test.ts` pins that trap directly). The second must
  // come back reused, and everything in this file is then built on the
  // instance it returned.
  firstVisit = await gateway.acquireInstance({
    subject: STICKY_SUBJECT,
    sticky: { subject: STICKY_SUBJECT },
  });
  reattached = await gateway.acquireInstance({
    subject: STICKY_SUBJECT,
    sticky: { subject: STICKY_SUBJECT },
  });
  instanceId = reattached.instanceId;

  client = await gateway.makeClient(instanceId, {
    transport: { WebSocketImpl: CountingWebSocket as never, allowInsecureTransport: true },
  });
  await client.connect();

  const targetIds: string[] = client.targets.length > 0 ? [client.targets[0]!.targetId] : [];
  while (targetIds.length < TARGETS) {
    // `newWindow` is left unset on purpose: with the pool's BrowserSpec at
    // `isolation: 'window'`, the server must default it, and a test that
    // passed the flag by hand would never catch that default regressing.
    const created = await client.tabs.new({ url: fixture.animatedUrl(`pane-${targetIds.length}`) });
    targetIds.push(created.targetId);
  }

  panes = [];
  for (const [i, targetId] of targetIds.entries()) {
    const label = `pane-${i}`;
    await client.navigate(targetId, fixture.animatedUrl(label));
    panes.push(await makePane(label, targetId));
  }
}, 240_000);

afterAll(async () => {
  await gateway?.close(client ? [client] : []);
  await fixture?.close();
}, 120_000);

describe('several targets of one browser stream and are driven at the same time', () => {
  it('reached this browser by sticky reuse, with no second Chrome launched, so everything below is asserted against a reattached instance', () => {
    // Ordered first on purpose. If this fails, every case after it is
    // measuring a freshly launched browser and its result says nothing
    // about the returning-user path the demo actually takes.
    expect(firstVisit.reused).toBe(false);
    expect(reattached.instanceId).toBe(firstVisit.instanceId);
    expect(reattached.reused).toBe(true);
    expect(reattached.reuseReason).toBe('sticky');
    // `reused` is the router's own account of itself. This is the
    // operating system's: one real Chrome browser-main process under this
    // run's profile root, counted from the process table.
    expect(
      gateway.chromeProcessCount(),
      'the second acquire launched another Chrome instead of reattaching',
    ).toBe(1);
  });

  it('puts every target in its own OS window and marks all of them active', () => {
    const windowIds = panes.map((p) => p.windowId);
    expect(windowIds.every((id) => typeof id === 'number')).toBe(true);
    expect(new Set(windowIds).size).toBe(TARGETS);

    // Under the old single `_activeTargetId` policy exactly one of these
    // could be true. All three being true is the policy change, observed
    // from the wire rather than from the internals.
    const actives = panes.map((p) => client.targets.find((t) => t.targetId === p.targetId)?.active);
    expect(actives).toEqual(Array.from({ length: TARGETS }, () => true));
  });

  it('produces frames on every stream over one shared measurement window', async () => {
    const fps = await measureConcurrentFps(MEASURE_MS);
    // Reported as one object so a failure shows the whole shape at once:
    // the old bug's signature is one healthy number next to two zeroes.
    const shape = Object.fromEntries(fps);
    for (const pane of panes) {
      expect
        .soft(
          fps.get(pane.label) ?? 0,
          `${pane.label} produced no frames while its siblings streamed: ${JSON.stringify(shape)}`,
        )
        .toBeGreaterThan(LIVE_FPS_FLOOR);
    }
  }, 60_000);

  it('keeps a quiet target streaming while its siblings are being driven', async () => {
    const driven = [panes[0]!, panes[2]!];
    const quiet = panes[1]!;

    let stop = false;
    // Hammer both driven panes for the whole measurement window, at the
    // same moment, never in a per pane loop. If input promotion still
    // steals a single instance wide live slot, `quiet` goes to zero here.
    const driving = (async () => {
      while (!stop) {
        await Promise.all(
          driven.map(async (pane) => {
            await click(pane, Math.floor(pane.fw / 2), Math.floor(pane.fh * 0.15));
            typeText(pane, 'x');
          }),
        );
        await sleep(50);
      }
    })();

    const fps = await measureConcurrentFps(MEASURE_MS);
    stop = true;
    await driving;

    const shape = JSON.stringify(Object.fromEntries(fps));
    expect
      .soft(
        fps.get(quiet.label) ?? 0,
        `the untouched pane stalled while two siblings were driven: ${shape}`,
      )
      .toBeGreaterThan(LIVE_FPS_FLOOR);
    for (const pane of driven) {
      expect
        .soft(fps.get(pane.label) ?? 0, `${pane.label} stalled while being driven: ${shape}`)
        .toBeGreaterThan(LIVE_FPS_FLOOR);
    }
  }, 60_000);

  it('runs every navigation verb across all targets at once without stalling any of them', async () => {
    const all = <T>(fn: (pane: Pane, i: number) => Promise<T>): Promise<T[]> =>
      Promise.all(panes.map(fn));

    // Each verb fans out across all three targets simultaneously. Any
    // shared lock, single in-flight promise, or per process CDP queue in
    // the path turns this from parallel into serial, and the frame
    // counters below catch it.
    await all((pane, i) => client.navigate(pane.targetId, fixture.animatedUrl(`verb-${i}`)));
    await all((pane) => client.reload(pane.targetId));
    await all((pane) => click(pane, Math.floor(pane.fw / 2), Math.floor(pane.fh * 0.15)));
    await all(async (pane) => typeText(pane, 'hello'));
    await all((pane) =>
      drag(
        pane,
        [20, Math.floor(pane.fh * 0.4)],
        [Math.floor(pane.fw * 0.6), Math.floor(pane.fh * 0.55)],
      ),
    );
    await all((pane) => chord(pane, 'a', 'KeyA'));
    await all((pane) => chord(pane, 'c', 'KeyC'));
    await all((pane) => chord(pane, 'v', 'KeyV'));
    await all((pane) => client.back(pane.targetId));

    const fps = await measureConcurrentFps(MEASURE_MS);
    const shape = JSON.stringify(Object.fromEntries(fps));
    for (const pane of panes) {
      expect
        .soft(
          fps.get(pane.label) ?? 0,
          `${pane.label} stalled after the parallel verb sweep: ${shape}`,
        )
        .toBeGreaterThan(LIVE_FPS_FLOOR);
    }
  }, 180_000);

  it('closes and reopens every target at once, and the reopened ones stream too', async () => {
    const closing = panes.map((p) => p.targetId);
    await Promise.all(closing.map((targetId) => client.tabs.close(targetId)));

    // Nothing that was closed may be left behind: a leaked OS window is
    // the "excess browsers" half of the requirement.
    await sleep(2000);
    for (const targetId of closing) {
      expect(client.targets.find((t) => t.targetId === targetId)).toBeUndefined();
    }

    const created = await Promise.all(
      Array.from({ length: TARGETS }, (_, i) =>
        client.tabs.new({ url: fixture.animatedUrl(`reopened-${i}`) }),
      ),
    );
    const reopened: Pane[] = [];
    for (const [i, target] of created.entries()) {
      reopened.push(await makePane(`reopened-${i}`, target.targetId));
    }
    panes = reopened;

    expect(new Set(reopened.map((p) => p.windowId)).size).toBe(TARGETS);

    const fps = await measureConcurrentFps(MEASURE_MS);
    const shape = JSON.stringify(Object.fromEntries(fps));
    for (const pane of reopened) {
      expect
        .soft(
          fps.get(pane.label) ?? 0,
          `${pane.label} did not stream after being reopened: ${shape}`,
        )
        .toBeGreaterThan(LIVE_FPS_FLOOR);
    }
  }, 180_000);
});
