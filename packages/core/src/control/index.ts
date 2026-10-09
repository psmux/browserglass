/**
 * `@browserglass/core`'s control-lease module: `LeasePhase` and its
 * 18-row transition table, the `ControlPolicy` strategy interface (only
 * `exclusive` implemented), the FIFO queue, `leaseId` fencing, the timing
 * constants, and `ControlLeaseEngine`, the orchestrator that ties them
 * together. See `lease-engine.ts` for the module-level design notes.
 *
 * The package barrel (`packages/core/src/index.ts`) re-exports the
 * individual files directly rather than this module.
 */

export * from './clock.js';
export * from './constants.js';
export * from './fencing.js';
export * from './lease-engine.js';
export * from './policies.js';
export * from './queue.js';
export * from './transitions.js';
export * from './types.js';
