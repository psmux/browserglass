/**
 * Domain entities. This module carries the shapes only; whether a field is
 * persisted, held in memory, or derived is decided by the code that owns
 * the entity.
 */

import type {
  AppId,
  Capability,
  InstanceId,
  NodeId,
  PayloadCodecValue,
  PolicyId,
  ProfileId,
  ProfileLeaseId,
  RecoveryRung,
  ServerStreamId,
  SessionId,
  SnapshotId,
  TargetId,
  TenantId,
  ViewerId,
} from '../wire/index.js';
import type { Iso } from './common.js';

/**
 * Branded id types, owned by the wire layer (`ids.ts`) and
 * re-exported here so every domain module can import them from
 * `./entities.js` alongside the entities that use them, without a second
 * import from `../wire`.
 */
export type {
  AppId,
  InstanceId,
  NodeId,
  ProfileId,
  ProfileLeaseId,
  RecoveryRung,
  SessionId,
  SnapshotId,
  TargetId,
  TenantId,
  ViewerId,
};

/**
 * Local alias for the wire layer's `PolicyId` (prefix `pol`). The `pol`
 * prefix belongs to the Pool entity, not a policy; kept as an alias to the
 * wire layer's type, rather than a second competing declaration, so both
 * names resolve to the same branded type. The naming mismatch is worth
 * reconciling in `wire/ids.ts` directly at some point.
 */
export type PoolId = PolicyId;

/**
 * Local alias for the wire layer's `ServerStreamId` (prefix `strm`), named
 * `StreamId` throughout the domain entities. Kept as an alias for the same
 * reason as `PoolId` above.
 */
export type StreamId = ServerStreamId;

// ── Tenant ──────────────────────────────────────────────────────────────

/** A billing and isolation boundary. Owns apps, pools, and profiles. */
export interface Tenant {
  id: TenantId;
  name: string;
  state: 'active' | 'suspended' | 'deleting';
  createdAt: number;
  updatedAt: number;
  /** Signing keys verifying app issued tokens. Rotatable. */
  keys: readonly TenantKey[];
  quotas: QuotaLimits;
  defaults: TenantDefaults;
  labels: Readonly<Record<string, string>>;
}

/** One signing key belonging to a tenant, echoed in a JWT header as `kid`. */
export interface TenantKey {
  kid: string;
  alg: 'EdDSA' | 'ES256' | 'HS256';
  /** PEM or JWK. Empty for HS256. */
  publicKey: string;
  state: 'active' | 'retiring' | 'revoked';
  notBefore: number;
  notAfter: number | null;
}

/** Per tenant defaults layered under a pool template during settings resolution. */
export interface TenantDefaults {
  browserSpec: Partial<BrowserSpec>;
  profileTtlMs: number;
  sessionIdleMs: number;
  sessionMaxDurationMs: number;
  controlLeaseMs: number;
  controlForceClaim: 'allowed' | 'requiresAdmin' | 'never';
  maxViewersPerStream: number;
  maxStreamsPerSession: number;
  maxStreamsPerViewer: number;
}

// ── App ─────────────────────────────────────────────────────────────────

/** An application registered under a tenant, the unit that signs tokens. */
export interface App {
  id: AppId;
  tenantId: TenantId;
  name: string;
  state: 'active' | 'disabled';
  createdAt: number;
  /** Token capability ceiling, enforced at the gateway. */
  grantableCapabilities: readonly Capability[];
  /** Narrows the tenant's quotas only, never widens them. */
  quotas: Partial<QuotaLimits>;
  defaultPoolId: PoolId | null;
  metadata: Readonly<Record<string, string>>;
}

// ── Node ────────────────────────────────────────────────────────────────

/** A machine (or container host) capable of running one or more runtimes. */
export interface Node {
  id: NodeId;
  /** Null means shared across tenants. */
  tenantId: TenantId | null;
  name: string;
  state: NodeState;
  labels: Readonly<Record<string, string>>;
  dataPlaneUrl: string;
  runtimes: readonly ('host' | 'docker' | 'k8s' | 'remote')[];
  capacity: NodeCapacity;
  load: NodeLoad;
  agentVersion: string;
  protocolVersions: readonly number[];
  registeredAt: number;
  lastHeartbeatAt: number;
  /** Router issued, bumped on re-registration, fences a resurrected node. */
  epoch: number;
  leaseExpiresAt: number;
  /** Profile keys materialised on this node's disk. */
  hostsProfiles: readonly string[];
  drain: { requestedAt: number; deadlineAt: number; mode: 'graceful' | 'force' } | null;
  lastError: { code: string; message: string; at: number } | null;
}

/** The lifecycle states a `Node` can be in. */
export type NodeState =
  | 'registering'
  | 'ready'
  | 'degraded'
  | 'draining'
  | 'drained'
  | 'lost'
  | 'quarantined';

/** Static capacity a node advertises at registration. */
export interface NodeCapacity {
  maxInstances: number;
  maxMemoryMb: number;
  cpuCores: number;
  profileDiskMb: number;
  /** Hard limit on concurrent launches, since a Chrome launch is CPU spiky. */
  maxConcurrentLaunches: number;
}

/** Live load sample. In memory only, never persisted. */
export interface NodeLoad {
  liveInstances: number;
  warmInstances: number;
  launchingInstances: number;
  /** 0 to 100, 10 second EWMA. */
  cpuPercent: number;
  memoryUsedMb: number;
  profileDiskUsedMb: number;
  loadAvg1: number;
  sampledAt: number;
}

// ── Pool ────────────────────────────────────────────────────────────────

/** A named capacity grouping, tenant scoped, shared across the tenant's apps. */
export interface Pool {
  id: PoolId;
  tenantId: TenantId;
  /** Unique within the tenant. */
  name: string;
  state: 'active' | 'paused' | 'deleting';
  /** Full spec every instance in the pool starts from. */
  template: BrowserSpec;
  profileTemplate: ProfileSpec;
  warm: WarmPolicy;
  placement: { policy: string; params: Readonly<Record<string, unknown>> };
  limits: PoolLimits;
  /** Node label selector. */
  nodeSelector: Readonly<Record<string, string>>;
  createdAt: number;
  updatedAt: number;
}

/** Warm instance pre launch policy for a pool. */
export interface WarmPolicy {
  /** Keep at least this many idle instances ready. */
  min: number;
  /** Never exceed this many idle instances. */
  max: number;
  /** A warm instance is killed if unused this long. */
  maxIdleMs: number;
  /** Only pre warm above this acquire rate. */
  minAcquiresPerMinute: number;
  /**
   * Warm instances hold ephemeral profiles only by default; adopted for a
   * persistent profile acquire only when that profile is already on the
   * same node.
   */
  allowPersistentAdoption: boolean;
}

/** Per pool limits on instance and session shape. */
export interface PoolLimits {
  maxInstances: number;
  maxInstancesPerUser: number;
  maxViewersPerStream: number;
  maxStreamsPerSession: number;
  sessionIdleMs: number;
  sessionMaxDurationMs: number;
  onFull: 'queue' | 'reject' | 'evictIdle';
  queueMaxDepth: number;
  queueMaxWaitMs: number;
}

// ── ProfileSpec (request shape, not a stored entity) ───────────────────

/** The three request shapes an acquire may name a profile with. */
export type ProfileSpec = EphemeralProfileSpec | PersistentProfileSpec | TemplateProfileSpec;

/** A throwaway profile, destroyed on release unless overridden. */
export interface EphemeralProfileSpec {
  mode: 'ephemeral';
  /** Cookies, local storage, and origins injected at launch. */
  seed?: StorageStateSeed;
  /** Always true for ephemeral. */
  readonly destroyOnRelease?: true;
}

/** A named, reusable profile pinned to a caller supplied key. */
export interface PersistentProfileSpec {
  mode: 'persistent';
  /** Stable name scoped to the tenant and app. Pins placement. */
  key: string;
  /** Default true. */
  createIfMissing?: boolean;
  /** Seed template if creating. */
  templateId?: string;
  /** Delete if unused this long. Null means never. */
  ttlMs?: number | null;
  snapshotOnRelease?: boolean;
}

/** A profile materialised from a frozen template directory. */
export interface TemplateProfileSpec {
  mode: 'template';
  templateId: string;
  /** Template derived profile is ephemeral unless promoted to this key. */
  promoteToKey?: string;
}

/** Storage state injected into a fresh profile at launch. */
export interface StorageStateSeed {
  cookies?: readonly SeedCookie[];
  origins?: readonly { origin: string; localStorage: readonly { name: string; value: string }[] }[];
}

/** One cookie injected as part of a `StorageStateSeed`. */
export interface SeedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number | null;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None' | null;
}

/** The resolved form of a `ProfileSpec`, what the router and profile service actually pass around. */
export interface ResolvedProfileSpec {
  mode: 'ephemeral' | 'persistent' | 'template';
  tenantId: TenantId;
  /** Synthesised as `eph:<instanceId>` for ephemeral, never null. */
  key: string;
  templateId: string | null;
  seed: StorageStateSeed | null;
  destroyOnRelease: boolean;
  snapshotOnRelease: boolean;
  ttlMs: number | null;
  /** Filled once the profile row exists. */
  profileId: ProfileId | null;
}

// ── BrowserSpec ─────────────────────────────────────────────────────────

/**
 * Headless mode. `'off'` is a real headful browser on a real display,
 * `'new'` is `--headless=new`, `'xvfb-headful'` is a real headful browser
 * against a virtual X display. Legacy boolean mapping: `false` maps to
 * `'off'`, `true` maps to `'new'`.
 */
export type HeadlessMode = 'off' | 'new' | 'xvfb-headful';

/** The browser binary channel a `BrowserSpec` may select. */
export type BrowserChannel =
  | 'chrome'
  | 'chrome-beta'
  | 'chromium'
  | 'chromium-headless-shell'
  | 'msedge'
  | 'brave'
  | 'bundled';

/**
 * Hard caps on `BrowserSpec.initScripts`, enforced by `resolveBrowserSpec`'s
 * `validateSpec` (`settings.ts`). Not part of `OverridePolicyBounds`: those
 * bounds describe how far a lower priority layer may be narrowed by a
 * higher priority one, while this is a flat structural limit on trusted
 * operator input that no layer, including the pool template itself, may
 * exceed.
 */
export const MAX_INIT_SCRIPTS = 20;

/**
 * Per script cap on `BrowserSpec.initScripts[number].source`, in UTF-16
 * code units (`string.length`), not bytes: this package's `tsconfig`
 * targets `lib: ["ES2023"]` only (see `AbortSignalLike`'s doc comment in
 * `runtime.ts`), which pulls in neither DOM nor Node ambient types, so
 * there is no `Buffer` here to measure a real byte size with. Code unit
 * count is a close enough proxy for a sanity bound, not a precise quota.
 * 256 Ki code units is generous for a real script (a minified submit gate
 * is a few hundred bytes) while still keeping one pathological entry from
 * dominating a spec's digest computation or bloating a stored
 * `browser_specs` row.
 */
export const MAX_INIT_SCRIPT_SOURCE_LENGTH = 262144;

/** The fully merged launch configuration for one browser. */
export interface BrowserSpec {
  engine: 'chromium';
  channel: BrowserChannel;
  executablePath: string | null;
  headless: HeadlessMode;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  /** Headful only. */
  window: { width: number; height: number; x: number | null; y: number | null } | null;
  /**
   * Whether each streamed target gets its own real OS window.
   *
   * `'tab'` is the historical behaviour: every target is a tab of one
   * Chrome window. Chromium composites only a window's visible tab, so
   * exactly one target per Instance can ever produce continuous screencast
   * frames and every other one emits a hard zero.
   *
   * `'window'` gives each target its own OS window, which was measured
   * at 4/4 streams live at roughly 82 to 90 fps, unaffected by which window holds OS
   * focus. This is what makes several panes drivable at once.
   */
  isolation: 'tab' | 'window';
  userAgent: string | null;
  /** Derived from `userAgent` when null. */
  clientHints: ClientHintsSpec | null;
  locale: string | null;
  timezoneId: string | null;
  geolocation: { latitude: number; longitude: number; accuracy: number } | null;
  permissions: readonly string[];
  colorScheme: 'light' | 'dark' | 'no-preference';
  reducedMotion: 'reduce' | 'no-preference';
  proxy: ProxySpec | null;
  extraArgs: readonly string[];
  ignoreDefaultArgs: readonly string[];
  env: Readonly<Record<string, string>>;
  extensions: readonly ExtensionRef[];
  stealth: 'off' | 'basic' | 'full';
  /**
   * JavaScript this Instance's browser evaluates before any page script, on
   * every document the browser navigates to. The CDP primitive underneath
   * is `Page.addScriptToEvaluateOnNewDocument`, installed by
   * `packages/core/src/cdp/target-registry.ts`, the only layer that ever
   * holds a live CDP session to call it on; there is no Chrome launch flag
   * for this the way `--user-agent` covers `userAgent`
   * (`runtime-host/src/flags.ts`), so a per instance field here is the only
   * way to declare it and have it survive a warm pool reuse or a gateway
   * restart, the same round trip `clientHints` gets.
   *
   * The motivating case: an automation filling in a real application form
   * needs the form's own submit handler neutralised (operators call this
   * kind of script `BLOCK_SUBMIT_JS`) before the page's own scripts ever
   * attach it, so a fill can never accidentally submit the form to a real
   * employer. A script injected after `load`, or run through
   * `page.evaluate` after navigation, is exactly too late: the handler has
   * already had its chance to attach and fire by then.
   * `Page.addScriptToEvaluateOnNewDocument` is the only CDP primitive that
   * runs before the target document's own script does, which is the whole
   * reason this field exists instead of a post navigation evaluate call.
   *
   * Operator input, not page input: this array comes from whoever assembled
   * the `BrowserSpec` (a pool template, a tenant default, or an app's own
   * launch request), never from a page the browser navigates to, so it is
   * trusted the same way `extraArgs` and `extensions` are. It still runs
   * with the full privilege of whatever page it lands in, so
   * `resolveBrowserSpec` (`settings.ts`) keeps it off both
   * `FREELY_OVERRIDABLE` and `NARROWING_ONLY`: a per request override can
   * never set or widen it, matching `extraArgs`/`env`/`extensions`. It is
   * also bounded (`MAX_INIT_SCRIPTS`, `MAX_INIT_SCRIPT_SOURCE_LENGTH`,
   * enforced by `validateSpec`): a spec is trusted content, not an
   * attacker's, but an unbounded array of unbounded strings would still let
   * one spec make every future navigation on its Instance slower, or bloat
   * the content addressed `browser_specs` row without limit.
   *
   * Order is preserved and significant: scripts run in array order on each
   * new document. Mirrors the shape `StealthProfile.initScripts` below
   * already declares, the other init script surface this package defines;
   * that one has no implementation anywhere in this codebase (see its own
   * doc comment), this field is the one that does.
   */
  initScripts: readonly { name: string; source: string }[];
  ignoreHttpsErrors: boolean;
  downloadDir: string | null;
  uploadDir: string | null;
  acceptDownloads: boolean;
  maxDownloadBytes: number | null;
  resources: {
    cpus: number | null;
    memoryMb: number | null;
    shmMb: number | null;
    pidsLimit: number | null;
  };
  /** Null means `about:blank`. */
  initialUrl: string | null;
  launchTimeoutMs: number;
  /**
   * Names the `RemoteEndpoint` (`runtime.ts`'s `RemoteEndpoint`, by its
   * `name`) a launch destined for a `'remote'` runtime kind must attach
   * to. `router`'s `LocalNode.launch` reads this field to populate
   * `LaunchRequest.labels[REMOTE_ENDPOINT_LABEL_KEY]`, the one channel
   * `runtime-remote`'s `RemoteRuntime.launch` accepts for choosing which
   * of its operator-registered endpoints one call targets; every other
   * runtime kind ignores it.
   *
   * Optional, unlike every other field on this interface, and
   * deliberately so: `BrowserSpec` is meant to be "always concretely
   * populated" (see `initScripts`'s own doc comment on this same
   * interface), but a required field here would have forced every
   * existing full `BrowserSpec` literal in the monorepo, including ones
   * this change has no business touching, to enumerate it just to keep
   * compiling. Absent or null both mean "no remote endpoint requested",
   * which is what every spec meant before this field existed.
   *
   * Set on the pool template (or a tenant/app default), never on a per
   * request override: `settings.ts`'s `NEVER_OVERRIDABLE` lists it for
   * the same reason `proxy`/`extraArgs`/`extensions` are there. Choosing
   * which pre-existing, someone-else-owned browser a request lands on is
   * an operator placement decision, not a caller's to make.
   */
  remoteEndpointName?: string | null;
}

/**
 * The `LaunchRequest.labels` key naming which registered `RemoteEndpoint`
 * (by its `name`) a launch destined for a `'remote'` runtime kind targets.
 * Defined here, in `protocol`, rather than in `runtime-remote` itself
 * (which owns the behaviour that reads it): `router`'s `LocalNode` is the
 * only party trusted to set it (an app must never supply one directly),
 * and `protocol` is the one layer both `router` and `runtime-remote`
 * already depend on, so referencing the same literal from both sides
 * needs no new edge in `scripts/check-deps.mjs`'s allowed dependency
 * table for a single string constant.
 */
export const REMOTE_ENDPOINT_LABEL_KEY = 'browserglass.remoteEndpointName';

/** Upstream HTTP or SOCKS proxy configuration, pool level plus per acquire credentials. */
export interface ProxySpec {
  /** `http://host:port` or `socks5://host:port`. Pool level only, never per request. */
  server: string;
  bypass: readonly string[];
  /** Supplied per acquire, never on a pool template. */
  username: string | null;
  /** Never returned by any read API. Stored encrypted. */
  password: string | null;
}

/** One browser extension a `BrowserSpec` loads. Operator registered only. */
export interface ExtensionRef {
  kind: 'path' | 'crx' | 'storeId';
  value: string;
  trusted: boolean;
}

/** Client hints reported by Chrome for a resolved `BrowserSpec`. */
export interface ClientHintsSpec {
  brands: readonly { brand: string; version: string }[];
  platform: string | null;
  platformVersion: string | null;
  architecture: string | null;
  model: string | null;
  mobile: boolean | null;
  fullVersion: string | null;
}

// ── Profile ─────────────────────────────────────────────────────────────

/** A durable browser profile directory and its lifecycle state. */
export interface Profile {
  id: ProfileId;
  tenantId: TenantId;
  /** Profile keys are scoped per app, never per tenant alone. */
  appId: AppId;
  /** Unique per (tenant, app). Synthesised `eph:<instanceId>` for ephemeral. */
  key: string;
  mode: 'ephemeral' | 'persistent' | 'template';
  state: ProfileState;
  /** Node whose local disk holds the authoritative copy. */
  homeNodeId: NodeId | null;
  replicaNodeIds: readonly NodeId[];
  /** Absolute path on the home node. Meaningless elsewhere. */
  path: string | null;
  lease: ProfileLease | null;
  sizeBytes: number;
  fileCount: number;
  measuredAt: number;
  templateId: string | null;
  latestSnapshot: SnapshotRef | null;
  createdAt: number;
  lastUsedAt: number;
  expiresAt: number | null;
  quarantine: { reason: string; at: number; byNodeId: NodeId | null } | null;
  encryption: { atRest: boolean; keyId: string | null };
  labels: Readonly<Record<string, string>>;
}

/**
 * The exact eight canonical `Profile` states. `ready`/`free` collapsed to
 * `free`. `archiving`/`archived` are not states, archival is snapshot then
 * delete. `corrupt` folds into `quarantined`.
 */
export type ProfileState =
  | 'creating'
  | 'free'
  | 'leased'
  | 'snapshotting'
  | 'migrating'
  | 'quarantined'
  | 'deleting'
  | 'deleted';

/**
 * A profile lease, combining the in memory shape with the DDL
 * columns on `profile_leases`, since `Store` returns this shape directly
 * and needs the row-only fields (`id`, `holderPid`, `releasedAt`,
 * `releaseReason`) the nested in memory view omits.
 */
export interface ProfileLease {
  /** Branded lease identifier, prefix `plse`. */
  id: ProfileLeaseId;
  profileId: ProfileId;
  tenantId: TenantId;
  holderInstanceId: InstanceId | null;
  holderNodeId: NodeId;
  holderPid: number | null;
  /** Monotonic, plus one per grant, never decreases. */
  fence: number;
  grantedAt: number;
  heartbeatAt: number;
  /** Absolute, router clock. The node renews before this. */
  expiresAt: number;
  renewIntervalMs: number;
  releasedAt: number | null;
  releaseReason: string | null;
}

/** A point in time archive of a profile directory. */
export interface SnapshotRef {
  id: SnapshotId;
  storeUri: string;
  bytes: number;
  sha256: string;
  createdAt: number;
  /** Restoring across a major version may trigger migration. */
  chromeVersion: string;
}

/**
 * One `ReleaseOptions.profile` and `AcquireRequest.releasePolicy` action.
 * One enum everywhere; `keepProfile` and `destroyProfile` spellings are
 * dead.
 */
export type ProfileAction = 'keep' | 'destroy' | 'snapshotThenKeep' | 'snapshotThenDestroy';

// ── Instance ────────────────────────────────────────────────────────────

/** A running (or in flight) Chrome, the durable unit the router places. */
export interface Instance {
  id: InstanceId;
  tenantId: TenantId;
  appId: AppId;
  poolId: PoolId | null;
  /** End user acquired for, drives per user quotas and sticky lookup. */
  subject: string | null;
  state: InstanceLifecycleState;
  stateReason: string | null;
  stateChangedAt: number;
  nodeId: NodeId | null;
  /** Bumped every placement, fences a stale node. */
  fence: number;
  /** Fully merged spec, not the raw request. */
  spec: BrowserSpec;
  profileSpec: ResolvedProfileSpec;
  profileId: ProfileId | null;
  sessionId: SessionId | null;
  /** Populated by the node once Chrome answers. Never exposed to clients. */
  runtime: InstanceRuntimeInfo | null;
  acquiredAt: number;
  readyAt: number | null;
  releasedAt: number | null;
  /** Hard deadline. The reaper releases at this time. */
  expiresAt: number;
  lastActivityAt: number;
  metadata: Readonly<Record<string, string>>;
  /** Most recent first, capped at 20. */
  incidents: readonly Incident[];
  /** `viewer-bound` releases after the last viewer leaves plus a linger; `explicit` lives until released. */
  lifetime: 'viewer-bound' | 'explicit';
  /**
   * `instances.first_viewer_at` (`0001_initial.sql`). Despite the column
   * name, this is NOT stamped when a `Viewer` row is created
   * (`Store.createViewer` never touches it); the only writer in this
   * build is `Store.claimWarmInstance`'s `COALESCE(first_viewer_at, ?)`,
   * the atomic warm-to-live claim `reuse.ts`'s warm adoption path calls.
   * `null` for an instance that was never a claimed warm instance (the
   * ordinary launch-on-demand path), and forever after that for one that
   * was, since `COALESCE` never overwrites an already-set value.
   */
  firstViewerAt: number | null;
  /**
   * `instances.release_reason` (`0001_initial.sql`). Written exactly
   * once, by `BrowserRouter.release()`'s terminal `'draining' -> 'released'`
   * transition, from the same `opts.reason ?? 'requested'` step 9 already
   * used for the `instance.released` audit event
   * (`'idle_timeout'|'max_duration'|'ttl_expired'|'requested'|'evicted_for_capacity'|'terminate_failed'|...`,
   * whatever string a caller or the reaper passed as `ReleaseOptions.reason`).
   * `null` until released. Deliberately a SEPARATE field from
   * `stateReason` even though the two agree at the moment release
   * completes: `stateReason` is stamped fresh on every transition (draining,
   * then again if the release fails and it bounces back to `live` with
   * `stateReason: 'terminate_failed'`), so it is not safe to read after
   * the fact as "the reason THIS instance was released" without knowing
   * the full transition history. `releaseReason` is written only at the
   * transition INTO `'released'` and never touched again, so it stays the
   * durable answer to "why did this browser close" a history read
   * (`GET /v1/instances/:instanceId/history`) needs for an instance that
   * may have gone through several failed release attempts first.
   */
  releaseReason: string | null;
  /** `instances.restart_count` (`0001_initial.sql`), incremented only by `Store.bumpInstanceEpoch`'s own dedicated UPDATE. Zero until the first restart. */
  restartCount: number;
  /**
   * `instances.peak_rss_mib` (`0001_initial.sql`). No code path in this
   * build writes it: `Store.createInstance`'s INSERT always supplies
   * `NULL` and nothing ever `UPDATE`s it afterward, so this reads `null`
   * for every instance today, not a real "never sampled yet" absence. Kept
   * on the domain entity anyway, rather than left off entirely: the
   * column exists for a future memory sampling loop to populate, and
   * exposing the field now means that loop needs no companion
   * `rowToInstance` change when it lands, only a writer.
   */
  peakRssMib: number | null;
  /**
   * `instances.os_pid` (`0001_initial.sql`). Same status as `peakRssMib`:
   * the column exists, nothing writes it, so this reads `null` for every
   * instance today. Not to be confused with `Instance.runtime.pid`
   * (`InstanceRuntimeInfo`), which IS the real, live process id while an
   * instance is running; that field is process memory only and never
   * persisted, which is the reason this column exists at all (a durable
   * pid a history read could answer with after the process, and the
   * in-memory `runtime` record, are both long gone) and also the reason
   * nothing has wired a writer for it yet.
   */
  osPid: number | null;
}

/**
 * The ten `Instance` lifecycle states. Named `InstanceLifecycleState`
 * rather than `InstanceState` because the wire layer already exports a
 * distinct, coarser seven value `InstanceState` for the client visible
 * message shape (`messages/instance.ts`); the two describe the same
 * lifecycle at different resolutions and are not interchangeable.
 */
export type InstanceLifecycleState =
  | 'requested'
  | 'placing'
  | 'launching'
  | 'ready'
  | 'degraded'
  | 'recovering'
  | 'draining'
  | 'releasing'
  | 'released'
  | 'failed';

/** Runtime detail populated once the node's browser answers CDP. Never persisted, memory only. */
export interface InstanceRuntimeInfo {
  kind: 'host' | 'docker' | 'k8s' | 'remote';
  pid: number | null;
  containerId: string | null;
  podName: string | null;
  /** Secret. Leaking this is full browser control. */
  cdpWsUrl: string;
  cdpPort: number | null;
  chromeVersion: string;
  profilePath: string;
  startedAt: number;
  /**
   * The `StealthProfile` that actually ran for this launch, as metadata
   * only, mirroring `LaunchedBrowser.stealthProfile`
   * (`@browserglass/protocol`'s `runtime.ts`). `null` when
   * `spec.stealth` was `'off'`, which is the default.
   *
   * Carried here because it is the ONLY way the gateway can find out
   * which profile a browser was launched under. A `StealthProfile`
   * carries live functions and cannot cross a process boundary; the
   * gateway needs the name and version so it can look up its own copy of
   * the same profile and apply that profile's `initScripts`/
   * `onTargetAttached` to the CDP session it opens
   * (`packages/server/src/session/factory.ts`'s `resolveStealthHooks`).
   * Before this field existed, `LaunchedBrowser.stealthProfile` was
   * recorded by the runtime and then dropped at the router boundary, so
   * the gateway had nothing to match on and a profile's per target work
   * silently never ran.
   */
  stealthProfile: { name: string; level: 'basic' | 'full'; version: string } | null;
}

/** One non fatal problem recorded against an instance, capped at 20 entries. */
export interface Incident {
  at: number;
  /** For example `TARGET_CRASHED`, `RECOVERY_R2`, `OOM`. */
  code: string;
  detail: string;
  /**
   * The full recovery rung union, widened from the original
   * `'R0'|'R1'|'R2'|'R3'|null` to match the wire type `RecoveryRung`. This
   * build automatically drives R0 to R3 and manually drives R4 only.
   */
  rung: RecoveryRung | null;
}

// ── Target ──────────────────────────────────────────────────────────────

/** A CDP target (tab, iframe, worker) mirrored in memory. Never persisted. */
export interface Target {
  /** Ours, stable across CDP session invalidation. */
  id: TargetId;
  /** Chrome's 32 character hex id. Never leaves the node, never on the wire. */
  cdpTargetId: string;
  instanceId: InstanceId;
  type: TargetType;
  url: string;
  title: string;
  faviconUrl: string | null;
  /** Chrome's opener relationship. */
  openerId: TargetId | null;
  browserContextId: string | null;
  /** Whether we hold a CDP session for it. */
  attached: boolean;
  /** Chrome's session id for our attachment. Changes on invalidation, the id does not. */
  cdpSessionId: string | null;
  /** Whether it can produce frames at all. */
  streamable: boolean;
  streamId: StreamId | null;
  viewport: { width: number; height: number; scale: number } | null;
  scroll: { x: number; y: number } | null;
  loading: boolean;
  crashed: boolean;
  discardedAt: number | null;
  createdAt: number;
  lastSeenAt: number;
}

/** The kinds of CDP target the registry tracks. */
export type TargetType =
  | 'page'
  | 'iframe'
  | 'worker'
  | 'service_worker'
  | 'shared_worker'
  | 'browser'
  | 'other';

// ── Session ─────────────────────────────────────────────────────────────

/** The live socket multiplexer for one instance. In memory only except `SessionRow`. */
export interface Session {
  id: SessionId;
  instanceId: InstanceId;
  tenantId: TenantId;
  nodeId: NodeId;
  state: SessionState;
  stateReason: string | null;
  streams: Map<StreamId, Stream>;
  /** Reverse index for the binary header. */
  wireIds: Map<number, StreamId>;
  viewers: Map<ViewerId, Viewer>;
  leases: Map<TargetId, ControlLease>;
  startedAt: number;
  lastInputAt: number;
  lastFrameAt: number;
  idleSince: number | null;
  timers: { idleAt: number | null; graceAt: number | null; maxDurationAt: number };
  limits: SessionLimits;
  stats: SessionStats;
}

/** The five `Session` lifecycle states. */
export type SessionState = 'provisioning' | 'live' | 'recovering' | 'idle' | 'ended';

/** Per session limits, resolved from tenant, pool, and app layers. */
export interface SessionLimits {
  maxViewers: number;
  maxStreams: number;
  maxViewersPerStream: number;
  maxStreamsPerViewer: number;
  inputRatePerSec: number;
  idleMs: number;
  idleGraceMs: number;
  maxDurationMs: number;
}

/** Running counters for one session, in memory only. */
export interface SessionStats {
  framesEncoded: number;
  framesSent: number;
  framesSkipped: number;
  bytesSent: number;
  inputEvents: number;
  recoveries: number;
  peakViewers: number;
}

/** The durable shadow row of a `Session`, everything a resume does not restore from the store. */
export interface SessionRow {
  id: SessionId;
  instanceId: InstanceId;
  tenantId: TenantId;
  nodeId: NodeId;
  state: SessionState;
  startedAt: number;
  endedAt: number | null;
  endReason: string | null;
  /** For billing and capacity planning. */
  peakViewers: number;
}

// ── Stream ──────────────────────────────────────────────────────────────

/** One screencast or screenshot poll pipeline for one target within one session. In memory only. */
export interface Stream {
  id: StreamId;
  /** u16 in the binary frame header, per session allocation from 1, never reused. */
  wireId: number;
  sessionId: SessionId;
  targetId: TargetId;
  state: StreamState;
  stateReason: string | null;
  quality: EffectiveQuality;
  /** The CDP session this stream's screencast runs on. */
  cdpSessionId: string;
  /** Monotonic, starts at 1, never resets, even across a quality change. */
  seq: number;
  lastFrameAt: number;
  lastKeyframeSeq: number;
  attachments: Map<ViewerId, Attachment>;
  /** `'screencast'` is the fast path. */
  source: 'screencast' | 'screenshot-poll';
  pollIntervalMs: number | null;
  stats: {
    framesProduced: number;
    framesDroppedNoViewers: number;
    bytesProduced: number;
    encodeMsTotal: number;
    stallCount: number;
  };
  createdAt: number;
}

/** The five `Stream` lifecycle states. */
export type StreamState = 'starting' | 'live' | 'paused' | 'stalled' | 'stopped';

/** The negotiated quality a `Stream` is actually encoding at, versus a viewer's `Attachment.preferred`. */
export interface EffectiveQuality {
  codec: PayloadCodecValue;
  maxWidth: number;
  maxHeight: number;
  /** 1 to 100. */
  quality: number;
  everyNthFrame: number;
  /** A cap; the screencast can deliver fewer. */
  maxFps: number;
}

// ── Viewer and Attachment ──────────────────────────────────────────────

/** One connected socket's view of a session. In memory only. */
export interface Viewer {
  id: ViewerId;
  sessionId: SessionId;
  tenantId: TenantId;
  appId: AppId;
  /** End user, from `Principal`. */
  subject: string;
  displayName: string | null;
  state: ViewerState;
  capabilities: readonly Capability[];
  transport: {
    protocolVersion: number;
    connectedAt: number;
    remoteAddress: string;
    userAgent: string | null;
    rttMs: number | null;
    lastMessageAt: number;
  };
  resume: {
    token: string;
    windowMs: number;
    expiresAt: number;
    snapshot: ResumeSnapshot;
  };
  subscriptions: Set<StreamId>;
  heldLeases: Set<TargetId>;
  /** Token bucket. */
  inputTokens: number;
  inputRatePerSec: number;
  lastRefillAt: number;
  /** u16 allocator for this viewer's binary header stream handles, monotonic, never reused. */
  nextStreamId: number;
  /** Set when the socket drops but the resume window is still open. */
  disconnectedAt: number | null;
}

/** The six `Viewer` lifecycle states. */
export type ViewerState =
  | 'connecting'
  | 'handshaking'
  | 'attached'
  | 'resuming'
  | 'disconnected'
  | 'expired';

/** What a resume token restores: the subscription set and held leases, self contained and signed. */
export interface ResumeSnapshot {
  sid: SessionId;
  vid: ViewerId;
  subs: readonly { targetId: TargetId; quality: EffectiveQuality; lastSeq: number }[];
  leases: readonly { targetId: TargetId; leaseId: string; expiresAt: number }[];
  caps: readonly Capability[];
  issuedAt: number;
}

/** One viewer's subscription to one stream, with its own independent backlog. */
export interface Attachment {
  viewerId: ViewerId;
  streamId: StreamId;
  /** What the viewer asked for; may differ from the stream's effective quality. */
  preferred: Partial<EffectiveQuality>;
  lastSentSeq: number;
  lastAckedSeq: number;
  backlog: number;
  /** Default 3. */
  maxBacklog: number;
  /** Default 2 MiB. */
  maxBufferedBytes: number;
  framesSent: number;
  framesSkipped: number;
  bytesSent: number;
  /** Drives slow consumer policy. */
  consecutiveSkips: number;
  slowSince: number | null;
  attachedAt: number;
  /** True for a recorder or other non interactive consumer. Filtered before tier level computation. */
  synthetic: boolean;
}

// ── ControlLease ────────────────────────────────────────────────────────

/** Exclusive input control over one target within one session. In memory only. */
export interface ControlLease {
  /** `lse_...`. */
  id: string;
  sessionId: SessionId;
  targetId: TargetId;
  state: ControlLeaseState;
  holderViewerId: ViewerId | null;
  grantedAt: number | null;
  expiresAt: number | null;
  /** Default 30000. */
  leaseMs: number;
  /** Default 10000. */
  renewBeforeMs: number;
  renewCount: number;
  /** FIFO, position 0 is next. */
  queue: readonly QueueEntry[];
  /** Default 20000. */
  forceClaimAfterMs: number;
  forceClaimPolicy: 'allowed' | 'requiresAdmin' | 'never';
  /** Capped at 50 in memory; every entry is also emitted to the `AuditSink`. */
  history: readonly {
    at: number;
    event: 'granted' | 'renewed' | 'released' | 'expired' | 'revoked' | 'forceClaimed';
    viewerId: ViewerId | null;
    by: ViewerId | null;
  }[];
}

/** The seven `ControlLease` states. `revoked` and `forceClaimed` are terminal for that lease instance, not for the target: a new lease is minted for the next holder. */
export type ControlLeaseState =
  | 'unheld'
  | 'requested'
  | 'granted'
  | 'renewing'
  | 'expiring'
  | 'revoked'
  | 'forceClaimed';

/** One waiter in a `ControlLease` queue. */
export interface QueueEntry {
  viewerId: ViewerId;
  requestedAt: number;
  reason: string;
  /** Higher wins; ties by `requestedAt`. Default 0. */
  priority: number;
}

// ── Quotas ──────────────────────────────────────────────────────────────

/** Concurrency and rate ceilings, layered tenant down through app and pool, never widened. */
export interface QuotaLimits {
  maxInstances: number;
  maxInstancesPerApp: number;
  maxInstancesPerUser: number;
  maxViewers: number;
  maxProfiles: number;
  maxProfileBytes: number;
  maxSessionMinutesPerDay: number;
  maxAcquiresPerMinute: number;
  maxFrameBytesPerMinute: number;
}
