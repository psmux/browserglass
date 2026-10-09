import { type DecodedBinaryFrame, PayloadCodec } from '@browserglass/protocol';
import type {
  AckInfo,
  CanvasFit,
  CanvasRendererOptions,
  ClientPoint,
  FramePoint,
  FrameSize,
  RendererStats,
  RendererStreamInfo,
} from './types.js';

/** Resolved options with every default filled in. */
type ResolvedOptions = Required<
  Pick<
    CanvasRendererOptions,
    | 'fit'
    | 'smoothing'
    | 'maxDecodeQueue'
    | 'letterboxColour'
    | 'dpr'
    | 'dim'
    | 'greyscale'
    | 'decodeStuckMs'
  >
> &
  Pick<CanvasRendererOptions, 'onPaint' | 'onAck'>;

const DEFAULT_OPTIONS: Omit<ResolvedOptions, 'onPaint' | 'onAck'> = {
  fit: 'contain',
  smoothing: true,
  maxDecodeQueue: 2,
  letterboxColour: 'transparent',
  dpr: 'ignore',
  dim: 1,
  greyscale: false,
  decodeStuckMs: 5000,
};

/** Maps a wire `payloadCodec` byte to the MIME type `createImageBitmap` needs. Returns `null` for codecs this renderer does not decode via `createImageBitmap` (the video range, `0x10` and above, is a v1.1 WebCodecs path, out of scope here). */
function mimeForCodec(codec: number): string | null {
  switch (codec) {
    case PayloadCodec.JPEG:
      return 'image/jpeg';
    case PayloadCodec.PNG:
      return 'image/png';
    case PayloadCodec.WEBP:
      return 'image/webp';
    case PayloadCodec.AVIF:
      return 'image/avif';
    default:
      return null;
  }
}

/** Monotonic clock in milliseconds, matching `performance.now()`. */
function nowMs(): number {
  return performance.now();
}

/** One frame accepted by `push()`, queued for decode. Stamped with the target generation it was accepted against, at accept time. */
interface PendingJob {
  seq: number;
  gen: number;
  payloadCodec: number;
  payload: Uint8Array;
}

/**
 * Owns one `<canvas>` and one stream: binary frame decode, three
 * independent staleness checks, backpressure, paint scheduling, letterbox
 * layout, and the client half of the coordinate transform. Nothing else in
 * the SDK touches the canvas.
 *
 * `push()` is called by the transport layer on every decoded binary frame
 * for this renderer's stream; apps never call it directly.
 */
export class CanvasRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly opts: ResolvedOptions;
  private readonly resizeObserver: { observe: (t: Element) => void; disconnect: () => void } | null;

  private streamId: number | null = null;
  private gen = 0;

  private lastAcceptedSeq = 0;
  private lastPaintedSeq = 0;
  private pending: PendingJob | null = null;
  private decodesInFlight = 0;

  private nextBitmap: ImageBitmap | null = null;
  private nextSeq = 0;
  private nextDecodeMs = 0;

  private retainedBitmap: ImageBitmap | null = null;

  private rafId = 0;
  private rafScheduledAt = 0;

  private destroyed = false;

  private readonly _stats: RendererStats = {
    droppedStaleGen: 0,
    droppedOutOfOrder: 0,
    droppedCoalesced: 0,
    droppedStalePostDecode: 0,
    decodeErrors: 0,
    decodeStuck: 0,
    framesPainted: 0,
    lastDecodeMs: 0,
    lastPaintedSeq: 0,
  };

  /**
   * @param canvas The canvas the renderer draws into.
   * @param container The layout box the canvas is letterboxed or covered
   * against. Distinct from `canvas` on purpose: do
   * not infer `canvas.parentElement`, callers may nest the canvas inside
   * wrapper elements the renderer must not assume away.
   */
  constructor(canvas: HTMLCanvasElement, container: HTMLElement, options?: CanvasRendererOptions) {
    this.canvas = canvas;
    this.container = container;
    this.opts = { ...DEFAULT_OPTIONS, ...options };

    // Never { desynchronized: true }: it promotes the canvas to its own
    // compositing layer and every sibling overlay then renders behind it
    // regardless of z-index. This renderer never
    // requests it, but the assertion guards against a runtime that hands one
    // back anyway.
    const ctx = canvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | null;
    if (!ctx) {
      throw new Error('BrowserGlass: CanvasRenderer could not acquire a 2D rendering context.');
    }
    const attrs = ctx.getContextAttributes?.();
    if (attrs?.desynchronized === true) {
      throw new Error(
        'BrowserGlass: canvas 2D context reports desynchronized:true. This promotes the canvas to its ' +
          'own compositing layer, so every overlay would render behind it regardless of z-index.',
      );
    }
    this.ctx = ctx;
    this.ctx.imageSmoothingEnabled = this.opts.smoothing;
    this.applyFilter();

    if (this.opts.letterboxColour !== 'transparent') {
      this.container.style.backgroundColor = this.opts.letterboxColour;
    }

    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.applyLayout());
      this.resizeObserver.observe(this.container);
    } else {
      this.resizeObserver = null;
    }
  }

  /**
   * Rebuilds the renderer's stream binding and target generation after a
   * `stream.subscribed` (including a re-emitted one). Resets the sequence
   * counters, because a `sidEpoch` bump (which every `stream.subscribed`
   * re-emission carries) resets `seq` numbering on the wire.
   */
  reconfigure(info: RendererStreamInfo): void {
    const firstConfigure = this.streamId === null;
    this.streamId = info.streamId;
    this.gen = info.gen;
    this.lastAcceptedSeq = 0;
    this.lastPaintedSeq = 0;
    this._stats.lastPaintedSeq = 0;
    if (firstConfigure) {
      this.canvas.width = info.width;
      this.canvas.height = info.height;
      this.applyLayout();
    }
  }

  /**
   * Accepts one decoded binary frame. Runs on the socket message handler
   * and must do almost nothing: the `gen16` staleness check happens before
   * any allocation. Frames for a different stream are ignored entirely
   * (the correct renderer's `push()` handles and acks them).
   */
  push(frame: DecodedBinaryFrame): void {
    if (this.destroyed) return;
    if (frame.streamId !== this.streamId) return;

    // Staleness check 1 of 3: gen16 mismatch on receipt, before decode.
    if (frame.gen16 !== (this.gen & 0xffff)) {
      this._stats.droppedStaleGen++;
      this.ack(frame.seq);
      return;
    }
    if (frame.seq <= this.lastAcceptedSeq) {
      this._stats.droppedOutOfOrder++;
      this.ack(frame.seq);
      return;
    }
    this.lastAcceptedSeq = frame.seq;

    // The pending slot is depth 1, newest wins: a frame it evicts here was
    // never decoded, so it is acked now rather than silently vanishing,
    // which is what keeps the server's cumulative backlog arithmetic
    // correct under sustained backpressure.
    if (this.pending) {
      this._stats.droppedCoalesced++;
      this.ack(this.pending.seq);
    }
    this.pending = {
      seq: frame.seq,
      gen: this.gen,
      payloadCodec: frame.payloadCodec,
      payload: frame.payload,
    };
    this.pump();
  }

  /** Drains the pending slot into a decode, bounded by `maxDecodeQueue` in-flight decodes. */
  private pump(): void {
    if (this.destroyed) return;
    if (this.decodesInFlight >= this.opts.maxDecodeQueue) return;
    const job = this.pending;
    if (!job) return;
    this.pending = null;
    this.decodesInFlight++;

    const mime = mimeForCodec(job.payloadCodec);
    if (!mime) {
      this.decodesInFlight--;
      this._stats.decodeErrors++;
      this.ack(job.seq);
      this.pump();
      return;
    }

    let settled = false;
    const t0 = nowMs();
    const stuckTimer =
      this.opts.decodeStuckMs > 0
        ? setTimeout(() => {
            if (settled) return;
            settled = true;
            this.decodesInFlight--;
            this._stats.decodeStuck++;
            this.ack(job.seq);
            this.pump();
          }, this.opts.decodeStuckMs)
        : 0;

    const blob = new Blob([job.payload as BlobPart], { type: mime });
    createImageBitmap(blob).then(
      (bitmap) => {
        // A decode the stuck timer already wrote off must not be acted on
        // twice: the bitmap it produced is simply released.
        if (settled) {
          bitmap.close();
          return;
        }
        settled = true;
        if (stuckTimer) clearTimeout(stuckTimer);
        const decodeMs = nowMs() - t0;
        this.decodesInFlight--;
        this._stats.lastDecodeMs = decodeMs;

        // Staleness check 2 of 3: the target generation moved while this
        // frame was decoding.
        if (job.gen !== this.gen) {
          bitmap.close();
          this._stats.droppedStalePostDecode++;
          this.ack(job.seq);
          this.pump();
          return;
        }
        // Staleness check 3 of 3: two concurrent decodes can settle in
        // either order; a later-numbered frame already painted makes this
        // one moot.
        if (job.seq <= this.lastPaintedSeq) {
          bitmap.close();
          this._stats.droppedStalePostDecode++;
          this.ack(job.seq);
          this.pump();
          return;
        }

        if (this.nextBitmap) this.nextBitmap.close();
        this.nextBitmap = bitmap;
        this.nextSeq = job.seq;
        this.nextDecodeMs = decodeMs;
        this.schedulePaint();
        // Ack is sent after decode, carrying the measured decodeMs: acking
        // on receipt would report a healthy RTT while the client falls
        // behind, and the server's adaptation controller has no other
        // source for decodeMs.
        this.ack(job.seq, decodeMs);
        this.pump();
      },
      () => {
        if (settled) return;
        settled = true;
        if (stuckTimer) clearTimeout(stuckTimer);
        this.decodesInFlight--;
        this._stats.decodeErrors++;
        this.ack(job.seq);
        this.pump();
      },
    );
  }

  /** Reports a frame `push()`/`pump()` has finished with, via `onAck`. Every path that consumes a `seq` calls this exactly once. */
  private ack(seq: number, decodeMs?: number): void {
    const info: AckInfo = decodeMs === undefined ? { seq } : { seq, decodeMs };
    this.opts.onAck?.(info);
  }

  /**
   * Schedules a paint on the next animation frame. Includes the rAF
   * self-heal guard: a scheduled rAF that never fires (a hidden tab, an
   * occluded element, a missed cancellation) would otherwise wedge painting
   * forever across tab switches, so a request older than 1000ms is treated
   * as abandoned and replaced rather than trusted.
   */
  private schedulePaint(): void {
    if (this.destroyed) return;
    if (this.rafId) {
      if (nowMs() - this.rafScheduledAt < 1000) return;
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.rafScheduledAt = nowMs();
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      const bitmap = this.nextBitmap;
      if (!bitmap) return;
      this.nextBitmap = null;
      const seq = this.nextSeq;
      const decodeMs = this.nextDecodeMs;
      if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
        this.canvas.width = bitmap.width; // clears the canvas
        this.canvas.height = bitmap.height;
        this.ctx.imageSmoothingEnabled = this.opts.smoothing;
        this.applyLayout();
      }
      this.ctx.drawImage(bitmap, 0, 0);
      this.lastPaintedSeq = seq;
      this._stats.lastPaintedSeq = seq;
      this._stats.framesPainted++;
      if (this.retainedBitmap) this.retainedBitmap.close();
      this.retainedBitmap = bitmap; // retained for dimmed reconnect display
      this.opts.onPaint?.({ seq, decodeMs, width: bitmap.width, height: bitmap.height });
    });
  }

  /**
   * Recomputes the canvas's drawn CSS box against the container: backing
   * store dimensions are the frame bitmap's own pixels; CSS scales the
   * element to fit, cover, or sit at 1:1 depending on `fit`. Letterbox
   * offsets never appear explicitly in the coordinate transform because
   * `getBoundingClientRect()` on the canvas returns this drawn rect with
   * margins already applied.
   */
  private applyLayout(): void {
    const box = this.container.getBoundingClientRect();
    const bw = this.canvas.width;
    const bh = this.canvas.height;
    if (bw === 0 || bh === 0) return;

    let scale: number;
    if (this.opts.fit === 'cover') scale = Math.max(box.width / bw, box.height / bh);
    else if (this.opts.fit === 'fixed') scale = 1;
    else scale = Math.min(box.width / bw, box.height / bh);

    const drawW = bw * scale;
    const drawH = bh * scale;

    this.canvas.style.width = `${drawW}px`;
    this.canvas.style.height = `${drawH}px`;
    this.canvas.style.marginLeft = `${Math.max(0, (box.width - drawW) / 2)}px`;
    this.canvas.style.marginTop = `${Math.max(0, (box.height - drawH) / 2)}px`;
  }

  /**
   * Client CSS pixels to frame space: subtract the canvas's drawn rect
   * origin, then scale by the ratio of backing store pixels to drawn CSS
   * pixels. Exactly the client half of the four operation coordinate
   * transform. Never rounds and never clamps (the server owns
   * both); rejects a non-finite input or a zero-size rect before doing any
   * arithmetic, so neither can put a `NaN` on the wire.
   */
  toFrame(clientX: number, clientY: number): FramePoint {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return { x: 0, y: 0, inside: false };
    }
    const rect = this.canvas.getBoundingClientRect(); // the drawn rect, never the container
    if (rect.width === 0 || rect.height === 0) {
      return { x: 0, y: 0, inside: false };
    }
    const x = (clientX - rect.left) * (this.canvas.width / rect.width);
    const y = (clientY - rect.top) * (this.canvas.height / rect.height);
    const inside = x >= 0 && y >= 0 && x <= this.canvas.width && y <= this.canvas.height;
    return { x, y, inside };
  }

  /** The inverse of {@link toFrame}: frame space back to client CSS pixels. `toClient(toFrame(p)) === p` for every point up to float precision. */
  toClient(x: number, y: number): ClientPoint {
    const rect = this.canvas.getBoundingClientRect();
    if (this.canvas.width === 0 || this.canvas.height === 0) {
      return { clientX: rect.left, clientY: rect.top };
    }
    return {
      clientX: rect.left + x * (rect.width / this.canvas.width),
      clientY: rect.top + y * (rect.height / this.canvas.height),
    };
  }

  /** The frame-space dims the currently painted bitmap actually has, plus the generation those dims belong to. Always read together: never stamp an input message with dimensions from a different frame than the `gen` it names. */
  frameSize(): FrameSize {
    return { fw: this.canvas.width, fh: this.canvas.height, gen: this.gen };
  }

  /** Brightness multiplier applied to the canvas, `1` is normal. Used by the connection state machine to dim the retained frame while reconnecting. */
  setDim(dim: number): void {
    this.opts.dim = dim;
    this.applyFilter();
    this.redraw();
  }

  /** Toggles greyscale rendering, used for the `fatal` connection state. */
  setGreyscale(on: boolean): void {
    this.opts.greyscale = on;
    this.applyFilter();
    this.redraw();
  }

  /** Changes how the bitmap fills its container and reapplies layout immediately. */
  setFit(fit: CanvasFit): void {
    this.opts.fit = fit;
    this.applyLayout();
  }

  private applyFilter(): void {
    const parts: string[] = [];
    if (this.opts.dim !== 1) parts.push(`brightness(${this.opts.dim})`);
    if (this.opts.greyscale) parts.push('grayscale(1)');
    this.ctx.filter = parts.length > 0 ? parts.join(' ') : 'none';
  }

  /** Repaints the retained bitmap with the current dim and greyscale settings, without waiting for a new frame. */
  redraw(): void {
    if (!this.retainedBitmap) return;
    this.ctx.drawImage(this.retainedBitmap, 0, 0);
  }

  /** Releases every held bitmap and blanks the canvas. Only for a closed or destroyed target, never for an ordinary stream pause. */
  clear(): void {
    this.nextBitmap?.close();
    this.nextBitmap = null;
    this.retainedBitmap?.close();
    this.retainedBitmap = null;
    this.ctx.filter = 'none';
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /** The most recently painted bitmap, retained for dimmed reconnect display. `null` before the first paint or after {@link clear}. */
  get lastBitmap(): ImageBitmap | null {
    return this.retainedBitmap;
  }

  /** Running counters for diagnostics and tests. */
  get stats(): RendererStats {
    return this._stats;
  }

  /** Tears the renderer down: cancels any scheduled paint, disconnects the resize observer, and closes every held bitmap. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.resizeObserver?.disconnect();
    this.nextBitmap?.close();
    this.nextBitmap = null;
    this.retainedBitmap?.close();
    this.retainedBitmap = null;
    this.pending = null;
  }
}
