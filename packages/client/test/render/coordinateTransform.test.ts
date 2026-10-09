import { describe, expect, it } from 'vitest';
import { CanvasRenderer } from '../../src/render/CanvasRenderer.js';
import { makeRenderer, stubRect } from './testHelpers.js';

/** A small deterministic PRNG (mulberry32) so the property test is reproducible across runs. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('CanvasRenderer coordinate transform', () => {
  it('toClient(toFrame(p)) === p over 10^5 randomised points, rects, and fractional scale factors (DPR)', () => {
    const rand = mulberry32(0xc0ffee);
    const canvas = document.createElement('canvas');
    const container = document.createElement('div');
    const renderer = new CanvasRenderer(canvas, container);

    const ITERATIONS = 100_000;
    for (let i = 0; i < ITERATIONS; i++) {
      // Frame bitmap dims: the backing store, arbitrary small integers.
      const fw = 1 + Math.floor(rand() * 2000);
      const fh = 1 + Math.floor(rand() * 2000);
      canvas.width = fw;
      canvas.height = fh;

      // Drawn CSS rect: origin anywhere, size scaled by a fractional factor
      // standing in for a fractional device pixel ratio (1, 1.25, 1.5,
      // 1.75, 2, 2.5, 3, or an arbitrary fraction in between).
      const dprLike = 0.5 + rand() * 3.5;
      const left = (rand() - 0.5) * 4000;
      const top = (rand() - 0.5) * 4000;
      const width = Math.max(0.01, fw / dprLike);
      const height = Math.max(0.01, fh / dprLike);
      stubRect(canvas, { left, top, width, height });

      // A point inside the drawn rect, in client CSS px.
      const clientX = left + rand() * width;
      const clientY = top + rand() * height;

      const frame = renderer.toFrame(clientX, clientY);
      const back = renderer.toClient(frame.x, frame.y);

      expect(back.clientX).toBeCloseTo(clientX, 6);
      expect(back.clientY).toBeCloseTo(clientY, 6);
    }
    renderer.destroy();
  });

  it('worked example B (letterboxed, tier-scaled, non-owner) produces exactly x=800, y=360', () => {
    // Viewport 1280x720
    // owned by someone else; this viewer's bitmap is 960x540 (tier scale
    // 0.75); container 800x600, so contain-fit letterboxes with offY=75.
    const { renderer, canvas } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 0, width: 960, height: 540 });
    // getBoundingClientRect() on the canvas returns the DRAWN rect, margins
    // already applied: {left:0, top:75, width:800, height:450}.
    stubRect(canvas, { left: 0, top: 75, width: 800, height: 450 });

    const p = renderer.toFrame(500, 300);
    expect(p.inside).toBe(true);
    // Client sends {x:600, y:270, fw:960, fh:540}; the server side of the
    // transform (not this renderer's concern) then produces x=800, y=360.
    // This renderer's own half of the transform is asserted directly: the
    // frame-space point matches the worked numbers exactly.
    expect(p.x).toBe(600);
    expect(p.y).toBe(270);

    // Reproduce the server's half inline to land on the doc's final
    // x=800, y=360, proving the two halves compose to the documented
    // end-to-end result.
    const { fw, fh } = renderer.frameSize();
    const viewportWidth = 1280;
    const viewportHeight = 720;
    const sx = viewportWidth / fw;
    const sy = viewportHeight / fh;
    const x = Math.max(0, Math.min(viewportWidth - 1, Math.round(p.x * sx)));
    const y = Math.max(0, Math.min(viewportHeight - 1, Math.round(p.y * sy)));
    expect(x).toBe(800);
    expect(y).toBe(360);

    renderer.destroy();
  });

  it('rect.width === 0 returns inside:false with x=0, y=0, no NaN', () => {
    const { renderer, canvas } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    stubRect(canvas, { left: 10, top: 10, width: 0, height: 0 });
    const p = renderer.toFrame(50, 50);
    expect(p).toEqual({ x: 0, y: 0, inside: false });
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
    renderer.destroy();
  });

  it('rejects a non-finite clientX/clientY before the transform', () => {
    const { renderer } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 0, width: 4, height: 4 });
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const p = renderer.toFrame(bad, 10);
      expect(p).toEqual({ x: 0, y: 0, inside: false });
      const p2 = renderer.toFrame(10, bad);
      expect(p2).toEqual({ x: 0, y: 0, inside: false });
    }
    renderer.destroy();
  });

  it('measures the canvas, never the container: a container offset does not leak into the transform', () => {
    const { renderer, canvas, container } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 0, width: 960, height: 540 });
    // Container is bigger and offset; canvas (the drawn rect) is the
    // letterboxed sub-rect within it. Measuring the container instead
    // would double-count the offset (a classic bug).
    stubRect(container, { left: 0, top: 0, width: 800, height: 600 });
    stubRect(canvas, { left: 0, top: 75, width: 800, height: 450 });
    const p = renderer.toFrame(500, 300);
    expect(p.x).toBe(600);
    expect(p.y).toBe(270);
    renderer.destroy();
  });

  it('frameSize() reports the currently painted bitmap dims, not a stale cached size', () => {
    const { renderer } = makeRenderer();
    renderer.reconfigure({ streamId: 1, gen: 3, width: 640, height: 480 });
    expect(renderer.frameSize()).toEqual({ fw: 640, fh: 480, gen: 3 });
    renderer.destroy();
  });
});
