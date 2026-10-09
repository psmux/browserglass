/**
 * `FrameRecorder`: a session recording, built entirely out of the
 * `synthetic` attachment seam `../stream/attachment.ts` and `../stream/stream.ts`
 * already provide.
 *
 * ## What question this answers, versus browser-harness's recorder
 *
 * `browser-harness`'s `recorder.py` is ACTION sampled: one screenshot per
 * state-changing helper call, each anchored to a named action with its
 * arguments (`click_at_xy`, `type_text`, ...). It answers "what did the
 * agent do, and what did the page look like right after." `FrameRecorder`
 * is TIME sampled: it writes whatever the live encode pipeline already
 * produces, at whatever cadence the stream's quality tier emits frames. It
 * answers "what did the screen look like, continuously", a video's
 * question, not an action log's. The two are complementary, not
 * substitutes: `RecordedFrameEntry.intent` (`./types.ts`) is reserved so a
 * future action-sampled sidecar can annotate this recording's frames with
 * exactly what browser-harness already captures, and BrowserGlass has
 * strictly more to put there than browser-harness does once that's wired:
 * viewer identity and a `ControlLease` holder travel with every
 * `input.*` wire message and every subscribed `Attachment` already, where
 * browser-harness has only a single local agent driving one browser. That
 * is not wired in yet; only the field is reserved.
 *
 * ## Why this is a `synthetic` `Attachment`, not a new fan-out path
 *
 * `Attachment.synthetic` (`../stream/attachment.ts`) already exists,
 * documented as "True for a recorder or other non-interactive consumer."
 * `Stream.interactiveAttachments()` (`../stream/stream.ts:137`) and
 * `assignTiers()` (`../stream/encode-tier-set.ts`) already filter it out
 * of tier-level computation and the AIMD controller, so a recorder cannot
 * drag a live viewer's quality down, and a recorder is never itself
 * dragged by another synthetic consumer. `fanOut()` (`../stream/attachment.ts:212`)
 * does NOT filter `synthetic` out: it sends to every attachment the caller
 * hands it, checking only transport health and backpressure. Registering
 * a `FrameRecorder`'s `Attachment` alongside a stream's real viewers and
 * including it in the array passed to `fanOut()` is therefore enough to
 * receive frames through the exact path that already exists, with zero
 * changes to `attachment.ts`, `stream.ts`, `encode-tier-set.ts`, or
 * `quality-ladder.ts`.
 *
 * `attachment.tierIndex` is set once at construction from `pinnedTierIndex`
 * and never touched again by this class. Nothing else ever touches it
 * either: the only code that reassigns an attachment's tier reads from
 * `interactiveAttachments()`/the caller's own `interactive` filter (see
 * `packages/server/src/session/managed-session.ts`'s `handleFrame`, which
 * filters `!a.synthetic` before computing tier levels), and a synthetic
 * attachment is excluded from both by construction. "Pinned" here means
 * "nothing in this codebase currently has a path that would change it,"
 * not an enforced invariant this class defends against a future caller
 * mutating `attachment.tierIndex` directly (it is a public field on
 * `Attachment`, same as every other attachment's).
 *
 * ## Where `seq`/`gen`/`sidEpoch`/`tsDeltaMs` come from
 *
 * `fanOut()`'s hot loop calls `att.transport.send(tier.buffer)` with only
 * the encoded bytes and no frame metadata, by design (`AttachmentTransport`
 * is deliberately minimal, see `../stream/types.ts`). This class does not
 * change that signature. Instead, it is constructed with a reference to
 * the owning `Stream` and reads `stream.seq`, `stream.gen`, `stream.sidEpoch`,
 * and `stream.tsDeltaMs(nowWallMs)` directly inside `send()`. This is
 * correct under one documented invariant this module relies on but cannot
 * itself verify: `fanOut()` is always called synchronously, with no
 * `await` between the moment a frame's `seq`/`gen`/`tsDeltaMs` were
 * derived from that same `Stream` (via `Stream.nextSeq()` and its `gen`/
 * `sidEpoch` fields) and the `fanOut()` call that reaches this transport's
 * `send()`. Every real call site in this codebase holds that invariant
 * (it is the same assumption `Stream.nextSeq()`'s own doc makes); a caller
 * that violates it (an `await` inserted between assigning a frame's `seq`
 * and fanning it out) would record a `seq`/`gen` newer than the bytes
 * actually being written. Reading from `Stream` instead of decoding the
 * wire header is still strictly more correct than the alternative: `gen`
 * only travels on the wire truncated to its low 16 bits (`../stream/types.ts`'s
 * `SequencedFrame.gen` doc), which this module needs full width for
 * exactly the reason given in `./types.ts`'s `RecordedFrameEntry` doc.
 *
 * ## Degradation on failure
 *
 * `packages/core` has no `node:fs` dependency anywhere (this package is
 * transport-agnostic, same as `AttachmentTransport` already assumes for a
 * viewer's socket); writing bytes to a directory is `RecordingSink`'s
 * job, implemented by the host. `send()` never lets a sink failure
 * (a thrown error or a rejected promise) reach `fanOut()`'s caller:
 * `browser-harness`'s `recorder.py` swallows a capture failure
 * unconditionally (`except Exception: pass`) so a recording problem can
 * never break the traced task, and this class takes that much: a
 * failure degrades this attachment to `isOpen() === false`, which is the
 * very first check `fanOut()` makes, so a broken recorder costs one
 * boolean read per frame forever after, never a retry, never a throw into
 * the live path. It does NOT take `recorder.py`'s silence: {@link FrameRecorder.failed}
 * and {@link FrameRecorder.lastError} are readable, and `onError` (if
 * supplied) fires exactly once, on the first failure, so a caller can
 * surface it (a log line, a UI badge) instead of a recording quietly
 * going nowhere forever.
 */

import type { RecordingId, TargetId } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import type { Clock } from '../control/clock.js';
import { createSystemClock } from '../control/clock.js';
import { Attachment } from '../stream/attachment.js';
import type { Stream } from '../stream/stream.js';
import type { AttachmentTransport } from '../stream/types.js';
import { redactMeta } from './redact.js';
import type { RecordedFrameEntry, RecordingMeta, RecordingSink } from './types.js';

/** Constructor options for {@link FrameRecorder}. */
export interface FrameRecorderOptions {
  /** Minted with `newId('rec')` if omitted. */
  recordingId?: RecordingId;
  /** The wire `streamId` this recorder's `Attachment` reports; distinct from any viewer's own, and never sent anywhere since a recorder has no socket. */
  streamId: number;
  /** The `Stream` this recorder reads `seq`/`gen`/`sidEpoch`/`tsDeltaMs` from. Must be the same `Stream` whose frames are fanned out to this recorder's `attachment`. */
  stream: Stream;
  targetId: TargetId;
  mode?: 'live' | 'thumbnail';
  /** Which `EncodeTierSet` tier index this recording reads. Default 0 (the best available tier). Set once; never reassigned by this class or anything else (see module doc). */
  pinnedTierIndex?: number;
  /** How many frames may be in flight to the sink before `fanOut()` starts skipping this attachment (mirrors a live viewer's ack window; see the "Degradation on failure" and backlog notes in the module doc). Default 3, matching `Attachment`'s own default. */
  maxBacklog?: number;
  sink: RecordingSink;
  clock?: Clock;
  /** Caller-supplied context folded into the written `RecordingMeta`. Always passed through `redactMeta()` (`./redact.ts`) before it reaches `sink.writeMeta`. Never assume a caller has not included a session id or a raw URL here. */
  extraMeta?: Readonly<Record<string, unknown>>;
  /** Fires exactly once, on this recording's first failure (from either `sink.writeFrame` or `sink.writeMeta`). Never fires again after. */
  onError?: (err: Error) => void;
}

/**
 * One recording in progress: a `synthetic` `Attachment` a caller registers
 * on a `Stream` (`stream.addAttachment(recorder.attachment)`) and includes
 * in the array it passes to `fanOut()`, plus the bookkeeping that turns
 * each frame `fanOut()` sends into a {@link RecordedFrameEntry} and hands
 * both it and the encoded bytes to a `RecordingSink`. See the module doc
 * for the full design rationale.
 */
export class FrameRecorder {
  readonly recordingId: RecordingId;
  readonly attachment: Attachment;

  private readonly sink: RecordingSink;
  private readonly stream: Stream;
  private readonly clock: Clock;
  private readonly onErrorCb: ((err: Error) => void) | undefined;

  private frameIndex = 0;
  private _failed = false;
  private _lastError: Error | undefined;
  private metaWritten = false;

  constructor(opts: FrameRecorderOptions) {
    this.recordingId = opts.recordingId ?? newId('rec');
    this.sink = opts.sink;
    this.stream = opts.stream;
    this.clock = opts.clock ?? createSystemClock();
    this.onErrorCb = opts.onError;

    const pinnedTierIndex = opts.pinnedTierIndex ?? 0;
    const transport: AttachmentTransport = {
      isOpen: () => !this._failed,
      // A recorder writes to disk, not a socket: there is no OS-level send
      // buffer to report. Backpressure instead runs through the attachment's
      // own backlog/ack window (see `handleSend`'s `onAck` call), which is
      // what `maxBacklog` on the constructor options actually governs.
      bufferedAmount: () => 0,
      send: (buf: Uint8Array) => this.handleSend(buf),
    };

    this.attachment = new Attachment({
      viewerId: `recorder:${this.recordingId}`,
      streamId: opts.streamId,
      transport,
      synthetic: true,
      maxBacklog: opts.maxBacklog ?? 3,
    });
    this.attachment.tierIndex = pinnedTierIndex;

    const meta: RecordingMeta = {
      recordingId: this.recordingId,
      targetId: opts.targetId,
      mode: opts.mode ?? 'live',
      pinnedTierIndex,
      startedAtMs: this.clock.wallNow(),
      ...(opts.extraMeta ? { extra: redactMeta(opts.extraMeta) } : {}),
    };
    this.writeMetaOnce(meta);
  }

  /** True once this recording has hit an unrecoverable sink failure. `attachment`'s transport reports `isOpen() === false` from this point on, so `fanOut()` skips it at the cost of one boolean read per frame, forever. */
  get failed(): boolean {
    return this._failed;
  }

  /** The error that caused {@link failed} to become true, if any. */
  get lastError(): Error | undefined {
    return this._lastError;
  }

  /** Number of frames actually handed to the sink so far (attempted, not necessarily yet durable: `sink.writeFrame` may still be pending or may have failed). */
  get framesWritten(): number {
    return this.frameIndex;
  }

  private writeMetaOnce(meta: RecordingMeta): void {
    if (this.metaWritten || !this.sink.writeMeta) {
      return;
    }
    this.metaWritten = true;
    Promise.resolve()
      .then(() => this.sink.writeMeta?.(meta))
      .catch((err: unknown) => this.fail(err));
  }

  /**
   * `AttachmentTransport.send`: called by `fanOut()` once per frame this
   * recorder is eligible for. Reads this frame's `seq`/`gen`/`sidEpoch`/
   * `tsDeltaMs` off `this.stream` (see the module doc's invariant note),
   * hands the entry and `buf` to the sink, and on success acks the
   * attachment's own backlog so a healthy recording never trips its
   * `maxBacklog` cap. A failure degrades the recording; it never throws
   * back into `fanOut()`'s caller.
   */
  private handleSend(buf: Uint8Array): void {
    if (this._failed) {
      return;
    }
    const seq = this.stream.seq;
    const nowWallMs = this.clock.wallNow();
    this.frameIndex += 1;
    const entry: RecordedFrameEntry = {
      frameIndex: this.frameIndex,
      seq,
      gen: this.stream.gen,
      sidEpoch: this.stream.sidEpoch,
      tsDeltaMs: this.stream.tsDeltaMs(nowWallMs),
      byteLength: buf.byteLength,
      writtenAtMs: nowWallMs,
    };

    Promise.resolve()
      .then(() => this.sink.writeFrame(entry, buf))
      .then(() => {
        if (!this._failed) {
          this.attachment.onAck(seq);
        }
      })
      .catch((err: unknown) => this.fail(err));
  }

  private fail(err: unknown): void {
    if (this._failed) {
      return;
    }
    this._failed = true;
    this._lastError = err instanceof Error ? err : new Error(String(err));
    this.onErrorCb?.(this._lastError);
  }
}
