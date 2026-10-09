import type {
  Envelope,
  ErrorMsg,
  Hello,
  HelloCapabilities,
  HelloViewport,
  QualityProfile,
  ReconnectBackoff,
  Welcome,
} from '@browserglass/protocol';

/**
 * The eight connection states. Only `live`,
 * `degraded`/`reconnecting` (surfaced as a banner), and `fatal` are
 * normally meant to reach a user's eyes; `connecting`/`handshaking`
 * render nothing on their own.
 */
export type ConnectionState =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'live'
  | 'degraded'
  | 'reconnecting'
  | 'resuming'
  | 'fatal';

/**
 * A minimal structured logger. Every method is a no-op sink by default;
 * pass `logger` in {@link TransportOptions} to observe transport
 * internals. Declared here (rather than in a later client-assembly task)
 * because the transport layer is the first thing that needs it.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** A `Logger` whose every method is a no-op. The default when no `logger` option is given. */
export const NOOP_LOGGER: Readonly<Logger> = Object.freeze({
  debug(): void {},
  info(): void {},
  warn(): void {},
  error(): void {},
});

/** The data shapes a {@link WebSocketLike} may send or receive. */
export type WebSocketDataLike = string | ArrayBuffer | ArrayBufferView;

/** The subset of a WebSocket `CloseEvent` this package reads. */
export interface WebSocketCloseEventLike {
  code: number;
  reason: string;
  wasClean: boolean;
}

/** The subset of a WebSocket `MessageEvent` this package reads. */
export interface WebSocketMessageEventLike {
  data: string | ArrayBuffer | ArrayBufferView;
}

/**
 * The structural shape of a WebSocket this package depends on, declared
 * locally rather than typed against the DOM's global `WebSocket`: this
 * package's `tsconfig` carries no DOM lib (see `env.ts`), and the client makes
 * no DOM assumption beyond `WebSocket` and must run under Node's `ws` package too, which this
 * shape is equally satisfied by. Handlers are assigned as properties
 * (`onopen`, not `addEventListener`), which every implementation this
 * package is asked to accept (the browser's `WebSocket`, `ws`, and this
 * package's own test fake) supports.
 */
export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: ((ev: WebSocketCloseEventLike) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: WebSocketMessageEventLike) => void) | null;
  send(data: WebSocketDataLike): void;
  close(code?: number, reason?: string): void;
}

/** A constructor producing a {@link WebSocketLike}, injected via `transport.WebSocketImpl`. */
export type WebSocketConstructorLike = new (
  url: string,
  protocols?: string | string[],
) => WebSocketLike;

/**
 * A WebSocket close as observed by the transport: the numeric code, the
 * reason string, whether the closure was clean, and the `error` message
 * the server sent immediately before closing, when one arrived.
 */
export interface CloseInfo {
  code: number;
  reason: string;
  wasClean: boolean;
  error: ErrorMsg | null;
}

/**
 * Terminal connection failure detail, emitted once on the `fatal` event
 * and never followed by a further reconnect attempt.
 */
export interface FatalInfo {
  code: number;
  reason: string;
  message: string;
  error: ErrorMsg | null;
}

/**
 * The resolved parameters of one of the four named reconnect schedules
 * `baseDelayMs` and `factor` drive the exponential
 * ladder, `capMs` is its ceiling, and `jitter` is the fraction added on
 * top of the nominal delay, never shortening it.
 */
export interface BackoffSchedule {
  readonly name: ReconnectBackoff;
  readonly baseDelayMs: number;
  readonly factor: number;
  readonly capMs: number;
  readonly jitter: number;
}

/** Tunable reconnect timing, `Partial<ReconnectOptions>` on `TransportOptions.reconnect`. */
export interface ReconnectOptions {
  /** Instant retries before any UI change. Default 2. */
  silentAttempts: number;
  /** Default 200. */
  silentDelayMs: number;
  /** First backoff step after the silent retries. Default 250. */
  baseDelayMs: number;
  /** Default 2. */
  factor: number;
  /** Cap for the `normal` schedule. Default 8000. */
  maxDelayMs: number;
  /** Cap for the `slow` schedule. Default 30000. */
  slowMaxDelayMs: number;
  /** Fraction added on top of the nominal delay. Default 0.25. */
  jitter: number;
  /** Give up and move to `fatal` past this cumulative outage duration. Default 600000. */
  maxReconnectMs: number;
  /** Default true. */
  pauseWhenHidden: boolean;
  /** Attempt count after which a hidden tab stops scheduling retries. Default 4. */
  pauseWhenHiddenAfter: number;
}

/** The default {@link ReconnectOptions}. */
export const DEFAULT_RECONNECT_OPTIONS: Readonly<ReconnectOptions> = Object.freeze({
  silentAttempts: 2,
  silentDelayMs: 200,
  baseDelayMs: 250,
  factor: 2,
  maxDelayMs: 8000,
  slowMaxDelayMs: 30000,
  jitter: 0.25,
  maxReconnectMs: 600000,
  pauseWhenHidden: true,
  pauseWhenHiddenAfter: 4,
});

/**
 * One target this client wants a stream for, the transport-level
 * projection of `SubscribeOptions` (the fuller, canvas/render-carrying
 * shape belongs to the client-assembly task): only the fields that are
 * meaningful to record for a resume rebuild.
 */
export interface DesiredSubscription {
  targetId: string;
  quality?: QualityProfile;
  codec?: string;
  maxFps?: number;
  maxWidth?: number;
  maxHeight?: number;
  thumbnail?: boolean;
  paused?: boolean;
}

/**
 * The client's in-memory resume state. Never
 * persisted to `localStorage`: the resume token is a credential, and
 * disk persistence would let it outlive the tab that was issued it.
 */
export interface ResumeRecord {
  /** Rotates on every accepted resume; the previous value is burned the moment a resume is accepted. */
  token: string;
  sessionId: string;
  viewerId: string;
  issuedAt: number;
  windowMs: number;
  /** Highest contiguous seq processed per streamId (string key), advisory to the server. */
  lastSeq: Record<string, number>;
  lastControlSq: number;
  /** What the client asked for; rebuilds a rejected resume from scratch. */
  desired: DesiredSubscription[];
  /** Leases the client believes it holds, by targetId. */
  leases: Record<string, { leaseId: string; expiresAt: number }>;
}

/** The fixed pieces of `hello` this package cannot infer on its own. */
export interface TransportHelloOptions {
  client: Hello['client'];
  capabilities: HelloCapabilities;
  viewport: HelloViewport;
  /** Protocol majors this client can speak, preference order. Default `[1]`. */
  versions?: number[];
  /** Lowest acceptable major. Default `1`. */
  minVersion?: number;
}

/** Transport-layer socket tuning, `TransportOptions.transport`. */
export interface TransportSocketOptions {
  /** Default `['bgls.v1']`. */
  protocols?: string[];
  /** Application `ping` interval. Default 5000. */
  pingIntervalMs?: number;
  /** No pong and no frame for this long moves `live` to `degraded`. Default 5000. */
  healthTimeoutMs?: number;
  /** No `welcome` in this long fails the connect attempt. Default 10000. */
  handshakeTimeoutMs?: number;
  /** Default 15000. Reserved for request/response methods layered on top of this transport. */
  requestTimeoutMs?: number;
  /** Node passes `ws`; tests pass a scripted fake. Defaults to the host's global `WebSocket`. */
  WebSocketImpl?: WebSocketConstructorLike;
  /** Default false: `ws://` is only tolerated on `localhost` otherwise. */
  allowInsecureTransport?: boolean;
}

/**
 * Everything `Transport` needs to run the connection lifecycle. A subset
 * of `BrowserGlassClientOptions`: fields the fuller
 * client owns (subscribe render options, presence, ack tuning, and so on)
 * are not this layer's concern.
 */
export interface TransportOptions {
  url: string;
  ticket?: string;
  token?: string;
  /**
   * Called whenever the transport needs a credential it does not have.
   * Called lazily, only when needed, and awaited inside the reconnect
   * loop: this is what makes "reconnect after token expiry" the same
   * code path as a normal reconnect plus one await. Throwing or
   * resolving to an object with neither field moves the client to
   * `fatal` with `bgls.error.auth.no_credential`.
   */
  credentials?: () => Promise<{ ticket?: string; token?: string }>;
  /** Default true. */
  autoReconnect?: boolean;
  reconnect?: Partial<ReconnectOptions>;
  /** Client-side resume ceiling. Actual = min(server `welcome.resume.windowMs`, this). Default 120000. */
  resumeWindowMs?: number;
  /** Folded into `hello.subscribe` to save a round trip, and seeds `ResumeRecord.desired`. */
  subscribe?: DesiredSubscription[];
  hello: TransportHelloOptions;
  transport?: TransportSocketOptions;
  /**
   * Close codes 4900 to 4999 are host-application defined. Called with the
   * close detail; returning `{reconnect:true}` (optionally with a
   * `schedule`) reconnects, anything else (including no handler at all)
   * is treated as permanent. Named `onAppClose` because `4900`-`4999` is
   * literally "host application" territory.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: public callback type; `| undefined` would reject handlers declared as returning void.
  onAppClose?: (info: CloseInfo) => { reconnect: boolean; schedule?: BackoffSchedule } | void;
  logger?: Logger;
}

/** Transport-scoped diagnostics; the connection-lifecycle subset of the fuller client's `ClientStats`. */
export interface ClientStats {
  state: ConnectionState;
  connectedAt: number | null;
  disconnectedAt: number | null;
  /** The reconnect attempt currently in flight or about to run, reset to 0 once `live` is reached. */
  reconnectAttempt: number;
  /** Total reconnect attempts made over the life of this client instance. */
  reconnectCount: number;
  /** Whether the outage is still within the resume window. */
  usingResume: boolean;
  lastCloseCode: number | null;
  lastCloseReason: string | null;
  /** Most recent application ping RTT, milliseconds. */
  rttMs: number | null;
  lastPongAt: number | null;
  lastFrameAt: number | null;
  resumesAccepted: number;
  resumesRejected: number;
}

/** The payload of the `disconnected` transport event. */
export type DisconnectedEvent = CloseInfo & {
  willReconnect: boolean;
  attempt: number;
  nextDelayMs: number | null;
};

/** The payload of the `connected` transport event: `welcome` has been fully processed. */
export interface ConnectedEvent {
  viewerId: string;
  sessionId: string;
  resumed: boolean;
  welcome: Welcome;
}

/** The payload of the `resumed` transport event, the informational parts of the server's `resumed` message. */
export interface ResumedEvent {
  streams: Array<{ streamId: number; targetId: string; missedFrames: number }>;
  leaseRestored: boolean;
  missedControl: number;
}

/** The payload of the `degraded` transport event. */
export interface DegradedEvent {
  reason: 'no-frames' | 'no-pong';
  sinceMs: number;
}

/** The payload of the `reconnecting` transport event, emitted before a new socket is created. */
export interface ReconnectingEvent {
  attempt: number;
  delayMs: number;
  usingResume: boolean;
}

/**
 * The events {@link Transport} (see `./transport.js`) emits. Framework-agnostic
 * client assembly builds on top of these. Carries an index signature
 * purely so it satisfies {@link Emitter}'s `Record<string, unknown>`
 * generic constraint; every declared key below still has its own precise
 * payload type.
 */
export interface TransportEvents {
  [key: string]: unknown;
  state: { from: ConnectionState; to: ConnectionState; reason: string };
  connected: ConnectedEvent;
  disconnected: DisconnectedEvent;
  degraded: DegradedEvent;
  reconnecting: ReconnectingEvent;
  resumed: ResumedEvent;
  fatal: FatalInfo;
  /** Every parsed control-channel message, server error frames included, for a higher layer to route by `t`. */
  message: Envelope;
  /** Every raw binary frame, undecoded: decoding is the renderer's job. */
  binary: ArrayBuffer;
  /** One application `pong` was matched to its `ping`. */
  pong: { rttMs: number };
}
