import {
  type Capability,
  type Codec,
  type ControlDenied,
  type ControlGranted,
  type ControlPreemptRequest,
  type ControlPreempted,
  type ControlQueued,
  type ControlRevoked,
  type ControlStateMsg,
  type DialogOpened,
  type DownloadReady,
  type Envelope,
  type ErrorMsg,
  type FileChooserOpened,
  type InstanceRecovered,
  type InstanceRecovering,
  type InstanceStateMsg,
  type LeaseState,
  type NavState,
  type PresenceCursor,
  type PresenceState,
  type QualityProfile,
  type StreamSubscribed,
  type TargetCaptured,
  type TargetClosed,
  type TargetCreated,
  type TargetListed,
  type TargetProbed,
  type TargetSummary,
  type TargetUpdated,
  type Welcome,
  type StreamStats as WireStreamStats,
  decodeBinaryHeader,
} from '@browserglass/protocol';
import { InputCapture, type SendableInputMessage } from '../input/index.js';
import { Emitter, type Unsubscribe } from '../transport/emitter.js';
import { now, randomCorrelationId, scheduleTimer } from '../transport/env.js';
import { Transport } from '../transport/transport.js';
import type {
  ConnectionState,
  DesiredSubscription,
  Logger,
  WebSocketConstructorLike,
} from '../transport/types.js';
import { NOOP_LOGGER } from '../transport/types.js';
import { StreamHandleImpl, type StreamHost } from './StreamHandleImpl.js';
import { BrowserGlassError } from './errors.js';
import type {
  BrowserGlassClientOptions,
  CaptureOptions,
  CaptureResult,
  ClientEvents,
  ClientStats,
  ControlOutcome,
  ControlRequestOptions,
  ControlYieldResult,
  DiagnosticsSubscribeOptions,
  DiagnosticsSubscription,
  ProbeOptions,
  ProbeResult,
  QualityOptions,
  RestartOptions,
  RestartResult,
  StreamHandle,
  StreamInfo,
  SubscribeOptions,
  UploadHandle,
  UploadOptions,
  ViewerPresence,
} from './types.js';
import { HoverWatcher } from './watchHover.js';

/** Fields of {@link SubscribeOptions} that affect the wire subscription (canvas/container/render are renderer-only and never part of the fingerprint). */
interface WireSubscribeFingerprint {
  quality: QualityProfile | undefined;
  codec: Codec | undefined;
  maxFps: number | undefined;
  maxWidth: number | undefined;
  maxHeight: number | undefined;
  thumbnail: boolean | undefined;
  paused: boolean | undefined;
}

function fingerprintOf(opts?: SubscribeOptions): WireSubscribeFingerprint {
  return {
    quality: opts?.quality,
    codec: opts?.codec,
    maxFps: opts?.maxFps,
    maxWidth: opts?.maxWidth,
    maxHeight: opts?.maxHeight,
    thumbnail: opts?.thumbnail,
    paused: opts?.paused,
  };
}

function sameFingerprint(a: WireSubscribeFingerprint, b: WireSubscribeFingerprint): boolean {
  return (
    a.quality === b.quality &&
    a.codec === b.codec &&
    a.maxFps === b.maxFps &&
    a.maxWidth === b.maxWidth &&
    a.maxHeight === b.maxHeight &&
    a.thumbnail === b.thumbnail &&
    a.paused === b.paused
  );
}

/** One tracked subscription: the live handle plus what it was asked for, so a repeat `subscribe()` call can be judged idempotent. */
interface TrackedSubscription {
  fingerprint: WireSubscribeFingerprint;
  handle: StreamHandleImpl;
  /** Set while the initial `stream.subscribe` (or a superseding `stream.quality`) is outstanding; a concurrent identical call joins this promise instead of sending a second wire message. */
  pending: Promise<StreamHandle> | null;
}

function streamInfoFrom(msg: {
  streamId: number;
  targetId: string;
  quality: QualityProfile;
  codec: Codec;
  fps: number;
  width: number;
  height: number;
  dpr: number;
  paused: boolean;
  sidEpoch: number;
  gen: number;
}): StreamInfo {
  return {
    streamId: msg.streamId,
    targetId: msg.targetId,
    quality: msg.quality,
    codec: msg.codec,
    fps: msg.fps,
    width: msg.width,
    height: msg.height,
    dpr: msg.dpr,
    paused: msg.paused,
    sidEpoch: msg.sidEpoch,
    gen: msg.gen,
  };
}

/**
 * The dimming ladder, computed centrally so every
 * layer that overlays a stream (the DOM-level `attach()` caller, and later
 * `react`'s `overlay` prop) renders the identical brightness/message pair.
 * The canvas is never cleared to black by a connection-state change; the
 * three real clear cases (`target.closed`, `instance.released`, `destroy()`)
 * are handled by their own call sites, not here.
 */
function dimFor(
  state: ConnectionState,
  reconnectAttempt: number,
): { dim: number; greyscale: boolean; message: string | null } {
  switch (state) {
    case 'live':
      return { dim: 1, greyscale: false, message: null };
    case 'resuming':
      return { dim: 0.4, greyscale: false, message: 'Reconnected' };
    case 'degraded':
      return { dim: 0.6, greyscale: false, message: null };
    case 'reconnecting':
      return {
        dim: 0.4,
        greyscale: false,
        message: reconnectAttempt >= 3 ? `Reconnecting, attempt ${reconnectAttempt}` : null,
      };
    case 'fatal':
      return { dim: 0.25, greyscale: true, message: null };
    default:
      return { dim: 1, greyscale: false, message: null };
  }
}

const RESERVED_KEYBOARD_LOCK_KEYS = [
  'Escape',
  'Tab',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
];

/**
 * The framework-agnostic BrowserGlass client. Owns a
 * {@link Transport} (`../transport`) for the connection lifecycle,
 * hands binary frames to per-target {@link StreamHandleImpl}s
 * (`../render`) for decode and paint, and wires each attached canvas
 * to an {@link InputCapture} (`../input`). This class only assembles
 * those pieces; the wire protocol, renderer, and pointer capture live in
 * their own modules and are used here as they are.
 */
export class BrowserGlassClient {
  private readonly transport: Transport;
  private readonly logger: Logger;
  private readonly emitter = new Emitter<ClientEvents>();
  private readonly requestTimeoutMs: number;
  private readonly keyboardLockEnabled: boolean;
  private readonly presenceCursorEnabled: boolean;
  private readonly signal: AbortSignal | undefined;

  private _viewerId: string | null = null;
  private _sessionId: string | null = null;
  private _instance: Welcome['instance'] | null = null;
  private _targets: TargetSummary[] = [];
  private _granted = new Set<Capability>();
  private _limits: Welcome['limits'] | null = null;
  private _presence: ClientEvents['presence']['viewers'] = [];
  private _lastError: ErrorMsg | null = null;
  private lastReconnectAttempt = 0;

  /** By `targetId`. The full lease table for the session (`control.state`), not only leases this client holds. */
  private readonly leasesByTarget = new Map<string, LeaseState>();
  /** By `targetId`. Only the leases this viewer itself currently holds; what `sendInput()` stamps. */
  private readonly myLeases = new Map<
    string,
    { leaseId: string; expiresAt: number; mode: 'exclusive' | 'shared' }
  >();
  /** Pending `control.renew` timers, by `targetId`. See {@link adoptGrant}. */
  private readonly leaseRenewTimers = new Map<string, { cancel: () => void }>();

  private readonly subscriptions = new Map<string, TrackedSubscription>(); // by targetId
  private readonly streamsById = new Map<number, StreamHandleImpl>();
  private readonly inputCaptures = new Map<string, InputCapture>(); // by targetId
  private readonly hoverWatchers = new Map<string, HoverWatcher>(); // by targetId
  private readonly keyframeBySeq = new Map<string, boolean>(); // `${streamId}:${seq}`

  private connectPromise: Promise<void> | null = null;
  private destroyed = false;
  private restartPromise: Promise<RestartResult> | null = null;
  private restartInstanceId: string | null = null;
  private lastCursorSentAt = 0;

  constructor(private readonly options: BrowserGlassClientOptions) {
    this.logger = options.logger ?? NOOP_LOGGER;
    this.requestTimeoutMs = options.transport?.requestTimeoutMs ?? 15000;
    this.keyboardLockEnabled = options.keyboardLock !== false;
    this.presenceCursorEnabled = options.presenceCursor ?? false;
    this.signal = options.signal;

    const desired: DesiredSubscription[] = (options.subscribe ?? []).map((s) => ({
      targetId: s.targetId,
      ...(s.quality !== undefined ? { quality: s.quality } : {}),
      ...(s.codec !== undefined ? { codec: s.codec } : {}),
      ...(s.maxFps !== undefined ? { maxFps: s.maxFps } : {}),
      ...(s.thumbnail !== undefined ? { thumbnail: s.thumbnail } : {}),
      ...(s.paused !== undefined ? { paused: s.paused } : {}),
    }));

    this.transport = new Transport({
      url: options.url,
      ...(options.ticket !== undefined ? { ticket: options.ticket } : {}),
      ...(options.token !== undefined ? { token: options.token } : {}),
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
      ...(options.autoReconnect !== undefined ? { autoReconnect: options.autoReconnect } : {}),
      ...(options.reconnect !== undefined ? { reconnect: options.reconnect } : {}),
      ...(options.resumeWindowMs !== undefined ? { resumeWindowMs: options.resumeWindowMs } : {}),
      subscribe: desired,
      hello: {
        client: { name: '@browserglass/client', version: '0.0.0', runtime: detectRuntime() },
        capabilities: {
          codecs: options.codecs ?? ['jpeg'],
          binaryFrames: options.binaryFrames !== true,
          input: ['mouse', 'key', 'text', 'touch', 'scroll'],
        },
        viewport: { width: 0, height: 0, dpr: 1, visible: true, fitMode: 'contain' },
      },
      transport: {
        ...(options.transport?.protocols !== undefined
          ? { protocols: options.transport.protocols }
          : {}),
        ...(options.transport?.pingIntervalMs !== undefined
          ? { pingIntervalMs: options.transport.pingIntervalMs }
          : {}),
        ...(options.transport?.healthTimeoutMs !== undefined
          ? { healthTimeoutMs: options.transport.healthTimeoutMs }
          : {}),
        ...(options.transport?.handshakeTimeoutMs !== undefined
          ? { handshakeTimeoutMs: options.transport.handshakeTimeoutMs }
          : {}),
        ...(options.transport?.WebSocketImpl !== undefined
          ? { WebSocketImpl: options.transport.WebSocketImpl as WebSocketConstructorLike }
          : {}),
        ...(options.transport?.allowInsecureTransport !== undefined
          ? { allowInsecureTransport: options.transport.allowInsecureTransport }
          : {}),
      },
      ...(options.onAppClose !== undefined ? { onAppClose: options.onAppClose } : {}),
      logger: this.logger,
    });

    this.wireTransportEvents();
    this.signal?.addEventListener('abort', () => this.destroy());
  }

  // ==================================================================
  // Observable state
  // ==================================================================

  get state(): ConnectionState {
    return this.transport.state;
  }
  get viewerId(): string | null {
    return this._viewerId;
  }
  get sessionId(): string | null {
    return this._sessionId;
  }
  get instance(): Welcome['instance'] | null {
    return this._instance;
  }
  get targets(): readonly TargetSummary[] {
    return this._targets;
  }
  get granted(): ReadonlySet<Capability> {
    return this._granted;
  }
  get limits(): Welcome['limits'] | null {
    return this._limits;
  }
  get streams(): readonly StreamHandle[] {
    return Array.from(this.streamsById.values());
  }
  get leases(): ReadonlyMap<string, LeaseState> {
    return this.leasesByTarget;
  }
  get presence(): readonly ClientEvents['presence']['viewers'][number][] {
    return this._presence;
  }
  get lastError(): ErrorMsg | null {
    return this._lastError;
  }

  // ==================================================================
  // Lifecycle
  // ==================================================================

  /**
   * Opens the socket. Resolves once `welcome` has been processed AND every
   * `subscribe` option produced its `stream.subscribed` (the
   * transport's own `connect()` resolves earlier, at `welcome` alone, so
   * this layer is what waits the rest of the way). Rejects only on a permanent failure. A second call while
   * already connecting returns the same promise, the StrictMode
   * double-mount defence; a second call while already connected resolves
   * immediately.
   */
  connect(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('BrowserGlassClient is destroyed'));
    if (this.connectPromise) return this.connectPromise;
    const s = this.transport.state;
    if (s === 'live' || s === 'degraded' || s === 'resuming') return Promise.resolve();

    const wantedTargetIds = (this.options.subscribe ?? []).map((s2) => s2.targetId);
    this.connectPromise = this.transport
      .connect()
      .then(() =>
        wantedTargetIds.length === 0
          ? Promise.resolve()
          : this.awaitInitialSubscriptions(wantedTargetIds),
      )
      .finally(() => {
        this.connectPromise = null;
      });
    return this.connectPromise;
  }

  private awaitInitialSubscriptions(targetIds: string[]): Promise<void> {
    const missing = new Set(targetIds.filter((id) => !this.subscriptions.has(id)));
    if (missing.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.transport.on('message', (msg) => {
        if (msg.t !== 'stream.subscribed') return;
        missing.delete(String(msg['targetId']));
        if (missing.size === 0) {
          off();
          resolve();
        }
      });
      // A subscribe folded into `hello` can fail server-side with no
      // dedicated notification this layer can wait on forever; bound the
      // wait so `connect()` still settles.
      scheduleTimer(() => {
        off();
        resolve();
      }, this.requestTimeoutMs);
    });
  }

  /**
   * Closes with `1000`. Releases every held lease and unsubscribes every
   * stream FIRST (both are sent synchronously over the still-open socket
   * before the close frame goes out), so the next viewer in a control
   * queue is served in milliseconds rather than after a socket timeout.
   */
  async disconnect(opts?: { code?: number; reason?: string }): Promise<void> {
    this.releaseAllLeasesOnWire();
    this.unsubscribeAllOnWire();
    await this.transport.disconnect(opts);
  }

  /** `disconnect()` plus releases every listener, renderer, and bitmap. Terminal. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.releaseAllLeasesOnWire();
    this.unsubscribeAllOnWire();
    this.transport.destroy();
    for (const handle of this.streamsById.values()) handle.close('session-ended');
    for (const capture of this.inputCaptures.values()) capture.destroy();
    for (const watcher of this.hoverWatchers.values()) watcher.stop();
    this.streamsById.clear();
    this.subscriptions.clear();
    this.inputCaptures.clear();
    this.hoverWatchers.clear();
    this.emitter.clear();
  }

  private releaseAllLeasesOnWire(): void {
    for (const [targetId, lease] of Array.from(this.myLeases.entries())) {
      this.trySend({
        v: 1,
        t: 'control.release',
        ts: Date.now(),
        targetId,
        leaseId: lease.leaseId,
      });
      this.myLeases.delete(targetId);
      this.transport.clearLeaseHeld(targetId);
    }
  }

  private unsubscribeAllOnWire(): void {
    for (const handle of this.streamsById.values()) {
      this.trySend({ v: 1, t: 'stream.unsubscribe', ts: Date.now(), streamId: handle.streamId });
    }
  }

  private trySend(msg: Envelope): void {
    try {
      this.transport.send(msg);
    } catch {
      // not connected; nothing to send over a socket that no longer exists
    }
  }

  // ==================================================================
  // Streams
  // ==================================================================

  /**
   * Subscribes to a target's stream. Idempotent: an identical `opts` for a
   * `targetId` already subscribed returns the existing handle with no
   * second `stream.subscribe` on the wire; a *different* `opts` reconfigures
   * the existing stream via `stream.quality` instead of resubscribing.
   */
  async subscribe(targetId: string, opts?: SubscribeOptions): Promise<StreamHandle> {
    const fp = fingerprintOf(opts);
    const existing = this.subscriptions.get(targetId);

    if (existing) {
      if (existing.pending) {
        const handle = (await existing.pending) as StreamHandleImpl;
        if (!sameFingerprint(existing.fingerprint, fp)) {
          await this.reconfigureFingerprint(handle, opts);
        }
        this.applyAttach(handle, opts);
        return handle;
      }
      if (sameFingerprint(existing.fingerprint, fp)) {
        this.applyAttach(existing.handle, opts);
        return existing.handle;
      }
      await this.reconfigureFingerprint(existing.handle, opts);
      this.applyAttach(existing.handle, opts);
      return existing.handle;
    }

    const pending = this.doSubscribe(targetId, opts, fp);
    this.subscriptions.set(targetId, {
      fingerprint: fp,
      handle: null as unknown as StreamHandleImpl,
      pending,
    });
    try {
      const handle = (await pending) as StreamHandleImpl;
      this.subscriptions.set(targetId, { fingerprint: fp, handle, pending: null });
      return handle;
    } catch (err) {
      this.subscriptions.delete(targetId);
      throw err;
    }
  }

  /**
   * A `subscribe()` call for an already-subscribed `targetId` with
   * different `opts` reconfigures the existing stream via `stream.quality`
   * rather than resubscribing. `stream.quality`'s wire shape carries no
   * `thumbnail`/`paused` fields (protocol limitation, see `streams.ts`'s
   * `StreamQuality`), so a fingerprint difference confined to those two is
   * a no-op here; `setQuality()` itself updates `tracked.fingerprint` for
   * the fields it actually sent.
   */
  private async reconfigureFingerprint(
    handle: StreamHandleImpl,
    opts: SubscribeOptions | undefined,
  ): Promise<void> {
    await this.setQuality(handle.streamId, {
      ...(opts?.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts?.codec !== undefined ? { codec: opts.codec } : {}),
      ...(opts?.maxFps !== undefined ? { maxFps: opts.maxFps } : {}),
      ...(opts?.maxWidth !== undefined ? { maxWidth: opts.maxWidth } : {}),
      ...(opts?.maxHeight !== undefined ? { maxHeight: opts.maxHeight } : {}),
    });
  }

  private async doSubscribe(
    targetId: string,
    opts: SubscribeOptions | undefined,
    fp: WireSubscribeFingerprint,
  ): Promise<StreamHandle> {
    const reply = await this.request<StreamSubscribed>('stream.subscribe', {
      targetId,
      ...(fp.quality !== undefined ? { quality: fp.quality } : {}),
      ...(fp.codec !== undefined ? { codec: fp.codec } : {}),
      ...(fp.maxFps !== undefined ? { maxFps: fp.maxFps } : {}),
      ...(fp.maxWidth !== undefined ? { maxWidth: fp.maxWidth } : {}),
      ...(fp.maxHeight !== undefined ? { maxHeight: fp.maxHeight } : {}),
      ...(fp.thumbnail !== undefined ? { thumbnail: fp.thumbnail } : {}),
      ...(fp.paused !== undefined ? { paused: fp.paused } : {}),
    });
    const info = streamInfoFrom(reply);
    const host = this.streamHost();
    const handle = new StreamHandleImpl(host, info);
    this.streamsById.set(info.streamId, handle);
    this.applyAttach(handle, opts);
    return handle;
  }

  private applyAttach(handle: StreamHandleImpl, opts?: SubscribeOptions): void {
    if (!opts?.canvas) return;
    if (!opts.container) {
      this.logger.warn(
        'subscribe(): opts.canvas given without opts.container; attach() requires both, ignoring canvas',
        { targetId: handle.targetId },
      );
      return;
    }
    handle.attach(opts.canvas, opts.container, opts.render);
    this.createInputCaptureFor(handle.targetId, opts.canvas, opts.container, handle);
    if (this.keyboardLockEnabled) this.wireKeyboardLock(opts.canvas);
  }

  private streamHost(): StreamHost {
    return {
      unsubscribe: (streamId: number) => this.unsubscribe(streamId),
      setQuality: (streamId: number, o: QualityOptions) => this.setQuality(streamId, o),
      pauseStream: (streamId: number) => this.pauseStreamById(streamId),
      resumeStream: (streamId: number) => this.resumeStreamById(streamId),
      ackFrame: (streamId: number, seq: number, decodeMs?: number) => {
        this.trySend({
          v: 1,
          t: 'ack',
          ts: Date.now(),
          streamId,
          seq,
          ...(decodeMs !== undefined ? { decodeMs } : {}),
        });
        // A dropped frame (decodeMs undefined) never reaches `onPaint`, so
        // nothing else will ever read (and clean up) its keyframe flag;
        // a painted one is cleaned up by `keyframeFlagFor` itself, which
        // runs later (paint is scheduled on the next animation frame,
        // after this ack already fired).
        if (decodeMs === undefined) this.keyframeBySeq.delete(`${streamId}:${seq}`);
      },
      keyframeFlagFor: (streamId: number, seq: number) => {
        const key = `${streamId}:${seq}`;
        const flag = this.keyframeBySeq.get(key) ?? false;
        this.keyframeBySeq.delete(key);
        return flag;
      },
    };
  }

  private resolveStreamId(stream: StreamHandle | number): number {
    return typeof stream === 'number' ? stream : stream.streamId;
  }

  async unsubscribe(stream: StreamHandle | number): Promise<void> {
    const streamId = this.resolveStreamId(stream);
    const handle = this.streamsById.get(streamId);
    this.trySend({ v: 1, t: 'stream.unsubscribe', ts: Date.now(), streamId });
    this.streamsById.delete(streamId);
    if (handle) {
      this.subscriptions.delete(handle.targetId);
      const capture = this.inputCaptures.get(handle.targetId);
      if (capture) {
        capture.destroy();
        this.inputCaptures.delete(handle.targetId);
      }
      handle.close('unsubscribed');
    }
  }

  async setQuality(stream: StreamHandle | number, opts: QualityOptions): Promise<StreamInfo> {
    const streamId = this.resolveStreamId(stream);
    const reply = await this.request<StreamSubscribed>('stream.quality', {
      streamId,
      ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
      ...(opts.maxFps !== undefined ? { maxFps: opts.maxFps } : {}),
      ...(opts.maxWidth !== undefined ? { maxWidth: opts.maxWidth } : {}),
      ...(opts.maxHeight !== undefined ? { maxHeight: opts.maxHeight } : {}),
    });
    const info = streamInfoFrom(reply);
    const handle = this.streamsById.get(streamId);
    if (handle) {
      const previous = handle.info();
      handle.reconfigure(info, previous);
      const tracked = this.subscriptions.get(handle.targetId);
      if (tracked)
        tracked.fingerprint = {
          quality: info.quality,
          codec: info.codec,
          maxFps: opts.maxFps,
          maxWidth: opts.maxWidth,
          maxHeight: opts.maxHeight,
          thumbnail: tracked.fingerprint.thumbnail,
          paused: tracked.fingerprint.paused,
        };
      if (previous.gen !== info.gen) this.inputCaptures.get(handle.targetId)?.releaseStuckButtons();
    }
    return info;
  }

  async pause(stream: StreamHandle | number): Promise<void> {
    await this.pauseStreamById(this.resolveStreamId(stream));
  }
  async resumeStream(stream: StreamHandle | number): Promise<void> {
    await this.resumeStreamById(this.resolveStreamId(stream));
  }
  private async pauseStreamById(streamId: number): Promise<void> {
    this.trySend({ v: 1, t: 'stream.pause', ts: Date.now(), streamId });
    this.streamsById.get(streamId)?.setPaused(true);
  }
  private async resumeStreamById(streamId: number): Promise<void> {
    this.trySend({ v: 1, t: 'stream.resume', ts: Date.now(), streamId });
    this.streamsById.get(streamId)?.setPaused(false);
  }

  requestKeyframe(stream: StreamHandle | number, reason?: string): void {
    const streamId = this.resolveStreamId(stream);
    this.trySend({
      v: 1,
      t: 'keyframe.request',
      ts: Date.now(),
      streamId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  // ==================================================================
  // Control
  // ==================================================================

  async requestControl(targetId: string, opts?: ControlRequestOptions): Promise<ControlOutcome> {
    if (!this._granted.has('control')) {
      throw BrowserGlassError.local(
        'cap',
        'bgls.error.cap.missing',
        "requestControl() needs the 'control' capability",
      );
    }
    if (opts?.force && !this._granted.has('admin')) {
      throw BrowserGlassError.local(
        'cap',
        'bgls.error.cap.missing',
        "requestControl({force:true}) needs the 'admin' capability",
      );
    }
    if (this._targets.length > 0 && !this._targets.some((t) => t.targetId === targetId)) {
      throw BrowserGlassError.local(
        'target',
        'bgls.error.target.not_found',
        `no such target: ${targetId}`,
      );
    }
    // `ControlRequestOptions.timeoutMs` documents `0` as "wait forever",
    // the opposite of `request()`'s own default-bounded behaviour, so it is
    // translated to a non-finite timeout that `awaitMessage()` treats as
    // "never time out" rather than reusing the ambient `requestTimeoutMs`.
    const controlTimeoutMs =
      opts?.timeoutMs === undefined
        ? this.requestTimeoutMs
        : opts.timeoutMs === 0
          ? Number.POSITIVE_INFINITY
          : opts.timeoutMs;
    const reply = await this.request<ControlGranted | ControlDenied | ControlQueued>(
      'control.request',
      {
        targetId,
        ...(opts?.ttlMs !== undefined ? { ttlMs: opts.ttlMs } : {}),
        ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
        ...(opts?.force !== undefined ? { force: opts.force } : {}),
        ...(opts?.queue !== undefined ? { queue: opts.queue } : {}),
      },
      { timeoutMs: controlTimeoutMs },
    );

    if (reply.t === 'control.granted') {
      const g = reply as ControlGranted;
      this.adoptGrant(targetId, g);
      return { granted: true, leaseId: g.leaseId, expiresAt: g.expiresAt, mode: g.mode };
    }
    if (reply.t === 'control.queued') {
      const q = reply as ControlQueued;
      return { granted: false, queued: true, position: q.position, holderLabel: q.holderLabel };
    }
    const d = reply as ControlDenied;
    return { granted: false, queued: false, reason: d.reason, message: d.message };
  }

  /**
   * Records a granted lease and arms its renewal.
   *
   * A lease is granted for `leaseTtlMs` (30s by default) and the grant says
   * how long before expiry the holder is expected to renew
   * (`renewWithinMs`, 15s). Nothing in this client ever sent
   * `control.renew`, so every lease simply expired half a minute after it
   * was taken. From that moment `sendInput()` stamped an empty `leaseId`,
   * the server dropped every event silently (it is required to: input
   * without a lease is not an error, it is ignored), and the tab became
   * unusable while the UI still showed the viewer as driving. Clicking and
   * typing worked for thirty seconds and then stopped, which is exactly how
   * it looked to anyone using it.
   */
  private adoptGrant(targetId: string, g: ControlGranted): void {
    this.myLeases.set(targetId, { leaseId: g.leaseId, expiresAt: g.expiresAt, mode: g.mode });
    this.transport.noteLeaseHeld(targetId, g.leaseId, g.expiresAt);
    this.inputCaptures.get(targetId)?.setLeaseId(g.leaseId);
    this.scheduleLeaseRenew(targetId, g);
  }

  /** Arms a single `control.renew` for `targetId`, replacing any pending one. The server answers a renew with a fresh `control.granted`, which comes back through {@link adoptGrant} and arms the next one. */
  private scheduleLeaseRenew(targetId: string, g: ControlGranted): void {
    this.cancelLeaseRenew(targetId);
    // Renew when `renewWithinMs` is left on the clock, with a floor so a
    // very short lease still produces a timer rather than a busy loop.
    // `expiresAt` is wall clock, so it is compared against `Date.now()` and
    // never against this module's `now()`, which is `performance.now()` and
    // measures milliseconds since page load: subtracting one from the other
    // yields a delay of roughly the current Unix time, so the renewal simply
    // never fires. `hasControl()` uses `Date.now()` against the same field
    // for the same reason.
    const delayMs = Math.max(1000, g.expiresAt - Date.now() - g.renewWithinMs);
    this.leaseRenewTimers.set(
      targetId,
      scheduleTimer(() => {
        this.leaseRenewTimers.delete(targetId);
        const lease = this.myLeases.get(targetId);
        if (!lease || lease.leaseId !== g.leaseId) return;
        this.trySend({
          v: 1,
          t: 'control.renew',
          ts: Date.now(),
          targetId,
          leaseId: lease.leaseId,
        });
      }, delayMs),
    );
  }

  /** Drops any pending renewal for `targetId`. */
  private cancelLeaseRenew(targetId: string): void {
    this.leaseRenewTimers.get(targetId)?.cancel();
    this.leaseRenewTimers.delete(targetId);
  }

  async releaseControl(targetId: string): Promise<void> {
    const lease = this.myLeases.get(targetId);
    if (!lease) return;
    this.cancelLeaseRenew(targetId);
    this.trySend({ v: 1, t: 'control.release', ts: Date.now(), targetId, leaseId: lease.leaseId });
    this.myLeases.delete(targetId);
    this.transport.clearLeaseHeld(targetId);
    this.inputCaptures.get(targetId)?.setLeaseId('');
  }

  /**
   * Asks the AGENTS driving a shared target to stand down, and leaves every
   * person driving it alone.
   *
   * This is the shared-mode counterpart to preemption. Preemption is an
   * exclusive-mode concept and the engine emits none of it for a shared
   * target, because nobody queues there: a person takes control by asking,
   * and is granted on the spot. What that does not do is tell the software
   * already typing into the page that a person has arrived, and an agent
   * cannot detect a second writer on its own. `control.yield` is how it is
   * told.
   *
   * NOT an admin act, deliberately. It is gated on `control`, not `admin`
   * (`packages/server/src/wire/capability-check.ts`), because asking a
   * robot to stop sharing your tab is an ordinary thing for somebody
   * already driving that tab to want. `control.revoke` remains the admin
   * instrument and stays narrower still: it names one holder, of any kind,
   * and removes them.
   *
   * Fire and forget on the wire, like `control.release`, `control.renew`
   * and `control.revoke`, and unlike `control.request`. The server's
   * success path replies with nothing at all, so awaiting a correlated
   * reply here would hang on every success.
   *
   * ## What a caller learns, and what it does not
   *
   * The server has two failure paths, and BOTH are decidable here without a
   * round trip, from state this client already holds. So they are checked
   * locally and thrown, the same way `requestControl()` throws for a
   * missing capability rather than sending a message it knows will be
   * refused:
   *
   * * `not_shared`, when this client positively knows the target's mode is
   *   `'exclusive'`. Only when it KNOWS: a target with no `control.state`
   *   yet has an unknown mode, and refusing on an unknown is worse than
   *   letting the server answer.
   * * `not_human`, when this token carries `automation`. That capability is
   *   exactly what makes a viewer `kind: 'agent'` server side
   *   (`ws/connection.ts`), so this check and the server's cannot disagree.
   *
   * The remaining gap is real and is NOT closed here. A yield that reaches
   * a target with no agent driving is a SUCCESS answered by silence, so
   * "nobody was driving" and "my message went nowhere" look identical on
   * the wire. {@link ControlYieldResult.agentsAsked} narrows it honestly
   * from this side and does not pretend to close it: it is this client's
   * own count, from its own last `control.state` and `presence.state`, at
   * the moment of sending. It is not an acknowledgement and it is not
   * proof of delivery. A `control.yielded` ack from the server is what
   * would actually close it, and it is filed rather than invented here.
   *
   * The message is sent EVEN when `agentsAsked` is 0. Suppressing it on a
   * local count would mean a grant this client has not been told about yet
   * silently swallows a person's takeover, and a redundant yield costs one
   * frame and does nothing.
   */
  async yieldControl(targetId: string, reason?: string): Promise<ControlYieldResult> {
    if (!this._granted.has('control')) {
      throw BrowserGlassError.local(
        'cap',
        'bgls.error.cap.missing',
        "yieldControl() needs the 'control' capability",
      );
    }
    if (this._granted.has('automation')) {
      throw BrowserGlassError.local(
        'control',
        'bgls.error.control.not_human',
        'yieldControl() may only be sent by a human viewer, and this token carries the ' +
          "'automation' capability, which makes this viewer an agent. Agent against agent is " +
          'already settled by the priority ladder.',
      );
    }

    const lease = this.leasesByTarget.get(targetId);
    if (lease?.mode === 'exclusive') {
      throw BrowserGlassError.local(
        'control',
        'bgls.error.control.not_shared',
        `yieldControl() applies to shared targets; ${targetId} is exclusive. Take it over with requestControl(), which preempts an agent holder and gives it the same grace to stand down in.`,
      );
    }

    const { agentsAsked, unknownHolders } = this.countAgentHolders(targetId);

    // Not `trySend`. That swallows a closed socket, which is right for the
    // release sent on the way out of `destroy()` and wrong here: the whole
    // question a caller is asking is whether the agent was told, and a
    // silent no-op is the one answer that must not be reported as a send.
    try {
      this.transport.send({
        v: 1,
        t: 'control.yield',
        ts: Date.now(),
        targetId,
        ...(reason !== undefined ? { reason } : {}),
      });
    } catch (err) {
      throw BrowserGlassError.local(
        'control',
        'bgls.error.control.not_sent',
        `yieldControl() could not be sent: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return { agentsAsked, unknownHolders };
  }

  /**
   * How many of a target's current holders this client believes are agents,
   * and how many it cannot say either way.
   *
   * The join is holders to roster on `viewerId`, because `LeaseHolderState`
   * carries no `kind` of its own: it is a control record (viewerId, label,
   * two timestamps, connected) and the answer lives on `presence.state`.
   * The same join `@browserglass/react`'s `driversOf()` does, kept here so
   * every consumer gets it rather than only the React one.
   *
   * `unknownHolders` is reported separately and is never folded into
   * `agentsAsked`. A holder missing from the roster is genuinely unknown,
   * not a person: the roster lags a grant by a broadcast, and the synthetic
   * viewer the REST control path borrows a lease under never appears in it
   * at all. Counting those as people would let this method report "no
   * agents" over a REST-driven tab.
   */
  private countAgentHolders(targetId: string): { agentsAsked: number; unknownHolders: number } {
    const holders = this.leasesByTarget.get(targetId)?.holders ?? [];
    let agentsAsked = 0;
    let unknownHolders = 0;
    for (const holder of holders) {
      const roster = this._presence.find((v) => v.viewerId === holder.viewerId);
      if (roster === undefined) unknownHolders += 1;
      else if (roster.kind === 'agent') agentsAsked += 1;
    }
    return { agentsAsked, unknownHolders };
  }

  hasControl(targetId: string): boolean {
    const lease = this.myLeases.get(targetId);
    return lease !== undefined && lease.expiresAt > Date.now();
  }

  controlQueuePosition(targetId: string): number | null {
    return this.leasesByTarget.get(targetId)?.queuePosition ?? null;
  }

  // ==================================================================
  // Navigation
  // ==================================================================

  async navigate(
    targetId: string,
    url: string,
    opts?: { referrer?: string; waitUntil?: 'commit' | 'load' | 'networkidle' },
  ): Promise<NavState> {
    return this.request<NavState>('nav.goto', {
      targetId,
      url,
      ...(opts?.referrer !== undefined ? { referrer: opts.referrer } : {}),
      ...(opts?.waitUntil !== undefined ? { waitUntil: opts.waitUntil } : {}),
    });
  }
  async back(targetId: string): Promise<NavState> {
    return this.request<NavState>('nav.back', { targetId });
  }
  async forward(targetId: string): Promise<NavState> {
    return this.request<NavState>('nav.forward', { targetId });
  }
  async reload(targetId: string, opts?: { ignoreCache?: boolean }): Promise<NavState> {
    return this.request<NavState>('nav.reload', {
      targetId,
      ...(opts?.ignoreCache !== undefined ? { ignoreCache: opts.ignoreCache } : {}),
    });
  }
  async stopLoading(targetId: string): Promise<void> {
    this.trySend({ v: 1, t: 'nav.stop', ts: Date.now(), targetId });
  }

  // ==================================================================
  // Tabs
  // ==================================================================

  readonly tabs = {
    list: async (opts?: { includeKinds?: TargetSummary['kind'][] }): Promise<TargetSummary[]> => {
      const reply = await this.request<TargetListed>(
        'target.list',
        opts?.includeKinds !== undefined ? { includeKinds: opts.includeKinds } : {},
      );
      return reply.targets;
    },
    new: async (opts?: {
      url?: string;
      background?: boolean;
      openerTargetId?: string;
      /**
       * Opens this target in its own new OS window rather than as a tab of
       * an existing one. Omit to fall back to the server's own default,
       * which mirrors the Instance's `BrowserSpec.isolation`
       * (`ManagedSession.newTarget`, `packages/server/src/session/managed-session.ts`):
       * a plain `tabs.new()` on an `isolation: 'window'` Instance still
       * gets its own window without the caller having to know that.
       */
      newWindow?: boolean;
    }): Promise<TargetSummary> => {
      const reply = await this.request<TargetCreated>('target.new', {
        ...(opts?.url !== undefined ? { url: opts.url } : {}),
        ...(opts?.background !== undefined ? { background: opts.background } : {}),
        ...(opts?.openerTargetId !== undefined ? { openerTargetId: opts.openerTargetId } : {}),
        ...(opts?.newWindow !== undefined ? { newWindow: opts.newWindow } : {}),
      });
      return reply.target;
    },
    close: async (targetId: string): Promise<void> => {
      await this.request('target.close', { targetId });
    },
    activate: async (targetId: string): Promise<void> => {
      await this.request('target.activate', { targetId });
    },
    reorder: async (targetIds: string[]): Promise<void> => {
      this.trySend({ v: 1, t: 'target.reorder', ts: Date.now(), targetIds });
    },
  };

  // ==================================================================
  // Clipboard: deliberately not offered here. A `clipboard` property used
  // to send `clipboard.read`/`clipboard.write`, but the server has no
  // handler for either (`packages/server/src/ws/connection.ts` has no
  // dispatch entry, only a capability check), so every call failed with
  // `bgls.error.protocol.unknown_type`. Wiring it properly turned out not
  // to be possible within the CDP surface this build allows: reading the
  // system clipboard's resulting text back out of the page has no CDP path
  // that does not go through `Runtime.evaluate` (a focused editable
  // element's live `.value` never syncs to a DOM attribute readable via
  // `DOM.getOuterHTML`/`DOM.getAttributes`), and `Runtime` is refused
  // outright by the CDP passthrough allowlist
  // (`packages/server/src/rest/cdp-passthrough-allowlist.ts`) as arbitrary
  // script execution. Writing could only be faked by inserting the given
  // text into whatever element happens to be focused in the page and then
  // issuing a native Copy edit command, which both requires a focused
  // editable element to already exist and corrupts that element's content
  // as a side effect, not a real "write to clipboard" primitive. Removed
  // rather than left in place returning a promise that can never resolve
  // successfully. Copy and paste via real Ctrl+C/Ctrl+V keyboard chords is
  // unaffected: that path goes through `input.key`, dispatched as a native
  // key event Chrome itself turns into an OS clipboard operation, and
  // never touches this (non-existent) API.
  // See `packages/server/test/ws/clipboard-unwired.test.ts`.
  // ==================================================================

  // ==================================================================
  // Diagnostics
  // ==================================================================

  readonly diagnostics = {
    /**
     * Starts console/error/network capture for one target. Requires
     * `devtools`, checked locally so a caller lacking it fails fast rather
     * than waiting a round trip for the server to refuse it. `feeds`
     * mirrors the wire message's own default (console and errors on,
     * network off): `Network.enable` is not free, and a wall of panes must
     * not pay for it on every target unless asked, so it is opt in per
     * target.
     * The reply echoes what the server actually turned on, which can differ
     * from what was requested (a target the server judges too busy, for
     * instance), so callers should read the return value rather than the
     * `feeds` argument to know what is really live.
     */
    subscribe: async (
      targetId: string,
      feeds?: DiagnosticsSubscribeOptions,
    ): Promise<DiagnosticsSubscription> => {
      if (!this._granted.has('devtools')) {
        throw BrowserGlassError.local(
          'cap',
          'bgls.error.cap.missing',
          "diagnostics.subscribe() needs the 'devtools' capability",
        );
      }
      const reply = await this.request<
        Envelope & { targetId: string; console: boolean; errors: boolean; network: boolean }
      >('diagnostics.subscribe', {
        targetId,
        ...(feeds?.console !== undefined ? { console: feeds.console } : {}),
        ...(feeds?.errors !== undefined ? { errors: feeds.errors } : {}),
        ...(feeds?.network !== undefined ? { network: feeds.network } : {}),
      });
      return {
        targetId: reply.targetId,
        console: reply.console,
        errors: reply.errors,
        network: reply.network,
      };
    },
    /** Stops diagnostics for one target. Fire and forget on the wire, like `stream.unsubscribe`: the contract defines no reply for it, so there is nothing to correlate against. `async` only for call-site symmetry with `subscribe()`. */
    unsubscribe: async (targetId: string): Promise<void> => {
      this.trySend({ v: 1, t: 'diagnostics.unsubscribe', ts: Date.now(), targetId });
    },
  };

  // ==================================================================
  // Capture and hit test
  // ==================================================================

  async capture(targetId: string, opts?: CaptureOptions): Promise<CaptureResult> {
    const reply = await this.request<TargetCaptured>('target.capture', {
      targetId,
      ...(opts?.format !== undefined ? { format: opts.format } : {}),
      ...(opts?.quality !== undefined ? { quality: opts.quality } : {}),
      ...(opts?.fullPage !== undefined ? { fullPage: opts.fullPage } : {}),
      ...(opts?.selector !== undefined ? { selector: opts.selector } : {}),
      ...(opts?.clip !== undefined ? { clip: opts.clip } : {}),
      ...(opts?.maxDimension !== undefined ? { maxDimension: opts.maxDimension } : {}),
    });

    let blob: Blob;
    let delivery: 'inline' | 'url';
    if (reply.data !== undefined) {
      blob = base64ToBlob(reply.data, reply.format === 'jpeg' ? 'image/jpeg' : 'image/png');
      delivery = 'inline';
    } else if (reply.downloadId !== undefined) {
      const ready = await this.awaitMessage<DownloadReady>(
        (m) => m.t === 'download.ready' && m['downloadId'] === reply.downloadId,
        this.requestTimeoutMs,
      );
      const res = await fetch(ready.url, opts?.signal ? { signal: opts.signal } : {});
      blob = await res.blob();
      delivery = 'url';
    } else {
      throw BrowserGlassError.local(
        'capture',
        'bgls.error.capture.failed',
        'target.captured carried neither inline data nor a downloadId',
      );
    }

    return {
      captureId: reply.captureId,
      targetId: reply.targetId,
      blob,
      format: reply.format,
      width: reply.width,
      height: reply.height,
      dpr: reply.dpr,
      sizeBytes: reply.sizeBytes,
      fullPage: reply.fullPage,
      downscaled: reply.downscaled,
      delivery,
    };
  }

  async probe(targetId: string, x: number, y: number, opts?: ProbeOptions): Promise<ProbeResult> {
    const stream = this.subscriptions.get(targetId)?.handle;
    const info = stream?.info();
    const reply = await this.request<TargetProbed>('target.probe', {
      targetId,
      x,
      y,
      fw: info?.width ?? 0,
      fh: info?.height ?? 0,
      ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
    });
    return {
      targetId: reply.targetId,
      detail: reply.detail,
      gen: reply.gen,
      hit: reply.hit,
      ...(reply.rect !== undefined ? { rect: reply.rect } : {}),
      ...(reply.label !== undefined ? { label: reply.label } : {}),
      ...(reply.tagName !== undefined ? { tagName: reply.tagName } : {}),
      ...(reply.href !== undefined ? { href: reply.href } : {}),
      ...(reply.hrefFromAncestor !== undefined ? { hrefFromAncestor: reply.hrefFromAncestor } : {}),
      ...(reply.name !== undefined ? { name: reply.name } : {}),
      ...(reply.role !== undefined ? { role: reply.role } : {}),
      ...(reply.attributes !== undefined ? { attributes: reply.attributes } : {}),
      ...(reply.outerHTML !== undefined ? { outerHTML: reply.outerHTML } : {}),
      ...(reply.outerHTMLTruncated !== undefined
        ? { outerHTMLTruncated: reply.outerHTMLTruncated }
        : {}),
      ...(reply.ancestors !== undefined ? { ancestors: reply.ancestors } : {}),
      ...(reply.ancestorsTruncated !== undefined
        ? { ancestorsTruncated: reply.ancestorsTruncated }
        : {}),
    };
  }

  /**
   * Coalesced hover probe (the exact four-step
   * algorithm, see {@link HoverWatcher}). Feeds itself from the target's
   * own attached canvas's `pointermove`/`pointerleave`; calling
   * `probe()` on every pointer move instead is the one documented way to
   * misuse this API. Returns its own unsubscribe.
   */
  watchHover(targetId: string, fn: (r: ProbeResult | null) => void): Unsubscribe {
    this.hoverWatchers.get(targetId)?.stop();
    const watcher = new HoverWatcher(
      (x, y) => this.probe(targetId, x, y, { detail: 'hover' }),
      () => this.subscriptions.get(targetId)?.handle.gen ?? 0,
      fn,
    );
    this.hoverWatchers.set(targetId, watcher);

    const canvas = this.subscriptions.get(targetId)?.handle.canvasElement();
    let move: ((e: PointerEvent) => void) | null = null;
    let leave: (() => void) | null = null;
    if (canvas) {
      const renderer = this.subscriptions.get(targetId)?.handle.renderer;
      move = (e: PointerEvent) => {
        const p = renderer?.toFrame(e.clientX, e.clientY);
        if (p?.inside) watcher.feed(p.x, p.y);
      };
      leave = () => watcher.leave();
      canvas.addEventListener('pointermove', move);
      canvas.addEventListener('pointerleave', leave);
    }

    return () => {
      watcher.stop();
      this.hoverWatchers.delete(targetId);
      if (canvas && move && leave) {
        canvas.removeEventListener('pointermove', move);
        canvas.removeEventListener('pointerleave', leave);
      }
    };
  }

  // ==================================================================
  // Instance
  // ==================================================================

  async restart(opts?: RestartOptions): Promise<RestartResult> {
    if (!this._granted.has('instance.restart')) {
      throw BrowserGlassError.local(
        'cap',
        'bgls.error.cap.missing',
        "restart() needs the 'instance.restart' capability",
      );
    }
    const instanceId = this._instance?.instanceId;
    if (!instanceId)
      throw BrowserGlassError.local(
        'instance',
        'bgls.error.instance.not_found',
        'no instance on this session yet',
      );

    if (this.restartPromise && this.restartInstanceId === instanceId) {
      const shared = this.restartPromise;
      return shared.then((r) => ({ ...r, initiated: false }));
    }

    const timeoutMs = opts?.timeoutMs ?? 60000;
    this.restartInstanceId = instanceId;
    const startedAt = now();
    const id = randomCorrelationId();
    this.trySend({
      v: 1,
      t: 'instance.restart',
      id,
      ts: Date.now(),
      instanceId,
      ...(opts?.reason !== undefined ? { reason: opts.reason } : {}),
      ...(opts?.preserveProfile !== undefined ? { preserveProfile: opts.preserveProfile } : {}),
    });

    const run = this.awaitMessage<InstanceRecovered | ErrorMsg>(
      (m) =>
        (m.t === 'instance.recovered' && m['instanceId'] === instanceId) ||
        (m.t === 'error' && m.re === id),
      timeoutMs,
    ).then((msg) => {
      if (msg.t === 'error') throw BrowserGlassError.fromErrorMsg(msg as ErrorMsg);
      const r = msg as InstanceRecovered;
      return {
        durationMs: now() - startedAt,
        initiated: true,
        targetsRestored: r.targetsPreserved ? this._targets.length : r.streamsResubscribed.length,
        targetsLost: r.streamsLost.length,
        streamsResubscribed: r.streamsResubscribed,
      } satisfies RestartResult;
    });

    this.restartPromise = run.finally(() => {
      if (this.restartInstanceId === instanceId) {
        this.restartPromise = null;
        this.restartInstanceId = null;
      }
    });
    return this.restartPromise;
  }

  // ==================================================================
  // Files, dialogs
  // ==================================================================

  /**
   * Begins a file upload. `upload.*` is typed only, not wired, in this
   * release: the `upload.begin` handshake is
   * attempted for real, but the chunked binary transfer that would follow
   * `upload.accepted` has no server counterpart yet and no path for this
   * package's {@link Transport} to send a raw binary frame (it exposes
   * `send(Envelope)` only). `done` resolves once a real transfer path
   * exists; until then it rejects with a clear, typed reason rather than
   * hanging.
   */
  upload(file: File | Blob, opts: UploadOptions): UploadHandle {
    const uploadId = randomCorrelationId();
    let cancelled = false;
    const done = (async (): Promise<{ uploadId: string; path: string; sizeBytes: number }> => {
      await this.request('upload.begin', {
        uploadId,
        targetId: opts.targetId,
        name: file instanceof File ? file.name : 'blob',
        sizeBytes: file.size,
        mime: file.type || 'application/octet-stream',
        purpose: opts.purpose,
        ...(opts.chooserId !== undefined ? { chooserId: opts.chooserId } : {}),
      });
      if (cancelled)
        throw BrowserGlassError.local('upload', 'bgls.error.upload.not_found', 'upload cancelled');
      // See doc comment above: chunk transfer is not wired yet.
      throw BrowserGlassError.local(
        'upload',
        'bgls.error.upload.not_found',
        'chunked upload transfer is not implemented yet (upload.* is typed only, not wired)',
      );
    })();
    return {
      uploadId,
      path: null,
      done,
      cancel: () => {
        cancelled = true;
      },
    };
  }

  async answerFileChooser(chooserId: string, uploads: UploadHandle[] | null): Promise<void> {
    this.trySend({
      v: 1,
      t: 'filechooser.answer',
      ts: Date.now(),
      chooserId,
      uploadIds: uploads?.map((u) => u.uploadId) ?? [],
      ...(uploads === null ? { cancel: true } : {}),
    });
  }

  async answerDialog(dialogId: string, accept: boolean, promptText?: string): Promise<void> {
    this.trySend({
      v: 1,
      t: 'dialog.answer',
      ts: Date.now(),
      dialogId,
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  }

  // ==================================================================
  // Diagnostics
  // ==================================================================

  stats(): ClientStats {
    let fps = 0;
    let decodeMs = 0;
    for (const handle of this.streamsById.values()) {
      const s = handle.stats();
      fps += s.fpsSent;
      if (s.renderer && s.renderer.lastDecodeMs > decodeMs) decodeMs = s.renderer.lastDecodeMs;
    }
    return { ...this.transport.stats(), streams: this.streamsById.size, fps, decodeMs };
  }

  async ping(): Promise<number> {
    const cts = now();
    this.trySend({ v: 1, t: 'ping', ts: Date.now(), cts });
    const pong = await this.awaitMessage<Envelope & { cts: number }>(
      (m) => m.t === 'pong' && m['cts'] === cts,
      this.requestTimeoutMs,
    );
    void pong;
    return now() - cts;
  }

  // ==================================================================
  // Low-level input
  // ==================================================================

  /**
   * Sends one already-built input envelope, stamping the sender's current
   * `leaseId` for that message's `targetId` itself: a caller (including this class's own `InputCapture`
   * instances) never needs to track the current lease correctly, because
   * this is the one place that does. Public and documented as low-level:
   * most apps never call it directly, `InputCapture` does. Also the single
   * point `presenceCursor` piggybacks off `input.mouse` moves.
   */
  sendInput(msg: SendableInputMessage): void {
    const leaseId = this.myLeases.get(msg.targetId)?.leaseId ?? '';
    this.trySend({ ...msg, leaseId });
    if (this.presenceCursorEnabled && msg.t === 'input.mouse' && msg.kind === 'move') {
      const nowMs = now();
      if (nowMs - this.lastCursorSentAt >= 40) {
        this.lastCursorSentAt = nowMs;
        this.trySend({
          v: 1,
          t: 'presence.cursor',
          ts: Date.now(),
          targetId: msg.targetId,
          x: msg.x,
          y: msg.y,
          fw: msg.fw,
          fh: msg.fh,
          action: 'move',
        });
      }
    }
  }

  // ==================================================================
  // Events
  // ==================================================================

  on<K extends keyof ClientEvents>(type: K, fn: (ev: ClientEvents[K]) => void): Unsubscribe {
    return this.emitter.on(type, fn);
  }
  once<K extends keyof ClientEvents>(type: K, fn: (ev: ClientEvents[K]) => void): Unsubscribe {
    return this.emitter.once(type, fn);
  }
  off<K extends keyof ClientEvents>(type: K, fn: (ev: ClientEvents[K]) => void): void {
    this.emitter.off(type, fn);
  }

  // ==================================================================
  // Internal: transport wiring
  // ==================================================================

  private wireTransportEvents(): void {
    this.transport.on('state', (ev) => {
      this.emitter.emit('state', ev);
      this.applyDimming();
    });
    this.transport.on('connected', (ev) => {
      const w = ev.welcome;
      this._viewerId = w.viewerId;
      this._sessionId = w.sessionId;
      this._instance = w.instance;
      this._targets = w.targets;
      this._granted = new Set(w.granted);
      this._limits = w.limits;
      // `welcome.presence.viewers` is a reduced projection (no `colour`,
      // `watching`, `idle`, `joinedAt`, and a loose `kind: string`); the
      // fuller `ViewerPresence` roster arrives on the first `presence.state`
      // broadcast, which every session sends promptly after `welcome`.
      this._presence = w.presence.viewers.map((v) => ({
        viewerId: v.viewerId,
        label: v.label,
        kind: (v.kind === 'human' || v.kind === 'agent' || v.kind === 'service'
          ? v.kind
          : 'human') as ViewerPresence['kind'],
        colour: '',
        controlling: v.controlling,
        watching: [] as string[],
        idle: false,
        joinedAt: 0,
      }));
      this.emitter.emit('connected', {
        viewerId: w.viewerId,
        sessionId: w.sessionId,
        resumed: ev.resumed,
        instance: w.instance,
        targets: w.targets,
        granted: w.granted,
        limits: w.limits,
        downgraded: w.downgraded,
      });
    });
    this.transport.on('disconnected', (ev) => {
      this.lastReconnectAttempt = ev.attempt;
      this.emitter.emit('disconnected', ev);
    });
    this.transport.on('degraded', (ev) => {
      this.emitter.emit('degraded', ev);
      this.applyDimming();
    });
    this.transport.on('reconnecting', (ev) => {
      this.lastReconnectAttempt = ev.attempt;
      for (const capture of this.inputCaptures.values()) capture.releaseStuckButtons();
      this.emitter.emit('reconnecting', ev);
      this.applyDimming();
    });
    this.transport.on('resumed', (ev) => {
      this.emitter.emit('resumed', ev);
      if (!ev.leaseRestored) {
        for (const targetId of Array.from(this.myLeases.keys())) {
          this.myLeases.delete(targetId);
          this.emitter.emit('controllost', { targetId, reason: 'expired' });
        }
      }
    });
    this.transport.on('fatal', (ev) => {
      this.emitter.emit('fatal', ev);
      this.applyDimming();
    });
    this.transport.on('message', (msg) => this.handleControlMessage(msg));
    this.transport.on('binary', (buf) => this.handleBinaryFrame(buf));
  }

  private applyDimming(): void {
    const { dim, greyscale } = dimFor(this.transport.state, this.lastReconnectAttempt);
    for (const handle of this.streamsById.values()) {
      handle.renderer?.setDim(dim);
      handle.renderer?.setGreyscale(greyscale);
    }
  }

  /**
   * Every binary frame is acked, including one this client cannot do
   * anything with.
   *
   * `Attachment`'s fan-out gate stops sending to a viewer once `maxBacklog`
   * (3) frames are outstanding unacked, which is correct backpressure for a
   * genuinely slow consumer. A frame dropped here without an ack is
   * indistinguishable from one still being decoded, so three of them wedge
   * that stream permanently: the server sends nothing further, the pane
   * never repaints, and it sits black for the life of the session while
   * every other pane behaves normally.
   *
   * A frame with no handle is exactly what arrives in the window between
   * the server starting a stream and this client processing that stream's
   * `stream.subscribed` reply, so the target most likely to lose the race
   * is the first one subscribed, which is also the one Chrome screencasts.
   * Acking it costs nothing and keeps the server's accounting honest.
   */
  private handleBinaryFrame(buf: ArrayBuffer): void {
    const header = decodeBinaryHeader(buf);
    const ack = (): void => {
      this.trySend({ v: 1, t: 'ack', ts: Date.now(), streamId: header.streamId, seq: header.seq });
    };
    const handle = this.streamsById.get(header.streamId);
    if (!handle) {
      ack();
      return;
    }
    this.keyframeBySeq.set(`${header.streamId}:${header.seq}`, header.keyframe);
    if (handle.renderer) {
      handle.pushToRenderer(header);
    } else {
      ack();
      this.keyframeBySeq.delete(`${header.streamId}:${header.seq}`);
    }
  }

  // eslint-disable-next-line complexity
  private handleControlMessage(msg: Envelope): void {
    switch (msg.t) {
      case 'error': {
        this._lastError = msg as ErrorMsg;
        this.emitter.emit('error', msg as ErrorMsg);
        break;
      }
      case 'capabilities.updated': {
        const granted = new Set((msg['granted'] as Capability[]) ?? []);
        const lost = Array.from(this._granted).filter((c) => !granted.has(c));
        this._granted = granted;
        this.emitter.emit('capabilities', { granted: Array.from(granted), lost });
        break;
      }
      case 'target.created': {
        const t = msg as unknown as TargetCreated;
        // Keyed by `targetId`, never appended blindly: the tab list is a
        // set, and the same target legitimately arrives more than once.
        // `tabs.new()` gets its own `target.created` as a correlated reply
        // AND the session broadcasts one to every viewer, so the caller of
        // `tabs.new()` sees both; a tab present in `welcome.targets` can be
        // announced again after a resync for the same reason. Appending
        // made `client.targets` drift above the real tab count, which
        // `useTargets()` renders directly, so the drift became duplicate
        // panes on screen.
        const existingIdx = this._targets.findIndex((x) => x.targetId === t.target.targetId);
        this._targets =
          existingIdx === -1
            ? [...this._targets, t.target]
            : this._targets.map((x, i) => (i === existingIdx ? { ...x, ...t.target } : x));
        this.emitter.emit('targets', {
          targets: this._targets,
          changed: existingIdx === -1 ? 'created' : 'updated',
        });
        break;
      }
      case 'target.updated': {
        const t = msg as unknown as TargetUpdated;
        this._targets = this._targets.map((x) =>
          x.targetId === t.targetId ? { ...x, ...t.changed } : x,
        );
        this.emitter.emit('targets', { targets: this._targets, changed: 'updated' });
        break;
      }
      case 'target.closed': {
        const t = msg as unknown as TargetClosed;
        this._targets = this._targets.filter((x) => x.targetId !== t.targetId);
        const handle = this.subscriptions.get(t.targetId)?.handle;
        handle?.close('target-closed');
        this.emitter.emit('targets', { targets: this._targets, changed: 'closed' });
        break;
      }
      case 'nav.state': {
        const n = msg as unknown as NavState;
        this.emitter.emit('nav', {
          targetId: n.targetId,
          url: n.url,
          title: n.title,
          loading: n.loading,
          canGoBack: n.canGoBack,
          canGoForward: n.canGoForward,
          securityState: n.securityState,
          ...(n.errorText !== undefined ? { errorText: n.errorText } : {}),
          ...(n.httpStatus !== undefined ? { httpStatus: n.httpStatus } : {}),
          ...(n.redirectedFrom !== undefined ? { redirectedFrom: n.redirectedFrom } : {}),
        });
        break;
      }
      case 'control.state': {
        const c = msg as unknown as ControlStateMsg;
        // Merged by `targetId`, never cleared first. `control.state` is
        // built and broadcast by ONE target's own `ControlLeaseEngine`
        // (`packages/core/src/control/lease-engine.ts`, `buildStateMsg`),
        // so it carries that target's entry alone and is a partial update,
        // not a whole-session snapshot. Clearing the map on each one left
        // whichever target spoke last as the only lease this client
        // believed in: a viewer driving three tabs took control of all
        // three, the server granted all three, and two of them silently
        // reverted to "nobody is driving" on screen. Releasing still works
        // through this path, because a released lease is broadcast as the
        // same entry with a null `holderViewerId`.
        for (const lease of c.leases) {
          this.leasesByTarget.set(lease.targetId, lease);
        }
        const mine: string[] = [];
        for (const [targetId, lease] of this.leasesByTarget) {
          if (lease.holderViewerId === this._viewerId) mine.push(targetId);
        }
        this.emitter.emit('control', {
          leases: Array.from(this.leasesByTarget.values()),
          mine,
          changed: c.leases.map((l) => l.targetId),
        });
        break;
      }
      case 'control.granted': {
        // Not every grant answers a live `request()` call. A `control.renew`
        // is answered with a fresh `control.granted`, and a request that was
        // queued behind another viewer is granted later, unprompted, when it
        // reaches the head. Both carry a new `expiresAt` that this client
        // must adopt, or the lease it still holds looks expired locally and
        // `sendInput()` goes back to stamping an empty `leaseId`.
        const g = msg as unknown as ControlGranted;
        if (typeof g.targetId === 'string' && typeof g.leaseId === 'string') {
          this.adoptGrant(g.targetId, g);
        }
        break;
      }
      case 'control.revoked': {
        const r = msg as unknown as ControlRevoked;
        if (this.myLeases.get(r.targetId)?.leaseId === r.leaseId) {
          this.myLeases.delete(r.targetId);
          this.transport.clearLeaseHeld(r.targetId);
          this.inputCaptures.get(r.targetId)?.setLeaseId('');
          this.emitter.emit('controllost', {
            targetId: r.targetId,
            reason: r.reason === 'capability_lost' ? 'admin' : r.reason,
            ...(r.byLabel !== undefined ? { byLabel: r.byLabel } : {}),
          });
        }
        break;
      }
      case 'control.preempt.request': {
        const p = msg as unknown as ControlPreemptRequest;
        this.emitter.emit('controlpreemptrequested', {
          targetId: p.targetId,
          byLabel: p.byLabel,
          reason: p.reason,
          graceMs: p.graceMs,
          deadline: p.deadline,
        });
        break;
      }
      case 'control.preempted': {
        const p = msg as unknown as ControlPreempted;
        this.myLeases.delete(p.targetId);
        this.transport.clearLeaseHeld(p.targetId);
        this.inputCaptures.get(p.targetId)?.setLeaseId('');
        this.emitter.emit('controlpreempted', {
          targetId: p.targetId,
          byLabel: p.byLabel,
          reason: p.reason,
          released: p.released,
          lastDispatchedInputSeq: p.lastDispatchedInputSeq,
          mayRequeue: p.mayRequeue,
          requeueAfterMs: p.requeueAfterMs,
        });
        break;
      }
      case 'presence.state': {
        const p = msg as unknown as PresenceState;
        this._presence = p.viewers;
        this.emitter.emit('presence', { viewers: p.viewers });
        break;
      }
      case 'presence.cursor': {
        const p = msg as unknown as PresenceCursor;
        const vid = msg.vid;
        if (typeof vid === 'string')
          this.emitter.emit('cursor', {
            viewerId: vid,
            targetId: p.targetId,
            x: p.x,
            y: p.y,
            label: '',
            colour: '',
            ...(p.action !== undefined ? { action: p.action } : {}),
          });
        break;
      }
      case 'instance.state': {
        const s = msg as unknown as InstanceStateMsg;
        this.emitter.emit('instance', {
          instanceId: s.instanceId,
          state: s.state,
          ...(s.reason !== undefined ? { reason: s.reason } : {}),
        });
        break;
      }
      case 'instance.recovering': {
        const r = msg as unknown as InstanceRecovering;
        this.emitter.emit('recovering', {
          rung: r.rung,
          signal: r.signal,
          attempt: r.attempt,
          estimatedMs: r.estimatedMs,
          message: r.message,
          ...(r.requestedByLabel !== undefined ? { requestedByLabel: r.requestedByLabel } : {}),
          ...(r.requestedReason !== undefined ? { requestedReason: r.requestedReason } : {}),
        });
        this.applyDimming();
        break;
      }
      case 'instance.recovered': {
        const r = msg as unknown as InstanceRecovered;
        this.emitter.emit('recovered', {
          rung: r.rung,
          durationMs: r.durationMs,
          streamsResubscribed: r.streamsResubscribed,
          streamsLost: r.streamsLost,
        });
        this.applyDimming();
        break;
      }
      case 'instance.released': {
        // Every viewer's socket closes with 4006 right behind this
        // message (see the wire spec); every stream this client held is
        // gone with it. `InstanceReleased`'s own `reason` field has no
        // corresponding `StreamEvents.closed` reason value, so this maps
        // to `'session-ended'`, the closest of the three.
        for (const handle of this.streamsById.values()) handle.close('session-ended');
        break;
      }
      case 'dialog.opened': {
        const d = msg as unknown as DialogOpened;
        this.emitter.emit('dialog', {
          dialogId: d.dialogId,
          targetId: d.targetId,
          kind: d.kind,
          message: d.message,
          ...(d.defaultPrompt !== undefined ? { defaultPrompt: d.defaultPrompt } : {}),
          url: d.url,
        });
        break;
      }
      case 'dialog.closed': {
        // No dedicated `ClientEvents` member (`dialog` covers the open
        // side); an app tracks a dialog's lifetime from its own
        // `answerDialog()` call.
        break;
      }
      case 'filechooser.opened': {
        const f = msg as unknown as FileChooserOpened;
        this.emitter.emit('filechooser', {
          chooserId: f.chooserId,
          targetId: f.targetId,
          multiple: f.multiple,
          accept: f.accept,
          elementDescription: f.elementDescription,
        });
        break;
      }
      case 'download.started':
      case 'download.progress':
      case 'download.ready':
      case 'download.failed': {
        this.emitDownloadEvent(msg);
        break;
      }
      case 'stream.subscribed': {
        // Handled inline by `subscribe()`/`setQuality()`'s own `request()`
        // correlation; nothing further to do generically here.
        break;
      }
      case 'stream.stats': {
        const s = msg as unknown as WireStreamStats;
        const handle = this.streamsById.get(s.streamId);
        handle?.applyStats({
          streamId: s.streamId,
          targetId: handle.targetId,
          quality: s.quality,
          codec: s.codec,
          paused: handle.paused,
          fpsSent: s.fpsSent,
          fpsDropped: s.fpsDropped,
          bytesPerSec: s.bytesPerSec,
          backlog: s.backlog,
          bufferedBytes: s.bufferedBytes,
          encodeMsP50: s.encodeMsP50,
          encodeMsP95: s.encodeMsP95,
          rttMs: s.rttMs,
          ...(s.adaptedReason !== undefined ? { adaptedReason: s.adaptedReason } : {}),
        });
        break;
      }
      case 'stream.degraded': {
        // No dedicated `ClientEvents` member; the stream's own
        // `stream.stats` (`StreamEvents.stats`) already carries
        // `adaptedReason` for a UI to explain a quality drop.
        break;
      }
      case 'console.entry': {
        const c = msg as unknown as Envelope & {
          targetId: string;
          level: string;
          text: string;
          url?: string;
          line?: number;
        };
        this.emitter.emit('console', {
          targetId: c.targetId,
          level: c.level,
          text: c.text,
          ...(c.url !== undefined ? { url: c.url } : {}),
          ...(c.line !== undefined ? { line: c.line } : {}),
        });
        break;
      }
      case 'page.error': {
        const p = msg as unknown as Envelope & {
          targetId: string;
          name: string;
          message: string;
          stack?: string;
        };
        this.emitter.emit('pageerror', {
          targetId: p.targetId,
          name: p.name,
          message: p.message,
          ...(p.stack !== undefined ? { stack: p.stack } : {}),
        });
        break;
      }
      case 'network.request': {
        const n = msg as unknown as Envelope & {
          targetId: string;
          requestId: string;
          method: string;
          url: string;
          resourceType: string;
          status: number | null;
          errorText: string | null;
          fromCache: boolean;
          durationMs: number | null;
          encodedBytes: number | null;
          startedAt: number;
        };
        this.emitter.emit('network', {
          targetId: n.targetId,
          requestId: n.requestId,
          method: n.method,
          url: n.url,
          resourceType: n.resourceType,
          status: n.status,
          errorText: n.errorText,
          fromCache: n.fromCache,
          durationMs: n.durationMs,
          encodedBytes: n.encodedBytes,
          startedAt: n.startedAt,
        });
        break;
      }
      case 'network.summary': {
        const s = msg as unknown as Envelope & {
          targetId: string;
          windowMs: number;
          requests: number;
          failed: number;
          bytesIn: number;
          bytesOut: number;
          slowest: Array<{ url: string; ms: number; status: number }>;
        };
        this.emitter.emit('networksummary', {
          targetId: s.targetId,
          windowMs: s.windowMs,
          requests: s.requests,
          failed: s.failed,
          bytesIn: s.bytesIn,
          bytesOut: s.bytesOut,
          slowest: s.slowest,
        });
        break;
      }
      case 'diagnostics.subscribed': {
        // Handled inline by `diagnostics.subscribe()`'s own `request()`
        // correlation; nothing further to do generically here, matching
        // `stream.subscribed` just above.
        break;
      }
      default:
        // Unknown message types are ignored silently, per protocol (forward
        // compatibility for new message types shipped in a minor release).
        break;
    }
  }

  private emitDownloadEvent(msg: Envelope): void {
    const downloadId = msg['downloadId'];
    if (typeof downloadId !== 'string') return;
    if (msg.t === 'download.started') {
      const d = msg as unknown as Envelope & { suggestedName: string; totalBytes: number | null };
      this.emitter.emit('download', {
        downloadId,
        phase: 'started',
        suggestedName: d.suggestedName,
        totalBytes: d.totalBytes,
      });
    } else if (msg.t === 'download.progress') {
      const d = msg as unknown as Envelope & { receivedBytes: number; totalBytes: number | null };
      this.emitter.emit('download', {
        downloadId,
        phase: 'progress',
        suggestedName: '',
        receivedBytes: d.receivedBytes,
        totalBytes: d.totalBytes,
      });
    } else if (msg.t === 'download.ready') {
      const d = msg as unknown as DownloadReady;
      this.emitter.emit('download', { downloadId, phase: 'ready', suggestedName: '', url: d.url });
    } else {
      this.emitter.emit('download', { downloadId, phase: 'failed', suggestedName: '' });
    }
  }

  // ==================================================================
  // Internal: request/response correlation
  // ==================================================================

  private request<T extends Envelope = Envelope>(
    t: string,
    payload: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const id = randomCorrelationId();
    const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
    const promise = this.awaitMessage<T | ErrorMsg>((m) => m.re === id, timeoutMs, id).then(
      (msg) => {
        if (msg.t === 'error') throw BrowserGlassError.fromErrorMsg(msg as ErrorMsg);
        return msg as T;
      },
    );
    try {
      this.transport.send({ v: 1, t, id, ts: Date.now(), ...payload });
    } catch (err) {
      throw err instanceof Error
        ? BrowserGlassError.local('internal', 'bgls.error.internal', err.message, id)
        : err;
    }
    return promise;
  }

  /** `timeoutMs` non-finite (`Infinity`, as `requestControl({timeoutMs:0})` translates to) waits forever: no timer is armed at all. */
  private awaitMessage<T extends Envelope>(
    predicate: (m: Envelope) => boolean,
    timeoutMs: number,
    requestId?: string,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? scheduleTimer(() => {
            off();
            reject(
              BrowserGlassError.local(
                'protocol',
                'bgls.error.internal',
                `request timed out after ${timeoutMs}ms`,
                requestId,
              ),
            );
          }, timeoutMs)
        : null;
      const off = this.transport.on('message', (msg) => {
        if (!predicate(msg)) return;
        timer?.cancel();
        off();
        resolve(msg as T);
      });
    });
  }

  // ==================================================================
  // Internal: input capture wiring
  // ==================================================================

  /** Called by `applyAttach()` once a canvas is actually attached, which is the earliest point a coordinate transform exists for `InputCapture` to use. Replaces any previously created capture for this target. */
  private createInputCaptureFor(
    targetId: string,
    canvas: HTMLCanvasElement,
    container: HTMLElement,
    handle: StreamHandleImpl,
  ): void {
    this.inputCaptures.get(targetId)?.destroy();
    const renderer = handle.renderer;
    if (!renderer) return;
    const lease = this.myLeases.get(targetId);
    const capture = new InputCapture(canvas, container, {
      renderer,
      targetId,
      leaseId: lease?.leaseId ?? '',
      send: (msg) => this.sendInput(msg),
    });
    this.inputCaptures.set(targetId, capture);
  }

  private wireKeyboardLock(canvas: HTMLCanvasElement): void {
    const nav = navigator as Navigator & {
      keyboard?: { lock?: (keys?: string[]) => Promise<void>; unlock?: () => void };
    };
    if (!nav.keyboard?.lock) return;
    canvas.addEventListener('pointerdown', () => {
      nav.keyboard?.lock?.(RESERVED_KEYBOARD_LOCK_KEYS).catch(() => {
        // best effort; unsupported or denied contexts (not a top-level frame, etc.) fall back silently
      });
    });
  }
}

function detectRuntime(): 'browser' | 'node' {
  return typeof window === 'undefined' ? 'node' : 'browser';
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes as BlobPart], { type: mime });
}
