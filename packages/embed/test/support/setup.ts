import { vi } from 'vitest';

/**
 * Test-only DOM polyfills for `@browserglass/embed`. `BrowserGlassElement`
 * attaches a real `@browserglass/client` `CanvasRenderer` and
 * `InputCapture` to a `<canvas>` inside its shadow root, both of which
 * need 2D canvas rendering, `createImageBitmap`, `ResizeObserver`,
 * `PointerEvent`, and `setPointerCapture`, none of which jsdom (this
 * package's configured Vitest environment) implements. Duplicated from
 * `packages/react/test/support/setup.ts` rather than imported across the
 * package boundary (test directories are not part of either package's
 * public surface). None of this ships in the built package.
 */

// --- 2D canvas context -----------------------------------------------------

interface FakeContext2D {
  canvas: HTMLCanvasElement;
  fillStyle: string;
  filter: string;
  imageSmoothingEnabled: boolean;
  getContextAttributes: () => { alpha: boolean; desynchronized: boolean };
  drawImage: (...args: unknown[]) => void;
  clearRect: (...args: unknown[]) => void;
  fillRect: (...args: unknown[]) => void;
  save: () => void;
  restore: () => void;
}

function createFakeContext2D(canvas: HTMLCanvasElement): FakeContext2D {
  return {
    canvas,
    fillStyle: '#000',
    filter: 'none',
    imageSmoothingEnabled: true,
    getContextAttributes: () => ({ alpha: false, desynchronized: false }),
    drawImage: () => {},
    clearRect: () => {},
    fillRect: () => {},
    save: () => {},
    restore: () => {},
  };
}

const contexts = new WeakMap<HTMLCanvasElement, FakeContext2D>();

HTMLCanvasElement.prototype.getContext = function getContext(
  this: HTMLCanvasElement,
  kind: string,
) {
  if (kind !== '2d') return null;
  let ctx = contexts.get(this);
  if (!ctx) {
    ctx = createFakeContext2D(this);
    contexts.set(this, ctx);
  }
  return ctx as unknown as CanvasRenderingContext2D;
} as typeof HTMLCanvasElement.prototype.getContext;

// --- createImageBitmap / ImageBitmap ---------------------------------------

class FakeImageBitmap {
  constructor(
    public width: number,
    public height: number,
  ) {}
  close = vi.fn();
}

(globalThis as unknown as { ImageBitmap: typeof FakeImageBitmap }).ImageBitmap = FakeImageBitmap;

(
  globalThis as unknown as { createImageBitmap: (blob: Blob) => Promise<FakeImageBitmap> }
).createImageBitmap = async () => new FakeImageBitmap(2, 2);

// --- ResizeObserver / IntersectionObserver ----------------------------------

if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverPolyfill {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverPolyfill }).ResizeObserver =
    ResizeObserverPolyfill;
}

// --- PointerEvent ------------------------------------------------------------

if (typeof globalThis.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number;
    pointerType: string;
    pressure: number;
    width: number;
    height: number;
    tiltX: number;
    tiltY: number;
    private readonly coalesced: PointerEvent[];

    constructor(
      type: string,
      params: PointerEventInit & { coalescedEvents?: PointerEvent[] } = {},
    ) {
      super(type, params);
      this.pointerId = params.pointerId ?? 1;
      this.pointerType = params.pointerType ?? 'mouse';
      this.pressure = params.pressure ?? 0;
      this.width = params.width ?? 1;
      this.height = params.height ?? 1;
      this.tiltX = params.tiltX ?? 0;
      this.tiltY = params.tiltY ?? 0;
      this.coalesced = params.coalescedEvents ?? [];
    }

    getCoalescedEvents(): PointerEvent[] {
      return this.coalesced.length > 0 ? this.coalesced : [this as unknown as PointerEvent];
    }
  }
  (globalThis as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent =
    PointerEventPolyfill;
}

// --- requestAnimationFrame / cancelAnimationFrame ---------------------------

const rafTimers = new Map<number, ReturnType<typeof setTimeout>>();
let rafNextId = 1;

function fakeRequestAnimationFrame(cb: FrameRequestCallback): number {
  const id = rafNextId++;
  const timer = setTimeout(() => {
    rafTimers.delete(id);
    cb(performance.now());
  }, 0);
  rafTimers.set(id, timer);
  return id;
}

function fakeCancelAnimationFrame(id: number): void {
  const timer = rafTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    rafTimers.delete(id);
  }
}

globalThis.requestAnimationFrame = fakeRequestAnimationFrame as typeof requestAnimationFrame;
globalThis.cancelAnimationFrame = fakeCancelAnimationFrame as typeof cancelAnimationFrame;

// --- setPointerCapture --------------------------------------------------------

if (typeof HTMLElement.prototype.setPointerCapture !== 'function') {
  HTMLElement.prototype.setPointerCapture = function setPointerCapture(): void {};
  HTMLElement.prototype.releasePointerCapture = function releasePointerCapture(): void {};
  HTMLElement.prototype.hasPointerCapture = function hasPointerCapture(): boolean {
    return false;
  };
}
