import { InputCapture } from '../../src/input/InputCapture.js';
import type {
  InputCaptureOptions,
  InputCoordinateSource,
  SendableInputMessage,
} from '../../src/input/types.js';

/** A `getBoundingClientRect`-shaped stub, shared with the render test helpers' convention. */
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

/**
 * A trivial coordinate source: 1:1 client-to-frame mapping bounded by
 * `width`/`height`, no letterboxing. `InputCapture` only ever calls
 * `toFrame`/`frameSize`, so a real `CanvasRenderer` is unnecessary here;
 * the coordinate transform itself is covered by
 * `test/render/coordinateTransform.test.ts`.
 */
export function makeFakeRenderer(width = 200, height = 200, gen = 1): InputCoordinateSource {
  return {
    toFrame(clientX: number, clientY: number) {
      const inside = clientX >= 0 && clientY >= 0 && clientX <= width && clientY <= height;
      return { x: clientX, y: clientY, inside };
    },
    frameSize() {
      return { fw: width, fh: height, gen };
    },
  };
}

/** Builds a canvas/container pair with an `InputCapture` attached, plus a collector for every message it sends. */
export function makeInputCapture(overrides: Partial<InputCaptureOptions> = {}): {
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  capture: InputCapture;
  sent: SendableInputMessage[];
  renderer: InputCoordinateSource;
} {
  const canvas = document.createElement('canvas');
  const container = document.createElement('div');
  container.appendChild(canvas);
  document.body.appendChild(container);
  stubRect(canvas, { left: 0, top: 0, width: 200, height: 200 });
  stubRect(container, { left: 0, top: 0, width: 200, height: 200 });

  const sent: SendableInputMessage[] = [];
  const renderer = overrides.renderer ?? makeFakeRenderer();
  const capture = new InputCapture(canvas, container, {
    renderer,
    targetId: 'tgt_TESTTARGET00000000000000',
    leaseId: 'lse_TESTLEASE0000000000000000',
    send: (msg) => sent.push(msg),
    ...overrides,
  });
  return { canvas, container, capture, sent, renderer };
}

/** Fires a `PointerEvent` on `target` with sensible defaults. */
export function pointerEvent(
  type: string,
  init: PointerEventInit & { coalescedEvents?: PointerEvent[] } = {},
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    button: 0,
    buttons: 1,
    ...init,
  });
}
