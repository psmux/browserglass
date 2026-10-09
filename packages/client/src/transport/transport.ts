import {
  CLOSE_REASON_BY_CODE_NAME,
  CloseCode,
  type CloseCodeName,
  type Envelope,
  type ErrorMsg,
  type Goodbye,
  type Hello,
  type Ping,
  type Pong,
  type QualityProfile,
  type Resumed,
  type Welcome,
  reconnectPolicy,
} from '@browserglass/protocol';
import { BrowserGlassError } from '../client/errors.js';
import { Emitter, type Unsubscribe } from './emitter.js';
import {
  type CancellableTimer,
  hasVisibilityApi,
  now,
  onVisibilityChange,
  randomCorrelationId,
  scheduleTimer,
  visibilityState,
} from './env.js';
import { type DegradeReason, KeepaliveManager } from './keepalive.js';
import { ReconnectController, backoffScheduleFor } from './reconnect.js';
import { isResumeWithinWindow, resumeRecordFromWelcome, toHelloResume } from './resume.js';
import { ConnectionStateMachine } from './state-machine.js';
import {
  type BackoffSchedule,
  type ClientStats,
  type CloseInfo,
  type ConnectionState,
  type DesiredSubscription,
  type FatalInfo,
  type Logger,
  NOOP_LOGGER,
  type ResumeRecord,
  type TransportEvents,
  type TransportOptions,
  type WebSocketCloseEventLike,
  type WebSocketConstructorLike,
  type WebSocketLike,
} from './types.js';

/** Reverse lookup from a numeric {@link CloseCode} to its {@link CLOSE_REASON_BY_CODE_NAME} reason string. */
const CLOSE_CODE_TO_REASON: ReadonlyMap<number, string> = new Map(
  (Object.entries(CLOSE_REASON_BY_CODE_NAME) as Array<[CloseCodeName, string]>).map(
    ([name, reason]) => [CloseCode[name], reason],
  ),
);

function closeCodeReasonName(code: number): string {
  return CLOSE_CODE_TO_REASON.get(code) ?? `close_${code}`;
}

function defaultWebSocketImpl(): WebSocketConstructorLike | undefined {
  return (globalThis as unknown as { WebSocket?: WebSocketConstructorLike }).WebSocket;
}

function toArrayBuffer(data: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const view = data;
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function toHelloSubscribeEntry(d: DesiredSubscription): {
  targetId: string;
  quality?: QualityProfile;
} {
  return d.quality === undefined
    ? { targetId: d.targetId }
    : { targetId: d.targetId, quality: d.quality };
}

/** Whether `url` is a `ws://` (not `wss://`) URL pointed at a loopback host. */
function isLoopbackWsUrl(url: string): boolean {
  return /^ws:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/.test(url);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface NormalizedSocketOptions {
  protocols: string[];
  pingIntervalMs: number;
  healthTimeoutMs: number;
  handshakeTimeoutMs: number;
  WebSocketImpl: WebSocketConstructorLike | undefined;
}

interface TransportStatsState {
  connectedAt: number | null;
  disconnectedAt: number | null;
  reconnectAttempt: number;
  reconnectCount: number;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  rttMs: number | null;
  lastPongAt: number | null;
  lastFrameAt: number | null;
  resumesAccepted: number;
  resumesRejected: number;
}

/**
 * Owns the `bgls.v1` connection lifecycle: the eight-state machine, the
 * WebSocket handshake, reconnection with backoff, resume, the 4200
 * ticket-consumed exception, `sq` gap detection, and the application-level
 * keepalive. Everything above the wire (stream/target/control message
 * routing, canvas rendering, input capture) is layered on top by the
 * client-assembly task; this class exposes only `send()`, the raw
 * `message`/`binary` events, and the connection-lifecycle events in
 * {@link TransportEvents}.
 *
 * Every field this class needs from the host environment (timers, a
 * monotonic clock, `document.visibilityState`, a WebSocket constructor)
 * is reached through `./env.js` and the injectable
 * `transport.WebSocketImpl`, so the whole class is exercised in tests
 * against a scripted fake with no real network or timers.
 */
export class Transport {
  private readonly logger: Logger;
  private readonly emitter = new Emitter<TransportEvents>();
  private readonly fsm: ConnectionStateMachine;
  private readonly reconnectCtl: ReconnectController;
  private readonly keepalive: KeepaliveManager;
  private readonly socketOpts: NormalizedSocketOptions;
  private readonly autoReconnect: boolean;
  private readonly resumeWindowMs: number;

  private url: string;
  private ticket: string | null;
  private token: string | null;
  private ticketConsumed = false;
  private ticketConsumedRetried = false;

  private desiredSubscriptions: DesiredSubscription[];
  private resumeRecord: ResumeRecord | null = null;
  private resumeRequestedThisAttempt = false;

  private ws: WebSocketLike | null = null;
  private helloId: string | null = null;
  private lastSq = 0;
  private lastError: ErrorMsg | null = null;
  private lastGoodbye: Goodbye | null = null;

  private destroyed = false;
  private connectPromise: Deferred<void> | null = null;

  private handshakeTimer: CancellableTimer | null = null;
  private resumingTimer: CancellableTimer | null = null;
  private reconnectTimer: CancellableTimer | null = null;
  private visibilityUnsub: Unsubscribe | null = null;

  private readonly stats_: TransportStatsState = {
    connectedAt: null,
    disconnectedAt: null,
    reconnectAttempt: 0,
    reconnectCount: 0,
    lastCloseCode: null,
    lastCloseReason: null,
    rttMs: null,
    lastPongAt: null,
    lastFrameAt: null,
    resumesAccepted: 0,
    resumesRejected: 0,
  };

  constructor(private readonly userOptions: TransportOptions) {
    this.logger = userOptions.logger ?? NOOP_LOGGER;
    this.url = userOptions.url;
    this.ticket = userOptions.ticket ?? null;
    this.token = userOptions.token ?? null;
    this.autoReconnect = userOptions.autoReconnect ?? true;
    this.resumeWindowMs = userOptions.resumeWindowMs ?? 120000;
    this.desiredSubscriptions = userOptions.subscribe ?? [];
    this.socketOpts = {
      protocols: userOptions.transport?.protocols ?? ['bgls.v1'],
      pingIntervalMs: userOptions.transport?.pingIntervalMs ?? 5000,
      healthTimeoutMs: userOptions.transport?.healthTimeoutMs ?? 5000,
      handshakeTimeoutMs: userOptions.transport?.handshakeTimeoutMs ?? 10000,
      WebSocketImpl: userOptions.transport?.WebSocketImpl ?? defaultWebSocketImpl(),
    };

    if (
      !(userOptions.transport?.allowInsecureTransport ?? false) &&
      this.url.startsWith('ws://') &&
      !isLoopbackWsUrl(this.url)
    ) {
      throw new Error(
        `insecure ws:// transport to a non-localhost host is disallowed; pass transport.allowInsecureTransport: ${this.url}`,
      );
    }

    this.reconnectCtl = new ReconnectController(userOptions.reconnect);
    this.keepalive = new KeepaliveManager({
      pingIntervalMs: this.socketOpts.pingIntervalMs,
      healthTimeoutMs: this.socketOpts.healthTimeoutMs,
      sendPing: (cts) => this.sendPingEnvelope(cts),
      onDegrade: (reason) => this.handleDegrade(reason),
      onRecover: (signal) => this.handleRecover(signal),
      onPong: (rttMs) => {
        this.stats_.rttMs = rttMs;
        this.emitter.emit('pong', { rttMs });
      },
    });
    this.fsm = new ConnectionStateMachine('idle', (from, to, reason) => {
      this.emitter.emit('state', { from, to, reason });
    });
  }

  /** The current {@link ConnectionState}. */
  get state(): ConnectionState {
    return this.fsm.state;
  }

  /** Subscribes `fn` to every `type` event; returns its own unsubscribe. */
  on<K extends keyof TransportEvents>(type: K, fn: (ev: TransportEvents[K]) => void): Unsubscribe {
    return this.emitter.on(type, fn);
  }

  /** Subscribes `fn` to the next `type` event only. */
  once<K extends keyof TransportEvents>(
    type: K,
    fn: (ev: TransportEvents[K]) => void,
  ): Unsubscribe {
    return this.emitter.once(type, fn);
  }

  /** Unsubscribes `fn` from `type`. */
  off<K extends keyof TransportEvents>(type: K, fn: (ev: TransportEvents[K]) => void): void {
    this.emitter.off(type, fn);
  }

  /** Transport-scoped connection diagnostics. See {@link ClientStats}. */
  stats(): ClientStats {
    const nowMs = now();
    return {
      state: this.fsm.state,
      connectedAt: this.stats_.connectedAt,
      disconnectedAt: this.stats_.disconnectedAt,
      reconnectAttempt: this.stats_.reconnectAttempt,
      reconnectCount: this.stats_.reconnectCount,
      usingResume:
        this.resumeRecord !== null &&
        this.reconnectCtl.isWithinResumeWindow(nowMs, this.resumeWindowMs),
      lastCloseCode: this.stats_.lastCloseCode,
      lastCloseReason: this.stats_.lastCloseReason,
      rttMs: this.stats_.rttMs,
      lastPongAt: this.stats_.lastPongAt,
      lastFrameAt: this.stats_.lastFrameAt,
      resumesAccepted: this.stats_.resumesAccepted,
      resumesRejected: this.stats_.resumesRejected,
    };
  }

  /**
   * Opens the socket. Resolves once `welcome` has been fully processed
   * (the state machine reaches `live` or `resuming`). Rejects only on a
   * permanent failure (bad credential, no acceptable version, a
   * never-reconnect close). A transient failure does not reject: it
   * starts the reconnect loop, and this promise settles once that loop
   * either succeeds or the client reaches `fatal`. Calling `connect()`
   * while already connected is a no-op that resolves immediately; calling
   * it again while a connection attempt is already in flight returns the
   * same promise (safe under React StrictMode's double mount).
   */
  connect(): Promise<void> {
    if (this.destroyed) return Promise.reject(new Error('Transport is destroyed'));
    const s = this.fsm.state;
    if (s === 'live' || s === 'degraded' || s === 'resuming') return Promise.resolve();
    if (this.connectPromise) return this.connectPromise.promise;

    this.reconnectCtl.reset();
    this.connectPromise = deferred();
    this.fsm.transition('connecting', 'connect()');
    void this.beginSocketAttempt('connecting');
    return this.connectPromise.promise;
  }

  /**
   * Closes with `1000` by default and does not reconnect. Higher layers
   * (the client-assembly task) are responsible for releasing leases and
   * unsubscribing streams *before* calling this, so the next viewer in a
   * control queue is served in milliseconds rather than after a socket
   * timeout; this method itself only tears down the socket.
   */
  async disconnect(opts?: { code?: number; reason?: string }): Promise<void> {
    if (this.destroyed) return;
    this.stopReconnectTimer();
    this.stopVisibilityWatch();
    this.stopHandshakeTimer();
    this.stopResumingTimer();
    this.keepalive.stop();

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(opts?.code ?? CloseCode.NormalClosure, opts?.reason ?? '');
      } catch {
        // already closed; nothing to do
      }
    }
    if (this.fsm.state !== 'idle') this.fsm.transition('idle', 'disconnect()');
    this.rejectConnectPromise(new Error('disconnect() called'));
  }

  /**
   * `disconnect()` plus releases every listener and timer. Terminal: no
   * further state transitions occur, and `terminal` is not itself a
   * {@link ConnectionState} value, so this bypasses the state machine
   * rather than transitioning into it.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopReconnectTimer();
    this.stopVisibilityWatch();
    this.stopHandshakeTimer();
    this.stopResumingTimer();
    this.keepalive.stop();

    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // already closed; nothing to do
      }
    }
    this.rejectConnectPromise(new Error('destroy() called'));
    this.emitter.clear();
  }

  /** Sends one control-channel envelope. Throws if not currently `live`, `degraded`, or `resuming`. */
  send(msg: Envelope): void {
    if (this.destroyed) throw new Error('cannot send: Transport is destroyed');
    const s = this.fsm.state;
    if (!this.ws || (s !== 'live' && s !== 'degraded' && s !== 'resuming')) {
      throw new Error(`cannot send '${msg.t}': not connected (state=${s})`);
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Sends one raw binary frame, already framed by the caller with
   * `@browserglass/protocol`'s `encodeBinaryHeader`.
   *
   * The only client-to-server binary type in `bgls.v1` is `UPLOAD_CHUNK`
   * (`msgType 0x03`), which is why this takes pre-encoded bytes rather
   * than an envelope: there is nothing here to serialise, and framing an
   * upload chunk needs the header fields (`seq` as the chunk index) that
   * only the upload's own sender knows. Same state gate as {@link send},
   * for the same reason.
   */
  sendBinary(bytes: Uint8Array): void {
    if (this.destroyed) throw new Error('cannot send: Transport is destroyed');
    const s = this.fsm.state;
    if (!this.ws || (s !== 'live' && s !== 'degraded' && s !== 'resuming')) {
      throw new Error(`cannot send a binary frame: not connected (state=${s})`);
    }
    this.ws.send(bytes);
  }

  /**
   * Updates what this client wants subscribed. Called by the
   * client-assembly layer as `subscribe()`/`unsubscribe()` change what is
   * wanted, so the next resume or fresh-connect rebuild (`ResumeRecord.desired`)
   * stays accurate.
   */
  setDesiredSubscriptions(desired: DesiredSubscription[]): void {
    this.desiredSubscriptions = desired;
    if (this.resumeRecord) this.resumeRecord = { ...this.resumeRecord, desired };
  }

  /** Records the highest contiguous seq processed for one stream, advisory input to the next resume attempt. */
  noteProcessedSeq(streamId: number, seq: number): void {
    if (!this.resumeRecord) return;
    this.resumeRecord = {
      ...this.resumeRecord,
      lastSeq: { ...this.resumeRecord.lastSeq, [String(streamId)]: seq },
    };
  }

  /** Records a lease the client believes it holds, so `resumed.leaseRestored` can be checked against it. */
  noteLeaseHeld(targetId: string, leaseId: string, expiresAt: number): void {
    if (!this.resumeRecord) return;
    this.resumeRecord = {
      ...this.resumeRecord,
      leases: { ...this.resumeRecord.leases, [targetId]: { leaseId, expiresAt } },
    };
  }

  /** Clears a previously recorded lease (released, revoked, expired, or preempted). */
  clearLeaseHeld(targetId: string): void {
    if (!this.resumeRecord) return;
    const leases = { ...this.resumeRecord.leases };
    delete leases[targetId];
    this.resumeRecord = { ...this.resumeRecord, leases };
  }

  // ---- connection attempt entry points ----

  /**
   * Resolves a credential (awaited, per the option's own contract) and
   * opens a socket, shared by every entry point that is expected to
   * flip through `connecting` in the ordinary way: the first `connect()`
   * call, a backoff timer firing from `reconnecting`, and a
   * `visibilitychange` resume (which has already made the `reconnecting`
   * to `connecting` transition itself before calling this). `fromState`
   * is re-checked after the `await`, since `disconnect()`/`destroy()`
   * may have run in the meantime; a credential failure moves straight to
   * `fatal` from whichever state this was called at (`connecting` in
   * every case except a raw `reconnecting` to `fatal` credential failure,
   * which the transition table lists explicitly).
   */
  private async beginSocketAttempt(fromState: 'connecting' | 'reconnecting'): Promise<void> {
    if (this.destroyed || this.fsm.state !== fromState) return;
    let credential: { ticket?: string; token?: string };
    try {
      credential = await this.resolveCredential();
    } catch (err) {
      this.goFatal(0, 'no_credential', null, errorMessage(err));
      return;
    }
    if (this.destroyed || this.fsm.state !== fromState) return;
    if (fromState === 'reconnecting') this.fsm.transition('connecting', 'backoff_fired');
    this.openSocket(credential);
  }

  /**
   * The 4200 `ticket_consumed` exception: retries
   * exactly once, silently, without any state-machine transition at all.
   */
  private async retryAfterTicketConsumed(): Promise<void> {
    let credential: { ticket?: string; token?: string };
    try {
      credential = await this.resolveCredential();
    } catch (err) {
      this.goFatal(CloseCode.InvalidAuth, 'no_credential', null, errorMessage(err));
      return;
    }
    if (this.destroyed || this.fsm.state === 'idle' || this.fsm.state === 'fatal') return;
    this.openSocket(credential);
  }

  private async resolveCredential(): Promise<{ ticket?: string; token?: string }> {
    if (this.ticket && !this.ticketConsumed) return { ticket: this.ticket };
    if (this.token) return { token: this.token };
    if (!this.userOptions.credentials) {
      throw new Error(
        'no credentials available: provide options.ticket, options.token, or options.credentials()',
      );
    }
    const result = await this.userOptions.credentials();
    if (!result || (!result.ticket && !result.token)) {
      throw new Error('credentials() returned no usable credential');
    }
    this.ticket = result.ticket ?? null;
    this.token = result.token ?? null;
    this.ticketConsumed = false;
    return result;
  }

  private openSocket(credential: { ticket?: string; token?: string }): void {
    if (this.destroyed) return;
    const WebSocketImpl = this.socketOpts.WebSocketImpl;
    if (!WebSocketImpl) {
      this.goFatal(
        0,
        'no_websocket_impl',
        null,
        'no WebSocket implementation available; pass transport.WebSocketImpl',
      );
      return;
    }

    const url = this.buildUrl(credential.ticket);
    let ws: WebSocketLike;
    try {
      ws = new WebSocketImpl(url, this.socketOpts.protocols);
    } catch (err) {
      this.handleTransientFailure('normal', errorMessage(err));
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    // `sq` is scoped per socket (gapless from 1, restarting with `welcome` on
    // every new connection), not per `Transport` instance's lifetime. Resetting here, rather than
    // only after a successful `welcome`, means an `error` arriving before `welcome` on this new
    // socket (the ticket-consumed retry's own close, for one) is gap-checked against the right
    // baseline too.
    this.lastSq = 0;
    this.armHandshakeTimer(credential);

    ws.onopen = () => {
      if (this.destroyed || this.ws !== ws) return;
      if (credential.ticket) this.ticketConsumed = true;
      if (this.fsm.state === 'connecting') this.fsm.transition('handshaking', 'ws_open');
      this.sendHello(credential);
    };
    ws.onmessage = (ev) => {
      if (this.ws === ws) this.handleMessage(ev.data);
    };
    ws.onerror = () => {
      // Every implementation this package targets (the browser's own
      // WebSocket, `ws`, and this package's test fake) always follows an
      // error with a close event; there is nothing independently
      // actionable here.
    };
    ws.onclose = (ev) => {
      if (this.ws === ws) this.handleClose(ev);
    };
  }

  private buildUrl(ticket: string | undefined): string {
    const params: string[] = ['v=1'];
    if (ticket) params.push(`ticket=${encodeURIComponent(ticket)}`);
    if (this.resumeRecord) {
      params.push(`sid=${encodeURIComponent(this.resumeRecord.sessionId)}`);
      params.push(`r=${encodeURIComponent(this.resumeRecord.token)}`);
    }
    const sep = this.url.includes('?') ? '&' : '?';
    return `${this.url}${sep}${params.join('&')}`;
  }

  private sendHello(credential: { ticket?: string; token?: string }): void {
    if (!this.ws) return;
    const id = randomCorrelationId();
    this.helloId = id;

    const withinWindow = this.resumeRecord
      ? isResumeWithinWindow(this.resumeRecord, now(), this.resumeWindowMs)
      : false;
    this.resumeRequestedThisAttempt = withinWindow;

    const hello: Hello = {
      v: 1,
      t: 'hello',
      id,
      ts: Date.now(),
      versions: this.userOptions.hello.versions ?? [1],
      minVersion: this.userOptions.hello.minVersion ?? 1,
      client: this.userOptions.hello.client,
      capabilities: this.userOptions.hello.capabilities,
      viewport: this.userOptions.hello.viewport,
    };
    if (this.desiredSubscriptions.length > 0)
      hello.subscribe = this.desiredSubscriptions.map(toHelloSubscribeEntry);
    if (withinWindow && this.resumeRecord) hello.resume = toHelloResume(this.resumeRecord);
    if (credential.token) hello.auth = { scheme: 'bearer', token: credential.token };

    this.ws.send(JSON.stringify(hello));
  }

  // ---- inbound message handling ----

  private handleMessage(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data !== 'string') {
      const buf = toArrayBuffer(data);
      this.stats_.lastFrameAt = now();
      this.keepalive.onFrameReceived();
      this.emitter.emit('binary', buf);
      if (this.fsm.state === 'resuming') this.promoteResumingToLive('first_frame');
      return;
    }

    let msg: Envelope;
    try {
      msg = JSON.parse(data) as Envelope;
    } catch {
      this.logger.warn('discarding unparseable control message');
      return;
    }
    this.processEnvelope(msg);
  }

  private processEnvelope(msg: Envelope): void {
    if (typeof msg.sq === 'number') {
      const expected = this.lastSq + 1;
      if (msg.sq !== expected) {
        this.closeForProtocolFault('sq_gap');
        return;
      }
      this.lastSq = msg.sq;
    }

    switch (msg.t) {
      case 'welcome':
        this.handleWelcome(msg as Welcome);
        break;
      case 'resumed':
        this.handleResumed(msg as Resumed);
        break;
      case 'pong':
        this.handlePong(msg as Pong);
        break;
      case 'error':
        this.lastError = msg as ErrorMsg;
        break;
      case 'goodbye':
        this.lastGoodbye = msg as Goodbye;
        break;
      default:
        break;
    }

    const s = this.fsm.state;
    if (s === 'live' || s === 'degraded' || s === 'resuming')
      this.keepalive.onControlMessageReceived();
    this.emitter.emit('message', msg);
  }

  private handleWelcome(welcome: Welcome): void {
    if (welcome.re !== this.helloId) {
      this.logger.warn('welcome.re does not match the sent hello.id; processing anyway', {
        expected: this.helloId,
        got: welcome.re,
      });
    }
    this.stopHandshakeTimer();

    const desired = this.resumeRecord?.desired ?? this.desiredSubscriptions;
    this.resumeRecord = resumeRecordFromWelcome({
      token: welcome.resume.token,
      windowMs: welcome.resume.windowMs,
      issuedAt: welcome.resume.issuedAt,
      sessionId: welcome.sessionId,
      viewerId: welcome.viewerId,
      desired,
      lastSeq: welcome.resumed ? this.resumeRecord?.lastSeq : undefined,
      lastControlSq: this.lastSq,
      leases: welcome.resumed ? this.resumeRecord?.leases : undefined,
    });

    if (this.resumeRequestedThisAttempt && !welcome.resumed) this.stats_.resumesRejected += 1;
    if (welcome.resumed) this.stats_.resumesAccepted += 1;

    this.reconnectCtl.reset();
    this.stats_.connectedAt = now();
    this.stats_.reconnectAttempt = 0;

    if (welcome.resumed) {
      this.fsm.transition('resuming', 'welcome_resumed');
      this.keepalive.start();
      this.armResumingTimer();
    } else {
      this.fsm.transition('live', 'welcome');
      this.keepalive.start();
    }

    this.emitter.emit('connected', {
      viewerId: welcome.viewerId,
      sessionId: welcome.sessionId,
      resumed: welcome.resumed,
      welcome,
    });
    this.resolveConnectPromise();
  }

  private handleResumed(msg: Resumed): void {
    this.emitter.emit('resumed', {
      streams: msg.streams.map((s) => ({
        streamId: s.streamId,
        targetId: s.targetId,
        missedFrames: s.missedFrames,
      })),
      leaseRestored: msg.leaseRestored,
      missedControl: msg.missedControl,
    });
  }

  private handlePong(msg: Pong): void {
    this.stats_.lastPongAt = now();
    this.keepalive.onPongReceived(msg.cts);
  }

  private promoteResumingToLive(reason: string): void {
    if (this.fsm.state !== 'resuming') return;
    this.stopResumingTimer();
    this.fsm.transition('live', reason);
  }

  private closeForProtocolFault(reason: string): void {
    this.logger.warn('closing for protocol fault', { reason });
    const ws = this.ws;
    if (ws) {
      try {
        ws.close(CloseCode.ProtocolError, reason);
      } catch {
        // already closing; the resulting close event (if any) is handled normally
      }
    }
  }

  // ---- keepalive callbacks ----

  private sendPingEnvelope(cts: number): void {
    if (!this.ws) return;
    const msg: Ping = { v: 1, t: 'ping', ts: Date.now(), cts };
    try {
      this.ws.send(JSON.stringify(msg));
    } catch {
      // a send failing here means the socket is on its way out; the close event handles the rest
    }
  }

  private handleDegrade(reason: DegradeReason): void {
    if (this.fsm.state !== 'live') return;
    this.fsm.transition('degraded', reason);
    this.emitter.emit('degraded', { reason, sinceMs: now() });
  }

  private handleRecover(signal: 'pong' | 'frame' | 'control'): void {
    if (this.fsm.state !== 'degraded') return;
    this.fsm.transition('live', `recovered_${signal}`);
  }

  // ---- close handling and reconnection ----

  private handleTransientFailure(backoffName: 'normal', detail: string): void {
    const closeInfo: CloseInfo = { code: 1006, reason: detail, wasClean: false, error: null };
    this.scheduleReconnect(backoffScheduleFor(backoffName, this.reconnectCtl.options), closeInfo);
  }

  private handleClose(ev: WebSocketCloseEventLike): void {
    this.ws = null;
    this.keepalive.stop();
    this.stopHandshakeTimer();
    this.stopResumingTimer();

    if (this.destroyed || this.fsm.state === 'idle') return;

    const closeInfo: CloseInfo = {
      code: ev.code,
      reason: ev.reason,
      wasClean: ev.wasClean,
      error: this.lastError,
    };
    this.stats_.lastCloseCode = ev.code;
    this.stats_.lastCloseReason = ev.reason;

    if (
      ev.code === CloseCode.InvalidAuth &&
      this.lastError?.code === 'bgls.error.auth.ticket_consumed' &&
      !this.ticketConsumedRetried
    ) {
      this.ticketConsumedRetried = true;
      this.lastError = null;
      this.ticket = null;
      void this.retryAfterTicketConsumed();
      return;
    }

    if (ev.code >= 4900 && ev.code <= 4999) {
      const decision = this.userOptions.onAppClose?.(closeInfo);
      this.lastError = null;
      this.lastGoodbye = null;
      if (decision?.reconnect) {
        this.scheduleReconnect(
          decision.schedule ?? backoffScheduleFor('normal', this.reconnectCtl.options),
          closeInfo,
        );
      } else {
        this.goFatalFromClose(closeInfo);
      }
      return;
    }

    const policy = reconnectPolicy(ev.code);
    const goodbyeRetryAfterMs = this.lastGoodbye?.retryAfterMs;
    const goodbyeRedirect = this.lastGoodbye?.redirect;
    this.lastError = null;
    this.lastGoodbye = null;

    if (!policy.reconnect || !this.autoReconnect) {
      this.goFatalFromClose(closeInfo);
      return;
    }

    if (policy.sameToken === false) {
      this.ticket = null;
      this.token = null;
    }
    if (policy.dropResume) {
      this.resumeRecord = null;
      this.stats_.resumesRejected += 1;
    }
    if (policy.useRedirect && goodbyeRedirect) {
      this.url = goodbyeRedirect.url;
      if (goodbyeRedirect.ticket) {
        this.ticket = goodbyeRedirect.ticket;
        this.ticketConsumed = false;
      }
    }

    const schedule = backoffScheduleFor(policy.backoff ?? 'normal', this.reconnectCtl.options);
    this.scheduleReconnect(schedule, closeInfo, goodbyeRetryAfterMs);
  }

  private scheduleReconnect(
    schedule: BackoffSchedule,
    closeInfo: CloseInfo,
    retryAfterMs?: number,
  ): void {
    const nowMs = now();
    if (this.reconnectCtl.hasExceededMaxReconnect(nowMs)) {
      this.goFatalFromClose(closeInfo);
      return;
    }

    const usingResumeNow =
      this.resumeRecord !== null &&
      this.reconnectCtl.isWithinResumeWindow(nowMs, this.resumeWindowMs);
    const { delayMs, attempt } = this.reconnectCtl.next(schedule.name, nowMs, retryAfterMs);
    this.stats_.reconnectAttempt = attempt;
    this.stats_.reconnectCount += 1;
    this.stats_.disconnectedAt = nowMs;

    if (this.fsm.state !== 'reconnecting')
      this.fsm.transition('reconnecting', `close_${closeInfo.code}`);

    this.emitter.emit('disconnected', {
      ...closeInfo,
      willReconnect: true,
      attempt,
      nextDelayMs: delayMs,
    });
    this.emitter.emit('reconnecting', { attempt, delayMs, usingResume: usingResumeNow });

    const opts = this.reconnectCtl.options;
    const hidden = opts.pauseWhenHidden && hasVisibilityApi() && visibilityState() === 'hidden';
    if (hidden && attempt > opts.pauseWhenHiddenAfter) {
      this.armVisibilityResume();
      return;
    }
    this.armReconnectTimer(delayMs);
  }

  private goFatalFromClose(closeInfo: CloseInfo): void {
    const reason = closeCodeReasonName(closeInfo.code);
    const message =
      closeInfo.error?.message ??
      (closeInfo.reason || `connection closed permanently (code ${closeInfo.code})`);
    this.goFatal(closeInfo.code, reason, closeInfo.error, message);
  }

  private goFatal(code: number, reason: string, error: ErrorMsg | null, message: string): void {
    this.keepalive.stop();
    this.stopReconnectTimer();
    this.stopVisibilityWatch();
    this.stopHandshakeTimer();
    this.stopResumingTimer();
    const info: FatalInfo = { code, reason, message, error };
    if (this.fsm.state !== 'fatal') this.fsm.transition('fatal', reason);
    this.emitter.emit('fatal', info);
    // A real wire `error` (for instance `bgls.error.instance.wrong_node`,
    // carrying `context.nodeId` when this gateway isn't the node driving
    // the instance) is worth more to a caller of `connect()` than a bare
    // `Error(message)`: rejecting with the typed `BrowserGlassError`
    // exposes `.code`/`.category`/`.context` directly off the rejection,
    // not only from the separate `'fatal'` event above, so a caller can
    // branch on `err.code` right where it awaited `connect()`.
    this.rejectConnectPromise(
      error ? BrowserGlassError.fromErrorMsg(error) : new Error(message || reason),
    );
  }

  // ---- timers ----

  /**
   * `credential` is the one THIS attempt's `hello` was (or would have
   * been) sent with, so the timeout callback below can tell whether it is
   * still safe to hand the same credential to the reconnect this timeout
   * triggers.
   *
   * A bearer token short lived enough to be jti replay checked
   * (`packages/server/src/auth/verify.ts`'s `jtiCache.admit`, one shot per
   * token) is only safe to resend when `hello` was never transmitted. Once
   * `ws.onopen` has fired (the state machine has reached `handshaking`),
   * the server may already have verified this token and admitted its jti
   * before this timer's `welcome` wait gave up on a merely SLOW response,
   * which is exactly what a saturated gateway handling several concurrent
   * connects at once produces: measured directly against the running demo
   * under a several-way concurrent `AutomationClient.connect()`, this
   * timeout fired, the reconnect resent the identical token, and the
   * server closed it with `bgls.error.auth.token_invalid` ("jti ... was
   * already presented and is still within its window") because the FIRST
   * attempt's hello had, in fact, already been admitted. Retrying with the
   * same token is not merely risky there, it is guaranteed to fail, and it
   * fails with a confusing replay error two hops away from the timeout
   * that actually caused it.
   *
   * Discarding `this.token` in that one case forces the next
   * `resolveCredential()` to call `options.credentials()` for a fresh
   * token (or fail immediately with an honest "no credentials available"
   * instead of the replay error) rather than resending a credential this
   * attempt may have already burned. A ticket needs no equivalent
   * handling here: `ws.onopen` already flips `ticketConsumed` the moment
   * it sends one, and `resolveCredential()` already refuses to reuse a
   * consumed ticket.
   */
  private armHandshakeTimer(credential: { ticket?: string; token?: string }): void {
    this.stopHandshakeTimer();
    this.handshakeTimer = scheduleTimer(() => {
      const ws = this.ws;
      this.ws = null;
      if (this.fsm.state === 'handshaking' && credential.token && this.token === credential.token) {
        this.token = null;
      }
      if (ws) {
        ws.onclose = null;
        try {
          ws.close();
        } catch {
          // already gone
        }
      }
      this.handleTransientFailure('normal', 'handshake_timeout');
    }, this.socketOpts.handshakeTimeoutMs);
  }

  private stopHandshakeTimer(): void {
    this.handshakeTimer?.cancel();
    this.handshakeTimer = null;
  }

  private armResumingTimer(): void {
    this.stopResumingTimer();
    this.resumingTimer = scheduleTimer(() => this.promoteResumingToLive('resume_timeout'), 2000);
  }

  private stopResumingTimer(): void {
    this.resumingTimer?.cancel();
    this.resumingTimer = null;
  }

  private armReconnectTimer(delayMs: number): void {
    this.stopReconnectTimer();
    this.reconnectTimer = scheduleTimer(() => {
      void this.beginSocketAttempt('reconnecting');
    }, delayMs);
  }

  private stopReconnectTimer(): void {
    this.reconnectTimer?.cancel();
    this.reconnectTimer = null;
  }

  private armVisibilityResume(): void {
    this.stopVisibilityWatch();
    this.visibilityUnsub = onVisibilityChange(() => {
      if (visibilityState() !== 'visible') return;
      this.stopVisibilityWatch();
      this.reconnectCtl.resetAttemptCounter();
      if (this.fsm.state !== 'reconnecting') return;
      this.fsm.transition('connecting', 'visibilitychange');
      void this.beginSocketAttempt('connecting');
    });
  }

  private stopVisibilityWatch(): void {
    this.visibilityUnsub?.();
    this.visibilityUnsub = null;
  }

  // ---- connect() promise bookkeeping ----

  private resolveConnectPromise(): void {
    const pending = this.connectPromise;
    if (!pending) return;
    this.connectPromise = null;
    pending.resolve();
  }

  private rejectConnectPromise(err: Error): void {
    const pending = this.connectPromise;
    if (!pending) return;
    this.connectPromise = null;
    pending.reject(err);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
