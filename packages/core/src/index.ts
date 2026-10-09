/**
 * `@browserglass/core`: the live session engine. Re-exports the CDP bridge
 * and target registry (`./cdp/**`), the control lease engine
 * (`./control/**`), the streaming pipeline (`./stream/**`), input dispatch
 * (`./input/**`), the session and recovery modules (`./session/**`,
 * `./recovery/**`), and per-target console/error/network capture
 * (`./diagnostics/**`), assembled into one public barrel.
 *
 * `./cdp/types.ts` and `./control/clock.ts` each declare their own,
 * unrelated `TimerHandle` interface (both a minimal `{unref?: () => void}`
 * shape, written independently). A blanket
 * `export *` from both would make `TimerHandle` ambiguous, so `control`'s
 * copy is re-exported under the name `ControlTimerHandle` here instead of
 * colliding; every other symbol from every sibling module is re-exported
 * under its own original name.
 */

export * from './cdp/index.js';

export type { Clock, TimerHandle as ControlTimerHandle } from './control/clock.js';
export { createSystemClock, createManualClock, ManualClock } from './control/clock.js';
export * from './control/constants.js';
export * from './control/fencing.js';
export * from './control/lease-engine.js';
export * from './control/policies.js';
export * from './control/queue.js';
export * from './control/transitions.js';
export * from './control/types.js';

export * from './stream/index.js';

export * from './input/index.js';

export * from './recovery/index.js';

export * from './session/index.js';

export * from './diagnostics/index.js';

export * from './downloads/index.js';

/**
 * The frame recorder (`./recording/**`): `FrameRecorder`, the `RecordingSink`
 * seam a host implements to write frames to disk, and the redaction
 * discipline (`./recording/redact.ts`) any persisted metadata must go
 * through. Used by `@browserglass/server`'s `recording.start`/
 * `.stop`/`.list` handlers, which construct a `FrameRecorder` per
 * recording with a real disk-backed `RecordingSink` and attach it to the
 * target's `Stream` via `Session.streamHandleFor()`, the same seam
 * `ManagedSession`'s own live fan-out pipeline already uses.
 */
export * from './recording/index.js';

/**
 * The page map capture pipeline (`./pagemap/**`, see `docs/page-map.md`).
 * Used by `@browserglass/server`'s `page.map.get`/`page.map.stamp` handlers
 * through `ManagedSession.pageMap()`.
 */
export * from './pagemap/index.js';

/**
 * The PDF capture module (`./pdf/**`). Used by `@browserglass/server`'s
 * `page.pdf.get` handler (`ManagedSession.pdf()`).
 */
export * from './pdf/index.js';

/**
 * The outbound request gate. Exported so `@browserglass/server` can offer
 * it to an embedding host, and so its types are nameable by a caller
 * writing a handler. `Fetch` stays on the CDP passthrough deny list:
 * this is a narrow door beside that refusal, not a hole through it.
 */
export { RequestGate } from './interception/request-gate.js';
export type {
  GatedRequest,
  RequestGateHandler,
  RequestGateOptions,
  RequestVerdict,
} from './interception/request-gate.js';
