import { type DecodedBinaryFrame, PayloadCodec } from '@browserglass/protocol';
import { CanvasRenderer } from '../../src/render/CanvasRenderer.js';
import type { CanvasRendererOptions } from '../../src/render/types.js';
import { fakeFramePayload } from '../setup.js';

/** Sets a `DOMRect`-shaped `getBoundingClientRect` override on an element. */
export function stubRect(
  el: HTMLElement,
  rect: { left: number; top: number; width: number; height: number },
): void {
  el.getBoundingClientRect = () =>
    ({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }) as DOMRect;
}

/** Builds a canvas plus container pair with a `CanvasRenderer` attached, both with a `0x0` rect stubbed by default (tests should call `stubRect` before relying on layout). */
export function makeRenderer(options?: CanvasRendererOptions): {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  renderer: CanvasRenderer;
} {
  const canvas = document.createElement('canvas');
  const container = document.createElement('div');
  container.appendChild(canvas);
  document.body.appendChild(container);
  stubRect(canvas, { left: 0, top: 0, width: 100, height: 100 });
  stubRect(container, { left: 0, top: 0, width: 100, height: 100 });
  const renderer = new CanvasRenderer(canvas, container, options);
  return { canvas, container, renderer };
}

/** Builds a `DecodedBinaryFrame` whose payload decodes (via the test `createImageBitmap` polyfill) to the given width/height. */
export function makeFrame(
  overrides: Partial<Omit<DecodedBinaryFrame, 'payload'>> & {
    seq: number;
    width?: number;
    height?: number;
    reject?: boolean;
    delayMs?: number;
  },
): DecodedBinaryFrame {
  const { width, height, reject, delayMs, ...rest } = overrides;
  return {
    version: 1,
    msgType: 1,
    streamId: 1,
    tsDeltaMs: 0,
    payloadCodec: PayloadCodec.JPEG,
    flags: 1,
    gen16: 0,
    keyframe: true,
    thumbnail: false,
    partial: false,
    final: true,
    synthetic: false,
    dprScaled: false,
    alpha: false,
    ext: false,
    payload: fakeFramePayload({ width: width ?? 4, height: height ?? 4, reject, delayMs }),
    ...rest,
  };
}

/**
 * Waits several macrotasks: enough for the polyfilled `createImageBitmap`
 * promise chain to settle AND for the fake `requestAnimationFrame` (see
 * `test/setup.ts`, one macrotask per scheduled frame) it triggers to fire.
 */
export function flushAsync(ticks = 4): Promise<void> {
  return new Promise((resolve) => {
    let remaining = ticks;
    const step = (): void => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setTimeout(step, 0);
    };
    setTimeout(step, 0);
  });
}
