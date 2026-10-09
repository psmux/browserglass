/**
 * The acceptance gate for shared control: several people driving the SAME
 * browser tab at the same time, with nobody waiting.
 *
 * The requirement, in the user's own words, is "view or view and control",
 * chosen freely: "multiple people to be not only able to view and wait in a
 * queue but also able to control immediately if needed, which is most
 * likely how most people will use". Today `LeaseMode` names `'shared'` and
 * ships only `'exclusive'`, so a second viewer on a busy target is queued
 * and their input is dropped on the floor by `resolveInputFencing` until
 * the first one lets go.
 *
 * What each file in this directory already proves, and why none of it
 * covers this
 * ---------------------------------------------------------------------
 * `parallel-multi-instance.test.ts` drives nine tabs across three Chromes
 * at once, and `parallel-live-streams.test.ts` proves three targets of one
 * Instance stream and are driven concurrently. Both are one viewer holding
 * N exclusive leases on N DIFFERENT targets, which is a completely
 * different claim: no two of those leases ever contend, because no two of
 * them are on the same target. `reply-correlation.test.ts` is the one file
 * that puts two viewers on ONE target, and what it proves there is that
 * the second is QUEUED. That is the behaviour this feature exists to
 * remove.
 *
 * So every assertion below is about two leases on one target, held at the
 * same moment, both driving.
 *
 * How the page is measured
 * ------------------------
 * Through `fixture.collabUrl()`, whose page publishes what it currently
 * HAS HELD every 80ms rather than what last happened to it. That
 * distinction is the whole reason it exists. A driver who presses a mouse
 * button and then disconnects leaves no event behind; they leave an
 * absence, and the only way to measure an absence is to ask the page what
 * it is holding right now. The report is read back through the ordinary
 * `target.probe` hit test, so nothing here uses a channel into Chrome that
 * a real BrowserGlass client would not have.
 *
 * The negative control
 * --------------------
 * The second `describe` in this file runs the same two viewer setup against
 * a gateway left in `'exclusive'` mode and asserts the OPPOSITE outcome:
 * the second viewer is queued rather than granted, and their keystrokes
 * never reach the page. It is both this file's permanent negative control
 * (a shared mode assertion that also passed under exclusive mode would be
 * proving nothing) and the regression guard on exclusive mode itself,
 * which must keep working exactly as it does now.
 *
 * Stale `dist`
 * ------------
 * This package imports `@browserglass/core`, `@browserglass/server` and the
 * rest through their package exports, which resolve to `dist`, while their
 * sourcemaps point at `src`. A stack trace therefore reads as if `src` were
 * running when it is not. Run `pnpm -r run build` before any run of this
 * file whose result is going to be believed.
 */
import type { BrowserGlassClient, StreamHandle } from '@browserglass/client';
import type { Capability, InstanceId } from '@browserglass/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

/**
 * CDP's modifier bitmask, from `packages/core/src/input/key-events.ts`:
 * 1 Alt, 2 Ctrl, 4 Meta, 8 Shift.
 */
const CTRL = 2;
const SHIFT = 8;

/**
 * The mode the first `describe` starts its gateway in. `'shared'` always,
 * except when this file is being run AS its own negative control.
 *
 * Set `BGLS_SHARED_CONTROL_MODE=exclusive` and every case in the shared
 * block runs, unchanged, against a gateway that admits one holder per
 * target. They must all fail. A case that passes under both values is
 * proving nothing about shared control and has to be rewritten, which is
 * the whole reason this switch exists rather than the mode being a
 * literal. The exclusive `describe` at the bottom of the file is the
 * permanent half of the same idea; this is the one that puts the SHARED
 * assertions themselves through it.
 */
const SHARED_MODE: 'shared' | 'exclusive' =
  process.env['BGLS_SHARED_CONTROL_MODE'] === 'exclusive' ? 'exclusive' : 'shared';

/**
 * Every live `ws` socket the capturing transport has opened, newest last.
 *
 * The disconnect case needs a socket it can kill WITHOUT the client getting
 * a word in first, and `client.destroy()` is not that: its very first act is
 * `releaseAllLeasesOnWire()`, which sends a `control.release` for every lease
 * it holds before it touches the transport. A case that called `destroy()`
 * and called the result a disconnect was measuring the polite release path
 * under a disconnect name, and measured it: the departing driver was out of
 * `holders[]` 305ms later, which is `settleHolderExit` running from
 * `release()` and not a grace window expiring.
 *
 * `TransportSocketOptions.WebSocketImpl` is the documented seam ("Node passes
 * `ws`; tests pass a scripted fake"), and `ws`'s own `terminate()` destroys
 * the connection immediately with no close frame, which is what a laptop lid
 * closing looks like from the server side.
 */
const capturedSockets: WebSocket[] = [];

/** A `ws` subclass that records each socket it opens so a test can kill one outright. It changes nothing else about the connection. */
class CapturingWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    capturedSockets.push(this);
  }
}

/** Every capability except `control`: a viewer who chose to watch. */
const VIEW_ONLY_CAPS: readonly Capability[] = ['view', 'probe', 'devtools'];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One viewer's handle on one target: their own client, their own stream, their own lease. */
interface Driver {
  readonly name: string;
  readonly client: BrowserGlassClient;
  readonly stream: StreamHandle;
  readonly targetId: string;
  readonly fw: number;
  readonly fh: number;
  readonly gen: number;
}

/** The common half of every input envelope. `leaseId` is stamped by `client.sendInput()` itself from that client's own live lease, which is exactly what makes a second driver's input testable: if they hold no lease, their events go out with an empty `leaseId` and the dispatcher drops them. */
function inputBase(d: Driver): {
  v: 1;
  targetId: string;
  fw: number;
  fh: number;
  gen: number;
  leaseId: string;
} {
  return { v: 1, targetId: d.targetId, fw: d.fw, fh: d.fh, gen: d.gen, leaseId: '' };
}

/** The collab page's live report, parsed. See `fixture-server.ts`'s `collabPage` for the grammar. */
interface CollabState {
  /** `window.innerWidth`, CSS px. Every coordinate assertion is written against this rather than against the frame size, which the stream is free to scale. */
  readonly w: number;
  /** Live `MouseEvent.buttons` mask. Non-zero means something is still pressed. */
  readonly buttons: number;
  /** Every `KeyboardEvent.code` with an unmatched `keydown`. */
  readonly keys: readonly string[];
  /** The shared text box's value. */
  readonly value: string;
  /** The last 8 `mousedown` positions, CSS px, in order. */
  readonly downs: readonly { readonly x: number; readonly y: number }[];
  /** Whether the CURRENT gesture produced a selection containing the marker. Reset on every press. */
  readonly sel: boolean;
}

function parseCollab(label: string | undefined): CollabState | null {
  if (label === undefined || !label.startsWith('C:')) return null;
  const fields = new Map<string, string>();
  for (const part of label.slice(2).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    fields.set(part.slice(0, eq), part.slice(eq + 1));
  }
  const keysRaw = fields.get('k') ?? '';
  const downsRaw = fields.get('d') ?? '';
  return {
    w: Number(fields.get('w') ?? 0),
    buttons: Number(fields.get('b') ?? 0),
    keys: keysRaw === '' ? [] : keysRaw.split('+'),
    value: fields.get('v') ?? '',
    downs:
      downsRaw === ''
        ? []
        : downsRaw.split('|').map((pair) => {
            const [x, y] = pair.split(',');
            return { x: Number(x), y: Number(y) };
          }),
    sel: (fields.get('sel') ?? '0') === '1',
  };
}

/**
 * Reads the collab page's report band through the ordinary public hit test.
 *
 * Probed at 75% of the frame height, which is inside `#state` (50% to 95%)
 * and clear of `#pulse` (95% to 100%), the moving strip that exists only so
 * the page produces compositor frames.
 */
async function readCollab(reader: Driver): Promise<CollabState | null> {
  const result = await reader.client
    .probe(reader.targetId, Math.floor(reader.fw / 2), Math.floor(reader.fh * 0.75))
    .catch(() => null);
  if (!result || !result.hit) return null;
  return parseCollab(result.label);
}

/**
 * Polls `readCollab` until `pred` holds, or gives up and returns the last
 * reading it managed to take (never `undefined`, so a failure message can
 * say what the page actually said rather than only that it never said the
 * right thing).
 *
 * The 600ms gap is deliberate. `probeFullRate` is 2/sec with a burst of 4
 * per target and a full probe is genuinely expensive; polling faster than
 * that exhausts the budget and every read comes back
 * `Rate limit exceeded for target.probe`, which is indistinguishable from a
 * page that never responded. A test should sit inside the limits it is not
 * trying to test.
 */
async function collabUntil(
  reader: Driver,
  pred: (s: CollabState) => boolean,
  timeoutMs: number,
): Promise<{ readonly ok: boolean; readonly last: CollabState | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: CollabState | null = null;
  for (;;) {
    const state = await readCollab(reader);
    if (state) last = state;
    if (state && pred(state)) return { ok: true, last: state };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(600);
  }
}

/** A real move, press and release at frame-space `(x, y)`. */
async function click(d: Driver, x: number, y: number): Promise<void> {
  const base = inputBase(d);
  d.client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'move',
    x,
    y,
    buttons: 0,
    modifiers: 0,
  });
  d.client.sendInput({
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
  d.client.sendInput({
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

/** A press with no matching release, at frame-space `(x, y)`. What a driver leaves behind when they walk away mid gesture. */
function pressAndHold(d: Driver, x: number, y: number): void {
  const base = inputBase(d);
  d.client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'move',
    x,
    y,
    buttons: 0,
    modifiers: 0,
  });
  d.client.sendInput({
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
}

/** A modifier keydown with no matching keyup. `code` is what the page sees and reports, so two drivers holding two different modifiers stay distinguishable. */
function holdModifier(d: Driver, key: string, code: string, mask: number): void {
  d.client.sendInput({
    ...inputBase(d),
    t: 'input.key',
    ts: Date.now(),
    kind: 'down',
    key,
    code,
    modifiers: mask,
  });
}

/**
 * Types `text` into whatever has focus.
 *
 * `input.text` rather than a stream of `input.key` char events, matching
 * what `parallel-multi-instance.test.ts` and `parallel-live-streams.test.ts`
 * already do. A bare `input.key` with `kind: 'char'` is deliberately
 * DROPPED by `buildKeyEvent` for any ordinary printable key: it assumes the
 * preceding `keyDown` already carried the text and refuses to double-type.
 * `input.text` is a real client's own path for a paste or an IME commit,
 * and it is fenced by `leaseId` exactly like every other input kind
 * (`fenceKindOf` gives it `'other'`, which is not in
 * `ALWAYS_DISPATCHED_KINDS`), which is the property every case below
 * depends on.
 */
async function typeText(d: Driver, text: string): Promise<void> {
  d.client.sendInput({ ...inputBase(d), t: 'input.text', ts: Date.now(), text });
  await sleep(120);
}

// ═══════════════════════════════════════════════════════════════════════
// Shared mode
// ═══════════════════════════════════════════════════════════════════════

describe('shared control: two viewers drive one tab at the same time', () => {
  let gateway: RealGateway;
  let fixture: FixtureServer;
  let instanceId: InstanceId;
  let targetId: string;
  let alice: Driver;
  let bob: Driver;

  /**
   * Puts both viewers back in the state every case below needs: two live,
   * concurrent leases on the one target.
   *
   * Called at the top of each case rather than a flag being set once by the
   * first one. The difference matters for the negative control: with a
   * shared flag, every case after the first reports "skipped, the two
   * viewers never both held control", which says nothing about the
   * behaviour that case exists for. Re-establishing it here means each case
   * fails on its own substance, naming which viewer was refused and what
   * the server said.
   *
   * `queue: false` on purpose. Under exclusive mode the second request
   * comes back denied at once instead of sitting in a queue, so the
   * negative control run neither hangs nor leaves a queue entry behind for
   * a later case to trip over.
   */
  async function ensureBothHold(): Promise<void> {
    for (const d of [alice, bob]) {
      if (d.client.hasControl(targetId)) continue;
      const outcome = await d.client.requestControl(targetId, { queue: false, timeoutMs: 10_000 });
      expect(
        outcome.granted,
        `${d.name} was not granted a concurrent lease on the shared target: ${JSON.stringify(outcome)}`,
      ).toBe(true);
    }
    expect(
      alice.client.hasControl(targetId) && bob.client.hasControl(targetId),
      'both viewers were granted but not both are holding',
    ).toBe(true);
  }

  /**
   * Reloads the collab page and puts the caret back in the shared text box,
   * so each case starts from a page holding nothing.
   *
   * `clicker` is made to hold a lease FIRST. The click into the box is real
   * input and is fenced like any other, so a driver who happens to hold no
   * lease at this moment silently focuses nothing, every later `typeText` in
   * that case inserts into the body instead of the box, and the case reports
   * an empty value. That is not a product failure, it is this helper quietly
   * doing nothing, and it is worth one round trip to make impossible rather
   * than debugging it again later.
   */
  async function resetPage(label: string, clicker: Driver = alice): Promise<void> {
    await ensureHolds(clicker);
    await clicker.client.navigate(targetId, fixture.collabUrl(label));
    const ready = await collabUntil(clicker, (s) => s.w > 0, 30_000);
    expect(
      ready.ok,
      `collab page never published a report after navigate: ${JSON.stringify(ready.last)}`,
    ).toBe(true);
    await focusBox(clicker);
  }

  /** Clicks `d` into the shared text box. Anything that presses elsewhere on the page (the report band, the selectable block) blurs it, so a driver about to type has to take focus back explicitly rather than assuming whoever clicked last left it there. */
  async function focusBox(d: Driver): Promise<void> {
    await click(d, Math.floor(d.fw / 2), Math.floor(d.fh * 0.15));
  }

  /** Makes sure one driver holds a lease, taking one if not. The single driver half of {@link ensureBothHold}. */
  async function ensureHolds(d: Driver): Promise<void> {
    if (d.client.hasControl(targetId)) return;
    const outcome = await d.client.requestControl(targetId, { queue: false, timeoutMs: 10_000 });
    expect(outcome.granted, `${d.name} was not granted a lease: ${JSON.stringify(outcome)}`).toBe(
      true,
    );
  }

  beforeAll(async () => {
    [gateway, fixture] = await Promise.all([
      startRealGateway({
        headless: 'new',
        // The whole subject of this file. Against a build where shared
        // mode is not implemented, `resolveConfig` ignores the key (it
        // rejects nothing it does not know), every target stays exclusive,
        // and the cases below fail on the behaviour rather than on the
        // constructor, which is the failure mode a negative control wants.
        controlMode: SHARED_MODE,
      }),
      startFixtureServer(),
    ]);

    const acquired = await gateway.acquireInstance();
    instanceId = acquired.instanceId;

    // Only alice gets the capturing transport, so `capturedSockets` holds
    // her sockets and nobody else's and the disconnect case cannot kill the
    // wrong one.
    const aliceClient = await gateway.makeClient(instanceId, {
      sub: 'vwr_alice',
      transport: { WebSocketImpl: CapturingWebSocket as never, allowInsecureTransport: true },
    });
    const bobClient = await gateway.makeClient(instanceId, { sub: 'vwr_bob' });
    await aliceClient.connect();
    await bobClient.connect();

    targetId =
      aliceClient.targets[0]?.targetId ??
      (await aliceClient.tabs.new({ url: fixture.collabUrl('collab') })).targetId;
    await aliceClient.navigate(targetId, fixture.collabUrl('collab'));

    // Both viewers subscribe to the SAME target. Each gets their own
    // `streamId` and their own `fw`/`fh`/`gen`, which is what an input
    // envelope is stamped with, so neither can accidentally borrow the
    // other's stream identity.
    const aliceStream = await aliceClient.subscribe(targetId);
    const bobStream = await bobClient.subscribe(targetId);

    alice = {
      name: 'alice',
      client: aliceClient,
      stream: aliceStream,
      targetId,
      fw: aliceStream.width,
      fh: aliceStream.height,
      gen: aliceStream.gen,
    };
    bob = {
      name: 'bob',
      client: bobClient,
      stream: bobStream,
      targetId,
      fw: bobStream.width,
      fh: bobStream.height,
      gen: bobStream.gen,
    };
  }, 240_000);

  afterAll(async () => {
    await gateway?.close(
      [alice?.client, bob?.client].filter((c): c is BrowserGlassClient => Boolean(c)),
    );
    await fixture?.close();
  }, 120_000);

  it('publishes a live report from the collab page, so a later zero reading is a product failure and not a broken fixture', async () => {
    // Ordered first on purpose. Every assertion after this one reads the
    // page through this band, and a band that never publishes would make
    // all of them fail for the wrong reason. It also pins the two numbers
    // the coordinate assertions are written against.
    const ready = await collabUntil(alice, (s) => s.w > 0, 60_000);
    expect(ready.ok, `collab page never published a report: ${JSON.stringify(ready.last)}`).toBe(
      true,
    );
    expect(ready.last?.buttons).toBe(0);
    expect(ready.last?.keys).toEqual([]);
  }, 120_000);

  it('grants a second viewer control on a target the first already holds, immediately and without queueing anyone', async () => {
    const first = await alice.client.requestControl(targetId);
    expect(first.granted, `alice was not granted control: ${JSON.stringify(first)}`).toBe(true);

    const startedAt = Date.now();
    const second = await bob.client.requestControl(targetId);
    const elapsedMs = Date.now() - startedAt;

    // "Granted quickly" and "granted without queueing" are different
    // claims and both are asserted, separately. A build that queued bob
    // and then dequeued him a few milliseconds later would satisfy the
    // first and is not what was asked for.
    expect(
      second.granted,
      `bob was not granted control on a shared target: ${JSON.stringify(second)}`,
    ).toBe(true);
    expect(
      second,
      `bob's grant answered a queue rather than the request itself`,
    ).not.toHaveProperty('queued', true);
    expect(elapsedMs).toBeLessThan(5000);

    // Two holders, two DISTINCT lease ids. One shared id would make it
    // impossible to fence one driver's in-flight input without fencing
    // everyone's, which is why the design rejects it.
    const aliceLeaseId = first.granted ? first.leaseId : '';
    const bobLeaseId = second.granted ? second.leaseId : '';
    expect(aliceLeaseId).not.toBe('');
    expect(bobLeaseId).not.toBe('');
    expect(bobLeaseId).not.toBe(aliceLeaseId);

    // Held at the same moment, not in sequence.
    expect(alice.client.hasControl(targetId), 'alice lost control the instant bob took it').toBe(
      true,
    );
    expect(bob.client.hasControl(targetId)).toBe(true);

    // And nobody is waiting, on either viewer's own copy of the lease
    // table. `control.state` is broadcast to the whole session, so both
    // copies have to agree.
    await sleep(500);
    const aliceViewerId = alice.client.viewerId;
    const bobViewerId = bob.client.viewerId;
    for (const d of [alice, bob]) {
      const lease = d.client.leases.get(targetId);
      expect(lease, `${d.name} has no lease row for the shared target`).toBeDefined();
      expect(lease?.mode).toBe('shared');
      expect(
        lease?.queueLength,
        `${d.name} sees a non-empty queue on a shared target: ${JSON.stringify(lease?.queue)}`,
      ).toBe(0);
      expect(lease?.queue ?? []).toEqual([]);
      expect(
        d.client.controlQueuePosition(targetId),
        `${d.name} was given a queue position on a shared target`,
      ).toBeNull();

      // `holders[]` is the roster, and it is the SAME for every recipient.
      // `holderViewerId` is not: in shared mode it reports the recipient's
      // OWN holding, so that the ordinary "am I driving?" test
      // (`holderViewerId === myViewerId`) stays correct for every driver
      // rather than for one arbitrary driver out of several. Both halves
      // are asserted, from both sockets, because a broadcast that agreed
      // with itself on only one of them would be a bug nobody would find
      // until two people used it.
      const holderIds = (lease?.holders ?? []).map((h) => h.viewerId);
      expect(
        holderIds,
        `${d.name}'s holder roster is missing a driver: ${JSON.stringify(lease?.holders)}`,
      ).toEqual(
        expect.arrayContaining([aliceViewerId, bobViewerId].filter((v): v is string => v !== null)),
      );
      expect(lease?.holderCount, `holderCount disagrees with holders[] on ${d.name}'s socket`).toBe(
        holderIds.length,
      );
      expect(lease?.holderCount).toBe(2);
      expect(lease?.holderViewerId, `${d.name} was told somebody else is the holder`).toBe(
        d.client.viewerId,
      );
      expect(
        (lease?.holders ?? []).every((h) => h.connected),
        `a live driver is reported disconnected: ${JSON.stringify(lease?.holders)}`,
      ).toBe(true);
    }
  }, 120_000);

  it('lands both viewers keystrokes in the one shared text box', async () => {
    await ensureBothHold();
    await resetPage('collab-typing');

    // Sequential, not simultaneous. Two drivers typing into one focused
    // element interleave at the CDP level, which is inherent to the
    // feature rather than a defect, so the assertion that BOTH keystrokes
    // landed is written where the order is deterministic. Concurrency is
    // asserted by the fact that both leases are live throughout, which the
    // case above pins and the check below repeats.
    await typeText(alice, 'ALPHA');
    const afterAlice = await collabUntil(alice, (s) => s.value === 'ALPHA', 20_000);
    expect(
      afterAlice.ok,
      `alice's keystrokes never reached the box: ${JSON.stringify(afterAlice.last)}`,
    ).toBe(true);

    expect(alice.client.hasControl(targetId)).toBe(true);
    expect(bob.client.hasControl(targetId)).toBe(true);

    await typeText(bob, 'BETA');
    const afterBob = await collabUntil(alice, (s) => s.value === 'ALPHABETA', 20_000);
    // Under exclusive mode bob holds no lease, `sendInput()` stamps an
    // empty `leaseId`, and `resolveInputFencing` drops every one of his
    // chars silently (input without a lease is not an error, it is
    // ignored), so the box stays at exactly `ALPHA`.
    expect(
      afterBob.ok,
      `bob's keystrokes never reached the shared box: ${JSON.stringify(afterBob.last)}`,
    ).toBe(true);
  }, 120_000);

  it('lands both viewers mouse presses on the one shared page', async () => {
    await ensureBothHold();
    await resetPage('collab-mouse');

    // Two presses at two places, one from each viewer, into the report
    // band. They are told apart by WHERE they landed, in the page's own
    // CSS pixels, so a single press that could have come from either
    // viewer cannot satisfy this.
    const y = Math.floor(alice.fh * 0.75);
    await click(alice, Math.floor(alice.fw * 0.2), y);
    await click(bob, Math.floor(bob.fw * 0.8), y);

    const seen = await collabUntil(
      alice,
      (s) => s.downs.some((p) => p.x < s.w * 0.4) && s.downs.some((p) => p.x > s.w * 0.6),
      20_000,
    );
    expect(
      seen.ok,
      `the page did not see a press from both viewers: ${JSON.stringify(seen.last?.downs)} (innerWidth ${seen.last?.w})`,
    ).toBe(true);
  }, 120_000);

  it('releases a departing driver held mouse button and held modifier, leaving the page clean', async () => {
    await ensureBothHold();
    await resetPage('collab-departure');

    pressAndHold(alice, Math.floor(alice.fw * 0.3), Math.floor(alice.fh * 0.75));
    holdModifier(alice, 'Shift', 'ShiftLeft', SHIFT);

    // Measured, not assumed. If the page never reported the press in the
    // first place, everything after it would "pass" against a fixture that
    // measured nothing.
    const held = await collabUntil(
      alice,
      (s) => s.buttons !== 0 && s.keys.includes('ShiftLeft'),
      20_000,
    );
    expect(
      held.ok,
      `alice's press and modifier were never observed by the page: ${JSON.stringify(held.last)}`,
    ).toBe(true);

    await alice.client.releaseControl(targetId);

    // `ControlLeaseEngine.settleHandingOver` runs pointer and key hygiene
    // through `releaseHeld` after draining the departing holder's dispatch
    // queue, so this is measured on the page rather than inferred from the
    // absence of an error.
    const clean = await collabUntil(
      bob,
      (s) => s.buttons === 0 && !s.keys.includes('ShiftLeft'),
      30_000,
    );
    expect(
      clean.ok,
      `alice left a stuck button or modifier behind for bob: ${JSON.stringify(clean.last)}`,
    ).toBe(true);

    // Bob is unaffected: still holding control, still able to drive.
    expect(bob.client.hasControl(targetId), 'bob lost control when alice released hers').toBe(true);
    // Focus first. Alice's held press landed on the report band, which blurs
    // the text box, so bob typing here without taking focus back inserts into
    // the body and reads as "bob cannot drive" when in fact bob is driving
    // perfectly and there is simply nothing focused.
    await focusBox(bob);
    await typeText(bob, 'OK');
    const bobStillDrives = await collabUntil(bob, (s) => s.value.includes('OK'), 20_000);
    expect(
      bobStillDrives.ok,
      `bob could not drive after alice departed: ${JSON.stringify(bobStillDrives.last)}`,
    ).toBe(true);
  }, 180_000);

  it('does not release the remaining driver held modifier when the other driver departs', async () => {
    await ensureBothHold();
    await resetPage('collab-hygiene-scope');

    // Two DIFFERENT modifier codes, one per driver. A mouse button cannot
    // serve here: the page has one pointer, not one per viewer, so two
    // drivers holding the left button are physically indistinguishable to
    // it. Two codes are not.
    holdModifier(alice, 'Shift', 'ShiftLeft', SHIFT);
    holdModifier(bob, 'Control', 'ControlLeft', CTRL);

    const both = await collabUntil(
      alice,
      (s) => s.keys.includes('ShiftLeft') && s.keys.includes('ControlLeft'),
      20_000,
    );
    expect(
      both.ok,
      `the page never saw both drivers' modifiers: ${JSON.stringify(both.last)}`,
    ).toBe(true);

    await alice.client.releaseControl(targetId);

    // The exact claim: alice's key goes, bob's key stays. `HeldState` is
    // documented as per `(target, viewer)` bookkeeping, and this is the
    // case that holds it to that. A release keyed on the target alone
    // sends a `keyup` for BOTH codes and takes bob's modifier out from
    // under him while he is still holding it.
    const scoped = await collabUntil(alice, (s) => !s.keys.includes('ShiftLeft'), 30_000);
    expect(scoped.ok, `alice's modifier was never released: ${JSON.stringify(scoped.last)}`).toBe(
      true,
    );
    expect(
      scoped.last?.keys,
      `alice's departure released bob's modifier as well: ${JSON.stringify(scoped.last)}`,
    ).toContain('ControlLeft');

    // Tidy up bob's own hold so it cannot leak into the next case.
    bob.client.sendInput({
      ...inputBase(bob),
      t: 'input.key',
      ts: Date.now(),
      kind: 'up',
      key: 'Control',
      code: 'ControlLeft',
      modifiers: 0,
    });
  }, 180_000);

  it('keeps the remaining driver drag selecting after the other driver departs', async () => {
    await ensureBothHold();
    await resetPage('collab-drag-survives');

    // Bob starts a real drag across the selectable block and is still
    // mid gesture when alice leaves.
    const base = inputBase(bob);
    const y0 = Math.floor(bob.fh * 0.32);
    const y1 = Math.floor(bob.fh * 0.45);
    bob.client.sendInput({
      ...base,
      t: 'input.mouse',
      ts: Date.now(),
      kind: 'move',
      x: 0,
      y: y0,
      buttons: 0,
      modifiers: 0,
    });
    bob.client.sendInput({
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
    await sleep(50);
    bob.client.sendInput({
      ...base,
      t: 'input.mouse',
      ts: Date.now(),
      kind: 'move',
      x: Math.floor(bob.fw * 0.3),
      y: y0,
      buttons: 1,
      modifiers: 0,
    });
    await sleep(50);

    await alice.client.releaseControl(targetId);
    await sleep(1500);

    // The rest of bob's drag. `button` is deliberately not repeated on the
    // moves: a real client does not repeat it, and `InputDispatcher`
    // derives it from its own record of what it saw pressed. If alice's
    // departure wiped that record, every one of these moves reaches Chrome
    // as a plain hover and nothing gets selected, which is exactly the
    // `drag-select-parallel.test.ts` failure re-created by a second
    // driver's exit.
    for (let step = 1; step <= 6; step++) {
      bob.client.sendInput({
        ...base,
        t: 'input.mouse',
        ts: Date.now(),
        kind: 'move',
        x: Math.round(bob.fw * (0.3 + (0.65 * step) / 6)),
        y: Math.round(y0 + ((y1 - y0) * step) / 6),
        buttons: 1,
        modifiers: 0,
      });
      await sleep(40);
    }
    bob.client.sendInput({
      ...base,
      t: 'input.mouse',
      ts: Date.now(),
      kind: 'up',
      x: Math.floor(bob.fw * 0.95),
      y: y1,
      button: 'left',
      buttons: 0,
      modifiers: 0,
      clickCount: 1,
    });

    const selected = await collabUntil(bob, (s) => s.sel, 20_000);
    expect(
      selected.ok,
      `bob's drag stopped selecting when alice departed: ${JSON.stringify(selected.last)}`,
    ).toBe(true);
  }, 180_000);

  it('never grants control to a view only viewer, and that viewer input never reaches the page', async () => {
    await resetPage('collab-view-only');

    const carolClient = await gateway.makeClient(instanceId, {
      caps: VIEW_ONLY_CAPS,
      sub: 'vwr_carol',
    });
    await carolClient.connect();
    const carolStream = await carolClient.subscribe(targetId);
    const carol: Driver = {
      name: 'carol',
      client: carolClient,
      stream: carolStream,
      targetId,
      fw: carolStream.width,
      fh: carolStream.height,
      gen: carolStream.gen,
    };

    try {
      // View only is a CHOICE, refused up front, not a consolation prize
      // for losing a race for the lease.
      await expect(carolClient.requestControl(targetId)).rejects.toMatchObject({
        code: 'bgls.error.cap.missing',
      });
      expect(carolClient.hasControl(targetId)).toBe(false);

      // Establish a known value first, so "carol changed nothing" is a
      // statement about a value that exists rather than about an empty box.
      await typeText(alice, 'BASE');
      const based = await collabUntil(alice, (s) => s.value === 'BASE', 20_000);
      expect(based.ok, `could not establish a baseline value: ${JSON.stringify(based.last)}`).toBe(
        true,
      );

      // Carol drives anyway: typing, and a click, which is what would
      // trigger `ManagedSession.promoteOnInput`. That promotion is about
      // which tab streams live, and must never turn into a lease.
      await typeText(carol, 'ZZZ');
      await click(carol, Math.floor(carol.fw / 2), Math.floor(carol.fh * 0.15));
      await sleep(2500);

      const after = await readCollab(alice);
      expect(
        after?.value,
        `a view only viewer's keystrokes reached the page: ${JSON.stringify(after)}`,
      ).toBe('BASE');
      expect(
        carolClient.hasControl(targetId),
        'a view only viewer was promoted to a holder by sending input',
      ).toBe(false);

      const lease = alice.client.leases.get(targetId);
      const holderIds = new Set<string>();
      if (lease?.holderViewerId) holderIds.add(lease.holderViewerId);
      for (const h of (
        lease as unknown as { holders?: readonly { viewerId: string }[] } | undefined
      )?.holders ?? []) {
        holderIds.add(h.viewerId);
      }
      expect(
        carolClient.viewerId !== null && holderIds.has(carolClient.viewerId),
        `a view only viewer appears as a holder: ${JSON.stringify([...holderIds])}`,
      ).toBe(false);
      // Named, not "the queue is empty". Under exclusive mode the queue is
      // not empty for reasons that have nothing to do with carol, and an
      // emptiness assertion would report her as queued when it is somebody
      // else sitting there. The claim is about her.
      expect(
        (lease?.queue ?? []).map((q) => q.viewerId),
        'a view only viewer was silently queued',
      ).not.toContain(carolClient.viewerId);
    } finally {
      carolClient.destroy();
    }
  }, 180_000);

  it('does not hand a lease to a viewer who has the control capability but never asked for one', async () => {
    await resetPage('collab-no-auto-grant');

    // The subtler half of "view only is a real choice". Carol above cannot
    // take control because her token does not carry the capability. Dave
    // can, and chose not to. Shared mode is where this stops being
    // hypothetical: once a target admits N holders there is nothing to
    // arbitrate any more, and "just grant it on the first click" becomes a
    // tempting shortcut that would silently take the choice away.
    // `ManagedSession.promoteOnInput` already runs on every input event; it
    // is about which tab streams live and must never become a grant.
    const daveClient = await gateway.makeClient(instanceId, { sub: 'vwr_dave' });
    await daveClient.connect();
    const daveStream = await daveClient.subscribe(targetId);
    const dave: Driver = {
      name: 'dave',
      client: daveClient,
      stream: daveStream,
      targetId,
      fw: daveStream.width,
      fh: daveStream.height,
      gen: daveStream.gen,
    };

    try {
      // Only ONE holder is needed here, so this case does not call
      // `ensureBothHold`. The claim is mode independent (a viewer who never
      // asked never drives, under either mode) and it is worth being able
      // to run and pass today, before shared mode is reachable, rather than
      // being blocked behind a second lease it does not need.
      if (!alice.client.hasControl(targetId)) {
        const held = await alice.client.requestControl(targetId, { timeoutMs: 10_000 });
        expect(held.granted, `alice could not take control: ${JSON.stringify(held)}`).toBe(true);
      }
      await typeText(alice, 'BASE');
      const based = await collabUntil(alice, (s) => s.value === 'BASE', 20_000);
      expect(based.ok, `could not establish a baseline value: ${JSON.stringify(based.last)}`).toBe(
        true,
      );

      await click(dave, Math.floor(dave.fw / 2), Math.floor(dave.fh * 0.15));
      await typeText(dave, 'DAVE');
      await sleep(2500);

      expect(
        daveClient.hasControl(targetId),
        'a viewer who never asked was granted a lease by sending input',
      ).toBe(false);
      const after = await readCollab(alice);
      expect(
        after?.value,
        `input from a viewer holding no lease reached the page: ${JSON.stringify(after)}`,
      ).toBe('BASE');
    } finally {
      daveClient.destroy();
    }
  }, 180_000);

  it('releases a disconnected driver held button after the disconnect grace, without touching the other driver', async () => {
    await ensureBothHold();
    await resetPage('collab-disconnect');

    // Bob holds a modifier that must SURVIVE alice's disconnect, alice
    // holds a button that must NOT.
    holdModifier(bob, 'Control', 'ControlLeft', CTRL);
    pressAndHold(alice, Math.floor(alice.fw * 0.3), Math.floor(alice.fh * 0.75));
    const held = await collabUntil(
      bob,
      (s) => s.buttons !== 0 && s.keys.includes('ControlLeft'),
      20_000,
    );
    expect(
      held.ok,
      `the page never saw the pre-disconnect state: ${JSON.stringify(held.last)}`,
    ).toBe(true);

    // A hard socket close, not a polite release: the case the grace window
    // exists for.
    //
    // This waits out the REAL `CONTROL_TIMING.disconnectGraceMs` of 30
    // seconds, on the real clock, and there is nothing here to speed up:
    // the thing under test is what a departed socket does to held pointer
    // and key state once its grace runs out. An earlier version of this
    // file asked `startRealGateway` for a 4 second grace and believed it
    // had one. It did not: `session.control.graceMs` is resolved,
    // validated and frozen into `ResolvedConfig` and then read by nothing,
    // so the engine used its own default throughout and this case was
    // passing (when it passed) for a reason its own comment denied. The
    // knob is gone and the wait is honest.
    // A HARD transport close: no close frame, no chance for the client to be
    // polite about it. `client.destroy()` cannot serve here, whatever it looks
    // like: its first act is `releaseAllLeasesOnWire()`, so it is a
    // `control.release` followed by a close, and a case built on it is a
    // second copy of the release case above wearing a disconnect name.
    // Measured before this was fixed: the departing driver was out of
    // `holders[]` 305ms after `destroy()`, which is `settleHolderExit` running
    // from `release()` and not a grace window expiring at all.
    const aliceViewerId = alice.client.viewerId;
    const aliceSocket = capturedSockets.at(-1);
    expect(aliceSocket, 'the capturing transport never recorded a socket for alice').toBeDefined();
    const disconnectedAt = Date.now();
    aliceSocket?.terminate();

    // Her TENURE survives. A shared holder whose socket drops keeps their
    // place in `holders[]` (flagged `connected: false`) for
    // `disconnectGraceMs`, so a reconnect inside the window resumes the same
    // lease rather than handing them a new one. Asserted before the page
    // state, because if the holder were dropped outright then whatever the
    // page does next is not the grace path and this case is not measuring
    // what its name says.
    await sleep(1500);
    const during = bob.client.leases.get(targetId);
    const duringIds = (during?.holders ?? []).map((h) => h.viewerId);
    expect(
      duringIds,
      `a disconnected shared holder lost their tenure immediately instead of keeping it through the grace: ${JSON.stringify(during?.holders)}`,
    ).toContain(aliceViewerId);
    expect(
      (during?.holders ?? []).find((h) => h.viewerId === aliceViewerId)?.connected,
      'a disconnected holder is still reported connected',
    ).toBe(false);

    const clean = await collabUntil(bob, (s) => s.buttons === 0, 90_000);
    // Printed so the number is on the record. The engine's own
    // `disconnectGraceMs` is 30000 and hygiene runs when it expires, so this
    // is how long the OTHER driver spends looking at a page with a mouse
    // button held down by somebody who is no longer there.
    // eslint-disable-next-line no-console
    console.log(
      `held button released ${Date.now() - disconnectedAt}ms after a hard socket close (engine disconnectGraceMs is 30000)`,
    );
    expect(
      clean.ok,
      `a disconnected driver left a button stuck down: ${JSON.stringify(clean.last)}`,
    ).toBe(true);
    expect(
      clean.last?.keys,
      `alice's disconnect released bob's modifier: ${JSON.stringify(clean.last)}`,
    ).toContain('ControlLeft');

    expect(bob.client.hasControl(targetId), 'bob lost control when alice disconnected').toBe(true);
  }, 240_000);
});

// ═══════════════════════════════════════════════════════════════════════
// Exclusive mode: this file's negative control, and the regression guard
// ═══════════════════════════════════════════════════════════════════════

describe('exclusive control still queues the second viewer and fences their input', () => {
  let gateway: RealGateway;
  let fixture: FixtureServer;
  let targetId: string;
  let alice: Driver;
  let bob: Driver;

  beforeAll(async () => {
    // No `controlMode`, so the default. Everything else is identical to
    // the shared setup above, which is the point: the only difference
    // between the two blocks is the mode, so any assertion that passes in
    // both is proving nothing about shared control.
    [gateway, fixture] = await Promise.all([
      startRealGateway({ headless: 'new' }),
      startFixtureServer(),
    ]);

    const acquired = await gateway.acquireInstance();
    const aliceClient = await gateway.makeClient(acquired.instanceId, { sub: 'vwr_alice_x' });
    const bobClient = await gateway.makeClient(acquired.instanceId, { sub: 'vwr_bob_x' });
    await aliceClient.connect();
    await bobClient.connect();

    targetId =
      aliceClient.targets[0]?.targetId ??
      (await aliceClient.tabs.new({ url: fixture.collabUrl('excl') })).targetId;
    await aliceClient.navigate(targetId, fixture.collabUrl('excl'));

    const aliceStream = await aliceClient.subscribe(targetId);
    const bobStream = await bobClient.subscribe(targetId);
    alice = {
      name: 'alice',
      client: aliceClient,
      stream: aliceStream,
      targetId,
      fw: aliceStream.width,
      fh: aliceStream.height,
      gen: aliceStream.gen,
    };
    bob = {
      name: 'bob',
      client: bobClient,
      stream: bobStream,
      targetId,
      fw: bobStream.width,
      fh: bobStream.height,
      gen: bobStream.gen,
    };
  }, 240_000);

  afterAll(async () => {
    await gateway?.close(
      [alice?.client, bob?.client].filter((c): c is BrowserGlassClient => Boolean(c)),
    );
    await fixture?.close();
  }, 120_000);

  it('queues the second viewer instead of granting, and leaves exactly one holder', async () => {
    const ready = await collabUntil(alice, (s) => s.w > 0, 60_000);
    expect(ready.ok, `collab page never published a report: ${JSON.stringify(ready.last)}`).toBe(
      true,
    );

    const first = await alice.client.requestControl(targetId);
    expect(first.granted).toBe(true);

    const second = await bob.client
      .requestControl(targetId, { timeoutMs: 8000 })
      .catch((err: unknown) => ({
        granted: false as const,
        queued: false as const,
        reason: 'timeout',
        message: String(err),
      }));
    expect(
      second.granted,
      `exclusive mode granted a second concurrent holder: ${JSON.stringify(second)}`,
    ).toBe(false);
    expect(bob.client.hasControl(targetId)).toBe(false);

    await sleep(500);
    const lease = alice.client.leases.get(targetId);
    expect(lease?.mode).toBe('exclusive');
    expect(
      lease?.queueLength,
      `nobody was queued in exclusive mode: ${JSON.stringify(lease)}`,
    ).toBeGreaterThan(0);
  }, 120_000);

  it('drops the queued viewer input rather than applying it to the page', async () => {
    // The half of exclusive mode nothing in this package covers.
    // `reply-correlation.test.ts` already proves the queue advances and
    // that the eventual `control.granted` carries the original request's
    // `re`; what it does not touch is what happens to a queued viewer's
    // INPUT in the meantime, which is the exact behaviour shared mode is
    // being built to change.
    await alice.client.navigate(targetId, fixture.collabUrl('excl-fence'));
    const ready = await collabUntil(alice, (s) => s.w > 0, 30_000);
    expect(ready.ok).toBe(true);
    await click(alice, Math.floor(alice.fw / 2), Math.floor(alice.fh * 0.15));

    await typeText(alice, 'HOLDER');
    const holderTyped = await collabUntil(alice, (s) => s.value === 'HOLDER', 20_000);
    expect(holderTyped.ok, `the holder could not type: ${JSON.stringify(holderTyped.last)}`).toBe(
      true,
    );

    await typeText(bob, 'QUEUED');
    await sleep(2500);
    const after = await readCollab(alice);
    expect(
      after?.value,
      `a queued viewer's keystrokes reached the page under exclusive mode: ${JSON.stringify(after)}`,
    ).toBe('HOLDER');
  }, 120_000);
});
