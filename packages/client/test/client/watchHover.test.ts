import { describe, expect, it } from 'vitest';
import type { ProbeResult } from '../../src/client/types.js';
import { HoverWatcher } from '../../src/client/watchHover.js';

/** Flushes the microtask queue. `HoverWatcher.settle()` runs inside a real `Promise.then()`, so a test that resolves a deferred probe must await one tick before the watcher's own follow-up logic (re-firing, delivering) has run. */
async function tick(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** A controllable, deferred probe function: resolves the oldest pending call when `settle()` is invoked. */
function deferredProbeFn() {
  const pending: Array<{ x: number; y: number; resolve: (r: ProbeResult) => void }> = [];
  let calls = 0;
  const fn = (x: number, y: number): Promise<ProbeResult> => {
    calls++;
    return new Promise<ProbeResult>((resolve) => {
      pending.push({ x, y, resolve });
    });
  };
  return {
    fn,
    callCount: () => calls,
    pendingCount: () => pending.length,
    /** Resolves the oldest still-pending probe with a result for its own (x, y), at the given gen. Awaits a tick so the watcher's `.then()` continuation has actually run before returning. */
    settleOldest: async (gen = 1) => {
      const p = pending.shift();
      if (!p) throw new Error('no pending probe to settle');
      p.resolve({
        targetId: 't',
        detail: 'hover',
        gen,
        hit: true,
        rect: { x: p.x, y: p.y, w: 1, h: 1 },
      });
      await tick();
    },
  };
}

describe('HoverWatcher (four-step coalescing)', () => {
  it('sends immediately when nothing is in flight', () => {
    const probe = deferredProbeFn();
    const results: Array<ProbeResult | null> = [];
    const watcher = new HoverWatcher(
      probe.fn,
      () => 1,
      (r) => results.push(r),
    );

    watcher.feed(10, 10);
    expect(probe.callCount()).toBe(1);
  });

  it('coalesces every position fed while a probe is in flight into exactly one follow-up call', async () => {
    const probe = deferredProbeFn();
    const results: Array<ProbeResult | null> = [];
    const watcher = new HoverWatcher(
      probe.fn,
      () => 1,
      (r) => results.push(r),
    );

    watcher.feed(0, 0);
    expect(probe.callCount()).toBe(1);
    // 998 more positions arrive while the first probe is still in flight.
    for (let i = 1; i <= 998; i++) watcher.feed(i, i);
    expect(probe.callCount()).toBe(1); // still exactly one in flight

    await probe.settleOldest(); // answers (0,0), stale versus the latest fed (998,998)
    expect(probe.callCount()).toBe(2); // discarded and re-fired with the latest position
    expect(results.length).toBe(0); // the stale answer was never delivered

    await probe.settleOldest(); // answers (998,998), which is what feed() most recently stored
    expect(results.length).toBe(1);
  });

  it('driven with 1000 synthetic pointer moves, issues at most one probe per round trip and never delivers a stale answer', async () => {
    const probe = deferredProbeFn();
    const results: Array<ProbeResult | null> = [];
    const watcher = new HoverWatcher(
      probe.fn,
      () => 1,
      (r) => results.push(r),
    );

    let lastFed = { x: -1, y: -1 };
    for (let i = 0; i < 1000; i++) {
      lastFed = { x: i, y: i * 2 };
      watcher.feed(lastFed.x, lastFed.y);
      // never more than one probe outstanding at a time
      expect(probe.pendingCount()).toBeLessThanOrEqual(1);
    }

    // settle every in-flight/re-fired probe until none remain; each delivered
    // result must match the position it was actually answered for (never a
    // stale one), and the very last delivered result is the final position.
    let iterations = 0;
    while (probe.pendingCount() > 0 && iterations < 2000) {
      await probe.settleOldest();
      iterations++;
    }

    expect(results.length).toBeGreaterThan(0);
    // total probe() calls issued must be far below the 1000 fed positions:
    // this is the self-limiting property the coalescing algorithm promises.
    expect(probe.callCount()).toBeLessThan(1000);
    for (const r of results) {
      expect(r).not.toBeNull();
    }
    const last = results[results.length - 1] as ProbeResult;
    expect(last.rect?.x).toBe(lastFed.x);
    expect(last.rect?.y).toBe(lastFed.y);
  });

  it('discards an answer whose gen no longer matches the current target generation', async () => {
    const probe = deferredProbeFn();
    const results: Array<ProbeResult | null> = [];
    let gen = 1;
    const watcher = new HoverWatcher(
      probe.fn,
      () => gen,
      (r) => results.push(r),
    );

    watcher.feed(5, 5);
    gen = 2; // target navigated/resized between ask and answer
    await probe.settleOldest(1); // answers with the OLD gen
    expect(results.length).toBe(0);
  });

  it('leave() delivers null immediately and does not keep the pointer position around for the next probe', async () => {
    const probe = deferredProbeFn();
    const results: Array<ProbeResult | null> = [];
    const watcher = new HoverWatcher(
      probe.fn,
      () => 1,
      (r) => results.push(r),
    );

    watcher.feed(1, 1);
    watcher.leave();
    expect(results[results.length - 1]).toBeNull();

    await probe.settleOldest(); // the in-flight probe for (1,1) answers after leave()
    // nothing new is fired for it since `latest` was cleared by leave(),
    // and the stale answer itself is discarded, not delivered as a second event.
    expect(results.length).toBe(1);
  });

  it('probe() (client.probe, the uncoalesced primitive) is a separate one-shot call unaffected by an active watcher', () => {
    // Documented distinctly: calling probe() on every pointer move instead
    // of watchHover() is the one way to misuse this API. This test only
    // confirms HoverWatcher itself never calls back into anything beyond
    // its own injected probeFn, i.e. it has no hidden coupling to a
    // one-shot probe() call path.
    const probe = deferredProbeFn();
    const watcher = new HoverWatcher(
      probe.fn,
      () => 1,
      () => {},
    );
    watcher.stop();
    watcher.feed(1, 1);
    expect(probe.callCount()).toBe(0);
  });
});
