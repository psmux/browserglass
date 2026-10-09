/**
 * `@browserglass/server`'s recording feature: the disk-backed
 * `RecordingSink` (`@browserglass/core`'s `RecordingSink` seam, implemented
 * here since `core` deliberately carries no `node:fs` dependency). Wired
 * into `ManagedSession.startRecording`/`.stopRecording`/`.listRecordings`
 * (`../session/managed-session.ts`) and the `recording.*` wire handlers
 * (`../ws/connection.ts`).
 */

export * from './disk-recording-sink.js';
