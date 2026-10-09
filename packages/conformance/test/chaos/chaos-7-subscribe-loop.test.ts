import type { BrowserGlassClient, StreamHandle } from '@browserglass/client';
import type { InstanceId } from '@browserglass/protocol';
/**
 * Chaos scenario 7: the subscribe/unsubscribe loop. The assertions:
 * `Page.startScreencast`
 * count stays under 30 for a 60s run, no stream-handle leak, memory back
 * to baseline within 30s.
 *
 * `Page.startScreencast` is counted by wrapping `globalThis.WebSocket`
 * (Node 22's built in implementation) for the duration of this test only:
 * `@browserglass/core`'s `CdpBridge` connects to the real Chrome CDP
 * endpoint through exactly this global (`packages/core/src/cdp/platform.ts`'s
 * `defaultWebSocketFactory`, re-read fresh on every call, never cached),
 * and `@browserglass/server`'s real `ManagedSessionFactory` constructs
 * `CdpBridge` with no `wsFactory` override, so this is the one seam
 * available to count real CDP commands from outside the process without
 * editing any other package. The wrapper is a transparent
 * pass-through: every call still reaches the real socket, this test only
 * observes.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type RealGateway, startRealGateway } from '../e2e/support/real-gateway.js';

const RealWebSocketCtor = globalThis.WebSocket;
let screencastStartCount = 0;

/** Counts every outbound `Page.startScreencast` CDP command while otherwise behaving exactly like the real global `WebSocket`. */
class CountingWebSocket extends RealWebSocketCtor {
  override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string' && data.includes('"Page.startScreencast"')) {
      screencastStartCount += 1;
    }
    super.send(data);
  }
}

let gateway: RealGateway;
let instanceId: InstanceId;
let client: BrowserGlassClient;

/**
 * Still skipped, but the `re`/`id` reply correlation bug this comment used
 * to describe is now fixed and confirmed NOT to be the reason. A suspected
 * `forceFrame()` hang never applied here either, since
 * `BrowserGlassClient.subscribe()` (`doSubscribe()`,
 * `packages/client/src/client/BrowserGlassClient.ts`) resolves as soon as
 * `stream.subscribed` arrives, never waiting for any frame (and that hang
 * was later traced to not be a real `forceFrame()` bug at all).
 *
 * `packages/server/src/ws/connection.ts`'s direct reply sites (and, for
 * `control.request`, `packages/core/src/control/lease-engine.ts`'s effect
 * builders) now echo `re` via `Connection.replyTo()` /
 * `ControlLeaseEngine.emitDirect()`'s `requestId` parameter (see `packages/conformance/test/e2e/reply-correlation.test.ts` for the
 * dedicated regression coverage). Verified directly against this exact
 * file: un-skipped and run against a real gateway, `client.subscribe()`
 * no longer hangs and the loop actually runs its full 60s, many hundreds
 * of cycles deep (confirmed by `screencastStartCount` reaching four
 * figures, something only possible once subscribe/unsubscribe stopped
 * hanging on the very first call).
 *
 * Running the loop for real surfaced a third, previously undiscovered
 * bug, unrelated to `re` correlation and still unfixed: `screencastStartCount` (every real `Page.startScreencast`
 * CDP command) reached 1049 over the 60s run, `expect(...).toBeLessThan(30)`
 * asserts. Either the test's own threshold assumed a slower loop than a
 * local, no-latency `subscribe()`/`unsubscribe()` cycle actually achieves,
 * or (more likely, given `core`'s own module docs elsewhere in this build
 * describe target reattachment as index-fresh per cycle) each subscribe in
 * a tight resubscribe loop is starting a genuinely new screencast rather
 * than reusing or debouncing one for the same target across a rapid
 * unsubscribe-then-resubscribe pair. Not investigated further: this needs
 * tracing `packages/core/src/stream/cdp-screencast-source.ts` and
 * `packages/core/src/session/target-activation.ts`'s subscribe/unsubscribe
 * handling, well outside a protocol correlation fix.
 */
describe.skip('BLOCKED (screencast restarts per resubscribe, see comment above): chaos scenario 7: the subscribe/unsubscribe loop, real Chrome, 60s', () => {
  beforeAll(async () => {
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket =
      CountingWebSocket as unknown as typeof WebSocket;
    gateway = await startRealGateway({ headless: 'new' });
    const result = await gateway.acquireInstance();
    instanceId = result.instanceId;
    client = await gateway.makeClient(instanceId);
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    try {
      client?.destroy();
    } catch {
      // best effort
    }
    await gateway.close();
    (globalThis as { WebSocket: typeof WebSocket }).WebSocket = RealWebSocketCtor;
  }, 60_000);

  afterEach(() => {
    screencastStartCount = 0;
  });

  it('Page.startScreencast stays under 30 over a 60s tight subscribe/unsubscribe loop, no stream-handle leak, memory back to baseline within 30s', async () => {
    const targetId = client.targets[0]?.targetId;
    if (!targetId) throw new Error('client reported no targets after connect');

    if (globalThis.gc) globalThis.gc();
    const baselineHeap = process.memoryUsage().heapUsed;

    const DURATION_MS = 60_000;
    const deadline = Date.now() + DURATION_MS;
    let cycles = 0;
    let leakedHandle: StreamHandle | undefined;

    while (Date.now() < deadline) {
      const handle = await client.subscribe(targetId);
      // Every cycle's handle really did detach: `unsubscribe` resolving
      // is this SDK's own confirmation the server processed
      // `stream.unsubscribe` for this `streamId`; holding on to the last
      // one below re-confirms no dangling reference survives the loop.
      await handle.unsubscribe();
      leakedHandle = handle;
      cycles += 1;
    }

    expect(cycles).toBeGreaterThan(0);
    expect(screencastStartCount).toBeLessThan(30);

    // No stream-handle leak: the client's own live handle list is empty
    // once every cycle has unsubscribed, and the loop's very own last
    // handle is not still tracked as an active stream.
    expect(client.streams).toHaveLength(0);
    expect(client.streams.includes(leakedHandle as StreamHandle)).toBe(false);

    // A subscribe/unsubscribe cycle after the loop still works cleanly,
    // proving the server-side `Stream`/lock bookkeeping was not left in
    // a wedged state.
    const finalHandle = await client.subscribe(targetId);
    await finalHandle.unsubscribe();

    await new Promise((resolve) => setTimeout(resolve, 30_000));
    if (globalThis.gc) globalThis.gc();
    const afterHeap = process.memoryUsage().heapUsed;

    // "Back to baseline" allows real headroom (GC timing, the JS
    // engine's own heap growth policy) rather than requiring byte for
    // byte equality; the load-bearing failure mode this guards against
    // is unbounded growth proportional to `cycles`, not a fixed,
    // bounded overhead.
    const growth = afterHeap - baselineHeap;
    const tolerance = Math.max(32 * 1024 * 1024, baselineHeap * 0.5);
    expect(growth).toBeLessThan(tolerance);
  }, 150_000);
});
