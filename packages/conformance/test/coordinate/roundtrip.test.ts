import { CanvasRenderer } from '@browserglass/client';
// @vitest-environment jsdom
/**
 * The coordinate round-trip property test: `toClient(toFrame(p)) === p` for every point, up to float precision, over randomised points,
 * rects, and scale factors including fractional DPR.
 *
 * `CanvasRenderer` is real, imported from the published `@browserglass/client`
 * entry point (never a relative `src` path into that package), so a
 * regression only visible through the built export surface is caught here
 * even if `@browserglass/client`'s own suite, run against its own `src`,
 * stays green. This file opts into a jsdom environment on its own
 * (`@vitest-environment jsdom` above) since it is the only file in this
 * package that touches `HTMLCanvasElement`; every other conformance test
 * runs under this package's default Node environment. jsdom does not
 * perform real layout, so `getBoundingClientRect()` is stubbed per test
 * the same way `@browserglass/client`'s own test suite stubs it: this is
 * the standard, documented way to drive `CanvasRenderer`'s coordinate
 * transform under a DOM environment with no real renderer.
 */
import { afterEach, describe, expect, it } from 'vitest';

/**
 * jsdom does not implement 2D canvas rendering at all (it has no `canvas`
 * npm package installed, by design: this package never draws a real
 * frame, `toFrame`/`toClient` are pure coordinate maths and never touch
 * the context). `CanvasRenderer`'s constructor still calls
 * `canvas.getContext('2d')` and throws if it returns `null`
 * (`packages/client/src/render/CanvasRenderer.ts`), so a minimal fake
 * context is enough to let construction succeed; nothing in this file
 * ever calls a method on it. Matches the technique
 * `@browserglass/client`'s own `test/setup.ts` uses for the same
 * jsdom limitation, reduced to only what this file needs.
 */
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = function fakeGetContext(
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind !== '2d') return null;
    return {
      canvas: this,
      fillStyle: '#000',
      filter: 'none',
      imageSmoothingEnabled: true,
      getContextAttributes: () => ({ alpha: false, desynchronized: false }),
      drawImage: () => undefined,
      clearRect: () => undefined,
      fillRect: () => undefined,
      save: () => undefined,
      restore: () => undefined,
    } as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;
}

interface StubbedRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Overrides `element.getBoundingClientRect()` to return a fixed rect, the same technique `@browserglass/client`'s own render tests use, since jsdom performs no real layout. */
function stubRect(element: HTMLElement, rect: StubbedRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => ({}),
    }),
  });
}

/** A small deterministic PRNG (mulberry32), reproducible across runs. */
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

describe('coordinate round-trip: toClient(toFrame(p)) === p', () => {
  let renderer: CanvasRenderer | undefined;

  afterEach(() => {
    renderer?.destroy();
    renderer = undefined;
  });

  it('holds over 10^5 randomised points, rects, and fractional scale factors (DPR)', () => {
    const rand = mulberry32(0xb2072e5);
    const canvas = document.createElement('canvas');
    const container = document.createElement('div');
    renderer = new CanvasRenderer(canvas, container);

    const ITERATIONS = 100_000;
    for (let i = 0; i < ITERATIONS; i++) {
      const fw = 1 + Math.floor(rand() * 2000);
      const fh = 1 + Math.floor(rand() * 2000);
      canvas.width = fw;
      canvas.height = fh;

      // A fractional device pixel ratio stand-in, covering the common
      // physical values (1, 1.25, 1.5, 1.75, 2, 2.5, 3) and everything
      // in between.
      const dprLike = 0.5 + rand() * 3.5;
      const left = (rand() - 0.5) * 4000;
      const top = (rand() - 0.5) * 4000;
      const width = Math.max(0.01, fw / dprLike);
      const height = Math.max(0.01, fh / dprLike);
      stubRect(canvas, { left, top, width, height });

      const clientX = left + rand() * width;
      const clientY = top + rand() * height;

      const frame = renderer.toFrame(clientX, clientY);
      const back = renderer.toClient(frame.x, frame.y);

      expect(back.clientX).toBeCloseTo(clientX, 6);
      expect(back.clientY).toBeCloseTo(clientY, 6);
    }
  });

  it('measures the canvas, never the container: an offset container does not leak into the transform', () => {
    const canvas = document.createElement('canvas');
    const container = document.createElement('div');
    renderer = new CanvasRenderer(canvas, container);
    canvas.width = 960;
    canvas.height = 540;
    stubRect(container, { left: 0, top: 0, width: 800, height: 600 });
    stubRect(canvas, { left: 0, top: 75, width: 800, height: 450 });

    const p = renderer.toFrame(500, 300);
    expect(p.inside).toBe(true);
    expect(p.x).toBe(600);
    expect(p.y).toBe(270);
  });

  it('a zero-size drawn rect returns inside:false with no NaN reaching either coordinate', () => {
    const canvas = document.createElement('canvas');
    const container = document.createElement('div');
    renderer = new CanvasRenderer(canvas, container);
    canvas.width = 4;
    canvas.height = 4;
    stubRect(canvas, { left: 10, top: 10, width: 0, height: 0 });

    const p = renderer.toFrame(50, 50);
    expect(p).toEqual({ x: 0, y: 0, inside: false });
    expect(Number.isNaN(p.x)).toBe(false);
    expect(Number.isNaN(p.y)).toBe(false);
  });

  it('a non-finite client coordinate is rejected before the transform runs', () => {
    const canvas = document.createElement('canvas');
    const container = document.createElement('div');
    renderer = new CanvasRenderer(canvas, container);
    canvas.width = 4;
    canvas.height = 4;
    stubRect(canvas, { left: 0, top: 0, width: 4, height: 4 });

    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(renderer.toFrame(bad, 10)).toEqual({ x: 0, y: 0, inside: false });
      expect(renderer.toFrame(10, bad)).toEqual({ x: 0, y: 0, inside: false });
    }
  });
});
