/**
 * `Stream`: one capture pipeline for one `(sessionId, targetId, mode)`,
 * its `seq`/`gen` bookkeeping, and reference-counted lifecycle
 * (`streamLingerMs`).
 */

import type { Clock, TimerHandle } from '../control/clock.js';
import { createSystemClock } from '../control/clock.js';
import type { Attachment } from './attachment.js';
import type { StreamKey } from './types.js';

/** How long a Stream with zero attachments is kept alive before it actually stops. A tight subscribe/unsubscribe loop reattaches to the still-live Stream within this window, with the same `gen` and a continuing `seq`. */
export const STREAM_LINGER_MS = 3000;

/** Why `Stream.bumpGeneration` was called; carried through for diagnostics only, has no effect on the bump itself (every reason bumps identically). */
export type GenerationBumpReason =
  | 'screencast-restart'
  | 'cdp-reattach'
  | 'reload'
  | 'target-recreated'
  | 'browser-relaunched'
  | 'session-relocated'
  | 'viewport-resize';

/** Constructor options for {@link Stream}. */
export interface StreamOptions {
  key: StreamKey;
  clock?: Clock;
  lingerMs?: number;
  /** Called once the linger window elapses with zero attachments; the caller tears down the underlying `FrameSource`/CDP session. */
  onIdleTimeout: (stream: Stream) => void;
}

/**
 * One target's stream. `seq` is monotonic within `(streamId, gen)`, from 1,
 * never reused within a generation; `gen` increments on any event whose
 * frames could describe a different visual state than the previous frame's
 * for a reason the client cannot infer on its own (a tier or quality change
 * alone never bumps it). Reference counted by attachment: the last
 * attachment leaving does not tear the stream down immediately, it starts
 * {@link STREAM_LINGER_MS} of linger first.
 */
export class Stream {
  readonly key: StreamKey;
  readonly createdAtMs: number;

  /** Full-width target generation. Seeded at 1, matching a stream's first live attach. */
  gen = 1;
  /** Monotonic within `(streamId, gen)`, from 1. Incremented by exactly 1 for every frame the stream *attempts* to send, including frames dropped for every viewer. */
  seq = 0;
  /** Reconfiguration counter: bumped on geometry/codec change, resize, recovery, `streamId` reuse, and every resume. Distinct from `gen`: a `sidEpoch` bump does not reset `seq`. */
  sidEpoch = 0;
  /** Absolute wall-clock ts that a frame's `tsDeltaMs` is relative to; reset whenever `sidEpoch` bumps. */
  sidEpochBaseMs: number;

  readonly attachments = new Set<Attachment>();

  private readonly clock: Clock;
  private readonly lingerMs: number;
  private readonly onIdleTimeout: (stream: Stream) => void;
  private lingerTimer: TimerHandle | null = null;
  private _stopped = false;

  constructor(opts: StreamOptions) {
    this.key = opts.key;
    this.clock = opts.clock ?? createSystemClock();
    this.lingerMs = opts.lingerMs ?? STREAM_LINGER_MS;
    this.onIdleTimeout = opts.onIdleTimeout;
    this.createdAtMs = this.clock.wallNow();
    this.sidEpochBaseMs = this.createdAtMs;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  /** Assigns the next `seq`, always incrementing by exactly 1 regardless of how many (or zero) attachments will actually receive the frame. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Milliseconds elapsed since this stream's current `sidEpoch` base, for a frame's `tsDeltaMs` header field. */
  tsDeltaMs(nowWallMs: number): number {
    return Math.max(0, nowWallMs - this.sidEpochBaseMs);
  }

  /**
   * Bumps `gen` and resets `seq` to 1 (every generation-bumping event
   * resets `seq`, none of them merely continues it). Also bumps
   * `sidEpoch` and rebases `sidEpochBaseMs`, since every `gen`-bumping event
   * is also a `sidEpoch`-bumping one (a visual discontinuity is always a
   * stream reconfiguration, though the converse is not true: a quality
   * change bumps `sidEpoch` alone).
   */
  bumpGeneration(_reason: GenerationBumpReason, nowWallMs: number): void {
    this.gen += 1;
    this.seq = 0;
    this.sidEpoch += 1;
    this.sidEpochBaseMs = nowWallMs;
  }

  /** Bumps `sidEpoch` alone (a quality change producing new dimensions, a resize, or a resume): does not touch `gen` or `seq`. */
  bumpSidEpoch(nowWallMs: number): void {
    this.sidEpoch += 1;
    this.sidEpochBaseMs = nowWallMs;
  }

  /**
   * Registers a new attachment. Cancels any pending idle-linger timeout:
   * a resubscribe within the linger window reattaches to this still-live
   * stream, with the same `gen` and a continuing (not reset) `seq`.
   */
  addAttachment(att: Attachment): void {
    this.attachments.add(att);
    if (this.lingerTimer) {
      this.clock.clearTimer(this.lingerTimer);
      this.lingerTimer = null;
    }
  }

  /** Removes an attachment. Starts the linger timer once the last attachment leaves. */
  removeAttachment(att: Attachment): void {
    this.attachments.delete(att);
    if (this.attachments.size === 0 && !this._stopped) {
      this.lingerTimer = this.clock.setTimer(() => {
        this.lingerTimer = null;
        if (this.attachments.size === 0 && !this._stopped) {
          this._stopped = true;
          this.onIdleTimeout(this);
        }
      }, this.lingerMs);
    }
  }

  /** Non-synthetic attachments; the set `assignTiers` and the AIMD controller operate on. */
  interactiveAttachments(): Attachment[] {
    return [...this.attachments].filter((a) => !a.synthetic);
  }

  /** Forcibly stops the stream (e.g. the owning Session tearing down), regardless of attachment count or linger state. */
  forceStop(): void {
    if (this.lingerTimer) {
      this.clock.clearTimer(this.lingerTimer);
      this.lingerTimer = null;
    }
    this._stopped = true;
  }
}

/** Constructs a fresh `Stream` for `key`. */
export function createStream(opts: StreamOptions): Stream {
  return new Stream(opts);
}
