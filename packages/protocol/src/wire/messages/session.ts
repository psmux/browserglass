import type { Capability } from '../capabilities.js';
import type { Envelope } from '../envelope.js';
import type { LeaseState, LeaseSummary } from './control.js';
import type { Codec, QualityProfile } from './streams.js';
import type { TargetSummary } from './targets.js';

/** A decode codec, plus whether hardware acceleration was probed and confirmed. */
export interface VideoCodecCapability {
  codec: string;
  /** MUST have been probed with `VideoDecoder.isConfigSupported`; guessing is the most common conformance failure here. */
  hardware: 'unknown' | string;
}

/** The client's decode and input capabilities, declared in `hello`. */
export interface HelloCapabilities {
  /** DECODE capability, preference order. A hard constraint: the server MUST NOT send a codec absent from this list. */
  codecs: Codec[];
  videoCodecs?: VideoCodecCapability[];
  createImageBitmap?: boolean;
  offscreenCanvas?: boolean;
  webcodecs?: boolean;
  /** False forces base64-in-JSON fallback (see the binary frames section of `docs/protocol/wire-spec.md`). */
  binaryFrames: boolean;
  maxFrameBytes?: number;
  /** e.g. `['mouse','key','text','touch','scroll','drop']`. */
  input: string[];
  clipboard?: boolean;
  upload?: boolean;
  download?: boolean;
  presence?: boolean;
  compression?: string[];
}

/** Describes the display surface, NOT a resize request. Resizing the actual browser viewport is a separate, capability-gated operation. */
export interface HelloViewport {
  /** CSS px of the canvas element. */
  width: number;
  height: number;
  dpr: number;
  visible: boolean;
  fitMode: string;
}

/** Present only on a resume attempt, folded into `hello` to save a round trip. */
export interface HelloResume {
  token: string;
  sessionId: string;
  viewerId: string;
  /** `streamId` (as a string key) to the highest seq fully processed. */
  lastSeq: Record<string, number>;
  lastControlSq: number;
}

/**
 * C to S, first message on every connection including resumes and
 * reauths.
 */
export interface Hello extends Envelope {
  t: 'hello';
  id: string;
  /** Protocol majors the client can speak, preference order. */
  versions: number[];
  /** Lowest acceptable; the server MUST NOT downgrade below this. */
  minVersion: number;
  client: {
    name: string;
    version: string;
    runtime: 'browser' | 'node' | 'agent' | 'cli';
    ua?: string;
    platform?: string;
    locale?: string;
    tz?: string;
  };
  capabilities: HelloCapabilities;
  viewport: HelloViewport;
  /** Fold the first subscription into the handshake. */
  subscribe?: Array<{ targetId: string; quality?: QualityProfile }>;
  resume?: HelloResume;
  /** Mode B only. */
  auth?: { scheme: 'bearer'; token: string };
  reauth?: boolean;
}

/** The `welcome.instance` summary. */
export interface WelcomeInstance {
  instanceId: string;
  state: string;
  engine: string;
  channel: string;
  engineVersion: string;
  headless: boolean;
  runtime: 'host' | 'docker' | 'k8s' | 'remote';
  /** Null when `security.leakNodeIdentity` is false. */
  nodeId: string | null;
  profile: { mode: string; key: string; sizeBytes: number };
  viewport: { width: number; height: number; dpr: number };
  startedAt: number;
}

/** The `welcome.lease` block. */
export interface WelcomeLease {
  byTarget: Record<string, LeaseSummary>;
  defaultTtlMs: number;
  renewWithinMs: number;
  idleReleaseMs: number;
  maxQueue: number;
}

/** The `welcome.limits` block, the subset of server limits a client needs to know at connect time. */
export interface WelcomeLimits {
  maxStreams: number;
  maxBacklog: number;
  maxBufferedBytes: number;
  maxControlMsgBytes: number;
  maxUploadBytes: number;
  maxUploadChunkBytes: number;
  inputRatePerSec: number;
  controlRatePerSec: number;
  navRatePerSec: number;
  maxTargets: number;
  maxSessionDurationMs: number;
  idleTimeoutMs: number;
}

/** The `welcome.ack` block: negotiated ack policy. */
export interface WelcomeAck {
  policy: 'per-stream' | 'cumulative' | 'off';
  everyNFrames: number;
  maxAckIntervalMs: number;
  required: boolean;
}

/** The `welcome.streaming` block. */
export interface WelcomeStreaming {
  /** Negotiated default; per-stream may differ. */
  codec: Codec;
  fallbackCodec: Codec;
  maxFps: number;
  keyframeIntervalMs: number;
  adaptive: boolean;
  qualityProfiles: QualityProfile[];
}

/** The `welcome.resume` block. */
export interface WelcomeResume {
  token: string;
  windowMs: number;
  issuedAt: number;
}

/**
 * S to C, the first server message after a valid `hello`, and never sent
 * at any other time.
 */
export interface Welcome extends Envelope {
  t: 'welcome';
  /** Echoes `hello.id`. */
  re: string;
  /** Control-channel sequence starts at 1 for `welcome` itself. */
  sq: 1;

  /** Negotiated major; authoritative from here on. */
  version: number;
  /** Informational build string. */
  serverVersion: string;
  /** True when `version < hello.versions[0]`. */
  downgraded: boolean;

  viewerId: string;
  sessionId: string;
  tenantId: string;
  appId: string;

  instance: WelcomeInstance;
  targets: TargetSummary[];
  /** Capabilities actually granted, e.g. `['view','control','navigate','tabs.manage','clipboard.read','upload']`. */
  granted: Capability[];
  lease: WelcomeLease;
  presence: {
    viewers: Array<{ viewerId: string; label: string; kind: string; controlling: string[] }>;
  };
  limits: WelcomeLimits;
  ack: WelcomeAck;
  streaming: WelcomeStreaming;
  resume: WelcomeResume;

  /** The real credential; the refresh target. */
  sessionToken: string;
  sessionTokenExpiresAt: number;

  resumed: boolean;
  reauth: boolean;
  /** For clock-skew estimation ONLY. NOT for ordering; `sq` and binary `seq` handle ordering. */
  serverTime: number;
  /** Non-fatal connect-time conditions. */
  notices: Array<{ level: string; code: string; message: string }>;
}

/** C to S: application-level keepalive, sent every 5s. */
export interface Ping extends Envelope {
  t: 'ping';
  /** Client clock at send. */
  cts: number;
}

/** S to C: reply to `ping`. RTT is `now - cts`. */
export interface Pong extends Envelope {
  t: 'pong';
  cts: number;
  /** Server clock at reply. */
  sts: number;
}

/** C to S: a standalone resume attempt. Not idempotent: single use. If BOTH `hello.resume` and this are present, the standalone message is rejected. */
export interface Resume extends Envelope {
  t: 'resume';
  token: string;
  sessionId: string;
  viewerId: string;
  lastSeq: Record<string, number>;
  lastControlSq: number;
}

/** One restored stream subscription reported in {@link Resumed}. */
export interface ResumedStream {
  streamId: number;
  targetId: string;
  quality: QualityProfile;
  codec: Codec;
  /** Frames the server dropped for this viewer while it was away. */
  missedFrames: number;
  /** The server WILL send a keyframe next; always true after resume. */
  keyframePending: true;
}

/** S to C: the reply to an accepted `resume`. */
export interface Resumed extends Envelope {
  t: 'resumed';
  sessionId: string;
  viewerId: string;
  streams: ResumedStream[];
  /** The restored lease, or null if it expired during the outage. */
  lease: LeaseState | null;
  leaseRestored: boolean;
  /** Control messages the server could not replay. */
  missedControl: number;
  /** Full current list; the client REPLACES its own, does not merge. */
  targets: TargetSummary[];
  resume: WelcomeResume;
}

/** S to C, sent before closing with any 4xxx code where possible. */
export interface Goodbye extends Envelope {
  t: 'goodbye';
  /** Machine readable, matches the close reason. */
  reason: string;
  /** The close code that will follow. */
  code: number;
  /** Human readable, safe to display. */
  message: string;
  reconnect: boolean;
  retryAfterMs?: number;
  /** Set for 4403 Relocate. */
  redirect?: { url: string; ticket?: string };
}

/**
 * C to S: "I am working, do not declare me dead." Suppresses the idle
 * timer and the frame-silence watchdog. Requires the `automation`
 * capability. Typed only, not wired yet.
 */
export interface SessionBusy extends Envelope {
  t: 'session.busy';
  /** Server clamps to `limits.maxBusyMs` (default 300000). */
  forMs: number;
  /** Free text, capped at 200 bytes. */
  reason: string;
  /** False ends suppression early; default true. */
  active?: boolean;
}

/**
 * S to C: a shrunk `granted` array mid-session. Emitted on shrink together
 * with `control.revoked{reason:'capability_lost'}` where relevant, plus
 * `presence.state`.
 */
export interface CapabilitiesUpdated extends Envelope {
  t: 'capabilities.updated';
  granted: Capability[];
  reason: 'reauth' | 'admin' | 'policy';
}
