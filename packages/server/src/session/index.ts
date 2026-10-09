/**
 * `@browserglass/server`'s session layer: `ManagedSession` (the
 * `core.Session` to WS-socket glue, including the frame-emission pipeline
 * `core` does not build), the process-wide `SessionRegistry`, its router-backed
 * factory, and `SessionApi` (`bg.sessions`).
 */

export * from './factory.js';
export * from './frame-pipeline.js';
export * from './managed-session.js';
export * from './node-action-executor.js';
export * from './registry.js';
export * from './rest-driver.js';
export * from './session-api.js';
export * from './types.js';
