import type { BrowserGlassClient, StreamHandle, TargetSummary } from '@browserglass/client';
import type { InstanceId } from '@browserglass/protocol';
/**
 * The requirement the whole architecture exists for, driven for real:
 *
 *   "Attachment granularity is arbitrary: N clients on one browser; N
 *    clients on one specific tab; different clients on different tabs of
 *    the same browser; different clients on entirely different browsers.
 *    Every combination must work simultaneously over the same connection
 *    infrastructure."
 *
 * Everything else in this package tests one instance, one or two targets,
 * one verb at a time. Nothing tested the actual claim: several real
 * Chromes, several real tabs inside each, several independent clients, all
 * being clicked, typed into, selected in, navigated, stopped and restarted
 * at the same moment, with every effect landing in exactly the tab it was
 * addressed to and nowhere else.
 *
 * Every verb is issued through `Promise.all` over all nine (instance, tab)
 * pairs at once, never in a per instance loop, so a serialisation bug (one
 * global lock, a shared mutable dispatcher, a per process CDP queue) shows
 * up as a failure here rather than as a slow demo later.
 *
 * Effects are read back with `client.probe()`, the ordinary public hit
 * test call, against a report band each fixture page paints at the bottom
 * of its own viewport. Nothing in this file opens a channel into Chrome
 * that a real BrowserGlass client would not have. The page title is
 * deliberately NOT the channel: Chrome emits `Target.targetInfoChanged` on
 * a URL change and never on a title change, so a title reaches a client
 * only on `TargetRegistry`'s 30s resync (see `support/fixture-server.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, MARKER, startFixtureServer } from './support/fixture-server.js';
import {
  type RealGateway,
  chromeMainProcessesUnder,
  startRealGateway,
} from './support/real-gateway.js';

/**
 * Three real Chrome processes, three real tabs in each: nine independently
 * addressable targets, the smallest set that can distinguish "works per
 * instance" from "works per tab" from "works globally". Larger fan-outs
 * were run by hand during development; three by three is what this suite
 * keeps, so an ordinary dev machine can run it unattended.
 */
const INSTANCES = 3;
const TABS_PER_INSTANCE = 3;

let gateway: RealGateway;
let fixture: FixtureServer;

beforeAll(async () => {
  [gateway, fixture] = await Promise.all([
    startRealGateway({ headless: 'new' }),
    startFixtureServer(),
  ]);
}, 180_000);

afterAll(async () => {
  await Promise.all([gateway?.close(), fixture?.close()]);
}, 120_000);

/** One tab under test: which browser it lives in, which client drives it, and everything an input envelope for it needs. */
interface Pane {
  /** `i<instance>t<tab>`, the label its fixture page was loaded with and the basis of the text typed into it. Unique across all nine. */
  readonly label: string;
  readonly instanceIndex: number;
  readonly instanceId: InstanceId;
  readonly client: BrowserGlassClient;
  readonly targetId: string;
  readonly stream: StreamHandle;
  /** Frame-space dims and target generation every coordinate below is expressed against. */
  readonly fw: number;
  readonly fh: number;
  readonly gen: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `fn` returns something other than `undefined`, or the deadline passes. Returns `undefined` on timeout so a caller can assert with a useful message rather than an opaque rejection. */
async function until<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 0,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    if (everyMs > 0) await sleep(everyMs);
  }
}

/**
 * `target.probe` is rate limited per connection, not per target:
 * `DEFAULT_LIMITS.probeFullRate` is 2/s with a burst of 4
 * (`packages/protocol/src/wire/limits.ts`), and all three of a client's
 * panes share one socket. Reading three bands freely in parallel trips
 * `bgls.error.limit.rate` within a second, which is the gateway behaving
 * correctly, so every read on one client is queued behind the last and
 * spaced to stay inside the bucket's refill rate.
 *
 * This paces the *reading* only. Every clicked, typed, navigated and
 * stopped action this file issues still goes out to all nine panes at
 * once, which is the thing under test.
 */
const PROBE_SPACING_MS = 700;
const probeChain = new WeakMap<BrowserGlassClient, Promise<unknown>>();

function pacedProbe<T>(client: BrowserGlassClient, run: () => Promise<T>): Promise<T> {
  const prior = probeChain.get(client) ?? Promise.resolve();
  const next = prior.then(() => sleep(PROBE_SPACING_MS)).then(run);
  // The chain must not break on a rejected link, or one failed probe would
  // wedge every later read on that client.
  probeChain.set(
    client,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * Reads one pane's report band through `target.probe`. The band fills the
 * bottom third of the page, and `ManagedSession.probe` answers with the
 * hit element's `aria-label`, which the fixture page keeps in step with
 * whatever it last observed.
 */
async function readEcho(pane: Pane): Promise<string | undefined> {
  const result = await pacedProbe(pane.client, () =>
    pane.client.probe(pane.targetId, Math.floor(pane.fw / 2), Math.floor(pane.fh * 0.8)),
  );
  return result.hit ? result.label : undefined;
}

/** Waits until a pane's report band satisfies `pred`, returning what it said. `undefined` means it never did. */
async function echoUntil(
  pane: Pane,
  pred: (echo: string) => boolean,
  timeoutMs: number,
): Promise<string | undefined> {
  return until(async () => {
    const echo = await readEcho(pane);
    return echo !== undefined && pred(echo) ? echo : undefined;
  }, timeoutMs);
}

/** That pane's tab, as its session currently reports it. */
async function tabOf(pane: Pane): Promise<TargetSummary | undefined> {
  const tabs = await pane.client.tabs.list();
  return tabs.find((t) => t.targetId === pane.targetId);
}

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

/** A real move, press and release at frame-space `(x, y)`. `clickCount` 3 is what Chrome turns into a paragraph selection. */
async function click(pane: Pane, x: number, y: number, clickCount = 1): Promise<void> {
  const base = inputBase(pane);
  pane.client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'move',
    x,
    y,
    buttons: 0,
    modifiers: 0,
  });
  pane.client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'down',
    x,
    y,
    button: 'left',
    buttons: 1,
    modifiers: 0,
    clickCount,
  });
  await sleep(35);
  pane.client.sendInput({
    ...base,
    t: 'input.mouse',
    ts: Date.now(),
    kind: 'up',
    x,
    y,
    button: 'left',
    buttons: 0,
    modifiers: 0,
    clickCount,
  });
}

/** Band centres, in frame space: the input on top, the selectable block in the middle. */
const boxPoint = (p: Pane): [number, number] => [Math.floor(p.fw / 2), Math.floor(p.fh * 0.15)];
const markerPoint = (p: Pane): [number, number] => [Math.floor(p.fw / 2), Math.floor(p.fh * 0.47)];

/**
 * Brings up one instance: acquires a real Chrome, connects a real client,
 * grows it to `TABS_PER_INSTANCE` real tabs each on its own fixture page,
 * then takes control of and subscribes to every one of them.
 *
 * Control is requested before navigation because `nav.goto` is capability
 * and lease gated the same way input is; subscription comes last so the
 * returned `StreamHandle` carries the frame dims the coordinates in this
 * file are expressed in.
 */
async function bringUpInstance(instanceIndex: number): Promise<Pane[]> {
  const acquired = await gateway.acquireInstance();
  const client = await gateway.makeClient(acquired.instanceId);
  await client.connect();

  const first = client.targets[0]?.targetId;
  if (first === undefined)
    throw new Error(`instance ${instanceIndex} reported no targets after connect`);

  const targetIds: string[] = [first];
  // Tabs are opened one at a time on purpose: this is setup, not the thing
  // under test. The parallelism this file is about starts in the case below.
  for (let tab = 1; tab < TABS_PER_INSTANCE; tab += 1) {
    const created = await client.tabs.new({
      url: fixture.pageUrl(`i${instanceIndex}t${tab}`),
      background: true,
    });
    targetIds.push(created.targetId);
  }

  const panes: Pane[] = [];
  for (const [tabIndex, targetId] of targetIds.entries()) {
    const label = `i${instanceIndex}t${tabIndex}`;

    const outcome = await client.requestControl(targetId);
    if (!outcome.granted)
      throw new Error(`control not granted on ${label}: ${JSON.stringify(outcome)}`);

    // Tab 0 is the instance's original new-tab page; the others were
    // created already pointing at their page, but all three are navigated
    // through the same call so all nine reach a known state identically.
    await client.navigate(targetId, fixture.pageUrl(label));

    const stream = await client.subscribe(targetId);
    panes.push({
      label,
      instanceIndex,
      instanceId: acquired.instanceId,
      client,
      targetId,
      stream,
      fw: stream.width,
      fh: stream.height,
      gen: stream.gen,
    });
  }
  return panes;
}

describe('arbitrary attachment granularity in full: many real browsers, many real tabs, every verb at once', () => {
  it('nine tabs across three Chromes are clicked, typed into, selected in, navigated, stopped and restarted simultaneously, and every effect lands in exactly its own tab', async () => {
    // ---------------------------------------------------------------
    // Bring-up, all three instances at once. `BrowserRouter`'s
    // admission and `maxConcurrentLaunches` may serialise the actual
    // Chrome launches internally, which is fine and is itself part of
    // what is under test; what must not happen is a deadlock or one
    // instance's bring-up failing because of another's.
    // ---------------------------------------------------------------
    const perInstance = await Promise.all(
      Array.from({ length: INSTANCES }, (_, i) => bringUpInstance(i)),
    );
    const panes = perInstance.flat();
    const clients = perInstance.map((p) => p[0]!.client);

    expect(panes).toHaveLength(INSTANCES * TABS_PER_INSTANCE);
    // Nine distinct targets across three distinct browsers, all live at
    // the same moment: not nine sequential rentals of one browser.
    expect(new Set(panes.map((p) => p.targetId)).size).toBe(INSTANCES * TABS_PER_INSTANCE);
    expect(new Set(panes.map((p) => p.instanceId)).size).toBe(INSTANCES);
    // Every pane really has its own stream on its own instance's socket.
    expect(new Set(panes.map((p) => `${p.instanceId}:${p.stream.streamId}`)).size).toBe(
      panes.length,
    );

    // Every page loaded and is reporting its own label back.
    const loaded = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e === `READY:${p.label}`, 25_000)),
    );
    expect(panes.filter((_, i) => loaded[i] === undefined).map((p) => p.label)).toEqual([]);

    // ---------------------------------------------------------------
    // 1. CLICK and TYPE, all nine at once.
    //
    // Each pane clicks into its own input box and types a string unique
    // to it. The page echoes the box's value into its report band, so a
    // mis-routed click (input landing in the wrong tab, or the right tab
    // of the wrong browser) shows up as a value that never arrives, or
    // as another pane's text appearing where it should not.
    // ---------------------------------------------------------------
    const typed = new Map(panes.map((p) => [p.label, `TYPED-${p.label.toUpperCase()}`]));

    await Promise.all(
      panes.map(async (pane) => {
        const [x, y] = boxPoint(pane);
        await click(pane, x, y);
        // A real client's `InputCapture` sends `input.text` for a paste
        // or an IME commit and `input.key` for a keystroke; both paths
        // are exercised, the second by the backspace in step 2.
        pane.client.sendInput({
          ...inputBase(pane),
          t: 'input.text',
          ts: Date.now(),
          text: typed.get(pane.label)!,
        });
      }),
    );

    const afterType = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e === `V:${typed.get(p.label)!}`, 30_000)),
    );
    expect(
      panes.filter((_, i) => afterType[i] === undefined).map((p) => p.label),
      'panes whose typed text never arrived',
    ).toEqual([]);

    // Isolation, asserted rather than assumed: no pane's report band
    // carries any other pane's text.
    const echoes = await Promise.all(
      panes.map(async (p) => [p.label, (await readEcho(p)) ?? ''] as const),
    );
    for (const [label, echo] of echoes) {
      for (const [otherLabel, otherText] of typed) {
        if (otherLabel === label) continue;
        expect(echo, `${label} leaked ${otherLabel}'s text`).not.toContain(otherText);
      }
    }

    // ---------------------------------------------------------------
    // 2. A real KEY event on every pane at once.
    //
    // Backspace travels the `input.key` down/up path, CDP `keyDown` with
    // the headless empty-text deadlock defence on it, not
    // `Input.insertText`. One character shorter is the proof.
    // ---------------------------------------------------------------
    await Promise.all(
      panes.map(async (pane) => {
        const base = inputBase(pane);
        pane.client.sendInput({
          ...base,
          t: 'input.key',
          ts: Date.now(),
          kind: 'down',
          key: 'Backspace',
          code: 'Backspace',
          modifiers: 0,
        });
        await sleep(25);
        pane.client.sendInput({
          ...base,
          t: 'input.key',
          ts: Date.now(),
          kind: 'up',
          key: 'Backspace',
          code: 'Backspace',
          modifiers: 0,
        });
      }),
    );

    const afterBackspace = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e === `V:${typed.get(p.label)!.slice(0, -1)}`, 25_000)),
    );
    expect(
      panes.filter((_, i) => afterBackspace[i] === undefined).map((p) => p.label),
      'panes where the Backspace key event never landed',
    ).toEqual([]);

    // ---------------------------------------------------------------
    // 3. TEXT SELECTION on every pane at once.
    //
    // A triple click is what Chrome turns into a paragraph selection.
    // This is a genuine multi-event gesture (move, down, up, three
    // times, with a rising clickCount) surviving nine-way concurrency,
    // not one synthetic event.
    // ---------------------------------------------------------------
    await Promise.all(
      panes.map(async (pane) => {
        const [x, y] = markerPoint(pane);
        await click(pane, x, y, 1);
        await sleep(50);
        await click(pane, x, y, 2);
        await sleep(50);
        await click(pane, x, y, 3);
      }),
    );

    const afterSelect = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e === `S:${MARKER}`, 30_000)),
    );
    expect(
      panes.filter((_, i) => afterSelect[i] === undefined).map((p) => p.label),
      'panes where the text selection never took',
    ).toEqual([]);

    // ---------------------------------------------------------------
    // 4. NAVIGATE, all nine at once, each to its own distinct URL.
    //
    // Every one of these is `BrowserGlassClient.navigate()`, the call an
    // application actually makes (through `useNav().goto`), resolving on
    // its own correlated `nav.state` reply.
    // ---------------------------------------------------------------
    const navStates = await Promise.all(
      panes.map((p) => p.client.navigate(p.targetId, fixture.pageUrl(`nav-${p.label}`))),
    );
    for (const [i, state] of navStates.entries()) {
      const pane = panes[i]!;
      // The reply is correlated to the pane that asked, not to whichever
      // of nine concurrent navigations happened to answer first.
      expect(state.targetId, `${pane.label} got another target's nav.state`).toBe(pane.targetId);
      expect(state.url).toContain(`nav-${pane.label}`);
    }

    const afterNav = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e === `READY:nav-${p.label}`, 30_000)),
    );
    expect(
      panes.filter((_, i) => afterNav[i] === undefined).map((p) => p.label),
      'panes that never reached their own new page',
    ).toEqual([]);

    // Each tab's own reported URL carries its own label and no other's.
    for (const pane of panes) {
      const tab = await tabOf(pane);
      expect(tab?.url, `${pane.label} navigated somewhere unexpected`).toContain(
        `nav-${pane.label}`,
      );
    }

    // ---------------------------------------------------------------
    // 5. STOP, all nine at once.
    //
    // Each pane starts a navigation whose load genuinely cannot finish
    // (see `slowPage`), waits until its report band confirms the page
    // has committed and is stuck in `readyState: loading`, then stops
    // it. Stopping finishes the document, so the band flips to
    // `readyState: complete`. That flip is the proof the stop reached
    // this tab and did the thing stopping is for.
    // ---------------------------------------------------------------
    await Promise.all(panes.map((p) => p.client.navigate(p.targetId, fixture.slowUrl(p.label))));

    const stuck = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e === `RS:loading:${p.label}`, 40_000)),
    );
    expect(
      panes.filter((_, i) => stuck[i] === undefined).map((p) => p.label),
      'panes that never got stuck mid-load, so stop had nothing to interrupt',
    ).toEqual([]);

    await Promise.all(panes.map((p) => p.client.stopLoading(p.targetId)));

    const stopped = await Promise.all(
      panes.map((p) => echoUntil(p, (e) => e === `RS:complete:${p.label}`, 40_000)),
    );
    expect(
      panes.filter((_, i) => stopped[i] === undefined).map((p) => p.label),
      'panes still loading after nav.stop',
    ).toEqual([]);

    // ---------------------------------------------------------------
    // 6. RESTART every browser at once.
    //
    // Three real Chrome processes torn down and relaunched
    // concurrently, with three live sockets watching. Each client's
    // `restart()` resolves on its own instance's `instance.recovered`,
    // so a crossed correlation between two simultaneous restarts fails
    // here.
    // ---------------------------------------------------------------
    const restarts = await Promise.all(
      clients.map((c) => c.restart({ reason: 'conformance parallel restart', timeoutMs: 120_000 })),
    );
    for (const [i, r] of restarts.entries()) {
      expect(r.initiated, `instance ${i} did not initiate its own restart`).toBe(true);
    }

    // Every instance is genuinely usable again: each client still lists
    // its own tabs, and can navigate one of them to a fresh page whose
    // report band comes back. A blank, wedged session fails here.
    const revived = await Promise.all(
      clients.map(async (client, i) => {
        const tabs = await until(
          async () => {
            const list = await client.tabs.list();
            return list.length > 0 ? list : undefined;
          },
          90_000,
          500,
        );
        if (tabs === undefined) return undefined;

        const targetId = tabs[0]!.targetId;
        await client.requestControl(targetId).catch(() => undefined);
        await client.navigate(targetId, fixture.pageUrl(`revived-${i}`));
        const stream = await client.subscribe(targetId);
        const pane: Pane = {
          label: `revived-${i}`,
          instanceIndex: i,
          instanceId: panes.find((p) => p.client === client)!.instanceId,
          client,
          targetId,
          stream,
          fw: stream.width,
          fh: stream.height,
          gen: stream.gen,
        };
        return echoUntil(pane, (e) => e === `READY:revived-${i}`, 40_000);
      }),
    );
    expect(
      revived.map((r, i) => (r === undefined ? i : null)).filter((x) => x !== null),
      'instances that never came back usable after a simultaneous restart',
    ).toEqual([]);

    // ---------------------------------------------------------------
    // Teardown. This file's single case owns all three instances, so
    // they are released here rather than in an `afterEach`.
    // ---------------------------------------------------------------
    for (const c of clients) c.destroy();
    await Promise.all(
      [...new Set(panes.map((p) => p.instanceId))].map((id) => gateway.releaseInstance(id)),
    );
  }, 900_000);
});

describe('attachment granularity matrix: several clients per browser, and tabs and instances starting and stopping under load', () => {
  it('two independent clients driving two different tabs of the SAME Chrome, plus a third client on a different Chrome, all typing at the same moment, stay completely isolated', async () => {
    // One browser, two viewers. This is the requirement's "different clients on
    // different tabs of the same browser", the combination nothing else
    // in this package covers: two sockets, two `ManagedSession` viewers,
    // one `Instance`, one `CdpBridge`, two independent control leases.
    const shared = await gateway.acquireInstance();
    const other = await gateway.acquireInstance();

    const [clientA, clientB, clientC] = await Promise.all([
      gateway.makeClient(shared.instanceId),
      gateway.makeClient(shared.instanceId),
      gateway.makeClient(other.instanceId),
    ]);
    await Promise.all([clientA!.connect(), clientB!.connect(), clientC!.connect()]);

    // Both viewers of the shared instance see the same browser.
    expect(clientA!.instance?.instanceId).toBe(clientB!.instance?.instanceId);
    expect(clientA!.viewerId).not.toBe(clientB!.viewerId);

    // A second tab on the shared browser, so A and B have one each.
    const secondTab = await clientA!.tabs.new({
      url: fixture.pageUrl('shared-b'),
      background: true,
    });
    const sharedTabs = await clientA!.tabs.list();
    const tabForA = sharedTabs.find((t) => t.targetId !== secondTab.targetId)!.targetId;
    const tabForB = secondTab.targetId;
    const tabForC = clientC!.targets[0]!.targetId;

    // The second viewer of the same browser must learn about a tab it did
    // not open, without asking. `client.targets` is fed purely by
    // `welcome.targets` plus `target.created`/`.closed` broadcasts, so
    // this is a direct read of whether the session fans tab lifecycle out
    // to every viewer or only answers whoever asked.
    const bSawTheNewTab = await until(
      async () => (clientB!.targets.some((t) => t.targetId === tabForB) ? true : undefined),
      15_000,
      200,
    );
    expect(
      bSawTheNewTab,
      'the second viewer was never told about a tab the first viewer opened',
    ).toBe(true);

    async function attach(
      client: BrowserGlassClient,
      targetId: string,
      label: string,
      instanceId: InstanceId,
      index: number,
    ): Promise<Pane> {
      const outcome = await client.requestControl(targetId);
      if (!outcome.granted)
        throw new Error(`control not granted on ${label}: ${JSON.stringify(outcome)}`);
      await client.navigate(targetId, fixture.pageUrl(label));
      const stream = await client.subscribe(targetId);
      return {
        label,
        instanceIndex: index,
        instanceId,
        client,
        targetId,
        stream,
        fw: stream.width,
        fh: stream.height,
        gen: stream.gen,
      };
    }

    const paneA = await attach(clientA!, tabForA, 'viewerA', shared.instanceId, 0);
    const paneB = await attach(clientB!, tabForB, 'viewerB', shared.instanceId, 0);
    const paneC = await attach(clientC!, tabForC, 'viewerC', other.instanceId, 1);
    const trio = [paneA, paneB, paneC];

    // Two leases on two tabs of one browser are both held at once: taking
    // one did not preempt the other.
    expect(clientA!.hasControl(tabForA)).toBe(true);
    expect(clientB!.hasControl(tabForB)).toBe(true);

    const ready = await Promise.all(
      trio.map((p) => echoUntil(p, (e) => e === `READY:${p.label}`, 30_000)),
    );
    expect(trio.filter((_, i) => ready[i] === undefined).map((p) => p.label)).toEqual([]);

    // All three type at the same instant, two of them into the same
    // browser process.
    const trioText = new Map(trio.map((p) => [p.label, `FROM-${p.label.toUpperCase()}`]));
    await Promise.all(
      trio.map(async (pane) => {
        const [x, y] = boxPoint(pane);
        await click(pane, x, y);
        pane.client.sendInput({
          ...inputBase(pane),
          t: 'input.text',
          ts: Date.now(),
          text: trioText.get(pane.label)!,
        });
      }),
    );

    const landed = await Promise.all(
      trio.map((p) => echoUntil(p, (e) => e === `V:${trioText.get(p.label)!}`, 30_000)),
    );
    expect(
      trio.filter((_, i) => landed[i] === undefined).map((p) => p.label),
      "panes that never received their own viewer's text",
    ).toEqual([]);

    // The isolation that matters most here: A and B share one Chrome, so
    // a bug that routed input per instance instead of per target would
    // show up as B's text in A's tab, and would be invisible in any test
    // that only ever ran one viewer per browser.
    for (const pane of trio) {
      const echo = (await readEcho(pane)) ?? '';
      for (const [otherLabel, otherText] of trioText) {
        if (otherLabel === pane.label) continue;
        expect(echo, `${pane.label} received ${otherLabel}'s text`).not.toContain(otherText);
      }
    }

    // ---------------------------------------------------------------
    // Tab close, concurrently, from two viewers of the same browser.
    // Closing B's tab must leave A's alone and must be visible to both
    // viewers, since the target list is a property of the Instance and
    // not of whoever asked.
    // ---------------------------------------------------------------
    await clientB!.tabs.close(tabForB);

    // `TargetRegistry.close()` awaits only `Target.closeTarget`'s own CDP
    // ack, never the later `Target.targetDestroyed` that actually drops
    // the row, so this is polled rather than asserted on the next call.
    // The assertion is on the closed tab's id specifically, not on a
    // count: a real Chrome may open or retire other targets of its own
    // (a new-tab page, an extension page) while this runs, and a count
    // would make those a spurious failure.
    const goneForA = await until(
      async () => {
        const tabs = await clientA!.tabs.list();
        return !tabs.some((t) => t.targetId === tabForB) && tabs.some((t) => t.targetId === tabForA)
          ? tabs
          : undefined;
      },
      20_000,
      300,
    );
    expect(
      goneForA,
      'the other viewer of the same browser never saw the closed tab disappear',
    ).toBeDefined();

    // And it reached that viewer's own pushed target list too, not just
    // the list it can ask for.
    const closeBroadcastSeen = await until(
      async () => (clientA!.targets.some((t) => t.targetId === tabForB) ? undefined : true),
      15_000,
      200,
    );
    expect(closeBroadcastSeen, 'the other viewer never received the target.closed broadcast').toBe(
      true,
    );

    // A's own tab survived its neighbour closing, and still takes input.
    const stillAlive = await echoUntil(paneA, (e) => e === `V:${trioText.get('viewerA')!}`, 20_000);
    expect(stillAlive, 'closing one tab disturbed another tab of the same browser').toBeDefined();

    // ---------------------------------------------------------------
    // Instance stop and start, while the other browser keeps working.
    // Releasing an Instance is what an application calls when a user is
    // done; acquiring is what it calls next. Doing both while a
    // completely separate browser is mid-session is the check that
    // neither is a process-wide operation.
    // ---------------------------------------------------------------
    clientA!.destroy();
    clientB!.destroy();
    await gateway.releaseInstance(shared.instanceId);

    const restarted = await gateway.acquireInstance();
    expect(restarted.instanceId).not.toBe(shared.instanceId);

    const clientD = await gateway.makeClient(restarted.instanceId);
    await clientD.connect();
    const paneD = await attach(
      clientD,
      clientD.targets[0]!.targetId,
      'afterstart',
      restarted.instanceId,
      2,
    );
    const freshReady = await echoUntil(paneD, (e) => e === 'READY:afterstart', 30_000);
    expect(freshReady, 'a freshly acquired instance was not usable').toBeDefined();

    // And the untouched browser was never disturbed by any of it.
    const survivor = await echoUntil(paneC, (e) => e === `V:${trioText.get('viewerC')!}`, 20_000);
    expect(
      survivor,
      'releasing and acquiring other instances disturbed an unrelated one',
    ).toBeDefined();

    clientC!.destroy();
    clientD.destroy();
    await Promise.all([
      gateway.releaseInstance(other.instanceId),
      gateway.releaseInstance(restarted.instanceId),
    ]);
  }, 900_000);

  /**
   * The same multi-viewer guarantee the case above proves, on a browser
   * the router handed back by STICKY REUSE rather than one it had just
   * launched.
   *
   * This is an extension of that case rather than a copy of it, and it is
   * here rather than in a file of its own for exactly that reason: the
   * helpers, the fixture pages and the isolation assertions are the ones
   * directly above, and duplicating them somewhere else would let the two
   * drift. What is new is only where the instance came from.
   *
   * Why that distinction is worth a case at all: browser affinity means a
   * returning user's browser is, by design, never freshly launched. A
   * second viewer arriving at a reattached instance takes a different path
   * into the gateway from one arriving at a cold launch, since the
   * instance already has a live session, an existing `CdpBridge`, an
   * existing target list, and possibly another viewer already on it. "Two
   * users collaborate on the same browsers" is the half of the requirement
   * that only exists once reuse does.
   */
  it('two viewers collaborate on one browser they reached by sticky reuse, each driving its own tab, with no second Chrome launched', async () => {
    const subject = 'collab:user';
    const sticky = { subject };

    // The demo's own request shape, twice: an ephemeral profile with
    // `sticky` beside it, and `subject` set so the router stamps the
    // instance row with the value `sticky.subject` is later matched
    // against. `sticky-affinity.test.ts` owns the proof of that mechanism
    // in isolation; this case depends on it and re-checks the one fact it
    // is about to build on.
    const firstVisit = await gateway.acquireInstance({ subject, sticky });
    // Pids, not a count. Earlier cases in this file release instances, and
    // a Chrome terminating on its own schedule would move a count DOWN in
    // the middle of this one; a set difference measures the launch, which
    // is the property, and is indifferent to deaths.
    const pidsAfterLaunch = new Set(
      chromeMainProcessesUnder(gateway.profileRoot).map((p) => p.pid),
    );
    const newChromePids = (): number[] =>
      chromeMainProcessesUnder(gateway.profileRoot)
        .map((p) => p.pid)
        .filter((pid) => !pidsAfterLaunch.has(pid));
    const returning = await gateway.acquireInstance({ subject, sticky });

    expect(returning.instanceId).toBe(firstVisit.instanceId);
    expect(returning.reuseReason).toBe('sticky');
    expect(
      newChromePids(),
      'the returning visit launched a second real Chrome instead of reattaching',
    ).toEqual([]);

    // Two independent sockets, two viewers, one reattached Instance.
    const [viewerOne, viewerTwo] = await Promise.all([
      gateway.makeClient(returning.instanceId),
      gateway.makeClient(returning.instanceId),
    ]);
    await Promise.all([viewerOne!.connect(), viewerTwo!.connect()]);
    expect(viewerOne!.instance?.instanceId).toBe(viewerTwo!.instance?.instanceId);
    expect(viewerOne!.viewerId).not.toBe(viewerTwo!.viewerId);

    const secondTab = await viewerOne!.tabs.new({
      url: fixture.pageUrl('collab-two'),
      background: true,
    });
    const tabs = await viewerOne!.tabs.list();
    const tabForOne = tabs.find((t) => t.targetId !== secondTab.targetId)!.targetId;
    const tabForTwo = secondTab.targetId;

    // The second viewer of a REATTACHED instance learns about a tab it did
    // not open. On a cold launch both viewers arrive before any tab
    // exists; here the instance was already up, so this is the broadcast
    // path rather than the `welcome` snapshot.
    const twoSawTheTab = await until(
      async () => (viewerTwo!.targets.some((t) => t.targetId === tabForTwo) ? true : undefined),
      15_000,
      200,
    );
    expect(
      twoSawTheTab,
      "the second viewer of a reattached instance never learned about the other viewer's tab",
    ).toBe(true);

    async function attachTo(
      client: BrowserGlassClient,
      targetId: string,
      label: string,
    ): Promise<Pane> {
      const outcome = await client.requestControl(targetId);
      if (!outcome.granted)
        throw new Error(`control not granted on ${label}: ${JSON.stringify(outcome)}`);
      await client.navigate(targetId, fixture.pageUrl(label));
      const stream = await client.subscribe(targetId);
      return {
        label,
        instanceIndex: 0,
        instanceId: returning.instanceId,
        client,
        targetId,
        stream,
        fw: stream.width,
        fh: stream.height,
        gen: stream.gen,
      };
    }

    const paneOne = await attachTo(viewerOne!, tabForOne, 'collabOne');
    const paneTwo = await attachTo(viewerTwo!, tabForTwo, 'collabTwo');
    const pair = [paneOne, paneTwo];

    // Both leases are held at the same time. Taking one did not preempt
    // the other, which is what "both drive" means under the normal control
    // lease rules: one lease per target, not one per instance.
    expect(viewerOne!.hasControl(tabForOne)).toBe(true);
    expect(viewerTwo!.hasControl(tabForTwo)).toBe(true);

    const ready = await Promise.all(
      pair.map((p) => echoUntil(p, (e) => e === `READY:${p.label}`, 30_000)),
    );
    expect(pair.filter((_, i) => ready[i] === undefined).map((p) => p.label)).toEqual([]);

    // Both viewers type at the same instant, into the same Chrome.
    const text = new Map(pair.map((p) => [p.label, `FROM-${p.label.toUpperCase()}`]));
    await Promise.all(
      pair.map(async (pane) => {
        const [x, y] = boxPoint(pane);
        await click(pane, x, y);
        pane.client.sendInput({
          ...inputBase(pane),
          t: 'input.text',
          ts: Date.now(),
          text: text.get(pane.label)!,
        });
      }),
    );

    const landed = await Promise.all(
      pair.map((p) => echoUntil(p, (e) => e === `V:${text.get(p.label)!}`, 30_000)),
    );
    expect(
      pair.filter((_, i) => landed[i] === undefined).map((p) => p.label),
      "panes that never received their own viewer's text on a reattached instance",
    ).toEqual([]);

    // And neither viewer's input leaked into the other's tab.
    for (const pane of pair) {
      const echo = (await readEcho(pane)) ?? '';
      for (const [otherLabel, otherText] of text) {
        if (otherLabel === pane.label) continue;
        expect(echo, `${pane.label} received ${otherLabel}'s text`).not.toContain(otherText);
      }
    }

    // Still the same one browser at the end of all of it: two viewers
    // connecting, opening a tab, taking leases and driving never caused
    // another launch.
    expect(newChromePids()).toEqual([]);

    viewerOne!.destroy();
    viewerTwo!.destroy();
    await gateway.releaseInstance(returning.instanceId);
  }, 600_000);
});
