import { describe, expect, it, vi } from 'vitest';
import { flushAsync, makeFrame, makeRenderer } from './testHelpers.js';

describe('CanvasRenderer: paint scheduling', () => {
  it('resizes the canvas backing store to the painted bitmap and reapplies layout', async () => {
    const { renderer, canvas } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    renderer.push(makeFrame({ seq: 1, gen16: 0, width: 800, height: 600 }));
    await flushAsync();
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    renderer.destroy();
  });

  it('calls onPaint once per painted frame with seq/decodeMs/dims', async () => {
    const paints: Array<{ seq: number; width: number; height: number }> = [];
    const { renderer } = makeRenderer({ onPaint: (p) => paints.push(p) });
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    renderer.push(makeFrame({ seq: 1, gen16: 0, width: 10, height: 20 }));
    await flushAsync();
    expect(paints).toHaveLength(1);
    expect(paints[0]).toMatchObject({ seq: 1, width: 10, height: 20 });
    renderer.destroy();
  });

  it('coalesces multiple decodes settling within one animation frame into a single paint', async () => {
    vi.useFakeTimers();
    const { renderer } = makeRenderer({ maxDecodeQueue: 2 });
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    // Freeze rAF so both decodes land before the first paint fires.
    let rafCb: FrameRequestCallback | null = null;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((cb: FrameRequestCallback) => {
        rafCb = cb;
        return 1;
      }),
    );
    renderer.push(makeFrame({ seq: 1, gen16: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    renderer.push(makeFrame({ seq: 2, gen16: 0 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(renderer.stats.framesPainted).toBe(0);
    rafCb!(0);
    expect(renderer.stats.framesPainted).toBe(1);
    expect(renderer.stats.lastPaintedSeq).toBe(2);
    vi.unstubAllGlobals();
    renderer.destroy();
    vi.useRealTimers();
  });

  describe('the rAF self-heal guard', () => {
    it('does not schedule a second rAF within 1000ms of a still-pending one', async () => {
      vi.useFakeTimers();
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const rafSpy = vi.fn(() => 1);
      const cafSpy = vi.fn();
      vi.stubGlobal('requestAnimationFrame', rafSpy);
      vi.stubGlobal('cancelAnimationFrame', cafSpy);

      const { renderer } = makeRenderer({ maxDecodeQueue: 2 });
      renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });

      renderer.push(makeFrame({ seq: 1, gen16: 0 }));
      await vi.advanceTimersByTimeAsync(1);
      expect(rafSpy).toHaveBeenCalledTimes(1);

      now = 500; // still inside the 1000ms guard window
      renderer.push(makeFrame({ seq: 2, gen16: 0 }));
      await vi.advanceTimersByTimeAsync(1);
      expect(rafSpy).toHaveBeenCalledTimes(1);
      expect(cafSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
      renderer.destroy();
      vi.useRealTimers();
    });

    it('cancels and replaces a stuck rAF once 1000ms have elapsed', async () => {
      vi.useFakeTimers();
      let now = 0;
      vi.spyOn(performance, 'now').mockImplementation(() => now);
      const rafSpy = vi.fn(() => 1);
      const cafSpy = vi.fn();
      vi.stubGlobal('requestAnimationFrame', rafSpy);
      vi.stubGlobal('cancelAnimationFrame', cafSpy);

      const { renderer } = makeRenderer({ maxDecodeQueue: 2 });
      renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });

      renderer.push(makeFrame({ seq: 1, gen16: 0 }));
      await vi.advanceTimersByTimeAsync(1);
      expect(rafSpy).toHaveBeenCalledTimes(1);

      now = 1200; // past the 1000ms guard window: the earlier rAF is presumed stuck
      renderer.push(makeFrame({ seq: 2, gen16: 0 }));
      await vi.advanceTimersByTimeAsync(1);
      expect(cafSpy).toHaveBeenCalledTimes(1);
      expect(rafSpy).toHaveBeenCalledTimes(2);

      vi.unstubAllGlobals();
      renderer.destroy();
      vi.useRealTimers();
    });
  });
});
