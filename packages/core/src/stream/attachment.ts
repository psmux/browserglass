/**
 * `Attachment`: one viewer's subscription to one `Stream`, its ack-window
 * bookkeeping, and `fanOut`, the per-frame send loop. The `dropRate` rule
 * is applied at the call site, never inside `fanOut` itself: `fanOut` only
 * ever increments `skipStreak` for the two backpressure checks, exactly the
 * set `dropRate` must be computed from.
 */

import { monotonicNow } from '../cdp/platform.js';
import type { LadderLevel } from './quality-ladder.js';
import type { AttachmentTransport, EncodeTier, FanOutResult, SequencedFrame } from './types.js';

/** Constructor options for {@link Attachment}. */
export interface AttachmentOptions {
  viewerId: string;
  streamId: number;
  transport: AttachmentTransport;
  /** Default 3 (thumbnail attachments pass 1). */
  maxBacklog?: number;
  /** Default 2 MiB. */
  maxBufferedBytes?: number;
  /** Seed ladder level, from the wire `QualityProfile` mapping. Default `L2`. */
  desiredLevel?: LadderLevel;
  /** True for a recorder or other non-interactive consumer; filtered out of tier-level computation. */
  synthetic?: boolean;
  /** True while this attachment's viewer holds the target's `ControlLease`; pins tier 0 and floors the level. */
  isLeaseHolder?: boolean;
  now?: () => number;
}

/** One `Attachment`'s live adaptive-controller state, read and written by `step()` in `adaptive-controller.ts`. */
export interface AttachmentAdaptiveState {
  desiredLevel: LadderLevel;
  goodWindows: number;
  cooldownUntil: number;
  lastLevelChangeAt: number;
}

/**
 * One viewer's subscription to one `Stream`. Owns its own ack window
 * (`backlog`, `sentAtBySeq`), its own tier assignment, and its own adaptive
 * state; two attachments on the same `Stream` never share any of this.
 */
export class Attachment {
  readonly viewerId: string;
  readonly streamId: number;
  readonly transport: AttachmentTransport;
  readonly maxBacklog: number;
  readonly maxBufferedBytes: number;
  readonly synthetic: boolean;
  isLeaseHolder: boolean;

  /** Which tier of the stream's current `EncodeTierSet` this attachment reads from. Never better than `desiredLevel` would justify. */
  tierIndex = 0;

  lastSentSeq = 0;
  lastAckedSeq = 0;
  /** Sent but unacked, counted in frames, not seq-delta. */
  backlog = 0;
  bytesInFlight = 0;
  ackRttEmaMs = 0;
  decodeMsEma = 0;
  bufferedBytesEma = 0;
  /**
   * Consecutive frames skipped for *backpressure* reasons only (backlog or
   * bufferedAmount over the limit). `emitEveryNth`
   * skips and encode-failure skips never touch this counter, which is what
   * lets an L7 attachment (75 percent of frames legitimately unsent by
   * design) still read as healthy and climb back.
   */
  skipStreak = 0;
  /** Bounded to `maxBacklog` entries by construction: every `onAck` drains every entry at or below the acked seq. */
  readonly sentAtBySeq = new Map<number, number>();

  /**
   * Cumulative count of frames actually sent to this attachment. Never
   * reset, never decremented; a caller that wants a per-interval rate (the
   * wire `stream.stats` message's `fpsSent`) diffs two readings against its own elapsed time
   * rather than this class tracking a window itself, matching how
   * `lastSentSeq` already works.
   */
  sentCount = 0;
  /**
   * Cumulative bytes actually sent to this attachment (the framed buffer's
   * full byte length, header included). Never reset; diffed the same way
   * as {@link sentCount} to derive `stream.stats`'s `bytesPerSec` and
   * `avgFrameBytes`.
   */
  bytesSentTotal = 0;
  /**
   * Cumulative count of frames skipped for this attachment for a
   * *backpressure* reason only, mirroring `dropRate`'s own scope
   * (backlog or bufferedAmount over the limit; never an `emitEveryNth` skip
   * or an encode failure). Never reset; diffed to derive `stream.stats`'s
   * `fpsDropped`.
   */
  backpressureDropCount = 0;

  /** The rolling 2-second `dropRate` window's raw counts (backpressure skips only). */
  private windowSent = 0;
  private windowSkipped = 0;
  private windowResetAt: number;
  dropRate = 0;

  readonly adaptive: AttachmentAdaptiveState;

  private readonly now: () => number;

  constructor(opts: AttachmentOptions) {
    this.viewerId = opts.viewerId;
    this.streamId = opts.streamId;
    this.transport = opts.transport;
    this.maxBacklog = opts.maxBacklog ?? 3;
    this.maxBufferedBytes = opts.maxBufferedBytes ?? 2 * 1024 * 1024;
    this.synthetic = opts.synthetic ?? false;
    this.isLeaseHolder = opts.isLeaseHolder ?? false;
    this.now = opts.now ?? monotonicNow;
    const nowMs = this.now();
    this.windowResetAt = nowMs;
    this.adaptive = {
      desiredLevel: opts.desiredLevel ?? 2,
      goodWindows: 0,
      cooldownUntil: 0,
      // -Infinity, not `nowMs`: a freshly constructed attachment must be
      // immediately eligible for its first AIMD evaluation. Seeding this at
      // construction time would otherwise make `step()`'s `minDwellMs` gate
      // (measured against `lastLevelChangeAt`) block the very first call.
      lastLevelChangeAt: Number.NEGATIVE_INFINITY,
    };
  }

  /** The attachment's requested ladder level; a thin accessor over `adaptive.desiredLevel`. */
  get desiredLevel(): LadderLevel {
    return this.adaptive.desiredLevel;
  }

  /** Called by `fanOut` on a successful send. */
  onSent(seq: number, bytes: number): void {
    this.lastSentSeq = seq;
    this.backlog += 1;
    this.bytesInFlight += bytes;
    this.sentAtBySeq.set(seq, this.now());
    this.recordWindow(true);
    this.skipStreak = 0;
    this.sentCount += 1;
    this.bytesSentTotal += bytes;
  }

  /** Called by `fanOut` on a backpressure skip (backlog or bufferedAmount over the limit). Never called for an `emitEveryNth` skip or an encode failure. */
  onBackpressureSkip(): void {
    this.skipStreak += 1;
    this.recordWindow(false);
    this.backpressureDropCount += 1;
  }

  private recordWindow(sent: boolean): void {
    const nowMs = this.now();
    if (nowMs - this.windowResetAt >= 2000) {
      this.windowSent = 0;
      this.windowSkipped = 0;
      this.windowResetAt = nowMs;
    }
    if (sent) {
      this.windowSent += 1;
    } else {
      this.windowSkipped += 1;
    }
    const total = this.windowSent + this.windowSkipped;
    this.dropRate = total === 0 ? 0 : this.windowSkipped / total;
  }

  /**
   * Cumulative ack: acking `seq` acks everything at or below it. Decrements
   * `backlog` by the number of `sentAtBySeq` entries actually drained, not
   * by the seq delta (a seq-delta decrement over-counts when frames were
   * skipped for this attachment, a bug in an earlier design).
   */
  onAck(seq: number, decodeMs?: number): void {
    if (seq <= this.lastAckedSeq) {
      return;
    }
    const sentAt = this.sentAtBySeq.get(seq);
    if (sentAt !== undefined) {
      const rtt = this.now() - sentAt;
      this.ackRttEmaMs = this.ackRttEmaMs === 0 ? rtt : 0.2 * rtt + 0.8 * this.ackRttEmaMs;
    }

    let drained = 0;
    for (const s of [...this.sentAtBySeq.keys()]) {
      if (s <= seq) {
        this.sentAtBySeq.delete(s);
        drained += 1;
      }
    }
    this.backlog = Math.max(0, this.backlog - drained);
    this.lastAckedSeq = seq;
    if (decodeMs !== undefined) {
      this.decodeMsEma =
        this.decodeMsEma === 0 ? decodeMs : 0.2 * decodeMs + 0.8 * this.decodeMsEma;
    }
  }

  /** Updates the buffered-bytes EMA from the transport's current reading, for the adaptive controller's fourth signal. */
  sampleBufferedBytes(): void {
    const buffered = this.transport.bufferedAmount();
    this.bufferedBytesEma =
      this.bufferedBytesEma === 0 ? buffered : 0.2 * buffered + 0.8 * this.bufferedBytesEma;
  }
}

/**
 * The fan-out gate: five checks in the stated order, cheapest first
 * (transport open, backlog, bufferedAmount, emit-skip, buffer-null). No
 * `await` anywhere in this loop; zero allocation in the loop body (the
 * `byTier` array is allocated once per call, not per attachment). A
 * skipped frame is dropped, never queued: there is no per-attachment ring
 * buffer.
 */
export function fanOut(
  attachments: readonly Attachment[],
  frame: SequencedFrame,
  tiers: readonly EncodeTier[],
): FanOutResult {
  let sent = 0;
  let skipped = 0;
  const byTier = new Int32Array(tiers.length);

  for (const att of attachments) {
    if (!att.transport.isOpen()) {
      skipped += 1;
      continue;
    }
    if (att.backlog >= att.maxBacklog) {
      skipped += 1;
      att.onBackpressureSkip();
      continue;
    }
    if (att.transport.bufferedAmount() >= att.maxBufferedBytes) {
      skipped += 1;
      att.onBackpressureSkip();
      continue;
    }
    const tier = tiers[att.tierIndex];
    if (!tier) {
      skipped += 1;
      continue;
    }
    if (frame.seq % tier.spec.emitEveryNth !== 0) {
      skipped += 1;
      continue;
    }
    if (tier.buffer === null) {
      skipped += 1;
      continue;
    }
    att.transport.send(tier.buffer, frame.seq);
    att.onSent(frame.seq, tier.buffer.byteLength);
    sent += 1;
    const bucket = byTier[att.tierIndex];
    byTier[att.tierIndex] = (bucket ?? 0) + 1;
  }

  return { sent, skipped, byTier };
}
