/**
 * `@browserglass/core`'s CDP layer: `CdpBridge`, `TargetRegistry`,
 * `probeCdpIdentity`, and their supporting types. Sibling modules within
 * `core` and the package barrel (`packages/core/src/index.ts`) import from
 * this file directly.
 */

export * from './platform.js';
export * from './timeouts.js';
export * from './errors.js';
export * from './types.js';
export * from './bridge.js';
export * from './proxy-auth.js';
export * from './probe.js';
export * from './target-types.js';
export * from './target-registry.js';
export * from './evaluate.js';
export * from './file-input.js';
export * from './hit-test.js';
export * from './accessibility.js';
export * from './response-body.js';
