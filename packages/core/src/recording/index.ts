/**
 * `@browserglass/core`'s frame recorder: a `synthetic` `Attachment` that
 * writes a stream's frames plus a sidecar index through a host-supplied
 * `RecordingSink`. See `frame-recorder.ts`'s module doc for the design.
 * Re-exported from `packages/core/src/index.ts`, so `@browserglass/server`
 * (the first, and so far only, host implementing `RecordingSink`) can
 * import `FrameRecorder`/`RecordingSink`/`redactMeta` from the package
 * barrel like every other `core` feature, rather than reaching into this
 * subpath directly.
 */

export * from './frame-recorder.js';
export * from './redact.js';
export * from './types.js';
