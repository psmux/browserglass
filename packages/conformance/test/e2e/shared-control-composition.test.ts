/**
 * Shared control composed with everything else this Instance is already
 * expected to do at the same time.
 *
 * `shared-control.test.ts` proves the feature itself on one target: two
 * leases, two drivers, one page, and clean pointer and key state when one
 * of them leaves. That file deliberately runs with `isolation: 'tab'` and a
 * single target, because a case about two leases should fail for reasons
 * about two leases.
 *
 * This file asks the next question, which is the one that actually decides
 * whether the demo works: does a SECOND DRIVER ARRIVING disturb anything
 * that already worked? The three properties proven earlier this session all
 * have to survive it:
 *
 *  - sticky reuse (`sticky-affinity.test.ts`): the Instance under test here
 *    is reached the way a returning user reaches theirs, by a second
 *    acquire that must come back reused, with no second Chrome launched.
 *    A guarantee that only holds on a freshly launched browser is worth
 *    nothing, because after affinity landed a returning user's browser is
 *    never freshly launched.
 *  - three windows streaming at once (`parallel-live-streams.test.ts`):
 *    three targets in three real OS windows, all producing frames across
 *    one shared wall clock window. Measured before the second driver
 *    arrives and again after, so "arriving cost nothing" is a comparison
 *    rather than an assertion about an absolute rate.
 *  - drag and selection (`drag-select-parallel.test.ts`): a real
 *    click-drag, with `button` set on the press only, still selecting text
 *    while two people hold leases on the same tab.
 *
 * And the thing that must NOT compose: driving one target must not reach
 * any other target. That was true with one viewer and is asserted again
 * with two, because a second holder on target 1 is a new way for input to
 * leak.
 *
 * Frames are counted on the wire, for the reason `parallel-live-streams`
 * gives: `StreamHandle` only emits its `frame` event from a
 * `CanvasRenderer`, there is no canvas in Node, and a renderer based count
 * reads zero for a perfectly healthy stream.
 *
 * Run `pnpm -r run build` before believing any result from this file. It
 * imports the other packages through their package exports, which resolve
 * to `dist`, while their sourcemaps point at `src`.
 */
import type { BrowserGlassClient, StreamHandle, TargetSummary } from '@browserglass/client';
import { type InstanceId, decodeBinaryHeader } from '@browserglass/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

/** Three targets: the smallest number that can tell "one live stream" from "one live stream plus a promoted one" from "all of them at once". */
const TARGETS = 3;

/** One shared measurement window, long enough that a stalled stream is unambiguous rather than unlucky. */
const MEASURE_MS = 5000;

/**
 * The floor a stream must clear to count as live, in frames per second.
 *
 * `parallel-live-streams.test.ts` sets the same floor at 2 against a page
 * driven by `requestAnimationFrame` measured at 81 to 103 fps, on the
 * grounds that a broken path produces a hard zero and the two populations
 * are two orders of magnitude apart. The collab page's animation is one
 * moving strip rather than a full viewport canvas, so its healthy rate is
 * lower; the floor stays where it is, because what must never happen is
 * still zero.
 */
const LIVE_FPS_FLOOR = 2;

/** The subject every acquire in this file is made for, so the second one has something to reattach to. */
const STICKY_SUBJECT = 'shared-control-composition:user';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Per `streamId` tally of binary frames that really arrived on the driving client's socket. */
const framesByStream = new Map<number, number>();

/** A `ws` subclass that tallies every binary message by the `streamId` in its header before handing it on untouched, installed through `TransportSocketOptions.WebSocketImpl`, the seam that option exists for. */
class CountingWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        const header = decodeBinaryHeader(data);
        framesByStream.set(header.streamId, (framesByStream.get(header.streamId) ?? 0) + 1);
      } catch {
        // A malformed frame is the binary codec suite's problem, not this file's.
      }
    });
  }
}

interface Pane {
  readonly label: string;
  readonly targetId: string;
  readonly stream: StreamHandle;
  readonly windowId: number | null;
  readonly fw: number;
  readonly fh: number;
  readonly gen: number;
}

let gateway: RealGateway;
let fixture: FixtureServer;
let instanceId: InstanceId;
/** The one viewer holding a lease on all three targets: the shape every earlier suite already proves. */
let owner: BrowserGlassClient;
/** The second driver, who joins ONE of the three and must disturb none of them. */
let guest: BrowserGlassClient;
let panes: Pane[] = [];
let firstVisit: Awaited<ReturnType<RealGateway['acquireInstance']>>;
let reattached: Awaited<ReturnType<RealGateway['acquireInstance']>>;
/** Set by the joining case; the cases after it assert against two live leases on `panes[1]`. */
let guestHoldsPane1 = false;

function inputBase(
  client: BrowserGlassClient,
  pane: Pane,
): { v: 1; targetId: string; fw: number; fh: number; gen: number; leaseId: string } {
  return { v: 1, targetId: pane.targetId, fw: pane.fw, fh: pane.fh, gen: pane.gen, leaseId: '' };
}

/** The collab page's report band, read through the ordinary public hit test at 75% of the frame height (inside `#state`, clear of the moving `#pulse` strip). */
async function readBand(client: BrowserGlassClient, pane: Pane): Promise<string | undefined> {
  const result = await client
    .probe(pane.targetId, Math.floor(pane.fw / 2), Math.floor(pane.fh * 0.75))
    .catch(() => null);
  return result?.hit ? result.label : undefined;
}

/** The `v=` field of the collab page's report, which is the shared text box's value. */
function valueField(band: string | undefined): string | null {
  if (band === undefined) return null;
  const match = /;v=([^;]*)/.exec(band);
  return match ? (match[1] ?? '') : null;
}

/** The `sel=` field: whether the CURRENT gesture produced a selection containing the marker. */
function selOf(band: string | undefined): boolean {
  return band !== undefined && /;sel=1/.test(band);
}

/** Polls `readBand` until `pred` holds. The 600ms gap keeps the suite inside `probeFullRate` (2/sec, burst 4, per target), which is not what this file is testing. */
async function bandUntil(
  client: BrowserGlassClient,
  pane: Pane,
  pred: (band: string) => boolean,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly last: string | undefined }> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  for (;;) {
    const band = await readBand(client, pane);
    if (band !== undefined) last = band;
    if (band !== undefined && pred(band)) return { ok: true, last: band };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(600);
  }
}

/**
 * Frames counted for every pane across ONE shared wall clock window,
 * returned as frames per second.
 *
 * One window for all panes, deliberately: measuring each pane in its own
 * window would let three panes that take turns being live pass a test only
 * "all three at once" should pass.
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
  // Printed, not only asserted on. A passing threshold check tells a reader
  // that the rate cleared 2 and nothing else; the numbers themselves are
  // what shows whether a later change halved the frame rate while staying
  // green, and they cost nothing to emit.
  // eslint-disable-next-line no-console
  console.log(
    `fps over ${Math.round(elapsedSec * 1000)}ms: ${JSON.stringify([...out].map(([k, v]) => [k, Math.round(v * 10) / 10]))}`,
  );
  return out;
}

/** Types into whatever has focus on `pane`, through `input.text`: a real client's paste and IME path, fenced by `leaseId` exactly like every other input kind. */
function typeText(client: BrowserGlassClient, pane: Pane, text: string): void {
  client.sendInput({ ...inputBase(client, pane), t: 'input.text', ts: Date.now(), text });
}

/** A real move, press and release at frame-space `(x, y)`. */
async function click(client: BrowserGlassClient, pane: Pane, x: number, y: number): Promise<void> {
  const base = inputBase(client, pane);
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
  await sleep(30);
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
  await sleep(30);
}

/**
 * A real press, several intermediate moves and a release across the
 * selectable block.
 *
 * `button` is deliberately NOT repeated on the moves. That is the property
 * `drag-select-parallel.test.ts` exists for: a correct client does not
 * repeat it, and `InputDispatcher` has to supply it from its own record of
 * what it saw pressed. Setting it here would test the client's politeness
 * instead.
 */
async function dragSelect(client: BrowserGlassClient, pane: Pane): Promise<void> {
  const base = inputBase(client, pane);
  // `#marker` sits between 30% and 50% of the viewport, and its TEXT is a
  // single line at the top of that band rather than centred in it, so the
  // sweep goes diagonally from just above the line to below it and starts
  // at x=0: the page only reports a selection containing the WHOLE marker
  // string, and the text starts at the div's left edge.
  const x1 = Math.floor(pane.fw * 0.95);
  const y0 = Math.floor(pane.fh * 0.31);
  const y1 = Math.floor(pane.fh * 0.45);
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'move',
    x: 0,
    y: y0,
    buttons: 0,
    modifiers: 0,
  });
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'down',
    x: 0,
    y: y0,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await sleep(40);
  for (let step = 1; step <= 8; step++) {
    client.sendInput({
      ...base,
      t: 'input.mouse',
      ts: Date.now(),
      kind: 'move',
      x: Math.round((x1 * step) / 8),
      y: Math.round(y0 + ((y1 - y0) * step) / 8),
      buttons: 1,
      modifiers: 0,
    });
    await sleep(30);
  }
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'up',
    x: x1,
    y: y1,
    button: 'left',
    buttons: 0,
    modifiers: 0,
    clickCount: 1,
  });
}

beforeAll(async () => {
  [gateway, fixture] = await Promise.all([
    startRealGateway({
      headless: 'new',
      // Three real OS windows. Chromium composites only a window's visible
      // tab, so three targets sharing one window can never all stream at
      // once; this is what makes the concurrency claim possible at all.
      isolation: 'window',
      controlMode: 'shared',
    }),
    startFixtureServer(),
  ]);

  // Two acquires for one user, the demo's own request shape both times.
  // `subject` is what the router stamps onto the instance row and
  // `sticky.subject` is what `findReusable` matches that column against, so
  // both are needed; `sticky-affinity.test.ts` pins that trap directly.
  //
  // `omitProfile` leaves the `profile` selector off rather than sending
  // `{ mode: 'ephemeral' }`. The pool's own `profileTemplate` already
  // defaults to ephemeral, so the RESOLVED profile is identical either way
  // and nothing about the affinity claim changes; what it buys is that this
  // file also runs against a tree whose router still refuses `profile` and
  // `sticky` together (`E_CONFLICTING_SELECTORS`), which is what a negative
  // control run needs.
  firstVisit = await gateway.acquireInstance({
    subject: STICKY_SUBJECT,
    sticky: { subject: STICKY_SUBJECT },
    omitProfile: true,
  });
  reattached = await gateway.acquireInstance({
    subject: STICKY_SUBJECT,
    sticky: { subject: STICKY_SUBJECT },
    omitProfile: true,
  });
  instanceId = reattached.instanceId;

  owner = await gateway.makeClient(instanceId, {
    sub: 'vwr_owner',
    transport: { WebSocketImpl: CountingWebSocket as never, allowInsecureTransport: true },
  });
  await owner.connect();

  const targetIds: string[] = owner.targets.length > 0 ? [owner.targets[0]!.targetId] : [];
  while (targetIds.length < TARGETS) {
    // `newWindow` is left unset on purpose: with the pool's BrowserSpec at
    // `isolation: 'window'` the server must default it, and a test that
    // passed the flag by hand would never catch that default regressing.
    const created = await owner.tabs.new({ url: fixture.collabUrl(`pane-${targetIds.length}`) });
    targetIds.push(created.targetId);
  }

  panes = [];
  for (const [i, targetId] of targetIds.entries()) {
    const label = `pane-${i}`;
    await owner.navigate(targetId, fixture.collabUrl(label));
    const outcome = await owner.requestControl(targetId);
    if (!outcome.granted)
      throw new Error(`control not granted on ${label}: ${JSON.stringify(outcome)}`);
    const stream = await owner.subscribe(targetId);
    // Asked of the server rather than read off `client.targets`: a
    // target's window is resolved lazily, on the subscribe that also
    // promotes it, so the summary cached at `welcome` predates it.
    const summary = (await owner.tabs.list()).find((t: TargetSummary) => t.targetId === targetId);
    panes.push({
      label,
      targetId,
      stream,
      windowId: summary?.windowId ?? null,
      fw: stream.width,
      fh: stream.height,
      gen: stream.gen,
    });
  }

  guest = await gateway.makeClient(instanceId, { sub: 'vwr_guest' });
  await guest.connect();
}, 300_000);

afterAll(async () => {
  await gateway?.close([owner, guest].filter((c): c is BrowserGlassClient => Boolean(c)));
  await fixture?.close();
}, 120_000);

describe('shared control composes with sticky reuse, three parallel windows, and drag selection', () => {
  it('reached this browser by sticky reuse, with no second Chrome launched, so everything below runs against a reattached instance', () => {
    // Ordered first. If this fails, every case after it is being asserted
    // against the wrong browser and their results mean nothing.
    expect(firstVisit.reused, 'the first acquire should have launched, not reused').toBe(false);
    expect(
      reattached.reused,
      `the second acquire did not reattach: ${JSON.stringify(reattached)}`,
    ).toBe(true);
    expect(reattached.instanceId).toBe(firstVisit.instanceId);
    // The operating system's own answer, not the router's claim about
    // itself: one browser-main process under this run's profile root.
    expect(gateway.chromeProcessCount()).toBe(1);
  });

  it('streams all three windows concurrently while one viewer holds all three leases', async () => {
    const windowIds = new Set(panes.map((p) => p.windowId));
    expect(
      windowIds.size,
      `three targets should be in three windows: ${JSON.stringify(panes.map((p) => p.windowId))}`,
    ).toBe(TARGETS);

    const fps = await measureConcurrentFps(MEASURE_MS);
    const stalled = [...fps.entries()]
      .filter(([, rate]) => rate < LIVE_FPS_FLOOR)
      .map(([label]) => label);
    expect(stalled, `these panes produced no frames: ${JSON.stringify([...fps])}`).toEqual([]);
  }, 120_000);

  it('grants a second driver a lease on one of the three, immediately, without queueing and without stalling the other two', async () => {
    const target = panes[1]!;
    await guest.subscribe(target.targetId);

    const startedAt = Date.now();
    const outcome = await guest.requestControl(target.targetId);
    const elapsedMs = Date.now() - startedAt;

    expect(
      outcome.granted,
      `the second driver was not granted a shared lease: ${JSON.stringify(outcome)}`,
    ).toBe(true);
    expect(elapsedMs).toBeLessThan(5000);
    expect(owner.hasControl(target.targetId), 'the owner lost control when the guest joined').toBe(
      true,
    );
    expect(guest.hasControl(target.targetId)).toBe(true);

    const lease = owner.leases.get(target.targetId);
    expect(
      lease?.queueLength,
      `somebody was queued on a shared target: ${JSON.stringify(lease?.queue)}`,
    ).toBe(0);

    // The composition claim. Measured AFTER the guest arrived, over a fresh
    // shared window, on all three panes.
    const fps = await measureConcurrentFps(MEASURE_MS);
    const stalled = [...fps.entries()]
      .filter(([, rate]) => rate < LIVE_FPS_FLOOR)
      .map(([label]) => label);
    expect(
      stalled,
      `a second driver arriving stalled these panes: ${JSON.stringify([...fps])}`,
    ).toEqual([]);

    guestHoldsPane1 = true;
  }, 180_000);

  it('lands the second driver input on its own target and on no other target', async () => {
    expect(guestHoldsPane1, 'skipped: the guest never took a shared lease').toBe(true);

    // A known starting value on every pane, typed by the owner, so "the
    // guest changed nothing here" is a statement about a value rather than
    // about an empty box.
    for (const pane of panes) {
      await click(owner, pane, Math.floor(pane.fw / 2), Math.floor(pane.fh * 0.15));
      typeText(owner, pane, `OWNER${pane.label.slice(-1)}`);
    }
    for (const pane of panes) {
      const settled = await bandUntil(
        owner,
        pane,
        (b) => valueField(b) === `OWNER${pane.label.slice(-1)}`,
        25_000,
      );
      expect(settled.ok, `${pane.label} never took its baseline value: ${settled.last}`).toBe(true);
    }

    const shared = panes[1]!;
    typeText(guest, shared, 'GUEST');
    const landed = await bandUntil(owner, shared, (b) => valueField(b) === 'OWNER1GUEST', 25_000);
    expect(landed.ok, `the guest's input never reached the shared target: ${landed.last}`).toBe(
      true,
    );

    // And nowhere else. A second holder on one target is a new way for
    // input to leak into another, so the other two are re-read rather than
    // assumed unchanged.
    await sleep(1500);
    for (const pane of [panes[0]!, panes[2]!]) {
      const band = await readBand(owner, pane);
      expect(valueField(band), `the guest's input leaked into ${pane.label}: ${band}`).toBe(
        `OWNER${pane.label.slice(-1)}`,
      );
    }
  }, 180_000);

  it('still selects text from a click-drag on a target two people are holding at once', async () => {
    expect(guestHoldsPane1, 'skipped: the guest never took a shared lease').toBe(true);
    const shared = panes[1]!;

    // The guest drives the drag, on a target the owner is also holding.
    // Both `InputDispatcher.heldFor` bookkeeping and `resolveInputFencing`
    // have to be right per holder for this to select anything: the moves
    // carry no `button`, so a dispatcher that lost track of the guest's
    // press sends them as plain hovers and Chrome selects nothing.
    await dragSelect(guest, shared);
    const selected = await bandUntil(owner, shared, (b) => selOf(b), 25_000);
    expect(selected.ok, `a drag by the second driver selected nothing: ${selected.last}`).toBe(
      true,
    );

    // The other two panes keep streaming through it.
    const fps = await measureConcurrentFps(MEASURE_MS);
    const stalled = [...fps.entries()]
      .filter(([, rate]) => rate < LIVE_FPS_FLOOR)
      .map(([label]) => label);
    expect(
      stalled,
      `a drag on a shared target stalled these panes: ${JSON.stringify([...fps])}`,
    ).toEqual([]);
  }, 180_000);
});
