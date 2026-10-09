import type { Codec, QualityProfile } from '@browserglass/protocol';
import {
  type AckInfo,
  CanvasRenderer,
  type CanvasRendererOptions,
  type PaintInfo,
  type RendererStats,
} from '../render/index.js';
import { Emitter, type Unsubscribe } from '../transport/emitter.js';
import type { QualityOptions, StreamEvents, StreamInfo, StreamStats } from './types.js';

/** The operations {@link StreamHandleImpl} needs from {@link BrowserGlassClient}, kept narrow so this file has no import cycle with the class that owns it. */
export interface StreamHost {
  unsubscribe(streamId: number): Promise<void>;
  setQuality(streamId: number, opts: QualityOptions): Promise<StreamInfo>;
  pauseStream(streamId: number): Promise<void>;
  resumeStream(streamId: number): Promise<void>;
  /** Sends the wire `ack` for one consumed `seq`, and clears any bookkeeping the client keyed on it (see `keyframeFlagFor`). */
  ackFrame(streamId: number, seq: number, decodeMs?: number): void;
  /** Whether the frame at `seq` (on `streamId`) carried the `KEYFRAME` flag on receipt, read once at paint time. `BrowserGlassClient` tracks this from the raw binary header, since `CanvasRenderer.push()`'s decoded frame does not surface it through to `onPaint`. */
  keyframeFlagFor(streamId: number, seq: number): boolean;
}

/**
 * Which {@link StreamEvents.dropped} reason best explains a `RendererStats`
 * delta between two snapshots. The four-value `dropped.reason` union
 * is coarser than `CanvasRenderer`'s six drop counters; `stale-gen` and
 * `out-of-order` map straight across (both are pre-decode receipt
 * rejections), `queue-full` is the depth-1 pending slot's coalescing
 * eviction, and every post-decode staleness case (superseded generation,
 * superseded seq, a decode error, or a written-off stuck decode) collapses
 * to `'superseded'`: by the time any of those settle, the frame is moot
 * for the same reason, just discovered later.
 */
function diffDropReason(
  prev: RendererStats,
  next: RendererStats,
): StreamEvents['dropped']['reason'] {
  if (next.droppedStaleGen > prev.droppedStaleGen) return 'stale-gen';
  if (next.droppedOutOfOrder > prev.droppedOutOfOrder) return 'out-of-order';
  if (next.droppedCoalesced > prev.droppedCoalesced) return 'queue-full';
  return 'superseded';
}

/**
 * Client-side handle for one subscription. Owns the
 * {@link CanvasRenderer} once `attach()` is called, the info mirror kept in
 * sync with every `stream.subscribed`/re-emission, and per-stream events.
 * Constructed and tracked only by {@link BrowserGlassClient}; apps receive
 * instances from `client.subscribe()`/`client.streams`.
 */
export class StreamHandleImpl {
  private readonly emitter = new Emitter<StreamEvents>();
  private readonly host: StreamHost;
  private _info: StreamInfo;
  private _renderer: CanvasRenderer | null = null;
  private _canvas: HTMLCanvasElement | null = null;
  private _lastBitmap: ImageBitmap | null = null;
  private _lastStreamStats: Omit<StreamStats, 'renderer'> | null = null;
  private _closed = false;

  constructor(host: StreamHost, info: StreamInfo) {
    this.host = host;
    this._info = info;
  }

  // ---- StreamInfo mirror ----
  get streamId(): number {
    return this._info.streamId;
  }
  get targetId(): string {
    return this._info.targetId;
  }
  get quality(): QualityProfile {
    return this._info.quality;
  }
  get codec(): Codec {
    return this._info.codec;
  }
  get fps(): number {
    return this._info.fps;
  }
  get width(): number {
    return this._info.width;
  }
  get height(): number {
    return this._info.height;
  }
  get dpr(): number {
    return this._info.dpr;
  }
  get paused(): boolean {
    return this._info.paused;
  }
  get sidEpoch(): number {
    return this._info.sidEpoch;
  }
  get gen(): number {
    return this._info.gen;
  }

  /** A plain-object snapshot of this handle's current {@link StreamInfo}. */
  info(): StreamInfo {
    return { ...this._info };
  }

  get renderer(): CanvasRenderer | null {
    return this._renderer;
  }

  /** The canvas the current renderer is attached to, or `null` if none is attached. Used by `BrowserGlassClient.watchHover()` to drive its own `pointermove`/`pointerleave` listeners. */
  canvasElement(): HTMLCanvasElement | null {
    return this._canvas;
  }

  /** Retained for dimmed reconnect display; `null` before the first paint or after the stream closes. */
  get lastBitmap(): ImageBitmap | null {
    return this._renderer?.lastBitmap ?? this._lastBitmap;
  }

  /**
   * Attaches a {@link CanvasRenderer} to `canvas`/`container` for this
   * stream. Replaces any previously attached renderer (its bitmaps are
   * released first). `container` is required and kept distinct from
   * `canvas` on purpose: never inferred from
   * `canvas.parentElement`.
   *
   * Wraps the caller's own `onAck`/`onPaint` (still invoked afterwards) to
   * additionally: send the wire `ack` for every consumed frame through
   * {@link StreamHost.ackFrame} (every path acks, including every drop
   * path); emit `StreamEvents.frame` on a successful paint, using
   * {@link StreamHost.keyframeFlagFor} for the one field `PaintInfo` itself
   * does not carry; and emit `StreamEvents.dropped` for every non-painted
   * consumption, with the reason resolved from a before/after
   * `RendererStats` snapshot diff (see {@link diffDropReason}).
   */
  attach(
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    opts?: CanvasRendererOptions,
  ): CanvasRenderer {
    this.detach();
    let prevStats: RendererStats = {
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
    const streamId = this._info.streamId;
    const renderer = new CanvasRenderer(canvas, container, {
      ...opts,
      onAck: (info: AckInfo) => {
        this.host.ackFrame(streamId, info.seq, info.decodeMs);
        if (info.decodeMs === undefined) {
          const stats = renderer.stats;
          this.emitDropped({ seq: info.seq, reason: diffDropReason(prevStats, stats) });
          prevStats = { ...stats };
        } else {
          prevStats = { ...renderer.stats };
        }
        opts?.onAck?.(info);
      },
      onPaint: (info: PaintInfo) => {
        this.emitFrame({
          seq: info.seq,
          width: info.width,
          height: info.height,
          decodeMs: info.decodeMs,
          codec: this._info.codec,
          keyframe: this.host.keyframeFlagFor(streamId, info.seq),
        });
        opts?.onPaint?.(info);
      },
    });
    renderer.reconfigure({
      streamId: this._info.streamId,
      gen: this._info.gen,
      width: this._info.width,
      height: this._info.height,
    });
    this._renderer = renderer;
    this._canvas = canvas;
    return renderer;
  }

  /** Detaches and destroys the current renderer, if any. Idempotent. */
  detach(): void {
    if (!this._renderer) return;
    this._lastBitmap = this._renderer.lastBitmap;
    this._renderer.destroy();
    this._renderer = null;
    this._canvas = null;
  }

  /** Pushes a decoded binary frame at this stream's renderer, if one is attached; a no-op otherwise (the frame is still acked upstream by {@link BrowserGlassClient}'s own gen16 fast path). */
  pushToRenderer(frame: Parameters<CanvasRenderer['push']>[0]): void {
    this._renderer?.push(frame);
  }

  async pause(): Promise<void> {
    await this.host.pauseStream(this._info.streamId);
  }

  async resume(): Promise<void> {
    await this.host.resumeStream(this._info.streamId);
  }

  async setQuality(opts: QualityOptions): Promise<StreamInfo> {
    return this.host.setQuality(this._info.streamId, opts);
  }

  async unsubscribe(): Promise<void> {
    await this.host.unsubscribe(this._info.streamId);
  }

  stats(): StreamStats {
    const base = this._lastStreamStats ?? {
      streamId: this._info.streamId,
      targetId: this._info.targetId,
      quality: this._info.quality,
      codec: this._info.codec,
      paused: this._info.paused,
      fpsSent: 0,
      fpsDropped: 0,
      bytesPerSec: 0,
      backlog: 0,
      bufferedBytes: 0,
      encodeMsP50: 0,
      encodeMsP95: 0,
      rttMs: 0,
    };
    return { ...base, renderer: this._renderer ? { ...this._renderer.stats } : null };
  }

  on<K extends keyof StreamEvents>(type: K, fn: (ev: StreamEvents[K]) => void): Unsubscribe {
    return this.emitter.on(type, fn);
  }

  // ---- internal, called only by BrowserGlassClient ----

  /** @internal Updates the info mirror after `stream.subscribed` (a re-emission carries a bumped `sidEpoch`). */
  reconfigure(info: StreamInfo, previous: StreamInfo): void {
    this._info = info;
    this._renderer?.reconfigure({
      streamId: info.streamId,
      gen: info.gen,
      width: info.width,
      height: info.height,
    });
    this.emitter.emit('reconfigured', {
      ...info,
      previousSidEpoch: previous.sidEpoch,
      previousGen: previous.gen,
    });
  }

  /** @internal */
  setPaused(paused: boolean): void {
    this._info = { ...this._info, paused };
    this.emitter.emit('paused', { paused });
  }

  /** @internal */
  emitFrame(ev: StreamEvents['frame']): void {
    this.emitter.emit('frame', ev);
  }

  /** @internal */
  emitDropped(ev: StreamEvents['dropped']): void {
    this.emitter.emit('dropped', ev);
  }

  /** @internal */
  applyStats(stats: Omit<StreamStats, 'renderer'>): void {
    this._lastStreamStats = stats;
    this.emitter.emit('stats', this.stats());
  }

  /** @internal */
  close(reason: StreamEvents['closed']['reason']): void {
    if (this._closed) return;
    this._closed = true;
    this.detach();
    this.emitter.emit('closed', { reason });
  }
}

/**
 * The public-facing name for one subscription handle. Aliased to the
 * concrete class: every public member (`attach`, `detach`, `renderer`, `lastBitmap`, `pause`,
 * `resume`, `setQuality`, `unsubscribe`, `stats`, `on`, plus the spread
 * {@link StreamInfo} fields) is implemented directly on
 * {@link StreamHandleImpl}.
 */
export type StreamHandle = StreamHandleImpl;
