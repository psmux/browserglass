/**
 * `@browserglass/core`'s page map module. This barrel exports the capture
 * entry point and the public shapes, nothing else. A caller outside
 * `pagemap/` (for example `ManagedSession.pageMap()` in the server package)
 * should never need to import a specific file under `pagemap/` directly;
 * everything it needs is re-exported here, and the package barrel
 * (`packages/core/src/index.ts`) re-exports this one.
 *
 * The pipeline internals (`snapshot.ts`, `dom-tree.ts`, `frames.ts`,
 * `ax-merge.ts`, `interactivity.ts`, `occlusion.ts`, `rect-union.ts`,
 * `listeners.ts`, `text.ts`'s own private helpers) are deliberately NOT
 * re-exported here: they are `capture.ts`/`budget.ts`'s own dependencies,
 * not a caller's. `text.ts`'s public extraction function IS re-exported,
 * because unlike the others it is a second, independent entry point a
 * caller can use directly on an already-finished {@link PageMapCapture}.
 */

export { capturePageMap, PageMapCaptureError, type PageMapCaptureRequest } from './capture.js';
export {
  buildPageMapBudget,
  type PageMapBudgetRequest,
  type PageMapBudgetResult,
} from './budget.js';
export {
  extractPageMapText,
  type PageMapTextBlock,
  type PageMapTextOutcome,
  type PageMapTextRequest,
} from './text.js';
export {
  assertFreshEpoch,
  isFreshEpoch,
  mintPageMapEpoch,
  pageMapIndexOf,
  PageMapStaleEpochError,
} from './index-assign.js';
export { PageMapCache } from './cache.js';
export {
  PAGE_MAP_COMPUTED_STYLES,
  type PageMapCapture,
  type PageMapComputedStyle,
  type PageMapDocumentRect,
  type PageMapNodeRecord,
  type PageMapPhase,
  type PageMapPhaseFailure,
  type PageMapShadowKind,
} from './types.js';
