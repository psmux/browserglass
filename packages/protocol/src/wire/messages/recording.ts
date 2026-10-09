import type { Envelope } from '../envelope.js';

/**
 * The frame recorder's wire surface: start, stop, and list a durable,
 * disk-persisted recording of one target's stream. Built against
 * `@browserglass/core`'s `packages/core/src/recording/` (`FrameRecorder`,
 * a `synthetic` `Attachment` that already receives frames through the
 * ordinary fan-out path; see that module's own doc for the capture
 * design). The wire family itself is new: `recordingId` (`rec_...`,
 * `wire/ids.ts`) was reserved "typed only" at first and is now
 * minted for real, by `packages/server`, on `recording.start`.
 *
 * CAPABILITY, worth stating plainly because it is deliberately NOT the
 * nearest existing gate. `target.capture` (`./capture.ts`) and
 * `page.pdf.get` are both gated on `capture` alone: a MOMENTARY render of
 * what the caller can already see, gone once the reply is sent, nothing
 * left behind on disk. `recording.start` produces the opposite thing: a
 * durable file that outlives the socket, the viewer, and the session
 * itself, and that can be read back later by anyone who can reach the
 * disk it landed on. That is exactly the authority `download` already
 * gates (`../capabilities.ts`: extracting bytes that leave the live
 * session as a retrievable file), so `packages/server`'s
 * `wire/capability-check.ts` requires `capture` (the render-visibility
 * half) AND `download` (the durable-artifact half) together for every
 * `recording.*` message, via a base check plus a second, handler-level
 * check documented at that table's own entry (the same "second
 * enforcement point `checkCapability` cannot express" pattern
 * `page.responsebody.get` already uses). Neither capability alone is
 * honest about what this grants: `capture` alone would hand out
 * indefinite retention to a token that was only ever meant to see one
 * frame at a time, and `download` alone would hand out recording
 * authority to a token that cannot already see the page's pixels most
 * operators gate the two together for. `view` (bare live streaming,
 * nothing stored) is deliberately insufficient on its own, per this
 * family's own reasoning: a session recording of a logged-in browser is a
 * far more dangerous artifact than a live stream nobody stores
 * (`packages/core/src/recording/redact.ts`'s own module doc makes the
 * identical argument for why its redaction exists at all).
 */

/**
 * C to S: begin a durable, disk-persisted recording of `targetId`'s
 * stream. Requires `capture` AND `download` (see this module's own doc).
 * Answered with `recording.started`, or an `error` if `targetId` has no
 * live stream to record.
 */
export interface RecordingStart extends Envelope {
  t: 'recording.start';
  targetId: string;
  /** Default `'live'`. `'thumbnail'` pins the recording to the low-cost polling tier instead of the full screencast, mirroring `stream.subscribe`'s own `thumbnail` flag. */
  mode?: 'live' | 'thumbnail';
}

/** S to C, addressed to the requesting viewer: the recording has started and is writing to disk. */
export interface RecordingStarted extends Envelope {
  t: 'recording.started';
  recordingId: string;
  targetId: string;
  mode: 'live' | 'thumbnail';
  startedAtMs: number;
}

/** C to S: stop a recording. Answered with `recording.stopped` even if the recording had already degraded to a no-op (see `RecordingStopped.failed`). */
export interface RecordingStop extends Envelope {
  t: 'recording.stop';
  recordingId: string;
}

/** S to C: acknowledges `recording.stop`. */
export interface RecordingStopped extends Envelope {
  t: 'recording.stopped';
  recordingId: string;
  targetId: string;
  startedAtMs: number;
  stoppedAtMs: number;
  /** How many frames actually reached the sink; see `FrameRecorder.framesWritten`'s own doc (attempted, not necessarily all durable if the process crashes mid write). */
  framesWritten: number;
  /** True if the recording degraded to a no-op before this stop, per `packages/core/src/recording/frame-recorder.ts`'s "Degradation on failure": `framesWritten` still counts whatever reached the sink before that happened. */
  failed: boolean;
}

/** C to S: list recordings on this session, optionally scoped to one target. */
export interface RecordingList extends Envelope {
  t: 'recording.list';
  targetId?: string;
}

/**
 * One recording's summary. Deliberately carries no page content and no
 * viewer identity: `targetId` and timing/status only, the same restraint
 * `RecordingMeta` (`@browserglass/core`'s `recording/types.ts`) already
 * applies to what gets written to disk.
 */
export interface RecordingSummary {
  recordingId: string;
  targetId: string;
  mode: 'live' | 'thumbnail';
  startedAtMs: number;
  stoppedAtMs?: number;
  framesWritten: number;
  failed: boolean;
}

/** S to C: reply to `recording.list`. */
export interface RecordingListed extends Envelope {
  t: 'recording.listed';
  recordings: readonly RecordingSummary[];
}

/**
 * S to C, unsolicited: a recording degraded to a no-op after a sink
 * failure. Sent at most once per recording, mirroring
 * `FrameRecorder.onError`'s own "fires exactly once" guarantee
 * (`frame-recorder.ts`), so a recording never goes silently nowhere with
 * nobody told; see that module's "Degradation on failure" section. `message`
 * is sanitised the same way every other host-derived string reaching the
 * wire is (`packages/server/src/wire/sanitize.ts`) and carries no stack
 * trace or filesystem path.
 */
export interface RecordingFailed extends Envelope {
  t: 'recording.failed';
  recordingId: string;
  targetId: string;
  message: string;
}
