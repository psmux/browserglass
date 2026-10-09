import { describe, expect, it, vi } from 'vitest';
import { popCreatedBitmaps } from '../setup.js';
import { flushAsync, makeFrame, makeRenderer } from './testHelpers.js';

/**
 * Every discarded `ImageBitmap` must call `.close()`. There are exactly
 * four discard paths in `push()`/`pump()`/the paint callback, and each is
 * asserted directly here via `popCreatedBitmaps()`.
 */
describe('CanvasRenderer: ImageBitmap.close() on every discard path', () => {
  it('1: post-decode gen mismatch closes the bitmap', async () => {
    popCreatedBitmaps();
    vi.useFakeTimers();
    const { renderer } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    renderer.push(makeFrame({ seq: 1, gen16: 0, delayMs: 1000 }));
    renderer.reconfigure({ streamId: 1, gen: 1, width: 4, height: 4 });
    await vi.advanceTimersByTimeAsync(1000);
    const [bitmap] = popCreatedBitmaps();
    expect(bitmap).toBeDefined();
    expect(bitmap!.close).toHaveBeenCalledTimes(1);
    expect(renderer.stats.droppedStalePostDecode).toBe(1);
    expect(renderer.stats.framesPainted).toBe(0);
    renderer.destroy();
    vi.useRealTimers();
  });

  it('2: post-decode out-of-order completion closes the bitmap', async () => {
    popCreatedBitmaps();
    vi.useFakeTimers();
    const { renderer } = makeRenderer({ maxDecodeQueue: 2 });
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    // seq 2 decodes fast; seq 1 decodes slow and settles after seq 2 has
    // already painted, so it must be discarded (and closed) on arrival.
    renderer.push(makeFrame({ seq: 1, gen16: 0, delayMs: 100 }));
    renderer.push(makeFrame({ seq: 2, gen16: 0 }));
    await vi.advanceTimersByTimeAsync(10);
    expect(renderer.stats.framesPainted).toBe(1);
    expect(renderer.stats.lastPaintedSeq).toBe(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(renderer.stats.droppedStalePostDecode).toBe(1);
    expect(renderer.stats.framesPainted).toBe(1); // still just the one paint
    const bitmaps = popCreatedBitmaps();
    expect(bitmaps).toHaveLength(2);
    // seq 2 decodes first (no delay) and paints; seq 1 (delayed) resolves
    // second, after it is already stale, so it is the second bitmap
    // created and the one that must be closed rather than painted.
    expect(bitmaps[1]!.close).toHaveBeenCalledTimes(1);
    renderer.destroy();
    vi.useRealTimers();
  });

  it('3: a newer decoded bitmap replacing an undrawn nextBitmap closes the superseded one', async () => {
    popCreatedBitmaps();
    vi.useFakeTimers();
    const { renderer } = makeRenderer({ maxDecodeQueue: 2 });
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    // Freeze rAF so neither decoded bitmap gets painted before the second
    // decode completes and overwrites `nextBitmap`.
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    renderer.push(makeFrame({ seq: 1, gen16: 0 }));
    await vi.advanceTimersByTimeAsync(5);
    renderer.push(makeFrame({ seq: 2, gen16: 0 }));
    await vi.advanceTimersByTimeAsync(5);
    expect(renderer.stats.framesPainted).toBe(0);
    const bitmaps = popCreatedBitmaps();
    expect(bitmaps).toHaveLength(2);
    // seq 1's bitmap was superseded by seq 2's before either painted.
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1);
    expect(bitmaps[1]!.close).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
    renderer.destroy();
    vi.useRealTimers();
  });

  it('4: painting a new bitmap closes the previously retained one', async () => {
    popCreatedBitmaps();
    const { renderer } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    renderer.push(makeFrame({ seq: 1, gen16: 0 }));
    await flushAsync();
    renderer.push(makeFrame({ seq: 2, gen16: 0 }));
    await flushAsync();
    const bitmaps = popCreatedBitmaps();
    expect(bitmaps).toHaveLength(2);
    expect(bitmaps[0]!.close).toHaveBeenCalledTimes(1); // replaced as the retained bitmap
    expect(bitmaps[1]!.close).not.toHaveBeenCalled(); // still the retained one
    renderer.destroy();
    expect(bitmaps[1]!.close).toHaveBeenCalledTimes(1); // destroy() releases it too
  });
});
