/**
 * An AI agent and a person driving the SAME browser tab.
 *
 * What this file exists to close
 * ------------------------------
 * `shared-control.test.ts` (12 cases) and `shared-control-composition.test.ts`
 * (5 cases) proved shared control against a real browser, and every one of
 * those cases used two `BrowserGlassClient`s. Nothing had ever put an
 * `AutomationClient` and a human viewer on one target. The lease engine does
 * not branch on holder kind when admitting a shared holder, so it should
 * behave identically; this file is what turns "should" into a measurement.
 *
 * A detail worth stating plainly, because it changes what those earlier cases
 * proved: holder KIND is derived server side from the TOKEN, not from which
 * client class connected. `packages/server/src/ws/connection.ts` sets
 * `kind: this.granted.has('automation') ? 'agent' : 'human'`, and
 * `RealGateway.makeClient()` mints every capability by default, `automation`
 * included. So alice and bob in the earlier shared control files were both
 * registered as `kind: 'agent'` and both carried `DEFAULT_PRIORITY.agent`
 * (50). Two agents, never a human. Every viewer below therefore gets an
 * EXPLICIT capability set, and the human's deliberately omits `automation`,
 * because a "human" whose token carries it is an agent as far as the priority
 * model is concerned and can never outrank an agent holder.
 *
 * The three groups
 * ----------------
 * A. Coexistence, `mode: 'shared'`. An agent and a person hold one target at
 *    once, both drive, nobody queues, and one of them leaving damages neither
 *    the other's page nor their own tenure.
 * B. Human takeover, `mode: 'exclusive'`. A person takes a target off an
 *    agent promptly, the agent is told it was a HUMAN takeover rather than
 *    merely being outranked, the agent then actually stops driving, and a
 *    HUMAN holder stays protected from exactly the same treatment.
 * C. Shared yield, `mode: 'shared'`. A person asks the agent holders of a
 *    shared target to stand down and every human holder keeps driving.
 *
 * How the page is measured
 * ------------------------
 * Through `fixture.collabUrl()`, the same page the shared control files use:
 * it publishes what it currently HAS HELD every 80ms rather than what last
 * happened to it, which is the only way to measure an absence (a departed
 * driver leaves no event behind, only a stuck button). The human reads it
 * back through `client.probe`, the agent through `AutomationClient.inspectAt`,
 * both of which are the ordinary public hit test. Nothing here uses a channel
 * into Chrome that a real client would not have.
 *
 * Reading the wire directly
 * -------------------------
 * Several assertions here are about a specific server to client MESSAGE
 * (`control.preempt.request`'s `reason`, `control.yield.request`'s `leaseId`,
 * `control.revoked`'s `reason`) rather than about a client side effect of it.
 * Those are read from a raw tap on each connection's `Transport`, reached
 * through a documented cast past a `private` field. That is deliberate: the
 * client surfaces for these messages are being written in the same session as
 * this file, and a test that asserted through them would be asserting whether
 * this week's convenience method exists rather than whether the wire contract
 * holds. The tap is read only and changes nothing about the connection.
 *
 * Stale `dist`
 * ------------
 * This package imports `@browserglass/core`, `@browserglass/server`,
 * `@browserglass/automation` and the rest through their package exports,
 * which resolve to `dist`, while their sourcemaps point at `src`. A stack
 * trace therefore reads as if `src` were running when it is not. Run
 * `pnpm -r --workspace-concurrency=1 run build` before any run of this file
 * whose result is going to be believed.
 */
import { AutomationClient } from '@browserglass/automation';
import type { BrowserGlassClient } from '@browserglass/client';
import type { Capability, Envelope, InstanceId } from '@browserglass/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

/** CDP's modifier bitmask, from `packages/core/src/input/key-events.ts`: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
const CTRL = 2;
const SHIFT = 8;

/**
 * The mode Group A and Group C start their gateway in. `'shared'` always,
 * except when this file is run AS its own negative control.
 *
 * Set `BGLS_SHARED_CONTROL_MODE=exclusive` and every coexistence case runs,
 * unchanged, against a gateway that admits one holder per target. They must
 * all fail: an agent and a person cannot both hold an exclusive target, so a
 * case that passes under both values is proving nothing about coexistence.
 * The same switch exists in `shared-control.test.ts` and means the same thing.
 *
 * ONE case in this block is exempt and says so in its own name: the fixture
 * health check, which asserts the collab page publishes a report at all. It is
 * mode independent on purpose, because its whole job is to make a later zero
 * reading a product failure rather than a broken fixture, and a fixture check
 * that only worked in one mode could not do that job. Measured under the
 * switch: 7 of the 8 cases here fail, and that one passes.
 *
 * Group B is NOT switched by it, and that is not an oversight. Takeover is an
 * exclusive mode concept (`beginPreempt`'s own comment: "a shared target never
 * reaches it"), so running Group B shared would not be a negative control, it
 * would be a different feature. Group B's negative control is the tree
 * itself: run this file against a build without the agent preemption change in
 * the lease engine and B4 and B5 fail, which is the point of them.
 */
const SHARED_MODE: 'shared' | 'exclusive' =
  process.env['BGLS_SHARED_CONTROL_MODE'] === 'exclusive' ? 'exclusive' : 'shared';

/**
 * A person's token: every capability a viewer UI actually uses, and
 * deliberately NOT `automation`.
 *
 * Load bearing rather than tidy. See the file header: kind comes from the
 * token, and priority comes from kind (human 100, agent 50). A "human"
 * holding an `automation` token ranks 50 and every takeover case in Group B
 * would then fail for a reason that has nothing to do with takeover.
 */
const HUMAN_CAPS: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'devtools',
];

/** A person with `admin`, used only by the case that checks `minHoldMs` still protects a HUMAN holder from a force claim. */
const ADMIN_CAPS: readonly Capability[] = [...HUMAN_CAPS, 'admin'];

/**
 * An agent's token. `automation` is what makes the server register this
 * connection as `kind: 'agent'`, which is the whole subject of this file.
 * `probe` is here because `AutomationClient.inspectAt` is how the agent reads
 * the collab page's report band back.
 */
const AGENT_CAPS: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'automation',
];

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────────
// A raw tap on one connection's wire
// ─────────────────────────────────────────────────────────────────────────

/** The `Transport` members this file uses. Structural, so it matches both `@browserglass/client`'s `Transport` and the one `AutomationCore` holds, without importing either type. */
interface TransportLike {
  on(event: 'message', fn: (msg: Envelope) => void): () => void;
  send(msg: unknown): void;
}

/** Every envelope a connection has received since the tap was opened. Read only: `Transport.on('message')` is the same subscription the client itself uses, so tapping it observes exactly the traffic the client saw and perturbs nothing. */
interface WireTap {
  /** Every envelope of type `t` seen so far, oldest first. */
  of(t: string): readonly Envelope[];
  /** The first envelope of type `t` to arrive, waiting up to `timeoutMs`, or `null`. */
  waitFor(t: string, timeoutMs: number): Promise<Envelope | null>;
  /** Forgets everything seen so far, so one case's traffic cannot be read by the next. */
  clear(): void;
}

function tapWire(transport: TransportLike): WireTap {
  let seen: Envelope[] = [];
  transport.on('message', (msg) => {
    seen.push(msg);
  });
  return {
    of: (t) => seen.filter((m) => m.t === t),
    async waitFor(t, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = seen.find((m) => m.t === t);
        if (hit) return hit;
        if (Date.now() >= deadline) return null;
        await sleep(25);
      }
    },
    clear() {
      seen = [];
    },
  };
}

/**
 * A `BrowserGlassClient`'s own `Transport`.
 *
 * `transport` is `private` on the class. TypeScript's `private` is a compile
 * time annotation with no runtime effect, so this cast reaches the real
 * object. It is used for exactly two things: opening a read only message tap,
 * and sending a `control.yield` envelope in Group C, whose client side
 * convenience method is being written in the same session as this file and
 * which this suite must not be blocked behind.
 */
function transportOf(client: BrowserGlassClient): TransportLike {
  return (client as unknown as { transport: TransportLike }).transport;
}

/** An `AutomationClient`'s own `Transport`, reached the same way and for the same reasons. `AutomationCore.transport` is itself public; only `AutomationClient.core` is private. */
function agentCoreOf(agent: AutomationClient): {
  transport: TransportLike;
  viewport: { width: number; height: number };
  leases: Map<string, { leaseId: string }>;
} {
  return (
    agent as unknown as {
      core: {
        transport: TransportLike;
        viewport: { width: number; height: number };
        leases: Map<string, { leaseId: string }>;
      };
    }
  ).core;
}

/** A `ws` subclass that records every socket it opens into `bucket`, so a case can kill one outright. It changes nothing else about the connection. */
function capturingWs(bucket: WebSocket[]): typeof WebSocket {
  return class Capturing extends WebSocket {
    constructor(...args: ConstructorParameters<typeof WebSocket>) {
      super(...args);
      bucket.push(this);
    }
  } as typeof WebSocket;
}

// ─────────────────────────────────────────────────────────────────────────
// The collab page's live report
// ─────────────────────────────────────────────────────────────────────────

/** The collab page's live report, parsed. See `fixture-server.ts`'s `collabPage` for the grammar. */
interface CollabState {
  readonly w: number;
  readonly buttons: number;
  readonly keys: readonly string[];
  readonly value: string;
  readonly downs: readonly { readonly x: number; readonly y: number }[];
  readonly sel: boolean;
}

function parseCollab(label: string | null): CollabState | null {
  if (label === null || !label.startsWith('C:')) return null;
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

// ─────────────────────────────────────────────────────────────────────────
// One party on one target, whichever kind of client they are
// ─────────────────────────────────────────────────────────────────────────

/**
 * A person or an agent, presented identically so a case can say "both drove"
 * without caring which client class is underneath.
 *
 * `fw`/`fh` differ by client kind and that is correct rather than incidental.
 * A person's are their own stream's frame dimensions; an `AutomationClient`
 * stamps the instance's real viewport, which makes the server's
 * `frame space -> CSS px` transform an identity so its coordinates ARE
 * viewport CSS pixels (the coordinate space rule). Both are honest
 * coordinates for their own client; neither is a test-only shortcut.
 */
interface Party {
  readonly name: string;
  readonly kind: 'human' | 'agent';
  readonly viewerId: string;
  readonly targetId: string;
  readonly fw: number;
  readonly fh: number;
  readonly tap: WireTap;
  /**
   * Hit tests `(x, y)` and returns the report band's label, or `null`.
   *
   * Only a HUMAN party can serve as a reader, and that is a product fact
   * rather than a shortcut. `connection.ts`'s `target.probe` handler passes
   * `x`/`y` to `ManagedSession.probe` untransformed, straight into
   * `document.elementFromPoint`, so probe coordinates are real viewport CSS
   * pixels and the message's `fw`/`fh` are ignored. A subscribed viewer's
   * `fw`/`fh` ARE the viewport's dimensions, so its coordinates land.
   * `AutomationClient.inspectAt` stamps `welcome.instance.viewport`, which
   * `connection.ts` hardcodes to 1440x900 whatever the real BrowserSpec says,
   * so an agent's hit test lands outside the page and comes back
   * `{hit: false}` every time. Measured, not assumed: 60 seconds of an agent
   * polling this band returned `{"hit":false,"gen":0}` on every attempt.
   * Reported rather than worked around; the cases below read the page through
   * a person.
   */
  probeLabel(x: number, y: number): Promise<string | null>;
  /** Whether this party currently holds a lease on the target, per its own client's bookkeeping. */
  holds(): boolean;
  /** The lease id this party's own client believes it holds, or `''`. */
  leaseId(): string;
  /** Sends one `input.*` envelope on this party's own connection, stamped with its CURRENT lease id and its latest known `gen`. */
  send(msg: Record<string, unknown>): void;
  /** Sends one `input.*` envelope stamped with an EXPLICIT lease id, bypassing the client's own bookkeeping. The only way to express "a half yielded agent keeps sending with the id it used to hold". */
  sendWithLease(leaseId: string, msg: Record<string, unknown>): void;
}

/**
 * The target generation an input envelope must carry, and why it is not read
 * back from anywhere.
 *
 * `resolveGenFencing` error-drops a `mouse.down` and silently drops a
 * `mouse.move` whose `gen` does not match the target's current one, so a
 * wrong value here does not fail loudly: it makes a click vanish, the text
 * box never take focus, and every later `typeText` in the case insert into
 * the body instead. That failure reads as "this party cannot drive" when in
 * fact its input arrived and was correctly refused, so it is worth writing
 * down where the right value comes from.
 *
 * `Stream.gen` starts at 1 and `Stream.bumpGeneration` is called by nothing
 * in this build, so a target with any live subscriber is on generation 1 for
 * the life of the session, navigations included. The server's own answer,
 * `ManagedSession.getGeneration`, is `streamHandleFor(targetId)?.stream.gen
 * ?? 0`, and `streamHandleFor` is per TARGET rather than per viewer, so one
 * subscriber makes it 1 for everybody addressing that target, subscriber or
 * not.
 *
 * An earlier version of this file refreshed the value from each
 * `target.probe` reply, which looked like the careful thing to do and was
 * exactly wrong: `connection.ts`'s `target.probe` handler hardcodes `gen: 0`
 * in the reply it builds. Every party then stamped 0, every mouse press was
 * gen-stale, and three cases failed on a text box that never took focus.
 * That hardcoded zero is also what `AutomationCore.ensureGen()` caches, which
 * means an `AutomationClient`'s own `clickAt()` is gen-stale against a real
 * gateway. Reported rather than worked around here: it is not this package's
 * to fix, and this file's agent stamps the same 1 its human counterpart does.
 */
const TARGET_GEN = 1;

/** Reads the collab page's report band through `reader`'s own public hit test, at 75% of the frame height (inside `#state`, clear of the `#pulse` strip). */
async function readCollab(reader: Party): Promise<CollabState | null> {
  const label = await reader.probeLabel(Math.floor(reader.fw / 2), Math.floor(reader.fh * 0.75));
  return parseCollab(label);
}

/**
 * Polls `readCollab` until `pred` holds, returning the last reading either
 * way, so a failure message can say what the page actually said.
 *
 * `gapMs` defaults to 600 for the same reason `shared-control.test.ts` uses
 * it: `probeFullRate` is 2/sec with a burst of 4 per target, and polling
 * faster exhausts the budget so every read comes back rate limited, which is
 * indistinguishable from a page that never responded. The disconnect hygiene
 * cases pass a shorter gap on purpose, because they are measuring a 1500ms
 * deadline against a 30000ms one and 600ms resolution would blur the point; a
 * rate limited read there simply returns null and the loop continues.
 */
async function collabUntil(
  reader: Party,
  pred: (s: CollabState) => boolean,
  timeoutMs: number,
  gapMs = 600,
): Promise<{ readonly ok: boolean; readonly last: CollabState | null }> {
  const deadline = Date.now() + timeoutMs;
  let last: CollabState | null = null;
  for (;;) {
    const state = await readCollab(reader);
    if (state) last = state;
    if (state && pred(state)) return { ok: true, last: state };
    if (Date.now() >= deadline) return { ok: false, last };
    await sleep(gapMs);
  }
}

/** Polls a purely local predicate (never the wire, never the page) until it holds, returning how long it took, or `null`. */
async function waitUntil(
  pred: () => boolean,
  timeoutMs: number,
  gapMs = 20,
): Promise<number | null> {
  const startedAt = Date.now();
  for (;;) {
    if (pred()) return Date.now() - startedAt;
    if (Date.now() - startedAt >= timeoutMs) return null;
    await sleep(gapMs);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Building the two kinds of party
// ─────────────────────────────────────────────────────────────────────────

/** A human party: an ordinary `BrowserGlassClient` on a token WITHOUT `automation`, subscribed to the target. */
async function makeHuman(
  gateway: RealGateway,
  instanceId: InstanceId,
  targetId: string,
  sub: string,
  opts?: { readonly caps?: readonly Capability[]; readonly socketBucket?: WebSocket[] },
): Promise<{
  readonly party: Party;
  readonly client: BrowserGlassClient;
  /** The page's real pixel size, which a subscribed viewer's stream reports and an `AutomationClient` cannot learn. See {@link makeAgent}. */
  readonly space: { readonly width: number; readonly height: number };
}> {
  const client = await gateway.makeClient(instanceId, {
    sub,
    caps: opts?.caps ?? HUMAN_CAPS,
    transport: {
      allowInsecureTransport: true,
      WebSocketImpl: (opts?.socketBucket ? capturingWs(opts.socketBucket) : WebSocket) as never,
    },
  });
  const transport = transportOf(client);
  const tap = tapWire(transport);
  await client.connect();
  const stream = await client.subscribe(targetId);
  const party: Party = {
    name: sub,
    kind: 'human',
    viewerId: client.viewerId ?? '',
    targetId,
    fw: stream.width,
    fh: stream.height,
    tap,
    async probeLabel(x, y) {
      const result = await client.probe(targetId, x, y).catch(() => null);
      if (!result || !result.hit) return null;
      return result.label ?? null;
    },
    holds: () => client.hasControl(targetId),
    // `myLeases` is private on the class for the same reason `transport` is;
    // see `transportOf`. Only read here, never written.
    leaseId: () =>
      (client as unknown as { myLeases: Map<string, { leaseId: string }> }).myLeases.get(targetId)
        ?.leaseId ?? '',
    send(msg) {
      // `sendInput` stamps the lease id from the client's OWN bookkeeping,
      // which is what a real viewer does and what makes "this party is no
      // longer a holder" show up as unfenced input rather than as a test
      // helpfully remembering a dead id.
      client.sendInput({
        v: 1,
        ts: Date.now(),
        targetId,
        fw: stream.width,
        fh: stream.height,
        gen: TARGET_GEN,
        leaseId: '',
        ...msg,
      } as never);
    },
    sendWithLease(leaseId, msg) {
      transport.send({
        v: 1,
        ts: Date.now(),
        targetId,
        fw: stream.width,
        fh: stream.height,
        gen: TARGET_GEN,
        leaseId,
        ...msg,
      });
    },
  };
  return { party, client, space: { width: stream.width, height: stream.height } };
}

/**
 * An agent party: a real `AutomationClient` on a token WITH `automation`,
 * which is what makes the server register it as `kind: 'agent'`.
 *
 * `space` is the page's real pixel size, taken from a subscribed person's
 * stream, and it is what this agent's input envelopes are stamped with instead
 * of `welcome.instance.viewport`.
 *
 * The reason is a measured product gap, not a preference.
 * `InputDispatcher.viewportFor` returns `this.targets.get(targetId)?.viewport
 * ?? {width: msg.fw, height: msg.fh}`, and no target in this build registers a
 * viewport, so `transformPoint` runs with `viewportDim === fw` and the
 * transform is the IDENTITY. Every client's `x`/`y` therefore reach
 * `Input.dispatchMouseEvent` as raw page CSS pixels whatever `fw`/`fh` say. A
 * subscribed viewer is unharmed by that, because its `fw` is its stream's
 * width and its stream's width IS the page's. An `AutomationClient` stamps
 * `welcome.instance.viewport`, which `connection.ts` hardcodes to 1440x900
 * regardless of the real BrowserSpec, so its coordinates are addressed to a
 * page 1440 wide that does not exist.
 *
 * Measured: against a real page 762x427, the agent's own "middle of the text
 * box" at (720, 135) landed on the marker block below it, blurred the box, and
 * every later keystroke went into the body instead. The page recorded the
 * press at exactly (720, 135), which is what proves the transform never ran
 * rather than ran wrongly.
 *
 * Reported rather than fixed here (it belongs to `packages/server` and
 * `packages/core`, not to this package), and worked around by telling the
 * agent the truth about the page it is driving.
 */
async function makeAgent(
  gateway: RealGateway,
  instanceId: InstanceId,
  targetId: string,
  sub: string,
  space: { readonly width: number; readonly height: number },
  opts?: { readonly socketBucket?: WebSocket[] },
): Promise<{ readonly party: Party; readonly agent: AutomationClient }> {
  const token = await gateway.mintToken(instanceId, { caps: AGENT_CAPS, sub });
  const agent = await AutomationClient.connect({
    endpoint: gateway.wsUrl,
    token,
    targetId,
    transport: {
      WebSocketImpl: (opts?.socketBucket ? capturingWs(opts.socketBucket) : WebSocket) as never,
    },
  });
  const core = agentCoreOf(agent);
  // `Transport.autoReconnect` defaults to true and `AutomationClientOptions`
  // has no field for it, while `RealGateway.makeClient()` turns it off for
  // every human in this package. Turning it off here too is not a
  // convenience: the disconnect cases below terminate a socket and then
  // measure what the server does about the held state left behind, and a
  // client that silently reconnects 200ms later cancels the very sweep those
  // cases exist to time. A laptop lid closing does not reconnect either.
  // `private readonly` is a compile time annotation with no runtime effect.
  (core.transport as unknown as { autoReconnect: boolean }).autoReconnect = false;

  const party: Party = {
    name: sub,
    kind: 'agent',
    viewerId: agent.viewerId ?? '',
    targetId,
    fw: space.width,
    fh: space.height,
    tap: tapWire(core.transport),
    async probeLabel() {
      // See `Party.probeLabel`. An agent's hit test lands outside the page
      // because `inspectAt` stamps a viewport `connection.ts` hardcodes to
      // 1440x900, and the probe handler treats the coordinates as real CSS
      // pixels. Rather than let a case read `null` forever and report it as a
      // page that never published, this says so.
      throw new Error(
        'an AutomationClient cannot read the page through target.probe in this build (inspectAt stamps the hardcoded welcome viewport and the probe handler applies no transform); read through a human party instead',
      );
    },
    holds: () => core.leases.has(targetId),
    leaseId: () => core.leases.get(targetId)?.leaseId ?? '',
    send(msg) {
      party.sendWithLease(party.leaseId(), msg);
    },
    sendWithLease(leaseId, msg) {
      core.transport.send({
        v: 1,
        ts: Date.now(),
        targetId,
        fw: space.width,
        fh: space.height,
        gen: TARGET_GEN,
        leaseId,
        ...msg,
      });
    },
  };
  return { party, agent };
}

// ─────────────────────────────────────────────────────────────────────────
// Input, sent identically by either kind of party
// ─────────────────────────────────────────────────────────────────────────

/** A real move, press and release at `(x, y)` in `party`'s own coordinate space. */
async function click(party: Party, x: number, y: number): Promise<void> {
  party.send({ t: 'input.mouse', kind: 'move', x, y, buttons: 0, modifiers: 0 });
  party.send({
    t: 'input.mouse',
    kind: 'down',
    x,
    y,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
  await sleep(30);
  party.send({
    t: 'input.mouse',
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

/** Clicks `party` into the shared text box (the top 30% band of the collab page). Anything that presses elsewhere blurs it, so a party about to type takes focus back explicitly rather than assuming whoever clicked last left it there. */
async function focusBox(party: Party): Promise<void> {
  await click(party, Math.floor(party.fw / 2), Math.floor(party.fh * 0.15));
}

/**
 * Types `text` into whatever has focus, as one `input.text`.
 *
 * `input.text` rather than a stream of `input.key` char events, matching what
 * every other e2e file here does: a bare `input.key` with `kind: 'char'` is
 * dropped by `buildKeyEvent` for an ordinary printable key, and `input.text`
 * is a real client's own path for a paste or an IME commit. It is fenced by
 * `leaseId` exactly like every other input kind (`fenceKindOf` gives it
 * `'other'`, which is not in `ALWAYS_DISPATCHED_KINDS`), which is the property
 * every "did this party's input land" assertion below depends on. It is also
 * `gen` independent, so a typing assertion cannot fail for a reason that is
 * really about a stale generation.
 */
async function typeText(party: Party, text: string): Promise<void> {
  party.send({ t: 'input.text', text });
  await sleep(120);
}

/** Types `text` stamped with an explicit, possibly dead, lease id. */
async function typeTextWithLease(party: Party, leaseId: string, text: string): Promise<void> {
  party.sendWithLease(leaseId, { t: 'input.text', text });
  await sleep(120);
}

/** A press with no matching release: what a driver leaves behind when they walk away mid gesture. */
function pressAndHold(party: Party, x: number, y: number): void {
  party.send({ t: 'input.mouse', kind: 'move', x, y, buttons: 0, modifiers: 0 });
  party.send({
    t: 'input.mouse',
    kind: 'down',
    x,
    y,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount: 1,
  });
}

/** A modifier keydown with no matching keyup. `code` is what the page reports, so two drivers holding two different modifiers stay distinguishable. */
function holdModifier(party: Party, key: string, code: string, mask: number): void {
  party.send({ t: 'input.key', kind: 'down', key, code, modifiers: mask });
}

/** Releases a held modifier, so one case's hold cannot leak into the next. */
function releaseModifier(party: Party, key: string, code: string): void {
  party.send({ t: 'input.key', kind: 'up', key, code, modifiers: 0 });
}

// ─────────────────────────────────────────────────────────────────────────
// Reading the lease off the wire
// ─────────────────────────────────────────────────────────────────────────

/** The `holders[]` roster as this tap last saw it, straight off the most recent `control.state` that named this target. */
function rosterOf(
  tap: WireTap,
  targetId: string,
): readonly { viewerId: string; connected: boolean }[] {
  const states = tap.of('control.state');
  for (let i = states.length - 1; i >= 0; i--) {
    const leases = states[i]?.['leases'] as
      | readonly {
          targetId: string;
          holders?: readonly { viewerId: string; connected: boolean }[];
        }[]
      | undefined;
    const mine = leases?.find((l) => l.targetId === targetId);
    if (mine) return mine.holders ?? [];
  }
  return [];
}

/** The queue as this tap last saw it, from the same source as {@link rosterOf}. */
function queueOf(tap: WireTap, targetId: string): readonly { viewerId: string }[] {
  const states = tap.of('control.state');
  for (let i = states.length - 1; i >= 0; i--) {
    const leases = states[i]?.['leases'] as
      | readonly { targetId: string; queue?: readonly { viewerId: string }[] }[]
      | undefined;
    const mine = leases?.find((l) => l.targetId === targetId);
    if (mine) return mine.queue ?? [];
  }
  return [];
}

// ═══════════════════════════════════════════════════════════════════════
// Group A: an agent and a person on one shared tab
// ═══════════════════════════════════════════════════════════════════════

describe('an agent and a person drive one shared tab together', () => {
  let gateway: RealGateway;
  let fixture: FixtureServer;
  let instanceId: InstanceId;
  let targetId: string;

  let human: Party;
  let humanClient: BrowserGlassClient;
  const humanSockets: WebSocket[] = [];

  let robot: Party;
  let agent: AutomationClient;
  const agentSockets: WebSocket[] = [];

  /**
   * A person who watches and never drives, and the reader for every page
   * assertion in this block.
   *
   * Needed for two independent reasons. First, an `AutomationClient` cannot
   * read this page at all (see `Party.probeLabel`), so the direction of A3 in
   * which the DRIVING person's socket is killed has nobody left to measure
   * with. Second, `probeFullRate` is 2/sec with a burst of 4 per target, and
   * one prober rather than two keeps every case inside a limit it is not
   * trying to test. It never requests control, so it is also a standing check
   * that watching a shared target does not make you a driver.
   */
  let observer: Party;
  let observerClient: BrowserGlassClient;
  /** The page's real pixel size, learned from the first subscribed viewer and handed to every agent built here. See {@link makeAgent}. */
  let pageSpace: { readonly width: number; readonly height: number };

  /**
   * Puts both parties back in the state every case below needs: two live,
   * concurrent leases on the one target.
   *
   * Called at the top of each case rather than once by the first, for the
   * same reason `shared-control.test.ts` does it: under the negative control
   * every case then fails on its own substance, naming which party was
   * refused and what the server said, instead of every case after the first
   * reporting "skipped, the two never both held control".
   *
   * `waitMs: 0` / `queue: false` on purpose. Under the negative control the
   * second request comes back refused at once rather than sitting in a queue,
   * so that run neither hangs nor leaves a queue entry for a later case.
   */
  async function ensureBothHold(): Promise<void> {
    if (!robot.holds()) {
      await agent.acquireControl({ waitMs: 0 }).catch((err: unknown) => {
        throw new Error(
          `the agent was not granted a concurrent lease on the shared target: ${String(err)}`,
        );
      });
    }
    if (!human.holds()) {
      const outcome = await humanClient.requestControl(targetId, {
        queue: false,
        timeoutMs: 10_000,
      });
      expect(
        outcome.granted,
        `the person was not granted a concurrent lease on the shared target: ${JSON.stringify(outcome)}`,
      ).toBe(true);
    }
    expect(
      robot.holds() && human.holds(),
      'both parties were granted but not both are holding',
    ).toBe(true);
  }

  /** Reloads the collab page and puts the caret back in the shared text box, so each case starts from a page holding nothing and from a fresh `gen`. */
  async function resetPage(label: string): Promise<void> {
    await ensureBothHold();
    await humanClient.navigate(targetId, fixture.collabUrl(label));
    const ready = await collabUntil(observer, (s) => s.w > 0, 30_000);
    expect(
      ready.ok,
      `collab page never published a report after navigate: ${JSON.stringify(ready.last)}`,
    ).toBe(true);
    await focusBox(human);
  }

  beforeAll(async () => {
    [gateway, fixture] = await Promise.all([
      startRealGateway({ headless: 'new', controlMode: SHARED_MODE }),
      startFixtureServer(),
    ]);

    const acquired = await gateway.acquireInstance();
    instanceId = acquired.instanceId;

    // A throwaway connection, only to learn the real target id and put the
    // page up. `AutomationClient.connect()` binds to a target at connect time
    // and `subscribe()` needs one too, so both real parties need the id first.
    const seed = await gateway.makeClient(instanceId, { sub: 'vwr_seed', caps: HUMAN_CAPS });
    await seed.connect();
    targetId =
      seed.targets[0]?.targetId ??
      (await seed.tabs.new({ url: fixture.collabUrl('agent-human') })).targetId;
    await seed.navigate(targetId, fixture.collabUrl('agent-human'));
    seed.destroy();

    const madeHuman = await makeHuman(gateway, instanceId, targetId, 'vwr_pat', {
      socketBucket: humanSockets,
    });
    human = madeHuman.party;
    humanClient = madeHuman.client;
    pageSpace = madeHuman.space;

    const madeAgent = await makeAgent(gateway, instanceId, targetId, 'agt_robo', pageSpace, {
      socketBucket: agentSockets,
    });
    robot = madeAgent.party;
    agent = madeAgent.agent;

    const madeObserver = await makeHuman(gateway, instanceId, targetId, 'vwr_obs');
    observer = madeObserver.party;
    observerClient = madeObserver.client;
  }, 240_000);

  afterAll(async () => {
    try {
      agent?.close();
    } catch {
      // teardown is best effort
    }
    await gateway?.close(
      [humanClient, observerClient].filter((c): c is BrowserGlassClient => Boolean(c)),
    );
    await fixture?.close();
  }, 120_000);

  it('publishes a live report from the collab page, so a later zero reading is a product failure and not a broken fixture', async () => {
    // Ordered first on purpose. Every assertion after this one reads the page
    // through this band, and a band that never published would make all of
    // them fail for the wrong reason.
    for (const reader of [human, observer]) {
      const seen = await collabUntil(reader, (s) => s.w > 0, 60_000);
      expect(
        seen.ok,
        `${reader.name} could not read the collab report: ${JSON.stringify(seen.last)}`,
      ).toBe(true);
      expect(seen.last?.buttons).toBe(0);
      expect(seen.last?.keys).toEqual([]);
    }
  }, 120_000);

  it('registers the automation client as kind agent and the viewer as kind human, which is what the whole priority model rests on', async () => {
    // Property A2, and not a formality. Holder kind is derived from the TOKEN
    // (`connection.ts`: `granted.has('automation') ? 'agent' : 'human'`), not
    // from which client class connected, so a file that built its "human" out
    // of the default all-capabilities token would be testing two agents and
    // would say so nowhere. This pins that the two parties really are one of
    // each, and that a person looking at the session can tell which of the two
    // drivers is a robot.
    await sleep(1000);
    const roster = humanClient.presence;
    const humanEntry = roster.find((v) => v.viewerId === human.viewerId);
    const agentEntry = roster.find((v) => v.viewerId === robot.viewerId);
    expect(
      humanEntry,
      `the person is missing from presence: ${JSON.stringify(roster)}`,
    ).toBeDefined();
    expect(
      agentEntry,
      `the agent is missing from presence: ${JSON.stringify(roster)}`,
    ).toBeDefined();
    expect(humanEntry?.kind, 'the person was registered as something other than a human').toBe(
      'human',
    );
    expect(
      agentEntry?.kind,
      'the automation client was registered as something other than an agent',
    ).toBe('agent');

    // Stated rather than asserted, because it is a gap and not a bug:
    // `LeaseHolderState` (`packages/protocol/src/wire/messages/control.ts`)
    // carries `viewerId`, `label`, `grantedAt`, `expiresAt` and `connected`,
    // and NO kind. So "which of the two drivers is a robot" is answerable off
    // `control.state` alone only by joining `holders[]` to `presence.viewers`
    // on `viewerId`, which is what the assertion below does and what a UI
    // would have to do. If the roster ever grows a `kind` this log line is
    // where that shows up first.
    await ensureBothHold();
    await sleep(500);
    const holders = rosterOf(human.tap, targetId);
    const withKind = holders.map((h) => ({
      viewerId: h.viewerId,
      kindOnRoster: (h as unknown as { kind?: string }).kind ?? '(absent from LeaseHolderState)',
      kindViaPresence: roster.find((v) => v.viewerId === h.viewerId)?.kind ?? '(not in presence)',
    }));
    // eslint-disable-next-line no-console
    console.log(`[A2] holder roster joined to presence: ${JSON.stringify(withKind)}`);
    expect(
      withKind.find((h) => h.viewerId === robot.viewerId)?.kindViaPresence,
      'the agent driving this target cannot be identified as an agent from the roster plus presence',
    ).toBe('agent');
    expect(
      withKind.find((h) => h.viewerId === human.viewerId)?.kindViaPresence,
      'the person driving this target is not identifiable as a person',
    ).toBe('human');
  }, 120_000);

  it('grants an agent and a person concurrent leases on one target, with nothing queued', async () => {
    // Property A1. Both hold at the same moment, the two lease ids are
    // distinct, and the queue is empty on BOTH sockets, because a broadcast
    // that agreed with itself on only one of them would be a bug nobody would
    // find until two people used it.
    if (!robot.holds()) await agent.acquireControl({ waitMs: 0 });
    const agentLeaseId = robot.leaseId();
    expect(robot.holds()).toBe(true);

    if (human.holds()) await humanClient.releaseControl(targetId);
    await sleep(300);
    human.tap.clear();
    robot.tap.clear();

    const startedAt = Date.now();
    const outcome = await humanClient.requestControl(targetId, { timeoutMs: 10_000 });
    const elapsedMs = Date.now() - startedAt;

    expect(
      outcome.granted,
      `a person was refused a concurrent lease on a target an agent already holds: ${JSON.stringify(outcome)}`,
    ).toBe(true);
    expect(
      outcome,
      'the person was queued behind the agent rather than granted alongside it',
    ).not.toHaveProperty('queued', true);
    expect(elapsedMs).toBeLessThan(5000);

    const humanLeaseId = human.leaseId();
    expect(humanLeaseId).not.toBe('');
    expect(agentLeaseId).not.toBe('');
    expect(humanLeaseId, 'the agent and the person were handed the SAME lease id').not.toBe(
      agentLeaseId,
    );
    expect(robot.holds(), 'the agent lost control the instant a person took it').toBe(true);
    expect(human.holds()).toBe(true);

    await sleep(800);
    for (const [who, tap] of [
      ['the person', human.tap],
      ['the agent', robot.tap],
    ] as const) {
      const roster = rosterOf(tap, targetId).map((h) => h.viewerId);
      expect(
        roster,
        `${who}'s holder roster does not show both drivers: ${JSON.stringify(roster)}`,
      ).toEqual(expect.arrayContaining([human.viewerId, robot.viewerId]));
      expect(
        roster.length,
        `${who} sees more or fewer than the two expected drivers: ${JSON.stringify(roster)}`,
      ).toBe(2);
      expect(queueOf(tap, targetId), `${who} sees a non-empty queue on a shared target`).toEqual(
        [],
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `[A1] agent plus person concurrent grant: the person waited ${elapsedMs}ms, queue length 0, two distinct lease ids`,
    );
  }, 120_000);

  it('lands both the agent and the person keystrokes in the one shared text box', async () => {
    await resetPage('agent-human-typing');

    // Sequential, not simultaneous. Two drivers typing into one focused
    // element interleave at the CDP level, which is inherent to the feature
    // rather than a defect, so the assertion that BOTH landed is written where
    // the order is deterministic. Concurrency is asserted by both leases being
    // live throughout, checked between the two writes.
    await typeText(robot, 'ROBOT');
    const afterAgent = await collabUntil(human, (s) => s.value === 'ROBOT', 20_000);
    expect(
      afterAgent.ok,
      `the agent's keystrokes never reached the box: ${JSON.stringify(afterAgent.last)}`,
    ).toBe(true);

    expect(robot.holds()).toBe(true);
    expect(human.holds()).toBe(true);

    await typeText(human, 'PERSON');
    const afterHuman = await collabUntil(human, (s) => s.value === 'ROBOTPERSON', 20_000);
    expect(
      afterHuman.ok,
      `the person's keystrokes never reached the box the agent is also typing into: ${JSON.stringify(afterHuman.last)}`,
    ).toBe(true);
  }, 120_000);

  it('lands both the agent and the person mouse presses on the one shared page', async () => {
    await resetPage('agent-human-mouse');

    // Two presses at two places, one from each party, told apart by WHERE they
    // landed in the page's own CSS pixels, so a single press that could have
    // come from either cannot satisfy this.
    await click(human, Math.floor(human.fw * 0.2), Math.floor(human.fh * 0.75));
    await click(robot, Math.floor(robot.fw * 0.8), Math.floor(robot.fh * 0.75));

    const seen = await collabUntil(
      human,
      (s) => s.downs.some((p) => p.x < s.w * 0.4) && s.downs.some((p) => p.x > s.w * 0.6),
      20_000,
    );
    expect(
      seen.ok,
      `the page did not see a press from both the agent and the person: ${JSON.stringify(seen.last?.downs)} (innerWidth ${seen.last?.w})`,
    ).toBe(true);
  }, 120_000);

  it('sweeps a disconnected AGENT held button promptly while the person keeps driving a clean page', async () => {
    // Property A3, first direction, measured in the gap between the two
    // deadlines that shipped today: hygiene at `disconnectHygieneMs` 1500 and
    // tenure at `disconnectGraceMs` 30000. BOTH halves are asserted, because
    // the fix for a stuck pointer must not be to evict the driver.
    await resetPage('agent-human-hygiene-agent');

    holdModifier(human, 'Control', 'ControlLeft', CTRL);
    pressAndHold(robot, Math.floor(robot.fw * 0.3), Math.floor(robot.fh * 0.75));
    const held = await collabUntil(
      human,
      (s) => s.buttons !== 0 && s.keys.includes('ControlLeft'),
      20_000,
    );
    expect(
      held.ok,
      `the page never saw the pre-disconnect state: ${JSON.stringify(held.last)}`,
    ).toBe(true);

    // A hard transport close: no close frame, no chance for the agent to be
    // polite about it. `agent.close()` cannot serve here, whatever it looks
    // like: its first act is releasing every lease on the wire, so it is a
    // `control.release` followed by a close and measures the release path
    // under a disconnect name.
    const agentSocket = agentSockets.at(-1);
    expect(
      agentSocket,
      'the capturing transport never recorded a socket for the agent',
    ).toBeDefined();
    const disconnectedAt = Date.now();
    agentSocket?.terminate();
    // Everything from here to the end of the case runs against a dead agent
    // socket, and the cases after it need a live one. Rebuilding in a `finally`
    // rather than at the end of the happy path is not tidiness: a failure here
    // would otherwise leave every later case connecting through a corpse and
    // failing with "not connected (state=fatal)", which says nothing about
    // what any of them were testing. Measured, in this file's own first full
    // run, on the other direction of this case.
    try {
      const clean = await collabUntil(human, (s) => s.buttons === 0, 25_000, 350);
      const sweptAfterMs = Date.now() - disconnectedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[A3 agent departs] held button swept ${sweptAfterMs}ms after a hard AGENT socket close (disconnectHygieneMs 1500, disconnectGraceMs 30000)`,
      );
      expect(
        clean.ok,
        `a disconnected agent left a button stuck down for the person: ${JSON.stringify(clean.last)}`,
      ).toBe(true);
      expect(
        sweptAfterMs,
        `the agent's held button survived past the hygiene deadline and into tenure territory (${sweptAfterMs}ms)`,
      ).toBeLessThan(15_000);
      expect(
        clean.last?.keys,
        `the agent's disconnect released the person's modifier: ${JSON.stringify(clean.last)}`,
      ).toContain('ControlLeft');

      // The TENURE survives. The sweep releases held state and NOTHING else: the
      // agent stays in `holders[]` flagged `connected: false` so a reconnect
      // inside `disconnectGraceMs` would resume the same `leaseId`. Read at a
      // moment inside the gap, well after 1500 and well before 30000.
      const roster = rosterOf(human.tap, targetId);
      const agentRow = roster.find((h) => h.viewerId === robot.viewerId);
      expect(
        agentRow,
        `the disconnected agent lost its tenure at the hygiene sweep instead of keeping it through the grace: ${JSON.stringify(roster)}`,
      ).toBeDefined();
      expect(agentRow?.connected, 'a disconnected agent is still reported connected').toBe(false);

      // The person is unaffected and still genuinely driving.
      expect(human.holds(), 'the person lost control when the agent disconnected').toBe(true);
      releaseModifier(human, 'Control', 'ControlLeft');
      await focusBox(human);
      await typeText(human, 'OK');
      const stillDrives = await collabUntil(human, (s) => s.value.includes('OK'), 20_000);
      expect(
        stillDrives.ok,
        `the person could not drive after the agent vanished: ${JSON.stringify(stillDrives.last)}`,
      ).toBe(true);
    } finally {
      // The old socket is dead and that tenure lapses on its own at
      // `disconnectGraceMs`.
      const rebuilt = await makeAgent(gateway, instanceId, targetId, 'agt_robo2', pageSpace, {
        socketBucket: agentSockets,
      });
      robot = rebuilt.party;
      agent = rebuilt.agent;
    }
  }, 240_000);

  it('sweeps a disconnected PERSON held button promptly while the agent keeps driving a clean page', async () => {
    // Property A3, the other direction. The engine's hygiene sweep is
    // scheduled on `othersStillDriving`, which knows nothing about kinds, so
    // this should behave identically. "Should" is the reason the case exists.
    await resetPage('agent-human-hygiene-human');

    holdModifier(robot, 'Shift', 'ShiftLeft', SHIFT);
    pressAndHold(human, Math.floor(human.fw * 0.3), Math.floor(human.fh * 0.75));
    const held = await collabUntil(
      observer,
      (s) => s.buttons !== 0 && s.keys.includes('ShiftLeft'),
      20_000,
    );
    expect(
      held.ok,
      `the page never saw the pre-disconnect state: ${JSON.stringify(held.last)}`,
    ).toBe(true);

    const humanSocket = humanSockets.at(-1);
    expect(
      humanSocket,
      'the capturing transport never recorded a socket for the person',
    ).toBeDefined();
    const disconnectedAt = Date.now();
    humanSocket?.terminate();
    // See the matching comment in the case above: the rebuild is in a
    // `finally` so a failure here cannot poison every case that follows.
    try {
      // Read through the OBSERVER from here on: the driving person's socket is
      // gone and an agent cannot read this page at all.
      const clean = await collabUntil(observer, (s) => s.buttons === 0, 25_000, 350);
      const sweptAfterMs = Date.now() - disconnectedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[A3 person departs] held button swept ${sweptAfterMs}ms after a hard HUMAN socket close (disconnectHygieneMs 1500, disconnectGraceMs 30000)`,
      );
      expect(
        clean.ok,
        `a disconnected person left a button stuck down for the agent: ${JSON.stringify(clean.last)}`,
      ).toBe(true);
      expect(
        sweptAfterMs,
        `the person's held button survived past the hygiene deadline and into tenure territory (${sweptAfterMs}ms)`,
      ).toBeLessThan(15_000);
      expect(
        clean.last?.keys,
        `the person's disconnect released the agent's modifier: ${JSON.stringify(clean.last)}`,
      ).toContain('ShiftLeft');

      const roster = rosterOf(observer.tap, targetId);
      const humanRow = roster.find((h) => h.viewerId === human.viewerId);
      expect(
        humanRow,
        `the disconnected person lost their tenure at the hygiene sweep instead of keeping it through the grace: ${JSON.stringify(roster)}`,
      ).toBeDefined();
      expect(humanRow?.connected, 'a disconnected person is still reported connected').toBe(false);

      expect(robot.holds(), 'the agent lost control when the person disconnected').toBe(true);
      releaseModifier(robot, 'Shift', 'ShiftLeft');
      await focusBox(robot);
      await typeText(robot, 'OK');
      const stillDrives = await collabUntil(observer, (s) => s.value.includes('OK'), 20_000);
      expect(
        stillDrives.ok,
        `the agent could not drive after the person vanished: ${JSON.stringify(stillDrives.last)}`,
      ).toBe(true);
    } finally {
      const rebuilt = await makeHuman(gateway, instanceId, targetId, 'vwr_pat2', {
        socketBucket: humanSockets,
      });
      human = rebuilt.party;
      humanClient = rebuilt.client;
    }
  }, 240_000);

  // ─────────────────────────────────────────────────────────────────────
  // Group C: the shared yield
  // ─────────────────────────────────────────────────────────────────────

  it('stands the AGENT holders of a shared target down on control.yield, and leaves every human holder driving', async () => {
    // Property C8, both halves in one case because they are one claim: the
    // yield is only worth anything if it is narrow. Written against the wire
    // contract exactly as `packages/protocol/src/wire/messages/control.ts`
    // states it:
    //   C to S  `control.yield {targetId, reason?}`
    //   S to C  `control.yield.request {targetId, leaseId, byViewerId, byLabel,
    //            graceMs, deadline, reason?}`, to AGENT holders only
    //   a holder that has not released by `deadline` has its tenure ended and
    //   receives `control.revoked {reason: 'human_takeover'}`.
    await resetPage('agent-human-yield');
    const agentLeaseId = robot.leaseId();

    // A second person, so "the other people keep driving" is a claim about
    // somebody other than the requester.
    const second = await makeHuman(gateway, instanceId, targetId, 'vwr_sam');
    const secondOutcome = await second.client.requestControl(targetId, {
      queue: false,
      timeoutMs: 10_000,
    });
    expect(
      secondOutcome.granted,
      `the second person could not join the shared target: ${JSON.stringify(secondOutcome)}`,
    ).toBe(true);

    try {
      await sleep(600);
      // Rosters are read off the OBSERVER'S tap throughout this case, and its
      // tap is the one never cleared. The three taps below are cleared so that
      // "was this party asked to stand down" is a question about THIS yield
      // rather than about anything earlier in the block, and `rosterOf` reads
      // the most recent `control.state` a tap has seen: on a cleared tap that
      // is none at all, which reads as an empty roster and would make "the
      // agent is gone" trivially true the instant it was asked. Measured: this
      // case reported the agent's tenure ending 0ms after the yield, before
      // the server had answered anything.
      const before = rosterOf(observer.tap, targetId).map((h) => h.viewerId);
      expect(
        before,
        `all three drivers should be holding before the yield: ${JSON.stringify(before)}`,
      ).toEqual(expect.arrayContaining([human.viewerId, robot.viewerId, second.party.viewerId]));

      robot.tap.clear();
      human.tap.clear();
      second.party.tap.clear();

      // Sent as a raw envelope. A `BrowserGlassClient` convenience method for
      // this is being written in the same session as this file; the MESSAGE is
      // the contract and is what the server has to answer either way.
      // An agent asking first, which must be refused. Standing the other
      // agents down is a PERSON'S intention; an agent that could send this
      // would be able to evict its own competition on a shared tab.
      agentCoreOf(agent).transport.send({
        v: 1,
        t: 'control.yield',
        id: 'yield-from-an-agent',
        ts: Date.now(),
        targetId,
      });
      const refusedAgent = await robot.tap.waitFor('error', 5000);
      expect(
        refusedAgent?.['code'],
        `an agent sending control.yield was not refused: ${JSON.stringify(refusedAgent ?? 'nothing at all')}`,
      ).toBe('bgls.error.control.not_human');
      robot.tap.clear();

      transportOf(humanClient).send({
        v: 1,
        t: 'control.yield',
        id: 'yield-from-a-person',
        ts: Date.now(),
        targetId,
        reason: 'I have got this one',
      });

      const yieldRequest = await robot.tap.waitFor('control.yield.request', 8000);
      const serverError = robot.tap.of('error')[0] ?? human.tap.of('error')[0];
      expect(
        yieldRequest,
        `the agent was never asked to stand down. The server answered: ${JSON.stringify(serverError ?? 'nothing at all')}`,
      ).not.toBeNull();
      expect(yieldRequest?.['targetId']).toBe(targetId);
      expect(
        yieldRequest?.['leaseId'],
        "control.yield.request must name the RECIPIENT'S own leaseId, never the lease's primary holder's",
      ).toBe(agentLeaseId);
      expect(yieldRequest?.['byViewerId']).toBe(human.viewerId);
      expect(
        yieldRequest?.['graceMs'],
        'the yield grace should be the same agentPreemptGraceMs an agent gets under exclusive preemption',
      ).toBe(2000);

      // Half one: the agent's tenure ends, whether it released itself inside
      // the grace or had it ended for it.
      const gone = await waitUntil(
        () => {
          const roster = rosterOf(observer.tap, targetId);
          return roster.length > 0 && !roster.some((h) => h.viewerId === robot.viewerId);
        },
        12_000,
        100,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[C8] the agent's tenure ended ${gone === null ? 'NEVER within 12000ms' : `${gone}ms`} after the person sent control.yield`,
      );
      expect(
        gone,
        `the agent was asked to stand down and did not: roster ${JSON.stringify(rosterOf(observer.tap, targetId))}`,
      ).not.toBeNull();

      // Half two, and the half that makes this a yield rather than a blunt
      // revoke: the OTHER people are untouched. Neither was asked to stand
      // down, both are still in the roster, and the one who did not send the
      // yield can still drive.
      expect(
        human.tap.of('control.yield.request'),
        'a human holder was asked to stand down; shared stays shared between people',
      ).toEqual([]);
      expect(
        second.party.tap.of('control.yield.request'),
        'the other human holder was asked to stand down; shared stays shared between people',
      ).toEqual([]);
      const after = rosterOf(observer.tap, targetId).map((h) => h.viewerId);
      expect(
        after,
        `the requester lost their own hold to their own yield: ${JSON.stringify(after)}`,
      ).toContain(human.viewerId);
      expect(
        after,
        `an uninvolved human holder was evicted by the yield: ${JSON.stringify(after)}`,
      ).toContain(second.party.viewerId);

      await focusBox(second.party);
      await typeText(second.party, 'SAM');
      const samDrives = await collabUntil(human, (s) => s.value.includes('SAM'), 20_000);
      expect(
        samDrives.ok,
        `the other person stopped being able to drive after somebody else yielded the agents: ${JSON.stringify(samDrives.last)}`,
      ).toBe(true);

      // And the agent really has stopped: the lease id it used to hold no
      // longer dispatches. Measured on the page, not on the absence of an
      // error.
      const valueBefore = (await readCollab(human))?.value ?? '';
      await typeTextWithLease(robot, agentLeaseId, 'ZZZ');
      await sleep(2500);
      const valueAfter = (await readCollab(human))?.value ?? '';
      expect(
        valueAfter,
        `a stood down agent's input still reached the page: ${JSON.stringify({ valueBefore, valueAfter })}`,
      ).toBe(valueBefore);
    } finally {
      second.client.destroy();
    }
  }, 240_000);
});

// ═══════════════════════════════════════════════════════════════════════
// Group B: a person takes an exclusive target off an agent
// ═══════════════════════════════════════════════════════════════════════

describe('a person takes control of an exclusive target from an agent', () => {
  let gateway: RealGateway;
  let fixture: FixtureServer;
  let instanceId: InstanceId;
  let targetId: string;

  beforeAll(async () => {
    // No `controlMode`, so the SDK default `'exclusive'`.
    [gateway, fixture] = await Promise.all([
      startRealGateway({ headless: 'new' }),
      startFixtureServer(),
    ]);
    const acquired = await gateway.acquireInstance();
    instanceId = acquired.instanceId;

    const seed = await gateway.makeClient(instanceId, { sub: 'vwr_seed_x', caps: HUMAN_CAPS });
    await seed.connect();
    targetId =
      seed.targets[0]?.targetId ??
      (await seed.tabs.new({ url: fixture.collabUrl('takeover') })).targetId;
    await seed.navigate(targetId, fixture.collabUrl('takeover'));
    seed.destroy();
  }, 240_000);

  afterAll(async () => {
    await gateway?.close();
    await fixture?.close();
  }, 120_000);

  /**
   * One agent holding the target, and one person who has not asked for it
   * yet, both freshly built.
   *
   * Fresh clients per case rather than shared ones, because every case here
   * cares about WHEN the holder was granted (`minHoldMs` is measured from
   * `grantedAt`) and a lease carried over from a previous case would have
   * been granted at an unknown time. The cost is two connections per case,
   * which against an already running gateway is a few hundred milliseconds.
   */
  async function freshPair(caseName: string): Promise<{
    readonly robot: Party;
    readonly agent: AutomationClient;
    readonly agentLeaseId: string;
    readonly human: Party;
    readonly humanClient: BrowserGlassClient;
    readonly grantedAt: number;
    readonly dispose: () => void;
  }> {
    const madeHuman = await makeHuman(gateway, instanceId, targetId, `vwr_${caseName}`);
    const madeAgent = await makeAgent(
      gateway,
      instanceId,
      targetId,
      `agt_${caseName}`,
      madeHuman.space,
    );
    await madeHuman.client.navigate(targetId, fixture.collabUrl(caseName));
    const ready = await collabUntil(madeHuman.party, (s) => s.w > 0, 30_000);
    expect(
      ready.ok,
      `collab page never published a report for ${caseName}: ${JSON.stringify(ready.last)}`,
    ).toBe(true);

    const lease = await madeAgent.agent.acquireControl({ waitMs: 0 });
    const grantedAt = Date.now();
    return {
      robot: madeAgent.party,
      agent: madeAgent.agent,
      agentLeaseId: lease.leaseId,
      human: madeHuman.party,
      humanClient: madeHuman.client,
      grantedAt,
      dispose: () => {
        try {
          madeAgent.agent.close();
        } catch {
          // teardown is best effort
        }
        madeHuman.client.destroy();
      },
    };
  }

  it('hands an exclusive target to a person promptly when an agent holds it, without waiting out minHoldMs', async () => {
    // Property B4, the case the change is FOR: a person asks for a target an
    // agent was granted moments ago.
    //
    // Before the change, `EXCLUSIVE_POLICY.onRequestHeld` gates preemption on
    // `minHoldMs` (3000) having elapsed since the holder was granted, so a
    // request inside that window is QUEUED. Nothing re-evaluates a queue until
    // the holder lets go, and `AutomationClient` renews by default, so the
    // person waits for as long as the agent keeps renewing. That is worse than
    // the "up to 5 seconds" originally estimated, and it is what the printed
    // number should show against a pre-change build.
    //
    // After the change the gate is scoped to human holders and the yield
    // window is `agentPreemptGraceMs` (2000).
    const ctx = await freshPair('b4-prompt');
    try {
      // Deliberately INSIDE minHoldMs. A request placed after 3000ms would
      // pass under both the old and the new engine and prove nothing.
      const sinceGrant = Date.now() - ctx.grantedAt;
      expect(
        sinceGrant,
        'the request was not placed inside minHoldMs, so this case proves nothing',
      ).toBeLessThan(2500);

      const startedAt = Date.now();
      const outcome = await ctx.humanClient
        .requestControl(targetId, { queue: true, timeoutMs: 25_000 })
        .catch((err: unknown) => ({
          granted: false as const,
          queued: false as const,
          reason: 'threw',
          message: String(err),
        }));
      // `requestControl` returns as soon as the server answers, and a queued
      // answer IS an answer, so the grant itself is waited for separately.
      const arrived = outcome.granted ? 0 : await waitUntil(() => ctx.human.holds(), 25_000);
      const latencyMs = Date.now() - startedAt;

      // eslint-disable-next-line no-console
      console.log(
        `[B4] human takeover from an AGENT holder, requested ${sinceGrant}ms after the agent was granted (minHoldMs 3000, agentPreemptGraceMs 2000): first answer ${JSON.stringify(outcome)}; control ${arrived === null ? 'NEVER ARRIVED within 25000ms' : `arrived after ${latencyMs}ms`}`,
      );

      expect(
        ctx.human.holds(),
        `a person asking for a target an agent holds did not get it within 25000ms: ${JSON.stringify(outcome)}`,
      ).toBe(true);
      // `agentPreemptGraceMs` is 2000 and the handoff drain is bounded at 2000
      // more, so 4500 is the contract's own ceiling rather than a number
      // chosen to make this pass.
      expect(
        latencyMs,
        `the person waited ${latencyMs}ms, longer than agentPreemptGraceMs plus the bounded handoff drain`,
      ).toBeLessThan(4500);
    } finally {
      ctx.dispose();
    }
  }, 180_000);

  it('takes an exclusive target off an agent within the yield window once minHoldMs has already elapsed', async () => {
    // The companion measurement to B4, and the thing that isolates `minHoldMs`
    // as the cause rather than leaving it inferred. Identical to B4 except
    // that the request is placed AFTER the hold window, where the pre-change
    // engine already preempts. Both numbers printed side by side say whether
    // the change did what it was for: this one should be roughly unchanged.
    const ctx = await freshPair('b4-after-minhold');
    try {
      await sleep(3300);
      const sinceGrant = Date.now() - ctx.grantedAt;
      expect(sinceGrant, 'this case must run OUTSIDE minHoldMs to mean anything').toBeGreaterThan(
        3000,
      );

      const startedAt = Date.now();
      const outcome = await ctx.humanClient
        .requestControl(targetId, { queue: true, timeoutMs: 25_000 })
        .catch((err: unknown) => ({
          granted: false as const,
          queued: false as const,
          reason: 'threw',
          message: String(err),
        }));
      const arrived = outcome.granted ? 0 : await waitUntil(() => ctx.human.holds(), 25_000);
      const latencyMs = Date.now() - startedAt;

      // eslint-disable-next-line no-console
      console.log(
        `[B4b] human takeover from an AGENT holder, requested ${sinceGrant}ms after the grant (OUTSIDE minHoldMs): control ${arrived === null ? 'NEVER ARRIVED within 25000ms' : `arrived after ${latencyMs}ms`}`,
      );

      expect(ctx.human.holds(), `the person never got control: ${JSON.stringify(outcome)}`).toBe(
        true,
      );
      expect(latencyMs).toBeLessThan(4500);
    } finally {
      ctx.dispose();
    }
  }, 180_000);

  it('tells the agent it was a human takeover, not merely that somebody outranked it', async () => {
    // Property B5. `PreemptReason` has declared `'human_takeover'` in five
    // files since the type was written and `beginPreempt` has always
    // hardcoded `force ? 'force_claim' : 'priority'`, so an agent being taken
    // over by a person could not tell that apart from being outranked by
    // another agent. That is the exact distinction the value was added for,
    // and this case is the difference between it being real and decorative.
    //
    // Read off the WIRE rather than off `PreemptionRequest.byKind`, which the
    // automation client derives locally from its own presence cache and which
    // would therefore read "human" even with the server still saying
    // 'priority'.
    //
    // Placed outside `minHoldMs` on purpose: the reason is a claim about the
    // preemption notice, and it must not fail merely because the
    // separate `minHoldMs` change has not landed yet.
    const ctx = await freshPair('b5-reason');
    try {
      await sleep(3300);
      ctx.robot.tap.clear();
      await ctx.humanClient
        .requestControl(targetId, { queue: true, timeoutMs: 25_000 })
        .catch(() => undefined);
      await waitUntil(() => ctx.human.holds(), 25_000);

      const preemptRequest = ctx.robot.tap.of('control.preempt.request')[0];
      const preempted = ctx.robot.tap.of('control.preempted')[0];
      const revoked = ctx.robot.tap.of('control.revoked')[0];
      // eslint-disable-next-line no-console
      console.log(
        `[B5] the agent was told: control.preempt.request reason ${JSON.stringify(preemptRequest?.['reason'])}, control.preempted reason ${JSON.stringify(preempted?.['reason'])}, control.revoked reason ${JSON.stringify(revoked?.['reason'])}`,
      );

      expect(
        preemptRequest,
        'the agent was never sent a control.preempt.request, so it was given no chance to yield at all',
      ).toBeDefined();
      expect(
        preemptRequest?.['reason'],
        "a person taking a target off an agent must say so: 'priority' is what an agent outranking another agent looks like, and an agent cannot tell the two apart",
      ).toBe('human_takeover');
      if (preempted) {
        expect(
          preempted['reason'],
          'the completed takeover disagreed with the notice that preceded it',
        ).toBe('human_takeover');
      }
    } finally {
      ctx.dispose();
    }
  }, 180_000);

  it('stops a yielded agent input from reaching the page, on its own client and on the wire', async () => {
    // Property B6. Two separate claims, because a half yielded agent is worse
    // than no yield and the two fail in different places:
    //   1. the agent's own client refuses to send. That is the automation SDK
    //      standing down.
    //   2. an agent that sends anyway, with the lease id it used to hold, is
    //      fenced off. That is the server, and it is what actually protects
    //      the page from an agent whose stand down is incomplete.
    const ctx = await freshPair('b6-standdown');
    try {
      await sleep(3300);
      const outcome = await ctx.humanClient
        .requestControl(targetId, { queue: true, timeoutMs: 25_000 })
        .catch(() => null);
      const got = await waitUntil(() => ctx.human.holds(), 25_000);
      expect(
        got,
        `the person never got control, so there is no yield to measure: ${JSON.stringify(outcome)}`,
      ).not.toBeNull();

      // Establish a known value first, so "the agent changed nothing" is a
      // statement about a value that exists rather than about an empty box.
      await focusBox(ctx.human);
      await typeText(ctx.human, 'BASE');
      const based = await collabUntil(ctx.human, (s) => s.value === 'BASE', 20_000);
      expect(based.ok, `could not establish a baseline value: ${JSON.stringify(based.last)}`).toBe(
        true,
      );

      // Claim 1: the client itself refuses.
      //
      // Either refusal code satisfies this, and both are named rather than the
      // case settling for "it threw something". `LEASE_NOT_HELD` is the plain
      // "you are not a holder" guard in `AutomationClient.run`;
      // `LEASE_REVOKED` is the dedicated stand down, whose message says which
      // viewer took over and that this client will not dispatch until control
      // is granted again. The property under test is that the call is REFUSED
      // and nothing goes on the wire, and both codes are that. Pinning one
      // would be pinning which of two correct answers the SDK gives this week.
      const refusal = await ctx.agent.type('CLIENTSIDE').then(
        () => null,
        (err: unknown) => err as { code?: string; message?: string },
      );
      // eslint-disable-next-line no-console
      console.log(
        `[B6] the yielded agent's own client answered type() with: ${JSON.stringify(refusal ? { code: refusal.code, message: refusal.message } : 'it accepted the call')}`,
      );
      expect(
        ['LEASE_REVOKED', 'LEASE_NOT_HELD'].includes(refusal?.code ?? ''),
        `a yielded automation client did not refuse an interaction call: ${JSON.stringify(refusal ?? 'it accepted the call')}`,
      ).toBe(true);

      // Claim 2: the wire refuses too. The stale lease id is sent directly,
      // bypassing the client's own guard, which is precisely the "a half
      // yielded agent keeps sending a few more events" case.
      await typeTextWithLease(ctx.robot, ctx.agentLeaseId, 'STALE');
      await sleep(2500);
      const after = await readCollab(ctx.human);
      expect(
        after?.value,
        `a yielded agent's input still reached the page: ${JSON.stringify(after)}`,
      ).toBe('BASE');
    } finally {
      ctx.dispose();
    }
  }, 180_000);

  it('does NOT let an agent yank an exclusive target off a human holder', async () => {
    // Property B7, and the one that matters most: the regression guard on
    // narrowing `minHoldMs`. Getting it wrong makes every human holder
    // interruptible, which is far worse than a person waiting three seconds.
    //
    // An agent ranks 50 and a person 100, so `priorityWins` is false and the
    // agent must be refused or queued, both immediately after the grant
    // (inside `minHoldMs`) and well after it, because the protection here is
    // the priority model and not the hold window. Checking both times is what
    // makes this survive the `minHoldMs` change rather than passing for the wrong
    // reason on either side of it.
    const madeHuman = await makeHuman(gateway, instanceId, targetId, 'vwr_b7');
    const madeAgent = await makeAgent(gateway, instanceId, targetId, 'agt_b7', madeHuman.space);
    try {
      await madeHuman.client.navigate(targetId, fixture.collabUrl('b7-human-holder'));
      const ready = await collabUntil(madeHuman.party, (s) => s.w > 0, 30_000);
      expect(ready.ok, `collab page never published a report: ${JSON.stringify(ready.last)}`).toBe(
        true,
      );

      const held = await madeHuman.client.requestControl(targetId, { timeoutMs: 10_000 });
      expect(held.granted, `the person could not take control: ${JSON.stringify(held)}`).toBe(true);

      const insideResult = await madeAgent.agent.acquireControl({ waitMs: 0 }).then(
        () => 'granted' as const,
        (err: unknown) => `refused: ${String(err)}`,
      );
      expect(
        insideResult,
        'an agent was handed a target a person was holding, inside minHoldMs',
      ).not.toBe('granted');
      expect(
        madeHuman.party.holds(),
        'the person lost their lease to an agent inside minHoldMs',
      ).toBe(true);

      await sleep(4000);
      const outsideResult = await madeAgent.agent.acquireControl({ waitMs: 0 }).then(
        () => 'granted' as const,
        (err: unknown) => `refused: ${String(err)}`,
      );
      // eslint-disable-next-line no-console
      console.log(
        `[B7] agent asking for a HUMAN held target: inside minHoldMs -> ${insideResult}; after 4000ms -> ${outsideResult}`,
      );
      expect(
        outsideResult,
        'an agent was handed a target a person was holding once minHoldMs had elapsed; a human holder is not preemptible by an agent at any time',
      ).not.toBe('granted');
      expect(
        madeHuman.party.holds(),
        'the person lost their lease to an agent after minHoldMs elapsed',
      ).toBe(true);
      expect(
        madeHuman.party.tap.of('control.preempt.request'),
        'a person was sent a preemption notice by an agent',
      ).toEqual([]);

      // And the person is still genuinely driving, not merely still listed.
      await focusBox(madeHuman.party);
      await typeText(madeHuman.party, 'MINE');
      const drives = await collabUntil(madeHuman.party, (s) => s.value.includes('MINE'), 20_000);
      expect(
        drives.ok,
        `the person stopped being able to drive their own lease: ${JSON.stringify(drives.last)}`,
      ).toBe(true);
    } finally {
      try {
        madeAgent.agent.close();
      } catch {
        // teardown is best effort
      }
      madeHuman.client.destroy();
    }
  }, 240_000);

  it('does NOT let a second person yank an exclusive target off the first, and keeps minHoldMs standing against an admin force claim', async () => {
    // Property B7's other two halves.
    //
    // Person from person is protected by priority EQUALITY (100 is not greater
    // than 100), so it would hold even with `minHoldMs` gone entirely. Said
    // plainly, because it means this half is NOT the sharp regression guard it
    // looks like.
    //
    // The sharp one is the admin force claim. `forceClaim` is the one path
    // that outranks a human holder, and `EXCLUSIVE_POLICY.onRequestHeld` gates
    // it on `minHoldElapsed` exactly as it gates a priority preempt. If
    // narrowing `minHoldMs` to agent holders is done by REMOVING the check
    // rather than by SCOPING it, a person three hundred milliseconds into a
    // drag becomes force claimable, and this is the case that notices.
    const first = await makeHuman(gateway, instanceId, targetId, 'vwr_b7a');
    const second = await makeHuman(gateway, instanceId, targetId, 'vwr_b7b');
    const boss = await makeHuman(gateway, instanceId, targetId, 'vwr_b7admin', {
      caps: ADMIN_CAPS,
    });
    try {
      const held = await first.client.requestControl(targetId, { timeoutMs: 10_000 });
      expect(held.granted, `the first person could not take control: ${JSON.stringify(held)}`).toBe(
        true,
      );
      const grantedAt = Date.now();

      const secondOutcome = await second.client.requestControl(targetId, {
        queue: true,
        timeoutMs: 8000,
      });
      expect(
        secondOutcome.granted,
        `a second person was handed a target the first was holding: ${JSON.stringify(secondOutcome)}`,
      ).toBe(false);
      expect(first.party.holds(), 'the first person lost their lease to a second person').toBe(
        true,
      );

      first.party.tap.clear();
      const sinceGrant = Date.now() - grantedAt;
      const forceOutcome = await boss.client
        .requestControl(targetId, { force: true, queue: true, timeoutMs: 8000 })
        .catch((err: unknown) => ({
          granted: false as const,
          queued: false as const,
          reason: 'threw',
          message: String(err),
        }));

      // Checked at a moment still inside the window, so this is about
      // `minHoldMs` and not about the eventual outcome, which is allowed to be
      // a successful force claim once the window has passed.
      const waitMs = grantedAt + 2200 - Date.now();
      if (waitMs > 0) await sleep(waitMs);
      const noticesInsideWindow = first.party.tap.of('control.preempt.request');
      // eslint-disable-next-line no-console
      console.log(
        `[B7 admin] force claim placed ${sinceGrant}ms after a HUMAN holder was granted (minHoldMs 3000): first answer ${JSON.stringify(forceOutcome)}; preempt notices seen by that holder at +2200ms: ${noticesInsideWindow.length}`,
      );
      expect(
        noticesInsideWindow,
        'a human holder was force claimed inside minHoldMs; the window that protects a person mid drag is gone',
      ).toEqual([]);
      expect(
        first.party.holds(),
        'a human holder lost their lease to a force claim inside minHoldMs',
      ).toBe(true);
    } finally {
      first.client.destroy();
      second.client.destroy();
      boss.client.destroy();
    }
  }, 240_000);

  it('refuses control.yield on an exclusive target rather than quietly doing nothing', async () => {
    // The other half of the Group C contract, and it belongs here because it
    // is a claim about EXCLUSIVE mode. `control.yield`'s own doc: refused on an
    // exclusive target, because exclusive control already has a way for a
    // person to take a target off an agent (`control.request`, whose
    // preemption notice gives that agent the same window), and a client that
    // sent the wrong message for the mode should learn so.
    const ctx = await freshPair('b-yield-exclusive');
    try {
      ctx.human.tap.clear();
      ctx.robot.tap.clear();
      transportOf(ctx.humanClient).send({
        v: 1,
        t: 'control.yield',
        id: 'yield-on-exclusive',
        ts: Date.now(),
        targetId,
      });
      const err = await ctx.human.tap.waitFor('error', 8000);
      // eslint-disable-next-line no-console
      console.log(
        `[C exclusive] control.yield on an exclusive target was answered with: ${JSON.stringify(err ?? 'nothing at all')}`,
      );
      expect(
        err,
        'control.yield on an exclusive target was answered with silence rather than a refusal',
      ).not.toBeNull();
      // The CODE, not merely the presence of an error. A build that has never
      // heard of `control.yield` answers
      // `bgls.error.protocol.unknown_type`, which is not a refusal of the
      // yield, it is a refusal of the message, and a case that accepted it
      // would pass identically before and after the feature was written.
      // Measured on the pre-change tree: exactly that, which is why this line
      // is here.
      expect(
        err?.['code'],
        'control.yield on an exclusive target was answered with "I do not know that message", not with a refusal of the yield',
      ).toBe('bgls.error.control.not_shared');
      expect(
        ctx.robot.tap.of('control.yield.request'),
        'control.yield reached an agent holder of an EXCLUSIVE target',
      ).toEqual([]);
    } finally {
      ctx.dispose();
    }
  }, 180_000);
});
