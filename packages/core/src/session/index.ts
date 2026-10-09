/**
 * `@browserglass/core`'s session module: `Session` and `Viewer`, the
 * target activation policy (screencast for the active target, poll
 * for every other subscribed one), and the CDP-backed recovery target
 * adapter. Re-exported wholesale from `packages/core/src/index.ts`.
 */

export * from './types.js';
export * from './viewer.js';
export * from './target-activation.js';
export * from './recovery-target.js';
export * from './session.js';
