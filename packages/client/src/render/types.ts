/**
 * How the bitmap fills its container.
 *
 * `'contain'` letterboxes: the bitmap is scaled to fit entirely inside the
 * container, centred, with bars on the shorter axis. `'cover'` crops: the
 * bitmap is scaled to fill the container, overflowing on the shorter axis.
 * `'fixed'` draws at a 1:1 device pixel ratio with no scaling; the container
 * is expected to scroll.
 */
export type CanvasFit = 'contain' | 'cover' | 'fixed';

/**
 * How the renderer's backing store relates to the viewer's device pixel
 * ratio. `'ignore'` (the default) sizes the canvas backing store to the
 * decoded frame bitmap and lets CSS scale it, which is correct in the
 * overwhelming majority of cases. `'match'` requests a device pixel ratio
 * scaled frame from the server via a larger `maxWidth`/`maxHeight`; the
 * resulting bitmap is bigger and flows through the same transform with no
 * separate multiplier (there is no DPR multiplier
 * anywhere in the coordinate transform, in either mode).
 */
export type DprMode = 'ignore' | 'match';

/**
 * Construction options for {@link CanvasRenderer}. All fields are optional;
 * defaults are documented per field.
 */
export interface CanvasRendererOptions {
  /** Default `'contain'`. */
  fit?: CanvasFit;
  /** Default `true`. `false` selects nearest neighbour scaling. */
  smoothing?: boolean;
  /**
   * Depth of the decode pipeline. Default `2`. This is the backpressure
   * mechanism, not a performance knob: `1` serialises decode of frame N
   * with arrival of frame N+1 (adds a full decode of latency per frame).
   * `3` or more absorbs the very signal backpressure needs to measure, a
   * deep queue lets the client keep acking promptly while falling behind,
   * so the server's ack RTT estimate stays artificially low and adaptation
   * never learns the client is struggling.
   */
  maxDecodeQueue?: number;
  /** CSS colour for the container background revealed by letterbox bars. Default `'transparent'`. */
  letterboxColour?: string;
  /** Default `'ignore'`. See {@link DprMode}. */
  dpr?: DprMode;
  /** Brightness multiplier applied to the painted bitmap, `1` is normal. Default `1`. */
  dim?: number;
  /** Renders the painted bitmap in greyscale. Default `false`. */
  greyscale?: boolean;
  /**
   * Milliseconds after which a decode that has not settled is written off:
   * the in-flight counter is decremented, a warning is logged, the frame is
   * still acked, and the pipeline continues. Default `5000`. A leaked
   * in-flight counter must never be able to wedge the stream permanently.
   */
  decodeStuckMs?: number;
  /** Called once per painted frame, after the paint has happened. */
  onPaint?: (info: PaintInfo) => void;
  /**
   * Called for every frame `push()` takes responsibility for, exactly once,
   * whether it is painted, dropped for staleness, or fails to decode. This
   * is the bridge point to the transport layer's wire `ack` message: every
   * path acks, including every drop path, because the server's backlog
   * arithmetic is cumulative and an unacked frame counts against the
   * viewer until the socket dies.
   */
  onAck?: (info: AckInfo) => void;
}

/** Payload of {@link CanvasRendererOptions.onPaint}. */
export interface PaintInfo {
  seq: number;
  decodeMs: number;
  width: number;
  height: number;
}

/** Payload of {@link CanvasRendererOptions.onAck}. `decodeMs` is present only when the frame was actually decoded. */
export interface AckInfo {
  seq: number;
  decodeMs?: number;
}

/**
 * The subset of a `stream.subscribed` (or re-emitted `stream.subscribed`
 * after a reconfigure) message {@link CanvasRenderer.reconfigure} needs:
 * the wire stream handle, the target generation the stream is bound to, and
 * the frame bitmap's advertised dimensions.
 */
export interface RendererStreamInfo {
  /** Wire `streamId`. Frames for any other stream are ignored by `push()`. */
  streamId: number;
  /** Target generation this stream is currently bound to. */
  gen: number;
  /** Frame bitmap width, device px. */
  width: number;
  /** Frame bitmap height, device px. */
  height: number;
}

/** Running counters exposed via {@link CanvasRenderer.stats}. */
export interface RendererStats {
  /** Frames dropped on receipt for a `gen16` mismatch (stale before decode). */
  droppedStaleGen: number;
  /** Frames dropped on receipt for a non-increasing `seq` (stale before decode). */
  droppedOutOfOrder: number;
  /** Frames evicted from the depth-1 pending slot by a newer arrival before they were ever decoded. */
  droppedCoalesced: number;
  /** Frames whose decode settled after the frame was already superseded (stale `gen` or `seq` after decode). */
  droppedStalePostDecode: number;
  /** Decodes that rejected. */
  decodeErrors: number;
  /** Decodes written off after {@link CanvasRendererOptions.decodeStuckMs}. */
  decodeStuck: number;
  /** Frames actually painted to the canvas. */
  framesPainted: number;
  /** `decodeMs` of the most recently completed decode, `0` if none yet. */
  lastDecodeMs: number;
  /** `seq` of the most recently painted frame, `0` if none yet. */
  lastPaintedSeq: number;
}

/**
 * A point in frame space (the decoded bitmap's own pixel grid) with an
 * `inside` flag reporting whether it fell within the canvas's drawn rect.
 */
export interface FramePoint {
  x: number;
  y: number;
  inside: boolean;
}

/** A point back in the viewer's client CSS pixel space. */
export interface ClientPoint {
  clientX: number;
  clientY: number;
}

/** The three values every input message stamps to address itself to a frame and generation. Always read together (`frameSize()`), never apart, so a message is never stamped with dimensions from a different frame than the `gen` it names. */
export interface FrameSize {
  fw: number;
  fh: number;
  gen: number;
}
