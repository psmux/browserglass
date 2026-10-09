/**
 * Click-drag text selection, on several browsers at once.
 *
 * The bug this guards was invisible to every existing suite, and worth
 * describing precisely because nothing about it looked like a bug.
 *
 * `Input.dispatchMouseEvent` decides whether a `mouseMoved` continues a
 * drag or is a plain hover from its `button` field, not from `buttons`.
 * `InputDispatcher` sent `button: msg.button ?? 'none'`, and a client has
 * no reason to repeat `button` on every move of a drag (the press already
 * said which button it was), so every drag reached Chrome as a sequence of
 * hovers. Pressing worked, releasing worked, and the gesture in between did
 * nothing: no text selected, no element dragged, no splitter resized.
 *
 * Caught by driving the real demo, and confirmed by measurement rather than
 * by reading the code: the identical three pane gesture changed 0 canvas
 * pixels with `'none'` and roughly 500,000 with `'left'`, with the whole
 * page visibly highlighted in the second case.
 *
 * Two reasons the older suites could not see it. `parallel-multi-instance`
 * selects with a triple click, which is a `clickCount: 3` press and needs
 * no drag at all. Everything else clicks and types, which are single events
 * where `button` is set on the event that carries it.
 *
 * The dispatcher now derives both `button` and `buttons` for a move from
 * `held.buttons`, its own record of what it has actually seen pressed, so a
 * client that omits them still drags and a client that lies about them
 * cannot claim a button that was never pressed. `dispatcher.test.ts` pins
 * that mapping directly; this file proves the whole path end to end against
 * real Chrome, on three targets being dragged at the same moment.
 */
import type { BrowserGlassClient, StreamHandle } from '@browserglass/client';
import type { InstanceId } from '@browserglass/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

const TARGETS = 3;

let gateway: RealGateway;
let fixture: FixtureServer;
let client: BrowserGlassClient;
let instanceId: InstanceId;

interface Pane {
  readonly label: string;
  readonly targetId: string;
  readonly stream: StreamHandle;
  readonly fw: number;
  readonly fh: number;
  readonly gen: number;
}

let panes: Pane[] = [];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

/** The fixture page's report band, read through the ordinary public hit test. */
async function readEcho(pane: Pane): Promise<string | undefined> {
  const result = await client.probe(
    pane.targetId,
    Math.floor(pane.fw / 2),
    Math.floor(pane.fh * 0.8),
  );
  return result.hit ? result.label : undefined;
}

/**
 * Polls `readEcho` until `pred` holds, or gives up. `undefined` means it
 * never held.
 *
 * The 700ms gap is deliberate. `probeFullRate` is 2/sec with a burst of 4,
 * per target, and a full probe is genuinely expensive; polling three panes
 * every 250ms exhausted it and every read came back
 * `Rate limit exceeded for target.probe`, which reads exactly like a page
 * that never responded. A test should sit inside the budget it is not
 * trying to test.
 */
async function echoUntil(
  pane: Pane,
  pred: (echo: string) => boolean,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const echo = await readEcho(pane).catch(() => undefined);
    if (echo !== undefined && pred(echo)) return echo;
    if (Date.now() >= deadline) return undefined;
    await sleep(700);
  }
}

/**
 * A real press, several intermediate moves, and a release.
 *
 * `button` is deliberately NOT set on the move events. That is the whole
 * point: a correct client does not repeat it, and the server has to supply
 * it from what it saw pressed. Setting it here would test the client's
 * politeness rather than the dispatcher's contract, and would have passed
 * against the broken build.
 */
async function dragSelect(pane: Pane): Promise<void> {
  const base = inputBase(pane);
  // `#marker` occupies 35% to 60% of the viewport, but its TEXT is a
  // single line at the top of that band, not centred in it. A horizontal
  // sweep at the band's midpoint (`fh * 0.47`, which is what
  // `parallel-multi-instance.test.ts` triple clicks) passes underneath the
  // glyphs and selects nothing: a triple click selects the whole block
  // wherever inside it you click, a drag only selects what it actually
  // crosses. So this drags diagonally from just above the line to below
  // it, which crosses the text whatever the exact font metrics turn out
  // to be.
  //
  // `x0` is 0, not an inset. The page only reports a selection that
  // contains the WHOLE `SELECTABLEMARKER` string (`fixture-server.ts`:
  // `s.indexOf(MARKER) !== -1`), and the text starts at the div's left
  // edge, so a drag that begins even a few percent in anchors partway
  // through the word and is ignored however correct the drag itself was.
  const x0 = 0;
  const x1 = Math.floor(pane.fw * 0.95);
  const y0 = Math.floor(pane.fh * 0.36);
  const y1 = Math.floor(pane.fh * 0.55);

  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'move',
    x: x0,
    y: y0,
    buttons: 0,
    modifiers: 0,
  });
  await sleep(30);
  client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'down',
    x: x0,
    y: y0,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await sleep(30);
  for (let step = 1; step <= 8; step++) {
    client.sendInput({
      ...base,
      t: 'input.mouse',
      ts: Date.now(),
      kind: 'move',
      x: Math.round(x0 + ((x1 - x0) * step) / 8),
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
    startRealGateway({ headless: 'new', isolation: 'window' }),
    startFixtureServer(),
  ]);

  const acquired = await gateway.acquireInstance();
  instanceId = acquired.instanceId;
  client = await gateway.makeClient(instanceId);
  await client.connect();

  const targetIds: string[] = client.targets.length > 0 ? [client.targets[0]!.targetId] : [];
  while (targetIds.length < TARGETS) {
    const created = await client.tabs.new({ url: fixture.pageUrl(`drag-${targetIds.length}`) });
    targetIds.push(created.targetId);
  }

  panes = [];
  for (const [i, targetId] of targetIds.entries()) {
    const label = `drag-${i}`;
    const outcome = await client.requestControl(targetId);
    if (!outcome.granted) throw new Error(`control not granted on ${label}`);
    await client.navigate(targetId, fixture.pageUrl(label));
    const stream = await client.subscribe(targetId);
    panes.push({ label, targetId, stream, fw: stream.width, fh: stream.height, gen: stream.gen });
  }

  const ready = await Promise.all(
    panes.map((p) => echoUntil(p, (e) => e === `READY:${p.label}`, 30_000)),
  );
  if (ready.some((r) => r === undefined)) {
    throw new Error(`fixture pages never reported ready: ${JSON.stringify(ready)}`);
  }
}, 240_000);

afterAll(async () => {
  await gateway?.close(client ? [client] : []);
  await fixture?.close();
}, 120_000);

describe('click-drag selects text, on every browser at once', () => {
  it('selects text on all three targets from one simultaneous drag, with button set on the press only', async () => {
    // Every drag is issued through `Promise.all`, never in a per pane loop,
    // so a serialisation bug shows up as a pane that never selects rather
    // than as a slow demo later.
    await Promise.all(panes.map((p) => dragSelect(p)));

    // The fixture page reports a non-empty selection as `S:<text>`. Before
    // the fix this stayed at whatever the band last said, because the drag
    // arrived as a hover and Chrome selected nothing at all.
    const echoes = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e.startsWith('S:') && e.length > 2, 20_000)),
    );

    const missed = panes.filter((_, i) => echoes[i] === undefined).map((p) => p.label);
    expect(
      missed,
      `these panes selected nothing from a click-drag: ${JSON.stringify(echoes)}`,
    ).toEqual([]);
  }, 120_000);
});
