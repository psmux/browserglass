/**
 * Types for `@browserglass/core`'s frame recorder: the sidecar index row
 * one written frame produces, the meta record written once per recording,
 * and the `RecordingSink` seam a host implements to actually put bytes on
 * a disk (or anywhere else).
 *
 * See `frame-recorder.ts`'s module doc for the design rationale and
 * `../stream/attachment.ts` / `../stream/stream.ts` for the seam this
 * plugs into.
 */

import type { RecordingId, TargetId } from '@browserglass/protocol';

/**
 * One written frame's sidecar row. Deliberately minimal: `seq`, `gen`, and
 * `sidEpoch` are exactly what `Stream` (`../stream/stream.ts:16-24`)
 * already tracks, read at the moment this frame reached the recorder's
 * transport, never re-derived from the encoded bytes themselves.
 *
 * `gen` and `sidEpoch` are recorded separately, not collapsed into one
 * number: a `gen` bump is a visual discontinuity (the previous frame and
 * this one may not describe the same scene, and `seq` restarts at 1); a
 * `sidEpoch` bump alone (a resize, a quality change, a resume) is a
 * reconfiguration of the *same* visual sequence and does not restart
 * `seq`. A replayer that only sees a merged counter cannot tell "this is a
 * new shot" from "this is the same shot, retimed", exactly the ambiguity
 * `stream.ts` was written to avoid on the wire, so this sidecar preserves
 * it on disk too.
 */
export interface RecordedFrameEntry {
  /** 1-based, monotonic per recording; this frame's ordinal position, independent of `seq` (which can reset on a `gen` bump while the recording itself keeps going). */
  frameIndex: number;
  /** `Stream.seq` at write time: monotonic within `(streamId, gen)`, resets to 1 on a `gen` bump. */
  seq: number;
  /** `Stream.gen` at write time, full width (the wire header only ever carries the low 16 bits; this sidecar is not wire-constrained, so it keeps the full value). */
  gen: number;
  /** `Stream.sidEpoch` at write time. See the interface doc above for why this is not folded into `gen`. */
  sidEpoch: number;
  /** `Stream.tsDeltaMs` at write time: milliseconds since the current `sidEpoch`'s base. */
  tsDeltaMs: number;
  /** Byte length of the payload handed to the sink for this frame. */
  byteLength: number;
  /** Wall-clock ms this entry was constructed. Coarse bookkeeping only; `tsDeltaMs` (relative to the stream's own epoch) is the source of truth for playback timing, not this. */
  writtenAtMs: number;
  /**
   * Reserved for a future action-sampled sidecar: which viewer/lease held
   * control and what triggered this frame (browser-harness's `recorder.py`
   * attaches exactly this to every frame it captures; it is deliberately
   * not wired here, see `frame-recorder.ts`'s module doc). Never
   * populated here. A future caller that does populate it MUST pass it
   * through `redactMeta()` first (`./redact.ts`): the moment intent
   * carries a URL or typed text, the same discipline `recorder.py` applies
   * to those fields applies here too.
   */
  intent?: Readonly<Record<string, unknown>>;
}

/** Written once per recording, before the first frame (best effort; a failure here does not block frame writes). */
export interface RecordingMeta {
  recordingId: RecordingId;
  targetId: TargetId;
  mode: 'live' | 'thumbnail';
  /** The `EncodeTierSet` tier index this recording is pinned to; never reassigned (see `frame-recorder.ts`). */
  pinnedTierIndex: number;
  startedAtMs: number;
  /**
   * Caller-supplied context, already passed through `redactMeta()` by
   * `FrameRecorder` before it reaches here. Never trust that a caller
   * has not included a session id or a raw URL in `FrameRecorderOptions.extraMeta`.
   */
  extra?: Readonly<Record<string, unknown>>;
}

/**
 * The seam a host implements to actually persist a recording:
 * `packages/core` is transport-agnostic (no `node:fs` dependency anywhere
 * in this package; see `frame-recorder.ts`'s module doc), so writing bytes
 * to a directory is the host's job, exactly the same division of
 * responsibility as `AttachmentTransport` (`../stream/types.ts`) already
 * draws for a viewer's socket.
 *
 * Both methods may throw or reject; `FrameRecorder` catches every failure
 * from either one and degrades the recording to a no-op rather than
 * letting it reach the live fan-out path (see `frame-recorder.ts`).
 */
export interface RecordingSink {
  /** Persists one frame's bytes plus its sidecar entry. Write order need not be strictly serialized by the caller, but a sink that reorders writes makes `FrameRecorder`'s ack-driven backlog accounting approximate (never data-corrupting: every entry and its bytes are still written in full). */
  writeFrame(entry: RecordedFrameEntry, bytes: Uint8Array): void | Promise<void>;
  /** Persists (or overwrites) the recording's meta record. Optional: a sink with nothing sensible to do here (e.g. a test double) can omit it. */
  writeMeta?(meta: RecordingMeta): void | Promise<void>;
}
