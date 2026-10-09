/**
 * `@browserglass/core`'s input dispatch module: `InputDispatcher`, the key
 * event builder, the coordinate transform, `gen`/`leaseId` fencing, the
 * rate limiter, pointer/key hygiene, message validation, and the CDP
 * allowlist. Sibling modules within `core` and the package barrel
 * (`packages/core/src/index.ts`) import from this file directly.
 */

export * from './cdp-allowlist.js';
export * from './coordinates.js';
export * from './dispatcher.js';
export * from './gen-fencing.js';
export * from './held-state.js';
export * from './key-events.js';
export * from './rate-limit.js';
export * from './validation.js';
