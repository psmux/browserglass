import type { BrowserGlassClient, StreamHandle } from '@browserglass/client';
/**
 * The acceptance gate for reading console output, page errors and network
 * activity from several browsers at the same time.
 *
 * What made this worth building: `console.entry`, `page.error`,
 * `network.summary` and `devtools.open` were all defined in
 * `packages/protocol/src/wire/messages/diagnostics.ts` under the comment
 * "Typed only, not wired yet", and every one of them was exactly
 * that. `BrowserGlassClient` even had handlers for `console.entry` and
 * `page.error` and emitted `console`/`pageerror` events from them, so the
 * client half looked finished; the server simply never sent a single one.
 * Nothing anywhere touched network.
 *
 * Two properties are asserted, and the second is the one that is easy to
 * get wrong.
 *
 * 1. CONCURRENCY. Every target's diagnostics arrive over ONE shared
 *    measurement window. Three targets taking turns would satisfy a per
 *    target assertion and is precisely the failure mode parallel streaming
 *    exists to avoid, so the window is shared and the counts are compared
 *    across it.
 * 2. ISOLATION. Target A's console line must never be delivered as target
 *    B's. Every line the fixture logs and every request it makes carries
 *    that target's own label, so a crossed wire shows up as a label
 *    appearing under the wrong targetId rather than as a vague count being
 *    off. Under the old per-connection habits in this codebase (the `ack`,
 *    `input`, `control` and `probeFull` limiters were all connection wide
 *    and each starved one pane while its siblings looked healthy) this is
 *    the assertion most likely to catch a regression.
 *
 * The suite runs `isolation: 'window'` because that is the mode a real
 * caller driving several browsers uses, and diagnostics must not cost the
 * streaming that mode exists to provide: the last case checks frames are
 * still flowing on every target while all three are reporting.
 */
import { type InstanceId, decodeBinaryHeader } from '@browserglass/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

const TARGETS = 3;

/** Long enough for the fixture's 700ms burst timer to fire several times on every target. */
const MEASURE_MS = 5000;

let gateway: RealGateway;
let fixture: FixtureServer;
let client: BrowserGlassClient;
let instanceId: InstanceId;

interface Pane {
  readonly label: string;
  readonly targetId: string;
  readonly stream: StreamHandle;
}

let panes: Pane[] = [];

/**
 * The subject both of this file's acquires are made for.
 *
 * Since browser affinity landed, this suite reaches its instance the way a
 * returning user does: one acquire that launches, then a second with the
 * same `sticky.subject` that must reattach to it. Every diagnostics
 * assertion below then runs against a browser the router handed back by
 * reuse rather than one it had just launched. That matters here
 * specifically because console, pageerror and network all arrive over a
 * session's own event fan-out, and a viewer joining a REATTACHED instance
 * joins a session that already exists rather than one built around it.
 */
const STICKY_SUBJECT = 'parallel-diagnostics:user';

/** The two acquires, asserted in this file's own first case before anything is built on them. */
let firstVisit: Awaited<ReturnType<RealGateway['acquireInstance']>>;
let reattached: Awaited<ReturnType<RealGateway['acquireInstance']>>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Per `streamId` tally of binary frames, so the last case can show streaming survived diagnostics. */
const framesByStream = new Map<number, number>();

class CountingWebSocket extends WebSocket {
  constructor(...args: ConstructorParameters<typeof WebSocket>) {
    super(...args);
    this.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) return;
      try {
        const header = decodeBinaryHeader(data);
        framesByStream.set(header.streamId, (framesByStream.get(header.streamId) ?? 0) + 1);
      } catch {
        // Not this suite's problem; never take the socket down over it.
      }
    });
  }
}

/** Everything the client reported, kept per target so isolation can be checked. */
interface Collected {
  console: Array<{ targetId: string; level: string; text: string }>;
  errors: Array<{ targetId: string; message: string }>;
  network: Array<{
    targetId: string;
    url: string;
    status: number | null;
    errorText: string | null;
  }>;
}

const collected: Collected = { console: [], errors: [], network: [] };

/** Which panes' labels appear anywhere in `texts`. Every fixture line and url carries exactly one. */
function labelsIn(texts: readonly string[]): string[] {
  const found = new Set<string>();
  for (const t of texts) {
    for (const pane of panes) {
      if (t.includes(pane.label)) found.add(pane.label);
    }
  }
  return [...found].sort();
}

beforeAll(async () => {
  [gateway, fixture] = await Promise.all([
    startRealGateway({ headless: 'new', isolation: 'window' }),
    startFixtureServer(),
  ]);

  // Two acquires for one user, the demo's own request shape both times: an
  // ephemeral profile plus `sticky`, with `subject` beside it (the router
  // stamps `subject` onto the instance row and matches `sticky.subject`
  // against that column, so both are needed; `sticky-affinity.test.ts`
  // pins that trap directly).
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

  client.on('console', (e) =>
    collected.console.push({ targetId: e.targetId, level: e.level, text: e.text }),
  );
  client.on('pageerror', (e) =>
    collected.errors.push({ targetId: e.targetId, message: e.message }),
  );
  // `network` is the event the new `network.request` message feeds. Guarded
  // so this file still loads if the client has not shipped it yet; the
  // assertions below fail loudly in that case rather than passing hollowly.
  (client as unknown as { on(t: string, fn: (e: Record<string, unknown>) => void): unknown }).on(
    'network',
    (e) => {
      collected.network.push({
        targetId: String(e['targetId']),
        url: String(e['url']),
        status: (e['status'] as number | null) ?? null,
        errorText: (e['errorText'] as string | null) ?? null,
      });
    },
  );

  const targetIds: string[] = client.targets.length > 0 ? [client.targets[0]!.targetId] : [];
  while (targetIds.length < TARGETS) {
    const created = await client.tabs.new({
      url: fixture.diagnosticsUrl(`diag-${targetIds.length}`),
    });
    targetIds.push(created.targetId);
  }

  panes = [];
  for (const [i, targetId] of targetIds.entries()) {
    const label = `diag-${i}`;
    await client.requestControl(targetId);
    await client.navigate(targetId, fixture.diagnosticsUrl(label));
    const stream = await client.subscribe(targetId);
    panes.push({ label, targetId, stream });
  }

  // Subscribe diagnostics on ALL THREE at once, never in a per target loop.
  await Promise.all(
    panes.map((p) =>
      (
        client as unknown as {
          diagnostics: {
            subscribe(targetId: string, feeds?: Record<string, boolean>): Promise<unknown>;
          };
        }
      ).diagnostics.subscribe(p.targetId, { console: true, errors: true, network: true }),
    ),
  );

  // One shared window for every target, so "they took turns" cannot pass.
  collected.console.length = 0;
  collected.errors.length = 0;
  collected.network.length = 0;
  await sleep(MEASURE_MS);
}, 300_000);

afterAll(async () => {
  await gateway?.close(client ? [client] : []);
  await fixture?.close();
}, 120_000);

describe('console, errors and network arrive from every browser at once', () => {
  it('reached this browser by sticky reuse, with no second Chrome launched, so every diagnostic below is read off a reattached instance', () => {
    // Ordered first on purpose. If this fails, every case after it is
    // reading diagnostics off a freshly launched browser and says nothing
    // about the returning-user path the demo takes.
    expect(firstVisit.reused).toBe(false);
    expect(reattached.instanceId).toBe(firstVisit.instanceId);
    expect(reattached.reuseReason).toBe('sticky');
    // The operating system's answer, not the router's.
    expect(
      gateway.chromeProcessCount(),
      'the second acquire launched another Chrome instead of reattaching',
    ).toBe(1);
  });

  it('reports console output from all three targets over one shared window', () => {
    const shape = Object.fromEntries(
      panes.map((p) => [
        p.label,
        collected.console.filter((c) => c.targetId === p.targetId).length,
      ]),
    );
    for (const pane of panes) {
      const mine = collected.console.filter((c) => c.targetId === pane.targetId);
      expect
        .soft(mine.length, `${pane.label} produced no console entries: ${JSON.stringify(shape)}`)
        .toBeGreaterThan(0);
    }
    // Every level the fixture logs should be represented somewhere, so a
    // capture path that only wires `console.log` is caught.
    const levels = new Set(collected.console.map((c) => c.level));
    expect
      .soft([...levels].sort(), `levels seen: ${JSON.stringify([...levels])}`)
      .toEqual(expect.arrayContaining(['error', 'log', 'warn']));
  });

  it("never delivers one target's console line under another target's id", () => {
    for (const pane of panes) {
      const mine = collected.console.filter((c) => c.targetId === pane.targetId).map((c) => c.text);
      const labels = labelsIn(mine);
      // Exactly its own label, never a sibling's. This is the assertion that
      // catches a shared buffer or a connection-wide fan-out.
      expect
        .soft(labels, `${pane.label} saw foreign labels in its console feed`)
        .toEqual([pane.label]);
    }
  });

  it('reports the uncaught page error from every target', () => {
    for (const pane of panes) {
      const mine = collected.errors.filter((e) => e.targetId === pane.targetId);
      expect
        .soft(
          mine.some((e) => e.message.includes(`PAGE-ERROR:${pane.label}`)),
          `${pane.label} never reported its page error`,
        )
        .toBe(true);
    }
  });

  it('reports network activity from every target, including a failed request', () => {
    for (const pane of panes) {
      const mine = collected.network.filter((n) => n.targetId === pane.targetId);
      expect.soft(mine.length, `${pane.label} produced no network rows`).toBeGreaterThan(0);
      expect
        .soft(
          mine.some((n) => n.url.includes('/api/echo') && n.url.includes(pane.label)),
          `${pane.label} never reported its successful request`,
        )
        .toBe(true);
      // The fixture asks for `/api/missing`, which answers 404. A network
      // panel that cannot distinguish that from a success is not much of a
      // debugging tool.
      expect
        .soft(
          mine.some(
            (n) => n.url.includes('/api/missing') && (n.status === 404 || n.errorText !== null),
          ),
          `${pane.label} never reported its failing request`,
        )
        .toBe(true);
    }
  });

  it("never delivers one target's network row under another target's id", () => {
    for (const pane of panes) {
      const mine = collected.network.filter((n) => n.targetId === pane.targetId).map((n) => n.url);
      const labels = labelsIn(mine);
      expect
        .soft(labels, `${pane.label} saw foreign labels in its network feed`)
        .toEqual([pane.label]);
    }
  });

  it('keeps every stream running while all three targets are reporting diagnostics', async () => {
    const before = panes.map((p) => framesByStream.get(p.stream.streamId) ?? 0);
    const start = Date.now();
    await sleep(4000);
    const elapsedSec = (Date.now() - start) / 1000;
    const fps = panes.map(
      (p, i) => ((framesByStream.get(p.stream.streamId) ?? 0) - before[i]!) / elapsedSec,
    );

    // `Network.enable` is not free, and the point of window isolation is
    // that several panes stream at once. Diagnostics must not quietly undo
    // that. The floor is low on purpose: this asserts the streams are ALIVE
    // while reporting, not a particular frame rate.
    const shape = JSON.stringify(
      Object.fromEntries(panes.map((p, i) => [p.label, Number(fps[i]!.toFixed(1))])),
    );
    for (const [i, pane] of panes.entries()) {
      expect
        .soft(fps[i]!, `${pane.label} stopped streaming while diagnostics were on: ${shape}`)
        .toBeGreaterThan(0);
    }
  }, 60_000);
});
