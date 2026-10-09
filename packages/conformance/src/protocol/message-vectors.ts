/**
 * Golden vectors for the `bgls.v1` JSON message catalogue: one canonical,
 * fully populated example envelope per message type exported from
 * `packages/protocol/src/wire/messages/**` plus `error`
 * (`packages/protocol/src/wire/errors.ts`'s `ErrorMsg`, which
 * `wire/messages/index.ts`'s own doc comment says lives outside the
 * messages barrel deliberately).
 *
 * Unlike the binary frame header, a JSON envelope has no bespoke encode
 * step to golden-vector against: the wire form of a `bgls.v1` control
 * message IS the JSON text of the envelope object (`ws/connection.ts`'s
 * `sendEnvelope` does nothing more than `JSON.stringify`). So the vector
 * that matters here is the canonical example OBJECT itself, matching the
 * real TypeScript interface field for field. Every `envelope` value below
 * is assigned with TypeScript's `satisfies` operator against the actual
 * type imported from `@browserglass/protocol`
 * (`test/protocol/golden-vectors.test.ts` additionally validates every one
 * of them against the generated JSON Schema, `./schema/wire-messages.schema.json`,
 * at runtime): a field renamed, retyped, or removed in `packages/protocol/src`
 * fails this file's own `tsc`, which is what keeps a vector from silently
 * describing a message shape the protocol package no longer produces.
 *
 * `wired` records whether this build's `@browserglass/server` actually
 * sends or handles this message type today, distinct from whether
 * `@browserglass/protocol` types it. Values:
 *   - `'wired'`: confirmed either as a handler key in
 *     `packages/server/src/ws/connection.ts`'s `handlers` record (inbound)
 *     or as a `t: '<name>'` literal actually constructed somewhere in
 *     `packages/server/src/**` (outbound), by direct grep against this
 *     repository's current source, not inferred from the protocol
 *     package's doc comments alone.
 *   - `'typed-only'`: `@browserglass/protocol` defines the type, but no
 *     handler and no emission site exists anywhere in
 *     `packages/server/src/**` today. Several of these carry their own
 *     "Typed only, not wired yet" doc comment in
 *     `packages/protocol/src/wire/messages/*.ts`; the ones below that do
 *     NOT carry that comment but were still found unemitted by grep are
 *     called out individually, since a stale doc comment is exactly the
 *     kind of thing a vector file existing at all is supposed to catch
 *     (see `target.reorder` below, which is the opposite case: commented
 *     "not wired" but actually is).
 *   - `'accepted-noop'`: present as a handler key, but the handler body
 *     does nothing (`stream.pause`/`stream.resume`; see the per-message
 *     comment for both).
 *
 * See `docs/protocol/wire-spec.md`'s message catalogue table for the same
 * information in prose, and its `presence.cursor` callout for the one
 * finding here worth reading before relying on this table: the message a
 * real client SDK sends is not the same set the server actually handles.
 */

import type {
  Ack,
  CapabilitiesUpdated,
  ClipboardData,
  ClipboardRead,
  ClipboardWrite,
  ConsoleEntry,
  ControlContention,
  ControlDenied,
  ControlExpiring,
  ControlGranted,
  ControlPreemptCancelled,
  ControlPreemptRequest,
  ControlPreempted,
  ControlQueued,
  ControlRelease,
  ControlRenew,
  ControlRequest,
  ControlRevoke,
  ControlRevoked,
  ControlStateMsg,
  DevtoolsOpen,
  DevtoolsUrl,
  DiagnosticsStatusGet,
  DiagnosticsStatusGot,
  DiagnosticsSubscribe,
  DiagnosticsSubscribed,
  DiagnosticsUnsubscribe,
  DialogAnswer,
  DialogClosed,
  DialogOpened,
  DownloadFailed,
  DownloadProgress,
  DownloadReady,
  DownloadStarted,
  ErrorMsg,
  FileChooserAnswer,
  FileChooserOpened,
  Goodbye,
  Hello,
  InputComposition,
  InputDrag,
  InputKey,
  InputMouse,
  InputText,
  InputTouch,
  InstanceRecovered,
  InstanceRecovering,
  InstanceReleased,
  InstanceRelocate,
  InstanceRestart,
  InstanceStateMsg,
  KeyframeRequest,
  NavBack,
  NavForward,
  NavGoto,
  NavReload,
  NavState,
  NavStop,
  NetworkRequestEntry,
  NetworkSummary,
  PageError,
  Ping,
  Pong,
  PresenceCursor,
  PresenceState,
  PresenceViewport,
  Resume,
  Resumed,
  SessionBusy,
  StreamDegraded,
  StreamPause,
  StreamQuality,
  StreamResume,
  StreamStats,
  StreamSubscribe,
  StreamSubscribed,
  StreamUnsubscribe,
  TargetActivate,
  TargetCapture,
  TargetCaptured,
  TargetClose,
  TargetClosed,
  TargetCreated,
  TargetList,
  TargetListed,
  TargetNew,
  TargetProbe,
  TargetProbed,
  TargetReorder,
  TargetUpdated,
  UploadAccepted,
  UploadBegin,
  UploadComplete,
  UploadDone,
  UploadProgress,
  Welcome,
} from '@browserglass/protocol';

/** Fixed wall clock, reused by every vector below, so regenerating this file never produces a spurious diff from `Date.now()` drift. 2024-11-20T12:00:00.000Z. */
const TS = 1732104000000;

/** A syntactically valid 26-character Crockford ULID body, reused with different id prefixes below. Vectors only need to be shaped correctly, not mutually distinct the way real minted ids (`newId()`) always are. */
const ULID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const ULID2 = '01ARZ3NDEKTSV4RRFFQ69G5FAW';

const TENANT_ID = `ten_${ULID}`;
const APP_ID = `app_${ULID}`;
const INSTANCE_ID = `inst_${ULID}`;
const TARGET_ID = `tgt_${ULID}`;
const TARGET_ID_2 = `tgt_${ULID2}`;
const SESSION_ID = `sess_${ULID}`;
const VIEWER_ID = `vwr_${ULID}`;
const VIEWER_ID_2 = `vwr_${ULID2}`;
const LEASE_ID = `lse_${ULID}`;
const STREAM_HANDLE = 1;

/** One entry in {@link MESSAGE_VECTORS}. */
export interface MessageVector {
  /** The envelope's `t` value; must match `envelope.t` exactly. */
  readonly t: string;
  readonly direction: 'c2s' | 's2c' | 'both';
  /** Path, relative to the repo root, of the interface this vector is shaped against. */
  readonly sourceFile: string;
  readonly wired: 'wired' | 'typed-only' | 'accepted-noop';
  /** One line on anything a implementer would get wrong, or empty string when nothing is subtle. */
  readonly note: string;
  readonly envelope: Record<string, unknown>;
}

// -- session.ts --------------------------------------------------------

const HELLO_VECTOR = {
  v: 1,
  t: 'hello',
  id: 'req_0001',
  ts: TS,
  versions: [1],
  minVersion: 1,
  client: { name: 'example-native-client', version: '0.1.0', runtime: 'node' },
  capabilities: {
    codecs: ['jpeg', 'webp'],
    binaryFrames: true,
    input: ['mouse', 'key', 'text', 'touch', 'scroll'],
  },
  viewport: { width: 1280, height: 720, dpr: 1, visible: true, fitMode: 'contain' },
} satisfies Hello;

const WELCOME_VECTOR = {
  v: 1,
  t: 'welcome',
  re: 'req_0001',
  sq: 1,
  ts: TS,
  version: 1,
  serverVersion: 'browserglass-server/0.0.0',
  downgraded: false,
  viewerId: VIEWER_ID,
  sessionId: SESSION_ID,
  tenantId: TENANT_ID,
  appId: APP_ID,
  instance: {
    instanceId: INSTANCE_ID,
    state: 'running',
    engine: 'chromium',
    channel: 'chrome',
    engineVersion: '131.0.6778.0',
    headless: true,
    runtime: 'host',
    nodeId: null,
    profile: { mode: 'ephemeral', key: 'eph:example', sizeBytes: 0 },
    viewport: { width: 1280, height: 720, dpr: 1 },
    startedAt: TS - 5000,
  },
  targets: [
    {
      targetId: TARGET_ID,
      kind: 'page',
      title: 'Example Domain',
      url: 'https://example.com/',
      faviconUrl: null,
      index: 0,
      windowId: 1,
      active: true,
      audible: false,
      muted: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      openerTargetId: null,
      viewers: 1,
      createdAt: TS - 4000,
    },
  ],
  granted: ['view', 'control', 'navigate'],
  lease: {
    byTarget: {},
    defaultTtlMs: 30000,
    renewWithinMs: 10000,
    idleReleaseMs: 20000,
    maxQueue: 10,
  },
  presence: {
    viewers: [{ viewerId: VIEWER_ID, label: 'example-viewer', kind: 'human', controlling: [] }],
  },
  limits: {
    maxStreams: 28,
    maxBacklog: 3,
    maxBufferedBytes: 2097152,
    maxControlMsgBytes: 65536,
    maxUploadBytes: 268435456,
    maxUploadChunkBytes: 0,
    inputRatePerSec: 300,
    controlRatePerSec: 60,
    navRatePerSec: 4,
    maxTargets: 20,
    maxSessionDurationMs: 3600000,
    idleTimeoutMs: 300000,
  },
  // ackRate defaults to perSecond 200, burst 400 (DEFAULT_LIMITS,
  // packages/protocol/src/wire/limits.ts). welcome.ack documents the
  // NEGOTIATED per-frame ack policy, not the rate limit: it says how often
  // to ack, not how fast acks may arrive. The two are easy to conflate;
  // see docs/protocol/wire-spec.md's ack section.
  ack: { policy: 'per-stream', everyNFrames: 1, maxAckIntervalMs: 250, required: true },
  streaming: {
    codec: 'jpeg',
    fallbackCodec: 'jpeg',
    maxFps: 30,
    keyframeIntervalMs: 2000,
    adaptive: true,
    qualityProfiles: ['auto', 'low', 'medium', 'high'],
  },
  resume: { token: 'rsm_example-resume-token', windowMs: 120000, issuedAt: TS },
  sessionToken: 'example.session.token',
  sessionTokenExpiresAt: TS + 900000,
  resumed: false,
  reauth: false,
  serverTime: TS,
  notices: [],
} satisfies Welcome;

const PING_VECTOR = { v: 1, t: 'ping', ts: TS, cts: TS } satisfies Ping;
const PONG_VECTOR = { v: 1, t: 'pong', sq: 42, ts: TS, cts: TS - 12, sts: TS } satisfies Pong;

const RESUME_VECTOR = {
  v: 1,
  t: 'resume',
  id: 'req_0002',
  ts: TS,
  token: 'rsm_example-resume-token',
  sessionId: SESSION_ID,
  viewerId: VIEWER_ID,
  lastSeq: { '1': 87 },
  lastControlSq: 14,
} satisfies Resume;

const RESUMED_VECTOR = {
  v: 1,
  t: 'resumed',
  re: 'req_0002',
  sq: 1,
  ts: TS,
  sessionId: SESSION_ID,
  viewerId: VIEWER_ID,
  streams: [
    {
      streamId: STREAM_HANDLE,
      targetId: TARGET_ID,
      quality: 'auto',
      codec: 'jpeg',
      missedFrames: 3,
      keyframePending: true,
    },
  ],
  lease: null,
  leaseRestored: false,
  missedControl: 0,
  targets: [
    {
      targetId: TARGET_ID,
      kind: 'page',
      title: 'Example Domain',
      url: 'https://example.com/',
      faviconUrl: null,
      index: 0,
      windowId: 1,
      active: true,
      audible: false,
      muted: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      openerTargetId: null,
      viewers: 1,
      createdAt: TS - 4000,
    },
  ],
  resume: { token: 'rsm_example-resume-token-2', windowMs: 120000, issuedAt: TS },
} satisfies Resumed;

const GOODBYE_VECTOR = {
  v: 1,
  t: 'goodbye',
  sq: 99,
  ts: TS,
  reason: 'idle_timeout',
  code: 4001,
  message: 'This session was idle past its configured limit.',
  reconnect: true,
} satisfies Goodbye;

const SESSION_BUSY_VECTOR = {
  v: 1,
  t: 'session.busy',
  id: 'req_0003',
  ts: TS,
  forMs: 60000,
  reason: 'batch import running',
} satisfies SessionBusy;

const CAPABILITIES_UPDATED_VECTOR = {
  v: 1,
  t: 'capabilities.updated',
  sq: 12,
  ts: TS,
  granted: ['view'],
  reason: 'reauth',
} satisfies CapabilitiesUpdated;

// -- targets.ts ----------------------------------------------------------

const TARGET_LIST_VECTOR = {
  v: 1,
  t: 'target.list',
  id: 'req_0004',
  ts: TS,
  includeKinds: ['page'],
} satisfies TargetList;

const TARGET_LISTED_VECTOR = {
  v: 1,
  t: 'target.listed',
  re: 'req_0004',
  sq: 3,
  ts: TS,
  targets: [
    {
      targetId: TARGET_ID,
      kind: 'page',
      title: 'Example Domain',
      url: 'https://example.com/',
      faviconUrl: null,
      index: 0,
      windowId: 1,
      active: true,
      audible: false,
      muted: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      openerTargetId: null,
      viewers: 1,
      createdAt: TS - 4000,
    },
  ],
} satisfies TargetListed;

const TARGET_CREATED_VECTOR = {
  v: 1,
  t: 'target.created',
  sq: 4,
  ts: TS,
  target: {
    targetId: TARGET_ID_2,
    kind: 'page',
    title: '',
    url: 'about:blank',
    faviconUrl: null,
    index: 1,
    windowId: 1,
    active: false,
    audible: false,
    muted: false,
    loading: true,
    canGoBack: false,
    canGoForward: false,
    openerTargetId: TARGET_ID,
    viewers: 0,
    createdAt: TS,
  },
} satisfies TargetCreated;

const TARGET_UPDATED_VECTOR = {
  v: 1,
  t: 'target.updated',
  sq: 5,
  ts: TS,
  targetId: TARGET_ID,
  // "carries a delta, not a full record" (targets.ts): only the changed keys appear.
  changed: { title: 'Example Domain (updated)', loading: false },
} satisfies TargetUpdated;

const TARGET_CLOSED_VECTOR = {
  v: 1,
  t: 'target.closed',
  sq: 6,
  ts: TS,
  targetId: TARGET_ID_2,
  reason: 'user',
} satisfies TargetClosed;

const TARGET_ACTIVATE_VECTOR = {
  v: 1,
  t: 'target.activate',
  id: 'req_0005',
  ts: TS,
  targetId: TARGET_ID,
} satisfies TargetActivate;

const TARGET_NEW_VECTOR = {
  v: 1,
  t: 'target.new',
  id: 'req_0006',
  ts: TS,
  url: 'https://example.com/second-tab',
  background: false,
  newWindow: false,
} satisfies TargetNew;

const TARGET_CLOSE_VECTOR = {
  v: 1,
  t: 'target.close',
  id: 'req_0007',
  ts: TS,
  targetId: TARGET_ID_2,
} satisfies TargetClose;

const TARGET_REORDER_VECTOR = {
  v: 1,
  t: 'target.reorder',
  ts: TS,
  targetIds: [TARGET_ID_2, TARGET_ID],
} satisfies TargetReorder;

// -- streams.ts ------------------------------------------------------------

const STREAM_SUBSCRIBE_VECTOR = {
  v: 1,
  t: 'stream.subscribe',
  id: 'req_0008',
  ts: TS,
  targetId: TARGET_ID,
  quality: 'auto',
  codec: 'jpeg',
} satisfies StreamSubscribe;

const STREAM_SUBSCRIBED_VECTOR = {
  v: 1,
  t: 'stream.subscribed',
  re: 'req_0008',
  sq: 7,
  ts: TS,
  streamId: STREAM_HANDLE,
  targetId: TARGET_ID,
  quality: 'auto',
  codec: 'jpeg',
  fps: 30,
  width: 1280,
  height: 720,
  dpr: 1,
  paused: false,
  sidEpoch: 1,
  gen: 0,
} satisfies StreamSubscribed;

const STREAM_UNSUBSCRIBE_VECTOR = {
  v: 1,
  t: 'stream.unsubscribe',
  ts: TS,
  streamId: STREAM_HANDLE,
} satisfies StreamUnsubscribe;

/** Handler is a registered `() => undefined` no-op; see this vector's own `wired` value. */
const STREAM_PAUSE_VECTOR = {
  v: 1,
  t: 'stream.pause',
  ts: TS,
  streamId: STREAM_HANDLE,
} satisfies StreamPause;
/** Same caveat as `stream.pause`. */
const STREAM_RESUME_VECTOR = {
  v: 1,
  t: 'stream.resume',
  ts: TS,
  streamId: STREAM_HANDLE,
} satisfies StreamResume;

const STREAM_QUALITY_VECTOR = {
  v: 1,
  t: 'stream.quality',
  id: 'req_0009',
  ts: TS,
  streamId: STREAM_HANDLE,
  quality: 'low',
  maxFps: 10,
} satisfies StreamQuality;

const STREAM_STATS_VECTOR = {
  v: 1,
  t: 'stream.stats',
  sq: 20,
  ts: TS,
  streamId: STREAM_HANDLE,
  fpsSent: 14.8,
  fpsDropped: 0.2,
  bytesPerSec: 184320,
  avgFrameBytes: 12450,
  backlog: 0,
  bufferedBytes: 0,
  encodeMsP50: 4.1,
  encodeMsP95: 9.7,
  rttMs: 22,
  quality: 'auto',
  codec: 'jpeg',
} satisfies StreamStats;

/**
 * `@browserglass/protocol` defines this type, but no `t: 'stream.degraded'` construction site exists anywhere in
 * `packages/server/src` as of this vector: the adaptive controller that
 * would emit it has not shipped in this build. See this vector's `wired`
 * value.
 */
const STREAM_DEGRADED_VECTOR = {
  v: 1,
  t: 'stream.degraded',
  sq: 21,
  ts: TS,
  streamId: STREAM_HANDLE,
  mode: 'thumbnail',
  reason: 'slow-consumer',
} satisfies StreamDegraded;

const ACK_VECTOR = {
  v: 1,
  t: 'ack',
  ts: TS,
  streamId: STREAM_HANDLE,
  seq: 87,
  decodeMs: 3.2,
} satisfies Ack;

const KEYFRAME_REQUEST_VECTOR = {
  v: 1,
  t: 'keyframe.request',
  ts: TS,
  streamId: STREAM_HANDLE,
  reason: 'canvas resized',
} satisfies KeyframeRequest;

// -- input.ts --------------------------------------------------------------

const INPUT_MOUSE_VECTOR = {
  v: 1,
  t: 'input.mouse',
  ts: TS,
  targetId: TARGET_ID,
  fw: 1280,
  fh: 720,
  gen: 0,
  leaseId: LEASE_ID,
  kind: 'move',
  x: 640.5,
  y: 360.25,
  buttons: 0,
  modifiers: 0,
} satisfies InputMouse;

const INPUT_KEY_VECTOR = {
  v: 1,
  t: 'input.key',
  ts: TS,
  targetId: TARGET_ID,
  fw: 1280,
  fh: 720,
  gen: 0,
  leaseId: LEASE_ID,
  kind: 'down',
  key: 'a',
  code: 'KeyA',
  modifiers: 0,
} satisfies InputKey;

const INPUT_TEXT_VECTOR = {
  v: 1,
  t: 'input.text',
  ts: TS,
  targetId: TARGET_ID,
  fw: 1280,
  fh: 720,
  gen: 0,
  leaseId: LEASE_ID,
  text: 'hello, browserglass',
} satisfies InputText;

const INPUT_TOUCH_VECTOR = {
  v: 1,
  t: 'input.touch',
  ts: TS,
  targetId: TARGET_ID,
  fw: 1280,
  fh: 720,
  gen: 0,
  leaseId: LEASE_ID,
  kind: 'start',
  points: [{ id: 0, x: 200, y: 300, force: 1 }],
  modifiers: 0,
} satisfies InputTouch;

const INPUT_COMPOSITION_VECTOR = {
  v: 1,
  t: 'input.composition',
  ts: TS,
  targetId: TARGET_ID,
  fw: 1280,
  fh: 720,
  gen: 0,
  leaseId: LEASE_ID,
  kind: 'update',
  text: 'nihongo',
  selectionStart: 0,
  selectionEnd: 3,
} satisfies InputComposition;

const INPUT_DRAG_VECTOR = {
  v: 1,
  t: 'input.drag',
  ts: TS,
  targetId: TARGET_ID,
  fw: 1280,
  fh: 720,
  gen: 0,
  leaseId: LEASE_ID,
  kind: 'over',
  x: 500,
  y: 400,
  modifiers: 0,
} satisfies InputDrag;

// -- control.ts --------------------------------------------------------------

const CONTROL_REQUEST_VECTOR = {
  v: 1,
  t: 'control.request',
  id: 'req_0010',
  ts: TS,
  targetId: TARGET_ID,
  ttlMs: 30000,
  queue: true,
} satisfies ControlRequest;

const CONTROL_GRANTED_VECTOR = {
  v: 1,
  t: 'control.granted',
  re: 'req_0010',
  sq: 30,
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
  expiresAt: TS + 30000,
  renewWithinMs: 10000,
  idleReleaseMs: 20000,
  mode: 'exclusive',
} satisfies ControlGranted;

const CONTROL_DENIED_VECTOR = {
  v: 1,
  t: 'control.denied',
  re: 'req_0010',
  sq: 30,
  ts: TS,
  targetId: TARGET_ID,
  reason: 'holder_pinned',
  message: 'Another viewer holds this lease and pinning is enabled.',
  holderLabel: 'alice',
} satisfies ControlDenied;

const CONTROL_QUEUED_VECTOR = {
  v: 1,
  t: 'control.queued',
  re: 'req_0010',
  sq: 30,
  ts: TS,
  targetId: TARGET_ID,
  position: 1,
  estimatedWaitMs: 15000,
  holderLabel: 'alice',
} satisfies ControlQueued;

const CONTROL_RENEW_VECTOR = {
  v: 1,
  t: 'control.renew',
  id: 'req_0011',
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
  ttlMs: 30000,
} satisfies ControlRenew;

const CONTROL_RELEASE_VECTOR = {
  v: 1,
  t: 'control.release',
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
} satisfies ControlRelease;

const CONTROL_REVOKED_VECTOR = {
  v: 1,
  t: 'control.revoked',
  sq: 31,
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
  reason: 'idle',
} satisfies ControlRevoked;

const CONTROL_REVOKE_VECTOR = {
  v: 1,
  t: 'control.revoke',
  id: 'req_0012',
  ts: TS,
  targetId: TARGET_ID,
  holderViewerId: VIEWER_ID_2,
  reason: 'misbehaving automation',
} satisfies ControlRevoke;

const CONTROL_EXPIRING_VECTOR = {
  v: 1,
  t: 'control.expiring',
  sq: 32,
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
  expiresAt: TS + 5000,
  inMs: 5000,
  reason: 'ttl',
} satisfies ControlExpiring;

const CONTROL_PREEMPT_REQUEST_VECTOR = {
  v: 1,
  t: 'control.preempt.request',
  sq: 33,
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
  byViewerId: VIEWER_ID_2,
  byLabel: 'bob',
  reason: 'force_claim',
  graceMs: 5000,
  deadline: TS + 5000,
} satisfies ControlPreemptRequest;

const CONTROL_PREEMPT_CANCELLED_VECTOR = {
  v: 1,
  t: 'control.preempt.cancelled',
  sq: 34,
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
  reason: 'withdrawn',
} satisfies ControlPreemptCancelled;

const CONTROL_PREEMPTED_VECTOR = {
  v: 1,
  t: 'control.preempted',
  sq: 35,
  ts: TS,
  targetId: TARGET_ID,
  leaseId: LEASE_ID,
  byViewerId: VIEWER_ID_2,
  byLabel: 'bob',
  reason: 'force_claim',
  released: false,
  lastDispatchedInputSeq: 512,
  mayRequeue: true,
  requeueAfterMs: 30000,
} satisfies ControlPreempted;

const CONTROL_STATE_VECTOR = {
  v: 1,
  t: 'control.state',
  sq: 36,
  ts: TS,
  leases: [
    {
      targetId: TARGET_ID,
      holderViewerId: VIEWER_ID,
      holderLabel: 'alice',
      grantedAt: TS - 1000,
      expiresAt: TS + 29000,
      mode: 'exclusive',
      // `holders[]` says the same thing `holderViewerId` does in exclusive
      // mode (0 or 1 entries), and is the whole truth about who is driving
      // in shared mode. Pinned here in its exclusive form so the golden
      // vector stays a statement about the mode this message has always
      // carried; a shared-mode vector belongs beside it, not instead of it.
      holders: [
        {
          viewerId: VIEWER_ID,
          label: 'alice',
          grantedAt: TS - 1000,
          expiresAt: TS + 29000,
          connected: true,
        },
      ],
      holderCount: 1,
      queue: [],
      queueLength: 0,
      queuePosition: null,
    },
  ],
} satisfies ControlStateMsg;

const CONTROL_CONTENTION_VECTOR = {
  v: 1,
  t: 'control.contention',
  sq: 37,
  ts: TS,
  targetId: TARGET_ID,
  // A human joining a target an agent already holds: `holders` reports
  // `kind` and `priority` directly (unlike `LeaseState.holders`, which
  // deliberately withholds `kind`; see this type's own doc for why), so an
  // agent reading this one message can decide to stand down without a
  // second round trip against `presence.state`.
  contended: true,
  holders: [
    {
      viewerId: VIEWER_ID_2,
      label: 'bob',
      kind: 'agent',
      priority: 50,
      grantedAt: TS - 2000,
      connected: true,
    },
    {
      viewerId: VIEWER_ID,
      label: 'alice',
      kind: 'human',
      priority: 100,
      grantedAt: TS - 1000,
      connected: true,
    },
  ],
  holderCount: 2,
  mostRecentViewerId: VIEWER_ID,
} satisfies ControlContention;

// -- navigation.ts -----------------------------------------------------------

const NAV_GOTO_VECTOR = {
  v: 1,
  t: 'nav.goto',
  id: 'req_0013',
  ts: TS,
  targetId: TARGET_ID,
  url: 'https://example.com/',
  waitUntil: 'load',
} satisfies NavGoto;
const NAV_BACK_VECTOR = {
  v: 1,
  t: 'nav.back',
  id: 'req_0014',
  ts: TS,
  targetId: TARGET_ID,
} satisfies NavBack;
const NAV_FORWARD_VECTOR = {
  v: 1,
  t: 'nav.forward',
  id: 'req_0015',
  ts: TS,
  targetId: TARGET_ID,
} satisfies NavForward;
const NAV_RELOAD_VECTOR = {
  v: 1,
  t: 'nav.reload',
  id: 'req_0016',
  ts: TS,
  targetId: TARGET_ID,
  ignoreCache: false,
} satisfies NavReload;
const NAV_STOP_VECTOR = {
  v: 1,
  t: 'nav.stop',
  id: 'req_0017',
  ts: TS,
  targetId: TARGET_ID,
} satisfies NavStop;

const NAV_STATE_VECTOR = {
  v: 1,
  t: 'nav.state',
  re: 'req_0013',
  sq: 40,
  ts: TS,
  targetId: TARGET_ID,
  url: 'https://example.com/',
  title: 'Example Domain',
  loading: false,
  canGoBack: true,
  canGoForward: false,
  securityState: 'secure',
  httpStatus: 200,
} satisfies NavState;

// -- clipboard.ts (typed only, not wired) -----------------------------------

const CLIPBOARD_READ_VECTOR = {
  v: 1,
  t: 'clipboard.read',
  id: 'req_0018',
  ts: TS,
  targetId: TARGET_ID,
  cut: false,
} satisfies ClipboardRead;
const CLIPBOARD_WRITE_VECTOR = {
  v: 1,
  t: 'clipboard.write',
  id: 'req_0019',
  ts: TS,
  targetId: TARGET_ID,
  text: 'copied from the remote page',
  mime: 'text/plain',
} satisfies ClipboardWrite;
const CLIPBOARD_DATA_VECTOR = {
  v: 1,
  t: 'clipboard.data',
  re: 'req_0018',
  ts: TS,
  targetId: TARGET_ID,
  text: 'copied from the remote page',
  mime: 'text/plain',
  truncated: false,
} satisfies ClipboardData;

// -- files.ts (typed only, not wired) ----------------------------------------

const UPLOAD_BEGIN_VECTOR = {
  v: 1,
  t: 'upload.begin',
  id: 'req_0020',
  ts: TS,
  uploadId: 'upload-example-0001',
  targetId: TARGET_ID,
  name: 'photo.png',
  sizeBytes: 245760,
  mime: 'image/png',
  purpose: 'filechooser',
  chooserId: 'chooser-example-0001',
} satisfies UploadBegin;

const UPLOAD_ACCEPTED_VECTOR = {
  v: 1,
  t: 'upload.accepted',
  re: 'req_0020',
  ts: TS,
  uploadId: 'upload-example-0001',
  chunkBytes: 65536,
  maxInFlight: 4,
} satisfies UploadAccepted;

const UPLOAD_PROGRESS_VECTOR = {
  v: 1,
  t: 'upload.progress',
  ts: TS,
  uploadId: 'upload-example-0001',
  receivedBytes: 131072,
} satisfies UploadProgress;

const UPLOAD_COMPLETE_VECTOR = {
  v: 1,
  t: 'upload.complete',
  id: 'req_0021',
  ts: TS,
  uploadId: 'upload-example-0001',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
} satisfies UploadComplete;

const UPLOAD_DONE_VECTOR = {
  v: 1,
  t: 'upload.done',
  re: 'req_0021',
  ts: TS,
  uploadId: 'upload-example-0001',
  path: '/uploads/photo.png',
  sizeBytes: 245760,
} satisfies UploadDone;

const FILECHOOSER_OPENED_VECTOR = {
  v: 1,
  t: 'filechooser.opened',
  sq: 50,
  ts: TS,
  chooserId: 'chooser-example-0001',
  targetId: TARGET_ID,
  multiple: false,
  accept: ['image/*'],
  elementDescription: 'input#avatar-upload',
} satisfies FileChooserOpened;

const FILECHOOSER_ANSWER_VECTOR = {
  v: 1,
  t: 'filechooser.answer',
  ts: TS,
  chooserId: 'chooser-example-0001',
  uploadIds: ['upload-example-0001'],
  cancel: false,
} satisfies FileChooserAnswer;

const DOWNLOAD_STARTED_VECTOR = {
  v: 1,
  t: 'download.started',
  sq: 51,
  ts: TS,
  downloadId: 'download-example-0001',
  targetId: TARGET_ID,
  suggestedName: 'report.pdf',
  mime: 'application/pdf',
  totalBytes: 524288,
  url: 'https://example.com/report.pdf',
} satisfies DownloadStarted;

const DOWNLOAD_PROGRESS_VECTOR = {
  v: 1,
  t: 'download.progress',
  sq: 52,
  ts: TS,
  downloadId: 'download-example-0001',
  receivedBytes: 262144,
  totalBytes: 524288,
} satisfies DownloadProgress;

const DOWNLOAD_READY_VECTOR = {
  v: 1,
  t: 'download.ready',
  sq: 53,
  ts: TS,
  downloadId: 'download-example-0001',
  sizeBytes: 524288,
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  url: 'https://gateway.example.com/downloads/download-example-0001?sig=example',
  expiresAt: TS + 60000,
} satisfies DownloadReady;

const DOWNLOAD_FAILED_VECTOR = {
  v: 1,
  t: 'download.failed',
  sq: 54,
  ts: TS,
  downloadId: 'download-example-0001',
  reason: 'disk_quota_exceeded',
} satisfies DownloadFailed;

// -- dialogs.ts (typed by @browserglass/protocol; dialog.opened/closed have no emission site as of this vector, see wired below) --

const DIALOG_OPENED_VECTOR = {
  v: 1,
  t: 'dialog.opened',
  sq: 60,
  ts: TS,
  dialogId: 'dialog-example-0001',
  targetId: TARGET_ID,
  kind: 'confirm',
  message: 'Leave site? Changes you made may not be saved.',
  url: 'https://example.com/',
} satisfies DialogOpened;

const DIALOG_ANSWER_VECTOR = {
  v: 1,
  t: 'dialog.answer',
  id: 'req_0022',
  ts: TS,
  dialogId: 'dialog-example-0001',
  accept: true,
} satisfies DialogAnswer;

const DIALOG_CLOSED_VECTOR = {
  v: 1,
  t: 'dialog.closed',
  sq: 61,
  ts: TS,
  dialogId: 'dialog-example-0001',
  targetId: TARGET_ID,
  reason: 'answered',
  accept: true,
  byViewerId: VIEWER_ID,
  byLabel: 'alice',
} satisfies DialogClosed;

// -- instance.ts ---------------------------------------------------------

const INSTANCE_STATE_VECTOR = {
  v: 1,
  t: 'instance.state',
  sq: 70,
  ts: TS,
  instanceId: INSTANCE_ID,
  state: 'running',
  since: TS - 5000,
} satisfies InstanceStateMsg;

const INSTANCE_RECOVERING_VECTOR = {
  v: 1,
  t: 'instance.recovering',
  sq: 71,
  ts: TS,
  instanceId: INSTANCE_ID,
  rung: 'R2',
  signal: 'cdp_dead',
  attempt: 1,
  estimatedMs: 4000,
  message: 'CDP connection lost; reattaching.',
} satisfies InstanceRecovering;

const INSTANCE_RECOVERED_VECTOR = {
  v: 1,
  t: 'instance.recovered',
  sq: 72,
  ts: TS,
  instanceId: INSTANCE_ID,
  rung: 'R2',
  durationMs: 3800,
  targetsPreserved: true,
  streamsResubscribed: [STREAM_HANDLE],
  streamsLost: [],
} satisfies InstanceRecovered;

const INSTANCE_RESTART_VECTOR = {
  v: 1,
  t: 'instance.restart',
  id: 'req_0023',
  ts: TS,
  instanceId: INSTANCE_ID,
  reason: 'operator requested restart',
  preserveProfile: true,
} satisfies InstanceRestart;

const INSTANCE_RELEASED_VECTOR = {
  v: 1,
  t: 'instance.released',
  sq: 73,
  ts: TS,
  instanceId: INSTANCE_ID,
  reason: 'idle',
} satisfies InstanceReleased;

const INSTANCE_RELOCATE_VECTOR = {
  v: 1,
  t: 'instance.relocate',
  sq: 74,
  ts: TS,
  instanceId: INSTANCE_ID,
  url: 'wss://node-b.example.com/bgls',
  ticket: 'tkt_example-relocate-ticket',
  reason: 'drain',
  graceMs: 10000,
} satisfies InstanceRelocate;

// -- presence.ts -----------------------------------------------------------

const PRESENCE_STATE_VECTOR = {
  v: 1,
  t: 'presence.state',
  sq: 80,
  ts: TS,
  viewers: [
    {
      viewerId: VIEWER_ID,
      label: 'alice',
      kind: 'human',
      colour: '#4287f5',
      controlling: [TARGET_ID],
      watching: [TARGET_ID],
      idle: false,
      joinedAt: TS - 10000,
    },
  ],
} satisfies PresenceState;

/**
 * `@browserglass/client`'s `BrowserGlassClient` (`packages/client/src/client/BrowserGlassClient.ts`)
 * DOES send this message (both directions, per the type's own doc comment)
 * whenever the local cursor moves over a controlled target. But
 * `ws/connection.ts`'s inbound `handlers` record has no `'presence.cursor'`
 * key: only `bucketFor()` (the rate limiter's own name lookup) mentions the
 * string. The result: every `presence.cursor` a real client sends is rate
 * limited normally, then falls through `dispatch()`'s
 * `const handler = this.handlers[t]` to the unknown-type branch and gets
 * back a non-fatal `bgls.error.protocol.unknown_type` reply. The server
 * never relays a viewer's cursor to any other viewer in this build. A
 * native client can safely omit sending this message entirely; if it does
 * send it anyway (matching the JS client's behaviour, for parity), it must
 * tolerate that specific error reply as expected rather than fatal.
 */
const PRESENCE_CURSOR_VECTOR = {
  v: 1,
  t: 'presence.cursor',
  ts: TS,
  targetId: TARGET_ID,
  x: 640,
  y: 360,
  fw: 1280,
  fh: 720,
  action: 'move',
} satisfies PresenceCursor;

const PRESENCE_VIEWPORT_VECTOR = {
  v: 1,
  t: 'presence.viewport',
  ts: TS,
  targetId: TARGET_ID,
  x: 0,
  y: 0,
  w: 1280,
  h: 720,
} satisfies PresenceViewport;

// -- diagnostics.ts ----------------------------------------------------------

const CONSOLE_ENTRY_VECTOR = {
  v: 1,
  t: 'console.entry',
  sq: 90,
  ts: TS,
  targetId: TARGET_ID,
  level: 'error',
  text: 'Uncaught TypeError: cannot read properties of undefined',
  url: 'https://example.com/app.js',
  line: 42,
  column: 7,
  count: 1,
} satisfies ConsoleEntry;

const PAGE_ERROR_VECTOR = {
  v: 1,
  t: 'page.error',
  sq: 91,
  ts: TS,
  targetId: TARGET_ID,
  name: 'TypeError',
  message: "cannot read properties of undefined (reading 'foo')",
  url: 'https://example.com/app.js',
} satisfies PageError;

const NETWORK_SUMMARY_VECTOR = {
  v: 1,
  t: 'network.summary',
  sq: 92,
  ts: TS,
  targetId: TARGET_ID,
  windowMs: 2000,
  requests: 14,
  failed: 1,
  bytesIn: 184320,
  bytesOut: 4096,
  slowest: [{ url: 'https://example.com/api/data', ms: 812, status: 200 }],
} satisfies NetworkSummary;

const DEVTOOLS_OPEN_VECTOR = {
  v: 1,
  t: 'devtools.open',
  id: 'req_0024',
  ts: TS,
  targetId: TARGET_ID,
} satisfies DevtoolsOpen;
const DEVTOOLS_URL_VECTOR = {
  v: 1,
  t: 'devtools.url',
  re: 'req_0024',
  ts: TS,
  targetId: TARGET_ID,
  url: 'https://gateway.example.com/devtools/inspector.html?ws=example',
  expiresAt: TS + 60000,
} satisfies DevtoolsUrl;

const DIAGNOSTICS_SUBSCRIBE_VECTOR = {
  v: 1,
  t: 'diagnostics.subscribe',
  id: 'req_0025',
  ts: TS,
  targetId: TARGET_ID,
  console: true,
  errors: true,
  network: false,
} satisfies DiagnosticsSubscribe;

const DIAGNOSTICS_UNSUBSCRIBE_VECTOR = {
  v: 1,
  t: 'diagnostics.unsubscribe',
  ts: TS,
  targetId: TARGET_ID,
} satisfies DiagnosticsUnsubscribe;

const DIAGNOSTICS_SUBSCRIBED_VECTOR = {
  v: 1,
  t: 'diagnostics.subscribed',
  re: 'req_0025',
  ts: TS,
  targetId: TARGET_ID,
  console: true,
  errors: true,
  network: false,
  // `console`/`errors` on means `Runtime.enable` landed
  // (`target-diagnostics.ts`'s `applyFeeds`), so the automation fingerprint
  // this vector's own reply reports is genuinely on.
  fingerprintActive: true,
} satisfies DiagnosticsSubscribed;

const DIAGNOSTICS_STATUS_GET_VECTOR = {
  v: 1,
  t: 'diagnostics.status.get',
  id: 'req_0028',
  ts: TS,
  targetId: TARGET_ID,
} satisfies DiagnosticsStatusGet;

const DIAGNOSTICS_STATUS_GOT_VECTOR = {
  v: 1,
  t: 'diagnostics.status.got',
  re: 'req_0028',
  ts: TS,
  targetId: TARGET_ID,
  // The quiet default: nobody has subscribed console/errors for this
  // target yet, so `Runtime` was never enabled on it.
  fingerprintActive: false,
} satisfies DiagnosticsStatusGot;

const NETWORK_REQUEST_VECTOR = {
  v: 1,
  t: 'network.request',
  sq: 93,
  ts: TS,
  targetId: TARGET_ID,
  requestId: 'req-cdp-0001',
  method: 'GET',
  url: 'https://example.com/api/data',
  resourceType: 'Fetch',
  status: 200,
  errorText: null,
  fromCache: false,
  durationMs: 184,
  encodedBytes: 2048,
  startedAt: TS - 200,
} satisfies NetworkRequestEntry;

// -- capture.ts --------------------------------------------------------------

const TARGET_CAPTURE_VECTOR = {
  v: 1,
  t: 'target.capture',
  id: 'req_0026',
  ts: TS,
  targetId: TARGET_ID,
  format: 'png',
  fullPage: false,
  delivery: 'auto',
} satisfies TargetCapture;

const TARGET_CAPTURED_VECTOR = {
  v: 1,
  t: 'target.captured',
  re: 'req_0026',
  ts: TS,
  captureId: 'capture-example-0001',
  targetId: TARGET_ID,
  format: 'png',
  width: 1280,
  height: 720,
  dpr: 1,
  sizeBytes: 48213,
  gen: 0,
  fullPage: false,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  downscaled: false,
} satisfies TargetCaptured;

// -- probe.ts ----------------------------------------------------------------

const TARGET_PROBE_VECTOR = {
  v: 1,
  t: 'target.probe',
  id: 'req_0027',
  ts: TS,
  targetId: TARGET_ID,
  x: 100,
  y: 200,
  fw: 1280,
  fh: 720,
  detail: 'full',
} satisfies TargetProbe;

const TARGET_PROBED_VECTOR = {
  v: 1,
  t: 'target.probed',
  re: 'req_0027',
  ts: TS,
  targetId: TARGET_ID,
  detail: 'full',
  gen: 0,
  hit: true,
  rect: { x: 90, y: 190, w: 120, h: 32 },
  label: 'a#login.btn.btn-primary',
  tagName: 'a',
  href: 'https://example.com/login',
  hrefFromAncestor: false,
  name: 'Log in',
  role: 'link',
  attributes: { href: '/login', class: 'btn btn-primary' },
} satisfies TargetProbed;

// -- errors.ts -----------------------------------------------------------

const ERROR_VECTOR = {
  v: 1,
  t: 'error',
  re: 'req_0999',
  ts: TS,
  code: 'bgls.error.target.not_found',
  category: 'target',
  message: 'Target closed; call target.list',
  fatal: false,
  retryable: false,
} satisfies ErrorMsg;

/**
 * Every message vector, in the same group order as
 * `packages/protocol/src/wire/messages/index.ts`'s own barrel, plus `error`
 * last (matching `wire/index.ts`'s own export order, `errors.js` after the
 * messages barrel).
 */
export const MESSAGE_VECTORS: readonly MessageVector[] = [
  // session.ts
  {
    t: 'hello',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'wired',
    note: 'First message on every connection, including reauth (hello with reauth:true).',
    envelope: HELLO_VECTOR,
  },
  {
    t: 'welcome',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'wired',
    note: 'Always sq 1. Never sent at any other time.',
    envelope: WELCOME_VECTOR,
  },
  {
    t: 'ping',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'wired',
    note: 'Client keepalive, sent every 5s by the reference client.',
    envelope: PING_VECTOR,
  },
  {
    t: 'pong',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'wired',
    note: 'RTT = now - cts.',
    envelope: PONG_VECTOR,
  },
  {
    t: 'resume',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'typed-only',
    note: 'The STANDALONE resume message. Only hello.resume (folded into the handshake) is implemented; this message type has no dispatch handler in ws/connection.ts.',
    envelope: RESUME_VECTOR,
  },
  {
    t: 'resumed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'wired',
    note: 'Sent in reply to hello.resume, not to a standalone resume (see above).',
    envelope: RESUMED_VECTOR,
  },
  {
    t: 'goodbye',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'wired',
    note: 'Sent before closing with a writable 4xxx code where possible.',
    envelope: GOODBYE_VECTOR,
  },
  {
    t: 'session.busy',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'typed-only',
    note: '',
    envelope: SESSION_BUSY_VECTOR,
  },
  {
    t: 'capabilities.updated',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/session.ts',
    wired: 'wired',
    note: 'Emitted on a reauth capability change.',
    envelope: CAPABILITIES_UPDATED_VECTOR,
  },

  // targets.ts
  {
    t: 'target.list',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: '',
    envelope: TARGET_LIST_VECTOR,
  },
  {
    t: 'target.listed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: '',
    envelope: TARGET_LISTED_VECTOR,
  },
  {
    t: 'target.created',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: '',
    envelope: TARGET_CREATED_VECTOR,
  },
  {
    t: 'target.updated',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: 'changed carries only the fields that actually changed, not a full TargetSummary.',
    envelope: TARGET_UPDATED_VECTOR,
  },
  {
    t: 'target.closed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: '',
    envelope: TARGET_CLOSED_VECTOR,
  },
  {
    t: 'target.activate',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: '',
    envelope: TARGET_ACTIVATE_VECTOR,
  },
  {
    t: 'target.new',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: 'Not idempotent; resending creates a second tab.',
    envelope: TARGET_NEW_VECTOR,
  },
  {
    t: 'target.close',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: '',
    envelope: TARGET_CLOSE_VECTOR,
  },
  {
    t: 'target.reorder',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/targets.ts',
    wired: 'wired',
    note: `packages/protocol/src's own doc comment on this type once said "Typed only, not wired"; that was stale. ws/connection.ts has a real handler (its own comment: "it had no handler at all, so tabs.reorder() was a shipped API that silently did nothing") and broadcasts the new order. Fire and forget: no reply.`,
    envelope: TARGET_REORDER_VECTOR,
  },

  // streams.ts
  {
    t: 'stream.subscribe',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'wired',
    note: '',
    envelope: STREAM_SUBSCRIBE_VECTOR,
  },
  {
    t: 'stream.subscribed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'wired',
    note: 'The first binary frame on a fresh subscription always carries the KEYFRAME flag.',
    envelope: STREAM_SUBSCRIBED_VECTOR,
  },
  {
    t: 'stream.unsubscribe',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'wired',
    note: 'Silent; no reply.',
    envelope: STREAM_UNSUBSCRIBE_VECTOR,
  },
  {
    t: 'stream.pause',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'accepted-noop',
    note: 'ws/connection.ts handler is () => undefined. The message is accepted (no error reply) but frame delivery is not actually paused in this build.',
    envelope: STREAM_PAUSE_VECTOR,
  },
  {
    t: 'stream.resume',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'accepted-noop',
    note: 'Same as stream.pause: accepted, does nothing.',
    envelope: STREAM_RESUME_VECTOR,
  },
  {
    t: 'stream.quality',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'wired',
    note: 'Answered with a re-emitted stream.subscribed carrying a bumped sidEpoch, and the following frame is always a keyframe.',
    envelope: STREAM_QUALITY_VECTOR,
  },
  {
    t: 'stream.stats',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'wired',
    note: 'Periodic, every statsIntervalMs (default 2000ms).',
    envelope: STREAM_STATS_VECTOR,
  },
  {
    t: 'stream.degraded',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'typed-only',
    note: 'Defined but never constructed anywhere in packages/server/src as of this vector: the adaptive controller that would emit it has not shipped.',
    envelope: STREAM_DEGRADED_VECTOR,
  },
  {
    t: 'ack',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'wired',
    note: 'MUST be sent for every binary frame received, or the server stops sending on that stream after maxBacklog (3) unacked frames; see docs/protocol/wire-spec.md.',
    envelope: ACK_VECTOR,
  },
  {
    t: 'keyframe.request',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/streams.ts',
    wired: 'wired',
    note: '',
    envelope: KEYFRAME_REQUEST_VECTOR,
  },

  // input.ts
  {
    t: 'input.mouse',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/input.ts',
    wired: 'wired',
    note: 'No enter/leave kind; CDP does not accept them.',
    envelope: INPUT_MOUSE_VECTOR,
  },
  {
    t: 'input.key',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/input.ts',
    wired: 'wired',
    note: '',
    envelope: INPUT_KEY_VECTOR,
  },
  {
    t: 'input.text',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/input.ts',
    wired: 'wired',
    note: '',
    envelope: INPUT_TEXT_VECTOR,
  },
  {
    t: 'input.touch',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/input.ts',
    wired: 'wired',
    note: 'points is the full active set every time, not a delta.',
    envelope: INPUT_TOUCH_VECTOR,
  },
  {
    t: 'input.composition',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/input.ts',
    wired: 'wired',
    note: 'While a composition is active the client MUST NOT send input.key.',
    envelope: INPUT_COMPOSITION_VECTOR,
  },
  {
    t: 'input.drag',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/input.ts',
    wired: 'wired',
    note: 'Native drag via Input.dispatchDragEvent (enter/over/drop map to dragEnter/dragOver/drop; leave maps to dragCancel). A page that never fires a native drag is still reachable through the input.mouse down/move/up path, unwired to this message type.',
    envelope: INPUT_DRAG_VECTOR,
  },

  // control.ts
  {
    t: 'control.request',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_REQUEST_VECTOR,
  },
  {
    t: 'control.granted',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: 'Can arrive unprompted (no fresh id) after a prior control.queued, once the queue advances; it still carries the ORIGINAL request id as re.',
    envelope: CONTROL_GRANTED_VECTOR,
  },
  {
    t: 'control.denied',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_DENIED_VECTOR,
  },
  {
    t: 'control.queued',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_QUEUED_VECTOR,
  },
  {
    t: 'control.renew',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_RENEW_VECTOR,
  },
  {
    t: 'control.release',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_RELEASE_VECTOR,
  },
  {
    t: 'control.revoked',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_REVOKED_VECTOR,
  },
  {
    t: 'control.revoke',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: 'Requires admin. Naming a non-current holderViewerId yields bgls.error.control.not_held rather than revoking whoever holds it now.',
    envelope: CONTROL_REVOKE_VECTOR,
  },
  {
    t: 'control.expiring',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_EXPIRING_VECTOR,
  },
  {
    t: 'control.preempt.request',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: 'Nothing is taken yet; the current holder still owns the lease during the grace window.',
    envelope: CONTROL_PREEMPT_REQUEST_VECTOR,
  },
  {
    t: 'control.preempt.cancelled',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_PREEMPT_CANCELLED_VECTOR,
  },
  {
    t: 'control.preempted',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_PREEMPTED_VECTOR,
  },
  {
    t: 'control.state',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: '',
    envelope: CONTROL_STATE_VECTOR,
  },
  {
    t: 'control.contention',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/control.ts',
    wired: 'wired',
    note: "Broadcast (ControlLeaseEngine emits it through the same LeaseBroadcastEffect shape as control.state, so ManagedSession.dispatchEffect sends it with no transport-layer change of its own). Fires once when a target's holder count crosses from one to two or more (contended: true) and once when it drops back to at most one (contended: false); never fires under mode: 'exclusive'.",
    envelope: CONTROL_CONTENTION_VECTOR,
  },

  // navigation.ts
  {
    t: 'nav.goto',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/navigation.ts',
    wired: 'wired',
    note: 'The correlated nav.state reply arrives before the session-wide nav.state broadcast; see docs/protocol/wire-spec.md.',
    envelope: NAV_GOTO_VECTOR,
  },
  {
    t: 'nav.back',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/navigation.ts',
    wired: 'wired',
    note: '',
    envelope: NAV_BACK_VECTOR,
  },
  {
    t: 'nav.forward',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/navigation.ts',
    wired: 'wired',
    note: '',
    envelope: NAV_FORWARD_VECTOR,
  },
  {
    t: 'nav.reload',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/navigation.ts',
    wired: 'wired',
    note: '',
    envelope: NAV_RELOAD_VECTOR,
  },
  {
    t: 'nav.stop',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/navigation.ts',
    wired: 'wired',
    note: '',
    envelope: NAV_STOP_VECTOR,
  },
  {
    t: 'nav.state',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/navigation.ts',
    wired: 'wired',
    note: 'Emitted on every main-frame navigation, title change, load-state change, and history-state change, not only in reply to nav.*.',
    envelope: NAV_STATE_VECTOR,
  },

  // clipboard.ts
  {
    t: 'clipboard.read',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/clipboard.ts',
    wired: 'typed-only',
    note: '',
    envelope: CLIPBOARD_READ_VECTOR,
  },
  {
    t: 'clipboard.write',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/clipboard.ts',
    wired: 'typed-only',
    note: '',
    envelope: CLIPBOARD_WRITE_VECTOR,
  },
  {
    t: 'clipboard.data',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/clipboard.ts',
    wired: 'typed-only',
    note: 'Addressed to the requesting viewer only; broadcasting it would be a data leak.',
    envelope: CLIPBOARD_DATA_VECTOR,
  },

  // files.ts
  {
    t: 'upload.begin',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: 'The bytes themselves would ride the binary channel as UPLOAD_CHUNK (msgType 0x03); see binary-vectors.ts.',
    envelope: UPLOAD_BEGIN_VECTOR,
  },
  {
    t: 'upload.accepted',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: UPLOAD_ACCEPTED_VECTOR,
  },
  {
    t: 'upload.progress',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: UPLOAD_PROGRESS_VECTOR,
  },
  {
    t: 'upload.complete',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: UPLOAD_COMPLETE_VECTOR,
  },
  {
    t: 'upload.done',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: UPLOAD_DONE_VECTOR,
  },
  {
    t: 'filechooser.opened',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: 'elementDescription is untrusted page content.',
    envelope: FILECHOOSER_OPENED_VECTOR,
  },
  {
    t: 'filechooser.answer',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: FILECHOOSER_ANSWER_VECTOR,
  },
  {
    t: 'download.started',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: DOWNLOAD_STARTED_VECTOR,
  },
  {
    t: 'download.progress',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: DOWNLOAD_PROGRESS_VECTOR,
  },
  {
    t: 'download.ready',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: 'Downloads never stream through the socket itself; url is a signed, short-lived, single-use HTTP URL.',
    envelope: DOWNLOAD_READY_VECTOR,
  },
  {
    t: 'download.failed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/files.ts',
    wired: 'typed-only',
    note: '',
    envelope: DOWNLOAD_FAILED_VECTOR,
  },

  // dialogs.ts
  {
    t: 'dialog.opened',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/dialogs.ts',
    wired: 'typed-only',
    note: 'No emission site found in packages/server/src as of this vector, even though dialog.answer IS wired: a viewer can answer a dialog the server never told anyone was open.',
    envelope: DIALOG_OPENED_VECTOR,
  },
  {
    t: 'dialog.answer',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/dialogs.ts',
    wired: 'wired',
    note: 'Only the lease holder may answer.',
    envelope: DIALOG_ANSWER_VECTOR,
  },
  {
    t: 'dialog.closed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/dialogs.ts',
    wired: 'typed-only',
    note: 'Same gap as dialog.opened: no emission site found.',
    envelope: DIALOG_CLOSED_VECTOR,
  },

  // instance.ts
  {
    t: 'instance.state',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/instance.ts',
    wired: 'typed-only',
    note: 'The standalone push message. welcome.instance carries the SAME shape of information inline on connect, and that field is always populated; this standalone message just has no emission site of its own in packages/server/src.',
    envelope: INSTANCE_STATE_VECTOR,
  },
  {
    t: 'instance.recovering',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/instance.ts',
    wired: 'wired',
    note: '',
    envelope: INSTANCE_RECOVERING_VECTOR,
  },
  {
    t: 'instance.recovered',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/instance.ts',
    wired: 'wired',
    note: '',
    envelope: INSTANCE_RECOVERED_VECTOR,
  },
  {
    t: 'instance.restart',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/instance.ts',
    wired: 'wired',
    note: 'Single-flight per instance; reuses instance.recovering/instance.recovered with rung R4, signal manual.',
    envelope: INSTANCE_RESTART_VECTOR,
  },
  {
    t: 'instance.released',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/instance.ts',
    wired: 'typed-only',
    note: 'No emission site found in packages/server/src as of this vector.',
    envelope: INSTANCE_RELEASED_VECTOR,
  },
  {
    t: 'instance.relocate',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/instance.ts',
    wired: 'typed-only',
    note: 'Single-node embedded never relocates.',
    envelope: INSTANCE_RELOCATE_VECTOR,
  },

  // presence.ts
  {
    t: 'presence.state',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/presence.ts',
    wired: 'wired',
    note: 'Never carries raw token claims; displayName/avatarUrl come from the token at issue time.',
    envelope: PRESENCE_STATE_VECTOR,
  },
  {
    t: 'presence.cursor',
    direction: 'both',
    sourceFile: 'packages/protocol/src/wire/messages/presence.ts',
    wired: 'typed-only',
    note: "The reference client SENDS this, but the server has no handler for it: see this vector's own doc comment above for the exact failure mode (bgls.error.protocol.unknown_type on every send).",
    envelope: PRESENCE_CURSOR_VECTOR,
  },
  {
    t: 'presence.viewport',
    direction: 'both',
    sourceFile: 'packages/protocol/src/wire/messages/presence.ts',
    wired: 'typed-only',
    note: '',
    envelope: PRESENCE_VIEWPORT_VECTOR,
  },

  // diagnostics.ts
  {
    t: 'console.entry',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Requires devtools plus diagnostics.subscribe{console:true} on that target. Coalesced: identical (level, text) within 1s arrives once with count.',
    envelope: CONSOLE_ENTRY_VECTOR,
  },
  {
    t: 'page.error',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Gated the same way as console.entry (errors:true).',
    envelope: PAGE_ERROR_VECTOR,
  },
  {
    t: 'network.summary',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Only sent when the network feed is on.',
    envelope: NETWORK_SUMMARY_VECTOR,
  },
  {
    t: 'devtools.open',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'typed-only',
    note: 'A separate feature (its own auth surface) from diagnostics.subscribe.',
    envelope: DEVTOOLS_OPEN_VECTOR,
  },
  {
    t: 'devtools.url',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'typed-only',
    note: '',
    envelope: DEVTOOLS_URL_VECTOR,
  },
  {
    t: 'diagnostics.subscribe',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Opt in per target, not a connection-wide default. Requires devtools.',
    envelope: DIAGNOSTICS_SUBSCRIBE_VECTOR,
  },
  {
    t: 'diagnostics.unsubscribe',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: '',
    envelope: DIAGNOSTICS_UNSUBSCRIBE_VECTOR,
  },
  {
    t: 'diagnostics.subscribed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Echoes what is actually on; may differ from the request if a feed could not be enabled. fingerprintActive reports whether Runtime is enabled on this target right now.',
    envelope: DIAGNOSTICS_SUBSCRIBED_VECTOR,
  },
  {
    t: 'diagnostics.status.get',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Read-only, side-effect-free: answers whether this target carries the Runtime automation fingerprint right now, without subscribing to anything. Requires devtools.',
    envelope: DIAGNOSTICS_STATUS_GET_VECTOR,
  },
  {
    t: 'diagnostics.status.got',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Reply to diagnostics.status.get.',
    envelope: DIAGNOSTICS_STATUS_GOT_VECTOR,
  },
  {
    t: 'network.request',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/diagnostics.ts',
    wired: 'wired',
    note: 'Per-request detail; gated the same way as console.entry, sent only when the network feed is on.',
    envelope: NETWORK_REQUEST_VECTOR,
  },

  // capture.ts
  {
    t: 'target.capture',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/capture.ts',
    wired: 'wired',
    note: "A full-resolution screenshot, independent of the requester's own stream quality tier.",
    envelope: TARGET_CAPTURE_VECTOR,
  },
  {
    t: 'target.captured',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/capture.ts',
    wired: 'wired',
    note: 'Addressed to the requesting viewer only.',
    envelope: TARGET_CAPTURED_VECTOR,
  },

  // probe.ts
  {
    t: 'target.probe',
    direction: 'c2s',
    sourceFile: 'packages/protocol/src/wire/messages/probe.ts',
    wired: 'wired',
    note: 'No gen required on the request; a stale probe is a wasted round trip, not a wrong action.',
    envelope: TARGET_PROBE_VECTOR,
  },
  {
    t: 'target.probed',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/messages/probe.ts',
    wired: 'wired',
    note: 'Stamped with the generation it was computed against.',
    envelope: TARGET_PROBED_VECTOR,
  },

  // errors.ts
  {
    t: 'error',
    direction: 's2c',
    sourceFile: 'packages/protocol/src/wire/errors.ts',
    wired: 'wired',
    note: 'fatal:true means a close follows within 100ms.',
    envelope: ERROR_VECTOR,
  },
];
