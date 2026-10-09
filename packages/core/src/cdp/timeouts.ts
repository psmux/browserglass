/**
 * The static per-method command timeout table. `Page.screencastFrameAck` never
 * appears here: it is sent through `sendNoReply`, which never arms a timer.
 */

/** The default timeout, in milliseconds, for any method not named in {@link TIMEOUT_TABLE}. */
export const DEFAULT_TIMEOUT_MS = 15000;

/** One method's timeout override, in milliseconds. */
export const TIMEOUT_TABLE: Readonly<Record<string, number>> = Object.freeze({
  'Browser.getVersion': 5000,
  'Target.attachToTarget': 10000,
  'Target.createTarget': 15000,
  'Page.enable': 10000,
  'Runtime.enable': 10000,
  'Log.enable': 10000,
  'Page.navigate': 30000,
  'Page.captureScreenshot': 10000,
  'Page.startScreencast': 10000,
  'Page.stopScreencast': 10000,
  'Input.dispatchMouseEvent': 5000,
  'Input.dispatchKeyEvent': 5000,
  'Input.dispatchTouchEvent': 5000,
  'Input.insertText': 5000,
  'Runtime.evaluate': 30000,
  'Runtime.callFunctionOn': 30000,
  'Emulation.setDeviceMetricsOverride': 10000,
  // `packages/core/src/cdp/accessibility.ts`. `queryAXTree` gets a longer
  // budget than the enable/disable pair either side of it: an unfiltered
  // whole-page query on a large accessibility tree is the one call in this
  // pair that can genuinely take a while, matching `Runtime.evaluate`'s own
  // 30s allowance for the same "a real caller can legitimately ask for a
  // lot" reason.
  'Accessibility.enable': 10000,
  'Accessibility.disable': 10000,
  'Accessibility.queryAXTree': 30000,
  'DOM.pushNodesByBackendIdsToFrontend': 10000,
  'DOM.setAttributeValue': 5000,
  // `packages/core/src/pagemap/**`. These three are the page map capture's
  // only new CDP methods, and each is a whole-page read on a page that may
  // be very large, so each gets the same 20s allowance for the same reason
  // `queryAXTree` above gets 30s.
  //
  // `DOM.getDocument` is deliberately NOT here, and must not be added.
  // `hit-test.ts` calls it at `depth: 1` and `accessibility.ts` at
  // `depth: 0`, and both should answer in milliseconds. A table entry sized
  // for the page map's full-depth piercing walk would hand those two calls
  // a twenty second budget they have no use for, so the piercing walk
  // passes an explicit `SendOptions.timeoutMs` override instead.
  'DOMSnapshot.captureSnapshot': 20000,
  'Accessibility.getFullAXTree': 20000,
  'DOMDebugger.getEventListeners': 20000,
  // `packages/core/src/pdf/print-to-pdf.ts`. A PDF render walks layout and
  // pagination across the whole printable area, not just the viewport, so
  // it gets the same 30s "a real caller can legitimately ask for a lot"
  // allowance `Runtime.evaluate`/`Accessibility.queryAXTree` get above,
  // rather than `Page.captureScreenshot`'s 10s: a screenshot rasterises
  // what is already painted, a PDF composes a document from it.
  'Page.printToPDF': 30000,
});

/** Resolves the timeout, in milliseconds, for one CDP method call. */
export function timeoutForMethod(method: string, override?: number): number {
  if (override !== undefined) {
    return override;
  }
  return TIMEOUT_TABLE[method] ?? DEFAULT_TIMEOUT_MS;
}
