import { Transport, type TransportHelloOptions } from '@browserglass/client';
import { type Envelope, type InstanceId, decodeBinaryHeader } from '@browserglass/protocol';
/**
 * Regression coverage for a reply gap: `packages/server/src/ws/connection.ts`'s `target.close` and
 * `target.activate` handlers never called `sendEnvelope` at all, so
 * `BrowserGlassClient.tabs.close()`/`.activate()` and `AutomationClient`'s
 * own `tabs.close()`/`.activate()` (both built on `request()`, which
 * correlates a reply purely by `m.re === id`, discarding the reply's own
 * `t`) hung forever against a real gateway. The fix adds a direct, `Connection.replyTo()` correlated reply
 * to both handlers: `target.close` answers with `target.closed`
 * (`reason: 'user'`), reusing the existing broadcast-shaped type as a
 * direct reply exactly the way `target.new` already answers with
 * `target.created`; `target.activate` answers with `target.updated`
 * (`changed: { active: true }`), since no dedicated `target.activated`
 * type exists in `protocol`.
 *
 * This file verifies two things against a real gateway and real Chrome,
 * not just that a reply arrives:
 *
 * 1. `target.activate` actually promotes the target to the Instance's one
 *    live-screencast target (`TargetActivationPolicy`): counting real `Target.activateTarget` CDP commands (the same
 *    `globalThis.WebSocket`-wrapping technique
 *    `chaos-7-subscribe-loop.test.ts` uses for `Page.startScreencast`)
 *    confirms the policy really called Chrome, not just that the wire
 *    reply looked right; a fast frame after a click on the newly promoted
 *    target (well under `ScreenshotPollSource`'s 1500ms supplement
 *    cadence, `packages/core/src/stream/screenshot-poll-source.ts`)
 *    confirms it is really the screencast-backed target now, not merely
 *    marked active on paper.
 * 2. `target.close` actually closes the real tab: a `target.list` sent
 *    right after confirms the closed target is gone.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

const HELLO: TransportHelloOptions = {
  client: { name: 'conformance', version: '0.0.0', runtime: 'node' },
  capabilities: {
    codecs: ['jpeg'],
    binaryFrames: true,
    input: ['mouse', 'key', 'text', 'touch', 'scroll'],
  },
  viewport: { width: 1280, height: 720, dpr: 1, visible: true, fitMode: 'contain' },
};

/** Every outbound `Target.activateTarget` CDP command, counted by wrapping `globalThis.WebSocket` for this file's duration only, exactly as `chaos-7-subscribe-loop.test.ts` already does for `Page.startScreencast`; see that file's own module doc for why this is the one available seam. */
const RealWebSocketCtor = globalThis.WebSocket;
let activateTargetCdpCount = 0;

class CountingWebSocket extends RealWebSocketCtor {
  override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string' && data.includes('"Target.activateTarget"')) {
      activateTargetCdpCount += 1;
    }
    super.send(data);
  }
}

let gateway: RealGateway;

beforeAll(async () => {
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
    CountingWebSocket as unknown as typeof WebSocket;
  gateway = await startRealGateway({ headless: 'new' });
}, 120_000);

afterAll(async () => {
  await gateway.close();
  (globalThis as { WebSocket: typeof WebSocket }).WebSocket = RealWebSocketCtor;
}, 60_000);

const acquiredThisTest: InstanceId[] = [];

afterEach(async () => {
  for (const instanceId of acquiredThisTest.splice(0)) {
    await gateway.releaseInstance(instanceId);
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

/** A self-contained, offline, distinctly colored clickable page, the same pattern `bgls doctor --deep` (`packages/cli/src/doctor/deep.ts`) uses to confirm a click produces a new screencast frame. */
function colorPageUrl(color: string): string {
  return `data:text/html,${encodeURIComponent(
    `<!doctype html><html><body style="margin:0;width:100vw;height:100vh;background:${color}" onclick="document.body.style.background='#000000'"></body></html>`,
  )}`;
}

/** Resolves with the first message on `transport` whose `re` equals `id`. Rejects on timeout: exactly what target.close/target.activate looked like before the fix, a hang, never a rejection from the server itself. */
function awaitReplyOn(transport: Transport, id: string, timeoutMs = 10_000): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no reply carrying re="${id}" arrived within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = transport.on('message', (m) => {
      if (m.re !== id) return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

/** Resolves with the first message on `transport` matching `predicate`. Used for `nav.state`, which is a broadcast with no `re` (a known, deliberately unfixed gap), so it cannot be awaited via `awaitReplyOn`. */
function awaitMessage(
  transport: Transport,
  predicate: (m: Envelope) => boolean,
  timeoutMs = 10_000,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no matching message arrived within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = transport.on('message', (m) => {
      if (!predicate(m)) return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `req_${prefix}_${idCounter}_${Math.random().toString(36).slice(2)}`;
}

describe('target.close and target.activate get a real, correlated reply and take real effect', () => {
  it('target.activate promotes the target to the live screencast pipeline (real Target.activateTarget, real fast frame delivery); target.close removes the real tab', async () => {
    const acquired = await gateway.acquireInstance();
    acquiredThisTest.push(acquired.instanceId);
    const token = await gateway.mintToken(acquired.instanceId);
    const transport = new Transport({
      url: gateway.wsUrl,
      token,
      autoReconnect: false,
      hello: HELLO,
      transport: { WebSocketImpl: WebSocket as never, allowInsecureTransport: true },
    });

    const frameArrivals = new Map<number, number[]>();
    transport.on('binary', (buf) => {
      const header = decodeBinaryHeader(buf);
      const arr = frameArrivals.get(header.streamId) ?? [];
      arr.push(Date.now());
      frameArrivals.set(header.streamId, arr);
      transport.send({
        v: 1,
        t: 'ack',
        ts: Date.now(),
        streamId: header.streamId,
        seq: header.seq,
      } as never);
    });

    const connected = new Promise<{ targets: readonly { targetId: string }[] }>((resolve) => {
      transport.once('connected', (info) => resolve(info.welcome));
    });
    await transport.connect();
    const welcome = await connected;
    const targetA = welcome.targets[0]?.targetId;
    if (!targetA) throw new Error('no targets reported after connect');

    // A second real tab, so this test has two real targets to activate
    // between.
    const idNew = nextId('new');
    const newPromise = awaitReplyOn(transport, idNew);
    transport.send({ v: 1, t: 'target.new', id: idNew, ts: Date.now(), background: true } as never);
    const created = await newPromise;
    expect(created.t).toBe('target.created');
    const targetB = (created as unknown as { target: { targetId: string } }).target.targetId;
    expect(targetB).not.toBe(targetA);

    /** Navigates `targetId` to a distinct color, requests control, and subscribes, returning everything a later `input.mouse` click on this target needs. */
    async function setUpTarget(
      targetId: string,
      color: string,
    ): Promise<{ streamId: number; gen: number; fw: number; fh: number; leaseId: string }> {
      const idCtl = nextId('ctl');
      const ctlPromise = awaitReplyOn(transport, idCtl);
      transport.send({ v: 1, t: 'control.request', id: idCtl, ts: Date.now(), targetId } as never);
      const granted = await ctlPromise;
      expect(granted.t).toBe('control.granted');
      const leaseId = (granted as unknown as { leaseId: string }).leaseId;

      const navPromise = awaitMessage(
        transport,
        (m) => m.t === 'nav.state' && (m as unknown as { targetId: string }).targetId === targetId,
      );
      transport.send({
        v: 1,
        t: 'nav.goto',
        ts: Date.now(),
        targetId,
        url: colorPageUrl(color),
      } as never);
      await navPromise;

      const idSub = nextId('sub');
      const subPromise = awaitReplyOn(transport, idSub);
      transport.send({ v: 1, t: 'stream.subscribe', id: idSub, ts: Date.now(), targetId } as never);
      const subscribed = await subPromise;
      expect(subscribed.t).toBe('stream.subscribed');
      const s = subscribed as unknown as {
        streamId: number;
        gen: number;
        width: number;
        height: number;
      };

      // The first frame is captured after the reply. Target B is a
      // background tab, and Chrome sometimes holds a background tab's
      // `Page.captureScreenshot` until the CDP command timeout (about
      // 4.5 s). Until the first frame moved after the reply, that wait
      // happened inside the subscribe and delayed the reply itself (this
      // test then waited up to 10 s for the reply), so the budget here
      // moves from the reply to the frame rather than shrinking.
      const gotFirstFrame = await waitUntil(
        () => (frameArrivals.get(s.streamId)?.length ?? 0) >= 1,
        10_000,
      );
      expect(gotFirstFrame).toBe(true);

      return { streamId: s.streamId, gen: s.gen, fw: s.width, fh: s.height, leaseId };
    }

    const a = await setUpTarget(targetA, '#c0392b');
    const b = await setUpTarget(targetB, '#27ae60');

    /** Clicks the center of `targetId`'s page and returns how long, in ms, until a new frame beyond `streamId`'s current count arrives. */
    async function clickAndMeasureFrameLatency(
      targetId: string,
      t: { streamId: number; gen: number; fw: number; fh: number; leaseId: string },
      timeoutMs: number,
    ): Promise<number> {
      const beforeCount = frameArrivals.get(t.streamId)?.length ?? 0;
      const x = Math.floor(t.fw / 2);
      const y = Math.floor(t.fh / 2);
      const inputBase = { v: 1, targetId, fw: t.fw, fh: t.fh, gen: t.gen, leaseId: t.leaseId };
      const clickStart = Date.now();
      transport.send({
        ...inputBase,
        t: 'input.mouse',
        ts: Date.now(),
        kind: 'down',
        x,
        y,
        button: 'left',
        buttons: 1,
        modifiers: 0,
        clickCount: 1,
      } as never);
      await sleep(50);
      transport.send({
        ...inputBase,
        t: 'input.mouse',
        ts: Date.now(),
        kind: 'up',
        x,
        y,
        button: 'left',
        buttons: 0,
        modifiers: 0,
        clickCount: 1,
      } as never);
      const gotFrame = await waitUntil(
        () => (frameArrivals.get(t.streamId)?.length ?? 0) > beforeCount,
        timeoutMs,
      );
      if (!gotFrame)
        throw new Error(`no new frame on target ${targetId} within ${timeoutMs}ms of the click`);
      return Date.now() - clickStart;
    }

    // `a` was subscribed first, so per `TargetActivationPolicy.ensureSubscribed`,
    // it is already the Instance's active (screencast) target: a
    // click should produce a fast frame, well under the 1500ms
    // `POLL_INTERVAL_SUPPLEMENT_MS` a background (poll) target would use.
    const latencyAWhileActive = await clickAndMeasureFrameLatency(targetA, a, 5000);
    expect(latencyAWhileActive).toBeLessThan(1200);

    const activateTargetCdpCountBefore = activateTargetCdpCount;

    // The regression this file exists to catch: before the fix,
    // `target.activate` never called `sendEnvelope` at all, so this next
    // line hung for the full 10s `awaitReplyOn` timeout and the test
    // failed there, never reaching the assertions below.
    const idActivate = nextId('activate');
    const activatePromise = awaitReplyOn(transport, idActivate);
    transport.send({
      v: 1,
      t: 'target.activate',
      id: idActivate,
      ts: Date.now(),
      targetId: targetB,
    } as never);
    const activateReply = await activatePromise;

    expect(activateReply.t).toBe('target.updated');
    expect(activateReply.re).toBe(idActivate);
    const activateFields = activateReply as unknown as {
      targetId: string;
      changed: { active: boolean };
    };
    expect(activateFields.targetId).toBe(targetB);
    expect(activateFields.changed).toEqual({ active: true });

    // Real effect, not just a well-shaped reply: `TargetActivationPolicy.activate()`
    // called Chrome's own `Target.activateTarget` exactly once for this
    // call, confirmed by counting the real outbound CDP command (the same
    // technique `chaos-7-subscribe-loop.test.ts` uses for `Page.startScreencast`).
    expect(activateTargetCdpCount).toBe(activateTargetCdpCountBefore + 1);

    // And `targetB` is now genuinely screencast-backed: a click produces a
    // fast frame, the same bound `targetA` met while it was active. (What
    // happens to `targetA`'s own frame delivery once demoted to
    // background/poll mode is `TargetActivationPolicy`/`ScreenshotPollSource`
    // territory the `target.activate` reply fix does not touch;
    // `managed?.activateTarget()` already ran that exact demotion path
    // before this fix too, since only the missing reply was new here, so
    // it is out of scope here and not asserted on.)
    await sleep(200); // lets the policy's stop/rebuild swap settle before measuring.
    const latencyBAfterActivate = await clickAndMeasureFrameLatency(targetB, b, 5000);
    expect(latencyBAfterActivate).toBeLessThan(1200);

    // target.close: the second half of the fix. Before it, this next
    // line hung the same way `target.activate` did above.
    const idClose = nextId('close');
    const closePromise = awaitReplyOn(transport, idClose);
    transport.send({
      v: 1,
      t: 'target.close',
      id: idClose,
      ts: Date.now(),
      targetId: targetB,
    } as never);
    const closeReply = await closePromise;

    expect(closeReply.t).toBe('target.closed');
    expect(closeReply.re).toBe(idClose);
    const closeFields = closeReply as unknown as { targetId: string; reason: string };
    expect(closeFields.targetId).toBe(targetB);
    expect(closeFields.reason).toBe('user');

    // Real effect: the closed target is actually gone from `target.list`.
    // `TargetRegistry.close()` (`packages/core/src/cdp/target-registry.ts`)
    // only awaits `Target.closeTarget`'s own CDP ack, not the later,
    // asynchronous `Target.targetDestroyed` event that actually drops the
    // target from its internal map; that gap is `TargetRegistry`'s own,
    // pre-existing eventual-consistency window, unrelated to the
    // reply fix, so this polls `target.list` briefly rather than asserting
    // on the very next call.
    async function fetchTargetIds(): Promise<string[]> {
      const idList = nextId('list');
      const listPromise = awaitReplyOn(transport, idList, 2000);
      transport.send({ v: 1, t: 'target.list', id: idList, ts: Date.now() } as never);
      const listReply = await listPromise;
      expect(listReply.t).toBe('target.listed');
      return (listReply as unknown as { targets: Array<{ targetId: string }> }).targets.map(
        (t) => t.targetId,
      );
    }

    let remainingIds: string[] = await fetchTargetIds();
    const deadline = Date.now() + 3000;
    while (remainingIds.includes(targetB) && Date.now() < deadline) {
      await sleep(150);
      remainingIds = await fetchTargetIds();
    }
    expect(remainingIds).not.toContain(targetB);
    expect(remainingIds).toContain(targetA);

    transport.destroy();
  }, 60_000);
});
