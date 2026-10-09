/**
 * The remaining extension point interfaces: `PlacementPolicy`, `FrameCodec`, `AuditSink`, `MetricsSink`,
 * `NavigationPolicy`, `QuotaProvider`, plus `NodeTransport`, the boundary
 * `LocalNodeTransport` (router) and a future networked transport both
 * implement so a standalone node agent is an additive change rather than a
 * rewrite.
 */

import type { PayloadCodecValue } from '../wire/index.js';
import type {
  BrowserSpec,
  NodeCapacity,
  NodeId,
  NodeLoad,
  NodeState,
  ResolvedProfileSpec,
} from './entities.js';
import type {
  LaunchRequest,
  LaunchedBrowser,
  RuntimeInventoryEntry,
  TerminateMode,
  TerminateResult,
} from './runtime.js';

// ── PlacementPolicy ─────────────────────────────────────────────────────

/**
 * Hints steering one placement decision.
 * `requireNodeId` and `requireLabels` are hard constraints, a violation is
 * a placement failure; `preferNodeId` and `preferLabels` only weight the
 * score.
 */
export interface AffinityHints {
  preferNodeId?: NodeId;
  requireNodeId?: NodeId;
  requireLabels?: Readonly<Record<string, string>>;
  preferLabels?: Readonly<Record<string, string>>;
  /** Spread instances of an app across nodes rather than pack them. */
  spreadKey?: string;
}

/** One placement decision for one candidate node. */
export interface PlacementDecision {
  ordered: readonly { nodeId: NodeId; score: number; reasons: readonly string[] }[];
  /** Set when the router should reuse an existing instance instead of launching. */
  reuse?: { instanceId: string; nodeId: NodeId; why: 'warm' | 'shared' | 'sticky' };
}

/** A read only view of one candidate node, as far as placement needs to know. */
export interface NodeSnapshot {
  nodeId: NodeId;
  labels: Readonly<Record<string, string>>;
  state: NodeState;
  capacity: NodeCapacity;
  load: NodeLoad;
  lastHeartbeatAt: number;
  /** Profile keys materialised locally. */
  hostsProfiles: readonly string[];
}

/** One placement request: what is being placed, and the pool of nodes it may land on. */
export interface PlacementRequest {
  tenantId: string;
  appId: string;
  poolId: string;
  spec: BrowserSpec;
  profile: ResolvedProfileSpec;
  /** Set if the profile is persistent and already materialised somewhere. */
  profileHome: { nodeId: NodeId; replicas: readonly NodeId[] } | null;
  affinity: AffinityHints;
  /** Only nodes in state `'ready'`. */
  candidates: readonly NodeSnapshot[];
  now: number;
}

/** A snapshot of the whole cluster, for `rebalance()`. */
export interface ClusterSnapshot {
  nodes: readonly NodeSnapshot[];
  at: number;
}

/** One instance a rebalance plan would move. */
export interface RelocationPlan {
  instanceId: string;
  fromNodeId: NodeId;
  toNodeId: NodeId;
  reason: string;
}

/** How the router chooses a node for a placement request. Default `scoredPlacement()`; named alternatives `binPack()` and `spread()`. */
export interface PlacementPolicy {
  name: string;
  /** Ordered candidates; an empty array means no capacity. */
  place(req: PlacementRequest): Promise<PlacementDecision>;
  rebalance?(state: ClusterSnapshot): Promise<readonly RelocationPlan[]>;
}

// ── FrameCodec ──────────────────────────────────────────────────────────

/** What a `FrameCodec` can do, probed once at startup. */
export interface CodecCapability {
  available: boolean;
  /** True for jpeg straight from CDP, false for webp, avif, and h264. */
  passthrough: boolean;
  hardware: boolean;
  maxWidth: number;
  maxHeight: number;
  /** True only for video codecs. */
  keyframeControl: boolean;
  estimatedMsPerFrameAt1080p: number;
}

/** Metadata CDP's screencast frame carries alongside the bytes. */
export interface ScreencastMetadata {
  deviceWidth: number;
  deviceHeight: number;
  pageScaleFactor: number;
  offsetTop: number;
  scrollOffsetX: number;
  scrollOffsetY: number;
  timestamp: number;
}

/** One captured, not yet encoded, frame. */
export interface RawFrame {
  bytes: Uint8Array;
  sourceCodec: PayloadCodecValue;
  width: number;
  height: number;
  capturedAt: number;
  metadata: ScreencastMetadata;
}

/** What one encode should aim for. */
export interface EncodeTarget {
  maxWidth: number;
  maxHeight: number;
  /** 1 to 100, ignored for video. */
  quality: number;
  forceKeyframe: boolean;
}

/** One encoded frame, ready for the binary header plus payload to go on the wire. */
export interface EncodedFrame {
  bytes: Uint8Array;
  codec: PayloadCodecValue;
  width: number;
  height: number;
  keyframe: boolean;
  encodeMs: number;
}

/** Context passed to `FrameCodec.encode`, for correlating a worker pool sample back to its stream. */
export interface CodecContext {
  streamId: string;
  tier: number;
}

/**
 * One pluggable frame codec. Passthrough codecs must return the input
 * buffer unchanged and must not copy; transcoding codecs run on a worker
 * thread from a pool the caller provides.
 */
export interface FrameCodec {
  /** Matches the `payloadCodec` byte in the binary frame header. */
  id: PayloadCodecValue;
  name: string;
  probe(): Promise<CodecCapability>;
  encode(frame: RawFrame, target: EncodeTarget, ctx: CodecContext): Promise<EncodedFrame>;
  release(streamId: string): void;
}

// ── AuditSink ───────────────────────────────────────────────────────────

/**
 * The discriminated union `AuditSink.emit` receives. Deliberately distinct from `store-types.js`'s flat `AuditEvent` row
 * (the shape `Store.appendAudit` persists): this union is what application
 * code constructs at the call site, the audit writer maps it down to a row
 * before persisting. `input.batch` is a rolling window with counts, never
 * per keystroke, which avoids both a denial of service against the log
 * pipeline and recording keystroke content by default.
 */
export type AuditSinkEvent =
  | {
      k: 'auth.accepted';
      tid: string;
      aid: string;
      sub: string;
      vid: string;
      ip: string;
      at: number;
    }
  | { k: 'auth.rejected'; tid?: string; reason: string; code: number; ip: string; at: number }
  | {
      k: 'instance.acquired';
      tid: string;
      aid: string;
      iid: string;
      nid: string;
      profileKey: string | null;
      reused: boolean;
      at: number;
    }
  | { k: 'instance.released'; iid: string; reason: string; durationMs: number; at: number }
  /**
   * One instance resolved through `BrowserRouter`'s authority gate for an
   * action, on a fresh resolve rather than on every call (the gate caches).
   *
   * Deliberately its own kind rather than another `instance.acquired`.
   * Driving an instance is not acquiring one, and an auditor counting
   * acquisitions would badly over-count if every REST call, CLI command and
   * CDP passthrough logged as an acquisition. `local` records whether the
   * action executed on this node or was forwarded to the owning one, which
   * is the field an operator uses to see cross node traffic at all.
   */
  | {
      k: 'instance.drive';
      tid: string;
      aid: string;
      iid: string;
      nid: string;
      local: boolean;
      at: number;
    }
  | {
      k: 'viewer.attached';
      sid: string;
      vid: string;
      sub: string;
      caps: readonly string[];
      at: number;
    }
  | { k: 'viewer.detached'; sid: string; vid: string; code: number; at: number }
  | { k: 'control.granted'; sid: string; tgt: string; vid: string; leaseId: string; at: number }
  | {
      k: 'control.revoked';
      sid: string;
      tgt: string;
      vid: string;
      leaseId: string;
      reason: 'released' | 'expired' | 'force_claimed' | 'kicked';
      by?: string;
      at: number;
    }
  | {
      k: 'input.batch';
      sid: string;
      tgt: string;
      vid: string;
      counts: { mouse: number; key: number; text: number; touch: number };
      windowMs: number;
      at: number;
    }
  | {
      k: 'navigate';
      sid: string;
      tgt: string;
      vid: string;
      url: string;
      allowed: boolean;
      policy?: string;
      at: number;
    }
  | { k: 'clipboard'; sid: string; vid: string; dir: 'read' | 'write'; bytes: number; at: number }
  | {
      k: 'file';
      sid: string;
      vid: string;
      dir: 'upload' | 'download';
      name: string;
      bytes: number;
      sha256: string;
      at: number;
    }
  | {
      k: 'profile';
      tid: string;
      key: string;
      op: 'create' | 'lease' | 'release' | 'snapshot' | 'restore' | 'quarantine' | 'delete';
      by: string;
      at: number;
    }
  | {
      k: 'quota';
      tid: string;
      aid?: string;
      limit: string;
      action: 'queued' | 'rejected' | 'evicted';
      at: number;
    };

/** Where audit events go. Must never throw, must never block; batched and asynchronous, never on the hot path. Default: a file backed NDJSON sink. */
export interface AuditSink {
  emit(event: AuditSinkEvent): void;
  flush(): Promise<void>;
}

// ── MetricsSink ─────────────────────────────────────────────────────────

/** A metric name, kept fixed so dashboards stay portable across deployments. */
export type MetricName = string;

/** Metric label set. */
export type Labels = Readonly<Record<string, string | number | boolean>>;

/** One tracing span, only present when `startSpan` is implemented. */
export interface Span {
  setAttribute(k: string, v: string | number | boolean): void;
  recordError(e: unknown): void;
  end(): void;
}

/** Where metrics and, optionally, traces go. Default is a no op sink, one function call's cost. */
export interface MetricsSink {
  counter(name: MetricName, value: number, labels?: Labels): void;
  gauge(name: MetricName, value: number, labels?: Labels): void;
  histogram(name: MetricName, value: number, labels?: Labels): void;
  /** Optional; absent means tracing is a no op. */
  startSpan?(name: string, attrs?: Labels): Span;
}

// ── NavigationPolicy and QuotaProvider ──────────────────────────────────

/** One navigation to check before it is allowed to proceed. */
export interface NavigationCheckRequest {
  url: string;
  sessionId: string;
  targetId: string;
  principal: {
    tenantId: string;
    appId: string;
    subject: string;
    capabilities: readonly string[];
  };
  kind: 'user' | 'automation' | 'redirect';
}

/** Vetoes or allows a navigation, independent of capability checks. Default: allow, deny only private and loopback ranges. */
export interface NavigationPolicy {
  check(
    req: NavigationCheckRequest,
  ): Promise<{ allow: true } | { allow: false; reason: string; code?: string }>;
}

/** Per tenant, and optionally per app, quota ceilings, resolved live rather than baked into config at startup. */
export interface QuotaProvider {
  limits(
    tenantId: string,
    appId: string | null,
  ): Promise<{
    maxInstances: number;
    maxInstancesPerApp: number;
    maxInstancesPerUser: number;
    maxViewers: number;
    maxProfiles: number;
    maxProfileBytes: number;
    maxSessionMinutesPerDay: number;
    maxAcquiresPerMinute: number;
    maxFrameBytesPerMinute: number;
  }>;
  /** Optional, called after every acquire and release for metering. */
  report?(usage: QuotaUsageDelta): void;
}

/** One usage delta `QuotaProvider.report` receives. */
export interface QuotaUsageDelta {
  tenantId: string;
  appId: string | null;
  metric: string;
  delta: number;
  at: number;
}

// ── NodeTransport ────────────────────────────────────────────────────────

/**
 * The periodic heartbeat a node sends the router. `LocalNodeTransport`
 * (router, embedded mode) and a future networked transport both construct
 * this exact shape, so the boundary between "in process call" and "over
 * the wire" is real even where no socket currently crosses it.
 */
export interface NodeHeartbeatPayload {
  nodeId: NodeId;
  epoch: number;
  load: NodeLoad;
  hostsProfiles: readonly string[];
  at: number;
}

/** The router's answer to one heartbeat. */
export interface NodeHeartbeatAck {
  nodeId: NodeId;
  accepted: boolean;
  serverTime: number;
  drain: { deadlineAt: number; mode: 'graceful' | 'force' } | null;
}

/**
 * The launch payload the router sends a node
 * (`nodes.launch(nodeId, {...})`), distinct from `runtime.js`'s
 * `LaunchRequest` (what a `BrowserRuntime` receives).
 * `LocalNode` (router) is the translation point between the
 * two, calling `ProfileService` and `ProfileFs` to turn this into a real
 * `LaunchRequest`.
 */
export interface NodeLaunchRequest {
  instanceId: string;
  sessionId: string | null;
  spec: BrowserSpec;
  profile: {
    storedKey: string;
    mode: 'ephemeral' | 'persistent' | 'template';
    fence: number;
    source: 'empty' | 'template' | 'restore' | 'import';
    templateId: string | null;
    seed: ResolvedProfileSpec['seed'];
  };
  limits: Readonly<Record<string, number>>;
  leaseMs: number;
  /** The instance's placement fence, echoed back so a stale node can be told to self terminate. */
  term: number;
}

// ── Node action dispatch ────────────────────────────────────────────────

/**
 * The one small, explicit vocabulary of actions `NodeTransport.dispatch`
 * accepts, kept small and explicit on purpose: exactly what a driving surface can already do
 * against a LOCAL instance today (navigate, screenshot, click, type,
 * target list/create/close, one scoped CDP passthrough), never a general
 * "run arbitrary code on another node" RPC. A caller can only ask for one
 * of these eight named things; `cdp` still only reaches a `method`/`params`
 * pair against the one `targetId` it names, mirroring the scoping
 * `server/src/session/managed-session.ts`'s `sendCdp` already enforces
 * locally, not an unscoped domain enable or a second target.
 */
export type NodeActionRequest =
  | {
      kind: 'navigate';
      instanceId: string;
      targetId: string;
      op: 'goto' | 'back' | 'forward' | 'reload' | 'stop';
      url?: string;
    }
  | {
      kind: 'screenshot';
      instanceId: string;
      targetId: string;
      format?: 'png' | 'jpeg';
      quality?: number;
      fullPage?: boolean;
    }
  | {
      kind: 'click';
      instanceId: string;
      targetId: string;
      x: number;
      y: number;
      button?: 'left' | 'middle' | 'right';
    }
  | { kind: 'type'; instanceId: string; targetId: string; text: string }
  | { kind: 'target.list'; instanceId: string }
  | { kind: 'target.create'; instanceId: string; url?: string }
  | { kind: 'target.close'; instanceId: string; targetId: string }
  | {
      kind: 'cdp';
      instanceId: string;
      targetId: string;
      method: string;
      params: Readonly<Record<string, unknown>>;
    };

/**
 * One target row a `'target.list'`/`'target.create'` action reports.
 * Deliberately narrower than `TargetSummary` (`wire/messages/targets.ts`):
 * only what a cross node caller needs to keep driving, not the full wire
 * shape a viewer's own target list carries.
 */
export interface NodeActionTarget {
  targetId: string;
  url: string;
  title: string;
}

/** `NodeTransport.dispatch`'s result, one variant per `NodeActionRequest.kind`, discriminated the same way the request is. */
export type NodeActionResult =
  | { kind: 'navigate' }
  | { kind: 'screenshot'; format: 'png' | 'jpeg'; data: string; width: number; height: number }
  | { kind: 'click' }
  | { kind: 'type' }
  | { kind: 'target.list'; targets: readonly NodeActionTarget[] }
  | { kind: 'target.create'; target: NodeActionTarget }
  | { kind: 'target.close' }
  | { kind: 'cdp'; result: unknown };

/**
 * The transport between the router and a node agent. `LocalNodeTransport`
 * implements this by direct in process call, for a `nodeId` this process
 * itself owns; `WebSocketNodeTransport` (router, `node/WebSocketNodeTransport.ts`)
 * implements the real multi node case, delegating to a `LocalNodeTransport`
 * for its own node and forwarding over an authenticated WebSocket to any
 * other. See that file's own top comment for exactly what the peer link's
 * authentication protects and what it does not.
 */
export interface NodeTransport {
  heartbeat(nodeId: NodeId, payload: NodeHeartbeatPayload): Promise<NodeHeartbeatAck>;
  launch(nodeId: NodeId, req: NodeLaunchRequest): Promise<LaunchedBrowser>;
  /**
   * `gracePeriodMs`, when supplied, overrides whatever static grace period
   * the target node's own runtime config would otherwise use
   * (`runtime-host`'s `DEFAULT_SUPERVISOR_CONFIG.gracePeriodMs`).
   * Added so a per call caller (`BrowserRouter.release()`'s own
   * `ReleaseOptions.gracefulMs`) can genuinely control how long a
   * `'graceful'` terminate is given before the caller itself escalates to
   * `'force'`, rather than that option being accepted and silently
   * discarded. Omitted, a node falls back to its own
   * static default exactly as it always has; this parameter narrows, it
   * never widens, what a node is willing to wait.
   */
  terminate(
    nodeId: NodeId,
    instanceId: string,
    mode: TerminateMode,
    gracePeriodMs?: number,
  ): Promise<TerminateResult>;
  list(nodeId: NodeId): Promise<readonly RuntimeInventoryEntry[]>;
  /**
   * Dispatches one action against an instance living on `nodeId`. Without
   * it, a REST/CLI/CDP call for an instance placed on another node returned
   * 409 "not live" even though the instance was alive and well, because
   * nothing could carry the action past this process's own
   * `SessionRegistry`. `LocalNodeTransport` (router) executes a local
   * `nodeId` directly, in process, no serialisation; a future
   * `WebSocketNodeTransport` would encode `req` and forward it to the
   * owning node's agent for a `nodeId` that is not its own.
   */
  dispatch(nodeId: NodeId, req: NodeActionRequest): Promise<NodeActionResult>;
}

// Re-exported so a caller importing only from `extension-points.js` has the
// runtime types its `NodeTransport` methods reference.
export type { LaunchRequest };
