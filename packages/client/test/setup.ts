import { vi } from 'vitest';

/**
 * Test-only DOM polyfills for `@browserglass/client`'s render and input
 * modules. jsdom (the configured Vitest environment, see
 * `vitest.config.ts`) does not implement 2D canvas rendering,
 * `createImageBitmap`, `ResizeObserver`, `PointerEvent`, or
 * `setPointerCapture`. None of this ships in the built package: it exists
 * solely so `HTMLCanvasElement`/`PointerEvent`-driven code can be exercised
 * under Vitest without a real browser.
 */

// --- 2D canvas context -----------------------------------------------------

/** Minimal fake `CanvasRenderingContext2D`. Records `drawImage` calls for assertions; every other method is a no-op. */
interface FakeContext2D {
  canvas: HTMLCanvasElement;
  fillStyle: string;
  filter: string;
  imageSmoothingEnabled: boolean;
  drawImageCalls: unknown[][];
  getContextAttributes: () => { alpha: boolean; desynchronized: boolean };
  drawImage: (...args: unknown[]) => void;
  clearRect: (...args: unknown[]) => void;
  fillRect: (...args: unknown[]) => void;
  save: () => void;
  restore: () => void;
}

function createFakeContext2D(canvas: HTMLCanvasElement): FakeContext2D {
  const drawImageCalls: unknown[][] = [];
  return {
    canvas,
    fillStyle: '#000',
    filter: 'none',
    imageSmoothingEnabled: true,
    drawImageCalls,
    getContextAttributes: () => ({ alpha: false, desynchronized: false }),
    drawImage: (...args: unknown[]) => {
      drawImageCalls.push(args);
    },
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
  // Test hook: set `(canvas as any).__forceDesynchronized = true` before
  // constructing a renderer to simulate a runtime that hands back a
  // desynchronized context, for the desynchronized assertion test.
  if ((this as unknown as { __forceDesynchronized?: boolean }).__forceDesynchronized) {
    ctx.getContextAttributes = () => ({ alpha: false, desynchronized: true });
  }
  return ctx as unknown as CanvasRenderingContext2D;
} as typeof HTMLCanvasElement.prototype.getContext;

// --- createImageBitmap / ImageBitmap ---------------------------------------

/** Every `FakeImageBitmap` ever created, in creation order, so a test can assert `.close()` was called on a specific one without the renderer exposing it directly. Cleared by {@link popCreatedBitmaps}. */
const createdBitmaps: FakeImageBitmap[] = [];

/** Returns and clears every `FakeImageBitmap` created since the last call. */
export function popCreatedBitmaps(): FakeImageBitmap[] {
  const out = createdBitmaps.slice();
  createdBitmaps.length = 0;
  return out;
}

/** Fake `ImageBitmap`. Tests control `width`/`height` (and decode failure/delay) via {@link fakeFramePayload}. */
class FakeImageBitmap {
  constructor(
    public width: number,
    public height: number,
  ) {
    createdBitmaps.push(this);
  }
  close = vi.fn();
}

interface FakeBitmapSpec {
  width?: number;
  height?: number;
  reject?: boolean;
  delayMs?: number;
}

(globalThis as unknown as { ImageBitmap: typeof FakeImageBitmap }).ImageBitmap = FakeImageBitmap;

// jsdom's `Blob` implementation in this stack exposes only `size`/`type`/
// `slice()`, not `text()`/`arrayBuffer()`, so content cannot round-trip
// through the Blob the way it would in a real browser. Tests instead pick
// a unique byte length per payload (via `fakeFramePayload`) and the spec is
// looked up by that length, which `blob.size` does report correctly.
const specsBySize = new Map<number, FakeBitmapSpec>();
let nextPayloadLength = 1024;

(
  globalThis as unknown as { createImageBitmap: (blob: Blob) => Promise<FakeImageBitmap> }
).createImageBitmap = async (blob: Blob) => {
  const spec = specsBySize.get(blob.size) ?? {};
  if (spec.delayMs) await new Promise((resolve) => setTimeout(resolve, spec.delayMs));
  if (spec.reject) throw new Error('synthetic decode failure');
  return new FakeImageBitmap(spec.width ?? 2, spec.height ?? 2);
};

/**
 * Builds a payload byte array that the fake `createImageBitmap` above
 * decodes to an `ImageBitmap` matching `spec`. Each call gets a distinct
 * byte length so concurrent decodes within one test never collide.
 */
export function fakeFramePayload(spec: FakeBitmapSpec = {}): Uint8Array {
  const length = nextPayloadLength;
  nextPayloadLength += 1;
  specsBySize.set(length, spec);
  return new Uint8Array(length);
}

// --- ResizeObserver ---------------------------------------------------------

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

// jsdom's real implementation is tied to actual frame timing (tens to
// hundreds of ms), which makes the renderer's async decode/paint pipeline
// slow and nondeterministic to test. Tests get a fast, deterministic
// stand-in instead: one macrotask per scheduled frame, cancellable the
// same way. Individual tests that need to control rAF timing precisely
// (the self-heal guard) stub it further with `vi.stubGlobal`.
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
