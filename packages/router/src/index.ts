/**
 * `@browserglass/router`: the control plane. `BrowserRouter`, placement
 * scoring, admission, quota resolution, the warm pool, the acquire queue,
 * and the single node registry plus `LocalNode`/`LocalNodeTransport`.
 *
 * Depends on `@browserglass/protocol` only. This package must
 * never import `@browserglass/core`, which is what makes a standalone
 * `bgls router` process possible later; enforced by `scripts/check-deps.mjs`.
 */

export * from './router/index.js';
export * from './placement/index.js';
export * from './admission/index.js';
export * from './quota/index.js';
export * from './pool/index.js';
export * from './queue/index.js';
export * from './node/index.js';
export * from './profiles/index.js';
