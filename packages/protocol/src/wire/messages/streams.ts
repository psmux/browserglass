import type { Envelope } from '../envelope.js';

/**
 * The wire quality-profile enum. This is a ladder seed and clamp applied
 * per `Attachment`, not a stream identity key; the
 * L0 to L7 encode ladder lives in `@browserglass/core` and never appears
 * on the wire.
 */
export type QualityProfile = 'low' | 'medium' | 'high' | 'auto';

/** Frame and stream codecs negotiable over `bgls.v1`. */
export type Codec = 'jpeg' | 'webp' | 'avif' | 'png' | 'h264' | 'vp9';

/** C to S: subscribe a viewer socket to a Target's stream. */
export interface StreamSubscribe extends Envelope {
  t: 'stream.subscribe';
  targetId: string;
  /** Default `'auto'`. */
  quality?: QualityProfile;
  /** Default: the negotiated `welcome.streaming.codec`. */
  codec?: Codec;
  /** Default: `welcome.streaming.maxFps`. */
  maxFps?: number;
  /** Encode-side downscale hint, CSS px. */
  maxWidth?: number;
  maxHeight?: number;
  /** Subscribe as a low-cost thumbnail stream. */
  thumbnail?: boolean;
  /** Subscribe but start paused. */
  paused?: boolean;
}

/** S to C: acknowledges a subscription and carries the stream's wire handle. */
export interface StreamSubscribed extends Envelope {
  t: 'stream.subscribed';
  /** u16, unique per socket, server assigned, starts at 1; `0` is reserved for session-scoped binary messages. */
  streamId: number;
  targetId: string;
  quality: QualityProfile;
  codec: Codec;
  fps: number;
  /** Frame bitmap width, device px. */
  width: number;
  height: number;
  dpr: number;
  paused: boolean;
  /** Increments on every reconfigure (geometry/codec change, resize, recovery, `streamId` reuse, every resume). */
  sidEpoch: number;
  /** Target generation this stream is bound to. */
  gen: number;
}

/** C to S: end a subscription. Silent, no reply. */
export interface StreamUnsubscribe extends Envelope {
  t: 'stream.unsubscribe';
  streamId: number;
}

/**
 * C to S: pause frame delivery for a stream without unsubscribing.
 * Accepted no-op for now: ws/connection.ts's handler is
 * `() => undefined`, so the message is acknowledged (no error reply) but
 * frame delivery is not actually paused.
 */
export interface StreamPause extends Envelope {
  t: 'stream.pause';
  streamId: number;
}

/**
 * C to S: resume a paused stream; the server answers with a fresh
 * keyframe. Accepted no-op for now, same as `stream.pause`: the
 * handler does nothing, so there is nothing to resume and no keyframe is
 * actually sent.
 */
export interface StreamResume extends Envelope {
  t: 'stream.resume';
  streamId: number;
}

/** C to S: request a reconfiguration of an existing stream. Answered with a re-emitted `stream.subscribed` carrying a bumped `sidEpoch`. */
export interface StreamQuality extends Envelope {
  t: 'stream.quality';
  streamId: number;
  quality?: QualityProfile;
  codec?: Codec;
  maxFps?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** S to C, periodic (default every `statsIntervalMs`, 2000ms). */
export interface StreamStats extends Envelope {
  t: 'stream.stats';
  streamId: number;
  fpsSent: number;
  fpsDropped: number;
  bytesPerSec: number;
  avgFrameBytes: number;
  backlog: number;
  bufferedBytes: number;
  encodeMsP50: number;
  encodeMsP95: number;
  rttMs: number;
  quality: QualityProfile;
  codec: Codec;
  adaptedReason?: 'backlog' | 'rtt' | 'cpu' | 'bandwidth' | 'manual' | 'idle';
}

/**
 * S to C: a stream has been demoted for a structural reason (controller
 * floor, a slow consumer, the viewer live-stream cap, the session pixel
 * budget, or the node encode budget). Added later than the rest of the
 * catalogue, which is legal because a new message type is not a breaking wire change. Defined
 * but never constructed anywhere in packages/server/src yet:
 * the adaptive controller that would emit it has not shipped.
 */
export interface StreamDegraded extends Envelope {
  t: 'stream.degraded';
  streamId: number;
  mode: 'live' | 'thumbnail';
  reason:
    | 'controller-floor'
    | 'slow-consumer'
    | 'viewer-live-cap'
    | 'session-pixel-budget'
    | 'node-encode-budget';
}

/** C to S: acknowledges frames processed on a stream. `seq` is cumulative: the highest contiguous seq processed. */
export interface Ack extends Envelope {
  t: 'ack';
  streamId: number;
  seq: number;
  recvTs?: number;
  /** Client decode plus paint time; used by the server's adaptation controller. */
  decodeMs?: number;
}

/** C to S: request an out-of-band keyframe on a stream. */
export interface KeyframeRequest extends Envelope {
  t: 'keyframe.request';
  streamId: number;
  reason?: string;
}
