import type {
  Capability,
  Codec,
  ErrorMsg,
  InstanceState,
  LeaseState,
  ProbeDetail,
  ProbeRect,
  QualityProfile,
  RecoveryRung,
  TargetKind,
  TargetSummary,
  WelcomeInstance,
  WelcomeLimits,
} from '@browserglass/protocol';
import type { CanvasRendererOptions, ClientPoint, RendererStats } from '../render/index.js';
import type {
  BackoffSchedule,
  CloseInfo,
  ConnectionState,
  FatalInfo,
  Logger,
  ReconnectOptions,
  ClientStats as TransportClientStats,
  WebSocketConstructorLike,
} from '../transport/types.js';

export type { StreamHandle } from './StreamHandleImpl.js';
export type { Logger } from '../transport/types.js';

/**
 * One target this client wants a stream for, folded into `hello.subscribe`
 * to save a round trip. Superset of the plain subscribe shape:
 * `canvas`/`container`/`render` immediately attach a renderer once the
 * subscription's `stream.subscribed` lands (equivalent to calling
 * `handle.attach(canvas, container, render)` as soon as the handle exists).
 */
export interface SubscribeOptions {
  /** Default `'auto'`. */
  quality?: QualityProfile;
  /** Default: the negotiated `welcome.streaming.codec`. */
  codec?: Codec;
  maxFps?: number;
  /** Encode-side downscale hint, CSS px. */
  maxWidth?: number;
  maxHeight?: number;
  /** Subscribe as a low-cost thumbnail stream. */
  thumbnail?: boolean;
  /** Subscribe but start paused. */
  paused?: boolean;
  /** Attach immediately once subscribed. Requires {@link SubscribeOptions.container} too (see `StreamHandle.attach`). */
  canvas?: HTMLCanvasElement;
  /**
   * The layout box `canvas` is letterboxed or covered against, required
   * alongside `canvas`. `CanvasRenderer`'s constructor takes a container
   * distinct from the canvas and never infers `canvas.parentElement`;
   * `attach()` and this option carry that same requirement through.
   */
  container?: HTMLElement;
  render?: CanvasRendererOptions;
}

/** Options for {@link StreamHandle.setQuality} and the client's `setQuality()`. */
export interface QualityOptions {
  quality?: QualityProfile;
  codec?: Codec;
  maxFps?: number;
  maxWidth?: number;
  maxHeight?: number;
}

/** Options for `client.capture()`. */
export interface CaptureOptions {
  /** Default `'png'`. */
  format?: 'png' | 'jpeg';
  /** JPEG only, 1 to 100, default 85. */
  quality?: number;
  fullPage?: boolean;
  /** One element, CSS selector. */
  selector?: string;
  /** Frame space. */
  clip?: { x: number; y: number; width: number; height: number };
  /** Caps the long edge, device px. */
  maxDimension?: number;
  signal?: AbortSignal;
}

/** Resolves `client.capture()`. Always a `Blob`, regardless of inline versus signed-URL wire delivery. */
export interface CaptureResult {
  captureId: string;
  targetId: string;
  blob: Blob;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  dpr: number;
  sizeBytes: number;
  fullPage: boolean;
  downscaled: boolean;
  /** Debug-only info field: which wire path actually carried the bytes. */
  delivery: 'inline' | 'url';
}

/** Options for `client.probe()`. */
export interface ProbeOptions {
  /** Default `'hover'`. */
  detail?: ProbeDetail;
  signal?: AbortSignal;
}

/** Resolves `client.probe()`. `hit: false` means every field below it is undefined. */
export interface ProbeResult {
  targetId: string;
  detail: ProbeDetail;
  gen: number;
  hit: boolean;
  /** Remote page's viewport CSS px, not frame space. Use `toClient()` to draw it. */
  rect?: ProbeRect;
  /** `"tag#id.class.class"`. UNTRUSTED: render as text. */
  label?: string;
  tagName?: string;
  /** UNTRUSTED, scheme-filtered server-side; filter again before touching any DOM attribute. */
  href?: string | null;
  hrefFromAncestor?: boolean;
  name?: string;
  role?: string;
  attributes?: Record<string, string>;
  outerHTML?: string;
  outerHTMLTruncated?: boolean;
  ancestors?: Array<{ tagName: string; id?: string; classNames: string[] }>;
  ancestorsTruncated?: boolean;
}

/**
 * Which diagnostics feeds to turn on for `client.diagnostics.subscribe()`.
 * Mirrors the `DiagnosticsSubscribe` wire message.
 * Default when the whole options object (or a given field) is omitted:
 * console and errors on, network off, matching the wire message's own
 * default and the plan's "opt in per target, and a wall of panes must not
 * pay for `Network.enable` on all of them by default" decision.
 */
export interface DiagnosticsSubscribeOptions {
  console?: boolean;
  errors?: boolean;
  network?: boolean;
}

/** Resolves `client.diagnostics.subscribe()`, echoing what the server actually turned on. */
export interface DiagnosticsSubscription {
  targetId: string;
  console: boolean;
  errors: boolean;
  network: boolean;
}

/** Options for `client.restart()`. */
export interface RestartOptions {
  reason?: string;
  /** Default `true`; `false` wipes the profile and additionally needs `profile.write`. */
  preserveProfile?: boolean;
  /** Default 60000. The restart itself continues regardless of this timeout. */
  timeoutMs?: number;
}

/** Resolves `client.restart()`. */
export interface RestartResult {
  durationMs: number;
  /** `true` only for the caller whose call actually started the restart; concurrent callers join the same one. */
  initiated: boolean;
  targetsRestored: number;
  targetsLost: number;
  streamsResubscribed: number[];
}

/** Options for `client.requestControl()`. */
export interface ControlRequestOptions {
  ttlMs?: number;
  /** Shown to the current holder. */
  reason?: string;
  /** Default `true`: queue if busy instead of failing. */
  queue?: boolean;
  /** Requires `admin`. */
  force?: boolean;
  /** Default 0, wait forever. */
  timeoutMs?: number;
}

export type ControlDeniedReason =
  | 'cap_missing'
  | 'queue_full'
  | 'policy'
  | 'holder_pinned'
  | 'target_gone'
  | 'session_readonly';

/** Resolves `client.requestControl()`. Denial and queuing both resolve; only a missing capability or a gone target throws. */
export type ControlOutcome =
  | { granted: true; leaseId: string; expiresAt: number; mode: 'exclusive' | 'shared' }
  | { granted: false; queued: true; position: number; holderLabel: string }
  | { granted: false; queued: false; reason: ControlDeniedReason; message: string };

/**
 * Resolves `client.yieldControl()`.
 *
 * Both numbers are THIS CLIENT'S OWN COUNT at the moment it sent, from its
 * last `control.state` joined to its last `presence.state`. Neither is an
 * acknowledgement, and neither is proof the message was delivered: the
 * server's success path for `control.yield` replies with nothing, so a
 * yield that reaches a target with no agent driving looks exactly like a
 * yield that went nowhere. That gap needs a `control.yielded` ack from the
 * server to close properly, and is filed rather than papered over here.
 *
 * What they honestly answer is the narrower question a UI actually asks:
 * "was there anything of mine to stand down, as far as I could see?"
 */
export interface ControlYieldResult {
  /**
   * Holders of this target that the presence roster describes as agents.
   * `0` does not mean the yield failed. It means this client knew of no
   * agent driving, which is usually because none was, and the message is
   * sent anyway rather than suppressed on a local guess.
   */
  agentsAsked: number;
  /**
   * Holders this client could not classify, because they were not in the
   * roster. Deliberately not folded into `agentsAsked`, and deliberately
   * not counted as people: the roster lags a fresh grant by one broadcast,
   * and the synthetic viewer the REST control path borrows a lease under
   * never appears in it at all. A non-zero value means `agentsAsked` is a
   * floor rather than a count.
   */
  unknownHolders: number;
}

/** The negotiated shape of one subscription, mirrored on every `StreamHandle`. */
export interface StreamInfo {
  streamId: number;
  targetId: string;
  quality: QualityProfile;
  codec: Codec;
  fps: number;
  /** Frame bitmap dims, device px. */
  width: number;
  height: number;
  dpr: number;
  paused: boolean;
  /** Stream reconfigure counter; stream messages only. */
  sidEpoch: number;
  /** Target generation; low 16 bits appear in every frame header as `gen16`. */
  gen: number;
}

/** Per-stream running counters, composing the server's `stream.stats` with this client's own `CanvasRenderer` counters. */
export interface StreamStats {
  streamId: number;
  targetId: string;
  quality: QualityProfile;
  codec: Codec;
  paused: boolean;
  fpsSent: number;
  fpsDropped: number;
  bytesPerSec: number;
  backlog: number;
  bufferedBytes: number;
  encodeMsP50: number;
  encodeMsP95: number;
  rttMs: number;
  adaptedReason?: 'backlog' | 'rtt' | 'cpu' | 'bandwidth' | 'manual' | 'idle';
  /** `null` until at least one `stream.stats` message has arrived. */
  renderer: RendererStats | null;
}

/** Per-stream events, delivered through `StreamHandle.on()`. */
export interface StreamEvents {
  /** Carries no semantic meaning; present only so this interface satisfies `Emitter<T>`'s `Record<string, unknown>` constraint (`../transport/emitter.js`). */
  [key: string]: unknown;
  /** After paint, hot path: keep handlers cheap. */
  frame: {
    seq: number;
    width: number;
    height: number;
    decodeMs: number;
    codec: Codec;
    keyframe: boolean;
  };
  reconfigured: StreamInfo & { previousSidEpoch: number; previousGen: number };
  dropped: { seq: number; reason: 'queue-full' | 'stale-gen' | 'superseded' | 'out-of-order' };
  paused: { paused: boolean };
  closed: { reason: 'unsubscribed' | 'target-closed' | 'session-ended' };
  stats: StreamStats;
}

/** One other viewer on this session, as broadcast on `presence.state`. */
export interface ViewerPresence {
  viewerId: string;
  label: string;
  kind: 'human' | 'agent' | 'service';
  avatarUrl?: string;
  colour: string;
  /** `targetId`s this viewer holds a lease on. */
  controlling: string[];
  /** `targetId`s this viewer is subscribed to. */
  watching: string[];
  idle: boolean;
  joinedAt: number;
}

/**
 * Connection-lifecycle diagnostics (transport's own {@link TransportClientStats})
 * plus the fuller counters `stats()` reports:
 * how many streams are live, an aggregate reported fps, and the most
 * recently measured decode time across every stream.
 */
export interface ClientStats extends TransportClientStats {
  /** Number of currently subscribed streams. */
  streams: number;
  /** Sum of each live stream's last-reported `stream.stats.fpsSent`. */
  fps: number;
  /** The largest `RendererStats.lastDecodeMs` across every live stream, `0` if none yet. */
  decodeMs: number;
}

/**
 * What `<BrowserGlass overlay={(ctx) => ReactNode}>` (a later, `react`-owned
 * prop) is called with: the reconnect/recovery dimming ladder,
 * computed by this package so every framework layer renders the identical
 * ladder rather than each re-deriving it.
 */
export interface OverlayContext {
  state: ConnectionState;
  /** Brightness multiplier per the dimming ladder: `1` live, `0.6` degraded/recovering, `0.4` reconnecting, `0.25` fatal. Never `0`: the canvas is never blanked to black by a connection-state change alone. */
  dim: number;
  /** `true` only in the `fatal` state. */
  greyscale: boolean;
  /** Human-readable overlay text for the current state, or `null` when no overlay text applies (the "silence is normal" cases). */
  message: string | null;
  /** The in-progress reconnect attempt number, or `null` outside `reconnecting`. */
  attempt: number | null;
  /** The stream this overlay concerns, or `null` when called generically (not per-stream). */
  stream: StreamInfo | null;
  toClient(x: number, y: number): ClientPoint;
}

/** Options for `client.upload()`. */
export interface UploadOptions {
  targetId: string;
  purpose: 'filechooser' | 'drop' | 'profile';
  /** Required when `purpose === 'filechooser'`. */
  chooserId?: string;
  onProgress?: (receivedBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
}

/** Returned synchronously by `client.upload()`; the transfer itself runs in the background. */
export interface UploadHandle {
  uploadId: string;
  readonly path: string | null;
  readonly done: Promise<{ uploadId: string; path: string; sizeBytes: number }>;
  cancel(): void;
}

/** Transport-scoped socket tuning, `BrowserGlassClientOptions.transport`. */
export interface ClientTransportOptions {
  /** Default `['bgls.v1']`. */
  protocols?: string[];
  /** Application `ping` interval. Default 5000. */
  pingIntervalMs?: number;
  /** No pong and no frame for this long moves `live` to `degraded`. Default 5000. */
  healthTimeoutMs?: number;
  /** No `welcome` in this long fails the connect attempt. Default 10000. */
  handshakeTimeoutMs?: number;
  /** Default 15000. Applied to every request/response method (`subscribe`, `requestControl`, `navigate`, and so on). */
  requestTimeoutMs?: number;
  /** Node passes `ws`; tests pass a scripted fake. Defaults to the host's global `WebSocket`. */
  WebSocketImpl?: WebSocketConstructorLike;
  allowInsecureTransport?: boolean;
}

/** Constructor options for {@link BrowserGlassClient}. */
export interface BrowserGlassClientOptions {
  /** `wss://` in prod; `ws://` tolerated on `localhost` only unless `transport.allowInsecureTransport`. */
  url: string;
  /** Single-use admission ticket. Required unless `token`. */
  ticket?: string;
  /** Bearer JWT. Node/CLI/agent only; falls back to `hello.auth` in a browser with a warning. */
  token?: string;
  /**
   * Called whenever the client needs a credential it does not have: first
   * connect with no ticket, reconnect after a cached ticket is
   * consumed/expired, close 4201. Called lazily, awaited inside the
   * reconnect loop. Throwing or returning neither field moves the client to
   * `fatal` with `bgls.error.auth.no_credential`.
   */
  credentials?: () => Promise<{ ticket?: string; token?: string }>;
  /** Default `true`. */
  autoReconnect?: boolean;
  reconnect?: Partial<ReconnectOptions>;
  /** Client-side resume ceiling. Actual = `min(server welcome.resume.windowMs, this)`. Default 120000. */
  resumeWindowMs?: number;
  /** Folded into `hello` to save a round trip. */
  subscribe?: Array<{
    targetId: string;
    quality?: QualityProfile;
    codec?: Codec;
    maxFps?: number;
    thumbnail?: boolean;
    paused?: boolean;
  }>;
  /** Decode capabilities advertised in `hello.capabilities`. Default `['jpeg']`. */
  codecs?: Codec[];
  /** Default `true`, uses `VideoDecoder.isConfigSupported` when available. Reserved for the video codec range; this build decodes images only. */
  probeVideoCodecs?: boolean;
  /** Forces the base64 JSON frame fallback. Default `false`. */
  binaryFrames?: boolean;
  transport?: ClientTransportOptions;
  ack?: { everyNFrames?: number; maxAckIntervalMs?: number };
  /** Default `false`. Publish this viewer's cursor via `presence.cursor`. */
  presenceCursor?: boolean;
  /** Default: no-op in production, `console`-backed when `debug` is true. Credentials are redacted by the logger itself, never per call site. */
  logger?: Logger;
  /** Default `false`, or `localStorage['bgls:debug'] === '1'` when `localStorage` exists. */
  debug?: boolean;
  /** Shown to other viewers in presence; server default from the token when omitted. */
  label?: string;
  /** Destroys the client when aborted. */
  signal?: AbortSignal;
  /**
   * Close codes 4900 to 4999 are host-application defined. Returning
   * `{reconnect:true}` (optionally with a `schedule`) reconnects; anything
   * else, including no handler at all, is permanent.
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: public callback type; `| undefined` would reject handlers declared as returning void.
  onAppClose?: (info: CloseInfo) => { reconnect: boolean; schedule?: BackoffSchedule } | void;
  /**
   * Default `true`. Requests exclusive capture of reserved browser keys via
   * the Keyboard Lock API while a subscribed canvas holds focus and this
   * client holds that target's control lease. A silent no-op wherever
   * `navigator.keyboard.lock` is unavailable.
   */
  keyboardLock?: boolean;
}

/** The full client event surface. Every payload is a plain object: no methods, no class identity, survives `structuredClone`. */
export interface ClientEvents {
  [key: string]: unknown;
  state: { from: ConnectionState; to: ConnectionState; reason: string };

  connected: {
    viewerId: string;
    sessionId: string;
    resumed: boolean;
    instance: WelcomeInstance;
    targets: TargetSummary[];
    granted: Capability[];
    limits: WelcomeLimits;
    downgraded: boolean;
  };

  disconnected: CloseInfo & { willReconnect: boolean; attempt: number; nextDelayMs: number | null };

  /** `live` to `degraded`. */
  degraded: { reason: 'no-frames' | 'no-pong'; sinceMs: number };

  /** Before a new socket is created. */
  reconnecting: { attempt: number; delayMs: number; usingResume: boolean };

  resumed: {
    streams: Array<{ streamId: number; targetId: string; missedFrames: number }>;
    leaseRestored: boolean;
    missedControl: number;
  };

  /** Terminal: no further reconnects follow. */
  fatal: FatalInfo;

  /** A server `error`; `fatal: false` errors not answering a specific request also land here. */
  error: ErrorMsg;

  /** Debounced to once per animation frame. */
  targets: { targets: TargetSummary[]; changed: 'created' | 'updated' | 'closed' | 'list' };

  nav: {
    targetId: string;
    url: string;
    title: string;
    loading: boolean;
    canGoBack: boolean;
    canGoForward: boolean;
    securityState: 'secure' | 'insecure' | 'neutral' | 'unknown';
    errorText?: string;
    httpStatus?: number;
    redirectedFrom?: string;
  };

  /** Any lease change on the session, including other viewers'. */
  control: { leases: LeaseState[]; mine: string[]; changed: string[] };

  /**
   * `reason` is the wire `ControlRevoked.reason` passed through, with two
   * deliberate differences. `'capability_lost'` is folded into `'admin'`
   * (see the `control.revoked` case in `BrowserGlassClient`): from a
   * viewer's point of view a lease taken away because its token stopped
   * carrying `control` is the same event as an administrator revoking it.
   * `'preempted'` is client only, emitted from the `control.preempted`
   * path rather than from `control.revoked`, so it has no wire counterpart
   * here.
   *
   * `'human_takeover'` is the wire value added when shared control shipped:
   * a person reclaiming a target an AUTOMATION client was driving. It is
   * deliberately distinct from `'preempted'`, because an app showing "you
   * lost control" wants to say who to, and "a person took over" is a
   * different sentence from "another viewer outranked you". Leaving it out
   * of this union is what broke `@browserglass/client`'s declaration build
   * (and, through it, `@browserglass/react` and `@browserglass/automation`)
   * when the wire type was widened without this one following.
   */
  /**
   * `'kind_changed'` is the wire value for a tenure ended because a reauth
   * changed the holder's identity class (a viewer that gained or lost the
   * `automation` capability mid session). It is deliberately distinct from
   * `'admin'`: both arrive from a reauth, but "you may no longer control
   * anything" and "you are now a different kind of actor, ask again" want
   * opposite responses from a client, and only the second is worth an
   * immediate re-request.
   */
  controllost: {
    targetId: string;
    reason:
      | 'expired'
      | 'idle'
      | 'admin'
      | 'preempted'
      | 'human_takeover'
      | 'kind_changed'
      | 'target_gone'
      | 'session_ended';
    byLabel?: string;
  };

  /** Preemption step 1: the lease is still held; input still dispatches until `deadline`. */
  controlpreemptrequested: {
    targetId: string;
    byLabel: string;
    reason: 'priority' | 'force_claim' | 'human_takeover';
    graceMs: number;
    deadline: number;
  };
  /** Preemption step 2: the lease is gone. */
  controlpreempted: {
    targetId: string;
    byLabel: string;
    reason: 'priority' | 'force_claim' | 'human_takeover';
    released: boolean;
    lastDispatchedInputSeq: number;
    mayRequeue: boolean;
    requeueAfterMs: number;
  };

  presence: { viewers: ViewerPresence[] };
  cursor: {
    viewerId: string;
    targetId: string;
    x: number;
    y: number;
    label: string;
    colour: string;
    action?: string;
  };

  instance: { instanceId: string; state: InstanceState; reason?: string };
  recovering: {
    rung: RecoveryRung;
    signal: string;
    attempt: number;
    estimatedMs: number | null;
    message: string;
    requestedByLabel?: string;
    requestedReason?: string;
  };
  recovered: {
    rung: RecoveryRung;
    durationMs: number;
    streamsResubscribed: number[];
    streamsLost: number[];
  };

  dialog: {
    dialogId: string;
    targetId: string;
    kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
    message: string;
    defaultPrompt?: string;
    url: string;
  };
  filechooser: {
    chooserId: string;
    targetId: string;
    multiple: boolean;
    accept: string[];
    elementDescription: string;
  };
  download: {
    downloadId: string;
    phase: 'started' | 'progress' | 'ready' | 'failed';
    suggestedName: string;
    url?: string;
    receivedBytes?: number;
    totalBytes?: number | null;
  };

  /** `granted` never grows without a reauth. */
  capabilities: { granted: Capability[]; lost: Capability[] };
  stats: ClientStats;
  /** Informational; the SDK handles the actual relocation. */
  relocating: { url: string; reason: 'drain' | 'rebalance' | 'node_lost'; graceMs: number };

  /** `devtools` capability only. */
  console: { targetId: string; level: string; text: string; url?: string; line?: number };
  pageerror: { targetId: string; name: string; message: string; stack?: string };
  /** `devtools` capability only. One completed or failed request; `url` is UNTRUSTED. */
  network: {
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
  /** `devtools` capability only. Periodic rollup, same target as the `network` entries it summarises. */
  networksummary: {
    targetId: string;
    windowMs: number;
    requests: number;
    failed: number;
    bytesIn: number;
    bytesOut: number;
    slowest: Array<{ url: string; ms: number; status: number }>;
  };
}

/** Re-exported so callers do not need a direct `@browserglass/protocol` import for these wire enums. */
export type {
  Capability,
  Codec,
  LeaseState,
  ProbeDetail,
  ProbeRect,
  QualityProfile,
  TargetKind,
  TargetSummary,
  WelcomeInstance,
  WelcomeLimits,
};
