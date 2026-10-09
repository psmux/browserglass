import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AckInfo } from '../../src/render/types.js';
import { flushAsync, makeFrame, makeRenderer } from './testHelpers.js';

describe('CanvasRenderer.push/pump', () => {
  let acks: AckInfo[];

  beforeEach(() => {
    acks = [];
  });

  function setup(options?: Parameters<typeof makeRenderer>[0]) {
    const rig = makeRenderer({ onAck: (info) => acks.push(info), ...options });
    rig.renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    return rig;
  }

  it('paints an accepted frame and acks after decode with measured decodeMs', async () => {
    const { renderer } = setup();
    renderer.push(makeFrame({ seq: 1, gen16: 0 }));
    await flushAsync();
    expect(renderer.stats.framesPainted).toBe(1);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.seq).toBe(1);
    expect(typeof acks[0]!.decodeMs).toBe('number');
    renderer.destroy();
  });

  it('drops a stale gen16 frame before any decode, and still acks it', async () => {
    const { renderer } = setup();
    // gen is 0 after reconfigure; gen16: 7 does not match.
    renderer.push(makeFrame({ seq: 1, gen16: 7 }));
    await flushAsync();
    expect(renderer.stats.droppedStaleGen).toBe(1);
    expect(renderer.stats.framesPainted).toBe(0);
    expect(acks).toEqual([{ seq: 1 }]);
    renderer.destroy();
  });

  it('drops a non-increasing seq on receipt, and still acks it', async () => {
    const { renderer } = setup();
    renderer.push(makeFrame({ seq: 5, gen16: 0 }));
    await flushAsync();
    acks.length = 0;
    renderer.push(makeFrame({ seq: 5, gen16: 0 }));
    await flushAsync();
    expect(renderer.stats.droppedOutOfOrder).toBe(1);
    expect(acks).toEqual([{ seq: 5 }]);
    renderer.destroy();
  });

  it('ignores frames for a different streamId, without acking (the owning renderer acks it)', async () => {
    const { renderer } = setup();
    renderer.push(makeFrame({ seq: 1, gen16: 0, streamId: 999 }));
    await flushAsync();
    expect(acks).toHaveLength(0);
    expect(renderer.stats.framesPainted).toBe(0);
    renderer.destroy();
  });

  it('a decode error still acks', async () => {
    const { renderer } = setup();
    renderer.push(makeFrame({ seq: 1, gen16: 0, reject: true }));
    await flushAsync();
    expect(renderer.stats.decodeErrors).toBe(1);
    expect(acks).toEqual([{ seq: 1 }]);
    renderer.destroy();
  });

  it('a decode not settled within decodeStuckMs is written off and still acks', async () => {
    vi.useFakeTimers();
    const { renderer } = setup({ decodeStuckMs: 50, onAck: (info) => acks.push(info) });
    // Never-resolving decode: a very long delay in the fake createImageBitmap.
    renderer.push(makeFrame({ seq: 1, gen16: 0, delayMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(60);
    expect(renderer.stats.decodeStuck).toBe(1);
    expect(acks).toEqual([{ seq: 1 }]);
    renderer.destroy();
    vi.useRealTimers();
  });

  describe('the 3-frames-then-stops regression', () => {
    it('every seq accepted from the wire is acked exactly once, even under sustained backpressure', async () => {
      // maxDecodeQueue 1 plus a slow decode forces every later push to
      // evict the pending slot before it is ever decoded. If eviction did
      // not ack, this is exactly the "stream runs 3 frames then silently
      // stops forever" bug: the server's cumulative backlog never clears.
      vi.useFakeTimers();
      const { renderer } = setup({ maxDecodeQueue: 1 });
      renderer.push(makeFrame({ seq: 1, gen16: 0, delayMs: 1000 }));
      renderer.push(makeFrame({ seq: 2, gen16: 0 }));
      renderer.push(makeFrame({ seq: 3, gen16: 0 }));
      renderer.push(makeFrame({ seq: 4, gen16: 0 }));
      renderer.push(makeFrame({ seq: 5, gen16: 0 }));
      await vi.advanceTimersByTimeAsync(1000);
      const ackedSeqs = acks.map((a) => a.seq).sort((a, b) => a - b);
      expect(ackedSeqs).toEqual([1, 2, 3, 4, 5]);
      renderer.destroy();
      vi.useRealTimers();
    });
  });

  it('pending-slot eviction acks the evicted, never-decoded frame (depth 1, newest wins)', async () => {
    vi.useFakeTimers();
    const { renderer } = setup({ maxDecodeQueue: 1 });
    // seq 1 occupies the in-flight decode slot with an artificial delay.
    renderer.push(makeFrame({ seq: 1, gen16: 0, delayMs: 1000 }));
    // seq 2 lands in `pending`.
    renderer.push(makeFrame({ seq: 2, gen16: 0 }));
    // seq 3 evicts seq 2 from `pending` before it was ever decoded.
    renderer.push(makeFrame({ seq: 3, gen16: 0 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(renderer.stats.droppedCoalesced).toBe(1);
    expect(acks.map((a) => a.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    renderer.destroy();
    vi.useRealTimers();
  });

  it('a post-decode gen change discards the frame and still acks it', async () => {
    vi.useFakeTimers();
    const { renderer } = setup();
    renderer.push(makeFrame({ seq: 1, gen16: 0, delayMs: 1000 }));
    // Bump the generation while the decode above is still in flight.
    renderer.reconfigure({ streamId: 1, gen: 1, width: 4, height: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(renderer.stats.droppedStalePostDecode).toBe(1);
    expect(renderer.stats.framesPainted).toBe(0);
    expect(acks).toEqual([{ seq: 1 }]);
    renderer.destroy();
    vi.useRealTimers();
  });

  it('respects maxDecodeQueue as the concurrency bound', async () => {
    vi.useFakeTimers();
    const { renderer } = setup({ maxDecodeQueue: 2 });
    renderer.push(makeFrame({ seq: 1, gen16: 0, delayMs: 1000 }));
    renderer.push(makeFrame({ seq: 2, gen16: 0, delayMs: 1000 }));
    // A third frame lands in the pending slot; only 2 decodes may run concurrently.
    renderer.push(makeFrame({ seq: 3, gen16: 0 }));
    await vi.advanceTimersByTimeAsync(10);
    // seq 1/2's decodes are still artificially delayed, so seq 3 (which has
    // no delay) cannot have been picked off the pending slot yet: the
    // concurrency bound, not just eventual delivery, is what is under test.
    expect(acks.length).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(acks.map((a) => a.seq).sort((a, b) => a - b)).toEqual([1, 2, 3]);
    renderer.destroy();
    vi.useRealTimers();
  });
});
