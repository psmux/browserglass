/**
 * Shared types for `@browserglass/core`'s streaming pipeline: the
 * `FrameSource` contract, the raw and sequenced frame shapes, encode tier
 * types, and the transport seam `Attachment` sends through.
 */

import type { TargetId } from '@browserglass/protocol';

/**
 * A codec Chrome (or a server-side transcode) can produce for a captured
 * frame. `'jpeg'` and `'png'` arrive from Chrome already encoded; every
 * other value costs a real server-side decode plus re-encode.
 */
export type FrameCodec = 'jpeg' | 'webp' | 'png' | 'h264' | 'vp9';

/**
 * CDP screencast metadata attached to one frame: the emulated viewport's
 * CSS size, page scale, scroll offset, and Chrome's own timestamp. Distinct
 * from `RawFrame.width`/`.height`, which are the captured bitmap's actual
 * pixel dimensions (`Page.startScreencast`'s `maxWidth`/`maxHeight` is a
 * bounding box, not an exact size).
 */
export interface RawFrameMeta {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  offsetTop: number;
  /** CDP's own timestamp, seconds, float. */
  timestamp: number;
}

/**
 * One captured frame at the source boundary: already decoded from base64
 * (decoding happens exactly once, here, never again downstream), with the
 * actual pixel dimensions of the bytes Chrome produced.
 */
export interface RawFrame {
  /** Encoded image bytes. Never base64 text. */
  bytes: Uint8Array;
  codec: FrameCodec;
  /** Actual pixel width of `bytes`. Chrome's bounding-box scaling means this can differ from the requested spec; read per frame, never assumed. */
  width: number;
  height: number;
  /** Server clock (monotonic) at receipt. */
  capturedAtMs: number;
  meta: RawFrameMeta;
  /** Always `true` for jpeg/webp/png: every captured frame here is a keyframe, since no inter-frame codec is used. */
  keyframe: boolean;
  /** Set by `forceFrame()`; the frame did not come from the screencast callback. */
  forced?: boolean;
}

/** What a `FrameSource` is asked to capture. */
export interface FrameSourceSpec {
  codec: FrameCodec;
  /** 1 to 100; ignored for `png`. */
  quality: number;
  /** Bounding box, not an exact target. */
  maxWidth: number;
  maxHeight: number;
  /** Passed to `Page.startScreencast`; the minimum across a stream's encode tiers. */
  everyNthFrame: number;
}

/**
 * One capture pipeline for one `(Session, targetId)`. `CdpScreencastSource`
 * is the primary implementation; `ScreenshotPollSource` is the fallback,
 * used standalone when CDP is unavailable and as a supplement alongside a
 * healthy screencast when the renderer is too busy to repaint.
 */
export interface FrameSource {
  readonly kind: 'cdp-screencast' | 'screenshot-poll' | 'webcodecs' | 'webrtc';
  readonly healthy: boolean;
  readonly lastFrameAtMs: number;

  start(spec: FrameSourceSpec, onFrame: (f: RawFrame) => void): Promise<void>;
  reconfigure(spec: Partial<FrameSourceSpec>): Promise<void>;
  /** One-shot capture, injected through the same `onFrame` callback as a normal frame. Returns `false` if the capture failed. */
  forceFrame(): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * A `RawFrame` promoted to a stream's own identity: sequenced, generation
 * stamped, and given a header-relative timestamp.
 */
export interface SequencedFrame extends RawFrame {
  /** The wire `streamId` this frame belongs to; `0` is never a valid value here, that is the session-scoped sentinel. */
  streamId: number;
  /** Monotonic within `(streamId, gen)`, starts at 1, never reused within a generation. */
  seq: number;
  /** Full-width target generation; only the low 16 bits travel in the binary header. */
  gen: number;
  /** Milliseconds since this stream's `sidEpoch` base. */
  tsDeltaMs: number;
}

/** One quality tier's encode configuration. */
export interface EncodeSpec {
  codec: 'jpeg' | 'webp' | 'png';
  /** 1 to 100; ignored for `png`. */
  quality: number;
  maxWidth: number;
  maxHeight: number;
  /** Emit-side skip: a frame is only encoded and sent for this tier when `seq % emitEveryNth === 0`. */
  emitEveryNth: number;
}

/** One of a stream's at-most-`K` encoded variants for the current frame. */
export interface EncodeTier {
  /** `0` is the best tier in this stream's current set; the last index is the worst. */
  index: number;
  spec: EncodeSpec;
  /** Filled per frame, shared and immutable across every attachment in this tier. `null` when this frame's encode failed. */
  buffer: Uint8Array | null;
  attachmentCount: number;
}

/** A stream's current bounded set of encode tiers, at most `k`. */
export interface EncodeTierSet {
  streamId: number;
  /** Configured max, default 2. */
  k: number;
  tiers: EncodeTier[];
}

/**
 * The minimal transport contract `fanOut` needs from a viewer's socket:
 * open/closed state, outstanding buffered bytes, and a raw send. No
 * per-viewer copy: `send` always receives a tier's shared buffer.
 */
export interface AttachmentTransport {
  isOpen(): boolean;
  bufferedAmount(): number;
  /**
   * Sends one frame. `seq` is the seq of the frame these bytes belong to,
   * the same value the caller passes to `Attachment.onSent` right after.
   * A socket transport can ignore it (the seq is in the header already);
   * a recorder needs it, because by the time an encode finishes the
   * owning `Stream.seq` may already have moved on to a later frame.
   */
  send(buf: Uint8Array, seq?: number): void;
}

/** One frame-encode-and-send-fan-out's outcome. */
export interface FanOutResult {
  sent: number;
  skipped: number;
  /** Sent count per tier index. */
  byTier: Int32Array;
}

/**
 * A parameterised thumbnail profile: one shape for a concept that would
 * otherwise be parameterised four different ways. Thumbnails
 * never participate in tier bucketing or adaptation, and never count
 * toward live-stream caps.
 */
export interface ThumbnailSpec {
  intervalMs: number;
  maxWidth: number;
  maxHeight: number;
  quality: number;
  maxBacklog: number;
}

/** A target's stream identity tuple: `(sessionId, targetId, mode)`. */
export interface StreamKey {
  sessionId: string;
  targetId: TargetId;
  mode: 'live' | 'thumbnail';
}
