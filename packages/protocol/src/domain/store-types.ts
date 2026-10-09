/**
 * The `New*`, `*Filter`, and DDL row types the `Store` interface needs that
 * are not already defined as an entity. Derived from the DDL columns,
 * camel cased, with
 * `Iso` (an ISO 8601 UTC string) for every column stored as DDL `TEXT`
 * timestamp, matching the store layer's own representation rather than the
 * epoch millisecond numbers the in memory entities use.
 *
 * Two deliberate divergences from a naive one type per table reading:
 *
 * - `StoredBrowserSpec` (the `browser_specs` row: id, digest, tenantId,
 *   createdAt, plus the launch fields) is kept distinct from the domain
 *   `BrowserSpec` (the merged launch config carried on `Instance.spec` and
 *   `Pool.template`), even though `Store.upsertBrowserSpec` and
 *   `getBrowserSpec` are typed against the row shape.
 *   Reusing the name would make every other `BrowserSpec` typed
 *   field (which never carries a digest or a tenant id) type-check against
 *   the wrong shape.
 * - `InstanceStatus` (the `instances.status` column, seven values) is kept
 *   distinct from the domain `InstanceLifecycleState` (`Instance.state`,
 *   ten values). The DDL enum collapses `requested`/`placing`/`launching`
 *   into `launching` and splits `ready` into `warm`/`live`; the two enums
 *   describe the same lifecycle at different resolutions and are not
 *   interchangeable.
 */

import type { Capability } from '../wire/index.js';
import type { Iso, Json } from './common.js';
import type {
  App,
  AppId,
  BrowserChannel,
  BrowserSpec,
  ClientHintsSpec,
  ControlLeaseState,
  HeadlessMode,
  Instance,
  InstanceId,
  NodeCapacity,
  NodeId,
  Pool,
  PoolId,
  Profile,
  ProfileId,
  ProfileState,
  QuotaLimits,
  SessionId,
  Tenant,
  TenantId,
  TenantKey,
} from './entities.js';

// ── Tenants ─────────────────────────────────────────────────────────────

/** The `tenants.status` column, four values: the entity's three plus the DDL's tombstoned `deleted`. */
export type TenantStatus = 'active' | 'suspended' | 'deleting' | 'deleted';

/** The fields `createTenant` requires; everything else takes its default. */
export interface NewTenant {
  id?: TenantId;
  name: string;
  allowedCaps?: readonly Capability[];
  nodePin?: readonly string[] | null;
  policy?: Json;
  quotas?: QuotaLimits;
  defaults?: Tenant['defaults'];
  labels?: Readonly<Record<string, string>>;
}

// ── Apps ────────────────────────────────────────────────────────────────

/** The fields `createApp` requires. */
export interface NewApp {
  id?: AppId;
  tenantId: TenantId;
  name: string;
  maxCaps?: readonly Capability[];
  defaultPoolId?: PoolId | null;
  grantableCapabilities?: readonly Capability[];
  quotas?: Partial<QuotaLimits>;
  metadata?: Readonly<Record<string, string>>;
}

// ── App keys ────────────────────────────────────────────────────────────

/** One `app_keys` row: an application's JWT signing key, either EdDSA (public half only) or HS256 (encrypted secret). */
export interface AppKey {
  id: string;
  appId: AppId;
  tenantId: TenantId;
  alg: 'EdDSA' | 'HS256';
  publicKey: string | null;
  secretEnc: string | null;
  status: 'pending' | 'active' | 'retiring' | 'revoked';
  notBefore: Iso;
  notAfter: Iso | null;
  activatedAt: Iso | null;
  retiredAt: Iso | null;
  revokedAt: Iso | null;
  createdAt: Iso;
}

/** The fields `createAppKey` requires. A row must never carry both `publicKey` and `secretEnc`; enforced in the adapter, not by a database constraint. */
export interface NewAppKey {
  id?: string;
  appId: AppId;
  tenantId: TenantId;
  alg: 'EdDSA' | 'HS256';
  publicKey?: string | null;
  secretEnc?: string | null;
  notBefore: Iso;
  notAfter?: Iso | null;
}

// ── Pools and specs ─────────────────────────────────────────────────────

/** The fields `createPool` requires. */
export interface NewPool {
  id?: PoolId;
  tenantId: TenantId;
  name: string;
  specId: string;
  minWarm?: number;
  maxInstances?: number;
  placement?: { policy: string; params: Readonly<Record<string, unknown>> };
  idleTimeoutMs?: number;
  maxDurationMs?: number;
}

/** A `browser_specs` row: a content addressed, stored `BrowserSpec`. Distinct from the domain `BrowserSpec`, see this module's top comment. */
export interface StoredBrowserSpec {
  id: string;
  tenantId: TenantId;
  /** sha256 of the canonical JSON of the spec fields below. */
  digest: string;
  engine: 'chromium';
  channel: BrowserChannel;
  headless: HeadlessMode;
  /**
   * Mirrors `BrowserSpec.isolation`. Optional here, unlike the domain type,
   * because it is a column added after this type and this table both
   * already existed, so a row written before that migration carries no
   * opinion at all. `Store.upsertBrowserSpec` and `storedSpecToBrowserSpec`
   * both treat a missing value as `'tab'`, the historical meaning a spec
   * written before this column existed always had.
   *
   * That optionality is for READERS of old rows and is not a licence for a
   * writer to omit the field. It used to say `toStoredSpecInput` "does not
   * set it yet", which stopped being true, and the same optional-so-easily-
   * forgotten shape then swallowed `clientHints` once and `initScripts`
   * once. `toStoredSpecInput` now returns `Required<BrowserSpecInput>`
   * precisely so that a field added below cannot be forgotten there
   * silently: see that function's own doc.
   */
  isolation?: 'tab' | 'window';
  viewportW: number;
  viewportH: number;
  dpr: number;
  locale: string | null;
  timezone: string | null;
  userAgent: string | null;
  /**
   * Mirrors `BrowserSpec.clientHints`. Optional here for the same reason
   * `isolation` above is optional: it is a column added after this type and
   * this table both already existed (`0005_browser_spec_client_hints.sql`),
   * so a caller assembling a `BrowserSpecInput` before that migration ran
   * (or a stored row written before it) may carry no opinion at all, which
   * is a different fact from a caller explicitly asking for `null`. Both
   * `Store.upsertBrowserSpec` and `storedSpecToBrowserSpec`
   * (`packages/store-sqlite/src/mappers.ts`) treat a missing value the same
   * as an explicit `null`: no client hints recorded for this spec.
   *
   * Before this field existed, `storedSpecToBrowserSpec` hardcoded
   * `clientHints: null` on every read, which meant a caller could set
   * `BrowserSpec.clientHints` on `acquire` and have it silently vanish the
   * moment the spec was written to and read back from `browser_specs` (see
   * "The client hints half, which the flag alone does not cover" in
   * `docs/cdp-and-interception.md`). `navigator.userAgentData` is built
   * from Chrome's own brand list and is never parsed back out of a
   * `--user-agent` string, so a browser launched with a custom user agent
   * but no surviving client hints presents a `User-Agent` header from one
   * identity and `Sec-CH-UA`/`userAgentData` from another, which is exactly
   * the inconsistency an anti-bot check looks for.
   */
  clientHints?: ClientHintsSpec | null;
  /**
   * Mirrors `BrowserSpec.initScripts`. Optional here for the same reason
   * `clientHints` above is: it is a column added after this type and this
   * table both already existed (`0006_browser_spec_init_scripts.sql`), so a
   * caller assembling a `BrowserSpecInput` before that migration ran (or a
   * stored row written before it) may carry no opinion at all, which is a
   * different fact from a caller explicitly asking for `null` or `[]`. Both
   * `Store.upsertBrowserSpec` and `storedSpecToBrowserSpec`
   * (`packages/store-sqlite/src/mappers.ts`) treat a missing value the same
   * as an explicit `null`: no init scripts recorded for this spec, which
   * `storedSpecToBrowserSpec` expands to `BrowserSpec.initScripts: []`.
   */
  initScripts?: readonly { name: string; source: string }[] | null;
  /**
   * Mirrors `BrowserSpec.remoteEndpointName`. Optional here for the same
   * reason `initScripts` above is: it is a column added after this type and
   * this table both already existed, so a caller assembling a
   * `BrowserSpecInput` before that migration ran (or a stored row written
   * before it) may carry no opinion at all, which is a different fact from
   * a caller explicitly asking for `null`. Both `Store.upsertBrowserSpec`
   * and `storedSpecToBrowserSpec` (`packages/store-sqlite/src/mappers.ts`,
   * `packages/store-postgres/src/mappers.ts`) treat a missing value the
   * same as an explicit `null`: no registered `RemoteEndpoint` named for
   * this spec.
   *
   * This is the field that made `runtime-remote` unreachable in practice
   * until it existed. `entities.ts`'s `BrowserSpec.remoteEndpointName` doc
   * comment names it the ONLY channel `RemoteRuntime.launch`
   * (`packages/runtime-remote/src/runtime.ts`) has for choosing which
   * operator-registered endpoint a launch attaches to; before this column,
   * `StoredBrowserSpec` had no place for it to land, so it never survived
   * the round trip through `browser_specs`, `Pool.template` was rebuilt
   * from a row that had silently dropped it, and every attach to an
   * externally launched Chrome failed `E_SPEC_CONFLICT` (missing endpoint
   * label) regardless of what a pool's spec was built with. See
   * `Required<BrowserSpecInput>`'s own doc on `toStoredSpecInput`
   * (`packages/router/src/router/specMapping.ts`) for the two prior
   * incidents (`clientHints`, `initScripts`) this exact optional-and-so-
   * easily-forgotten shape already caused.
   */
  remoteEndpointName?: string | null;
  /** Never carries `proxy.username`/`proxy.password`; those travel with the per-acquire request only. */
  proxy: { server: string; bypass: readonly string[] } | null;
  args: readonly string[];
  extensions: readonly string[];
  stealth: 'off' | 'basic' | 'full';
  limits: Json;
  createdAt: Iso;
}

/** The input to `upsertBrowserSpec`: the subset of `BrowserSpec` that is content addressed. */
export type BrowserSpecInput = Omit<StoredBrowserSpec, 'id' | 'tenantId' | 'digest' | 'createdAt'>;

// ── Profiles ────────────────────────────────────────────────────────────

/** The fields `createProfile` requires. */
export interface NewProfile {
  id?: ProfileId;
  tenantId: TenantId;
  appId: AppId;
  key: string;
  mode: 'ephemeral' | 'persistent' | 'template';
  templateId?: string | null;
  storagePath: string;
  homeNodeId?: NodeId | null;
  ttlMs?: number | null;
  encryptionKeyId?: string | null;
}

/** Filter for `listProfiles`. */
export interface ProfileFilter {
  appId?: AppId;
  state?: ProfileState | readonly ProfileState[];
  homeNodeId?: NodeId;
  keyPrefix?: string;
  limit?: number;
  cursor?: string;
}

/** The fields `createSnapshot` requires. */
export interface NewSnapshot {
  id?: string;
  profileId: ProfileId;
  tenantId: TenantId;
  label?: string | null;
  storagePath: string;
  sizeBytes: number;
  contentHash: string;
  encryptionKeyId?: string | null;
  createdBy?: string | null;
}

/**
 * A `profile_snapshots` row. Its own four value `status` set, not
 * `ProfileState`: a snapshot is an inert archive with no lease, no
 * quarantine, no migration.
 */
export interface ProfileSnapshot {
  id: string;
  profileId: ProfileId;
  tenantId: TenantId;
  label: string | null;
  storagePath: string;
  sizeBytes: number;
  contentHash: string;
  encryptionKeyId: string | null;
  createdBy: string | null;
  status: 'creating' | 'ready' | 'deleting' | 'corrupt';
  createdAt: Iso;
}

// ── Nodes ───────────────────────────────────────────────────────────────

/** The `nodes.status` column. */
export type NodeStatus = 'joining' | 'ready' | 'draining' | 'cordoned' | 'lost' | 'retired';

/** The fields `registerNode` requires. */
export interface NewNode {
  id?: NodeId;
  name: string;
  region?: string | null;
  zone?: string | null;
  runtime: 'host' | 'docker' | 'k8s' | 'remote';
  address: string;
  dataAddress?: string | null;
  registrationSecretEnc: string;
  labels?: Readonly<Record<string, string>>;
  tenantPin?: readonly TenantId[] | null;
  capacity?: NodeCapacity;
  version?: string;
}

/** One `node_heartbeats` upsert, a single row per node updated in place. */
export interface NodeHeartbeat {
  nodeId: NodeId;
  beatAt: Iso;
  seq: number;
  liveInstances: number;
  memFreeMib?: number | null;
  cpuLoadPct?: number | null;
  diskFreeMib?: number | null;
  detail?: Json;
}

// ── Instances ───────────────────────────────────────────────────────────

/**
 * The `instances.status` column, seven values, coarser than
 * `Instance.state`. See this module's top comment for why they are kept
 * distinct.
 */
export type InstanceStatus =
  | 'launching'
  | 'warm'
  | 'live'
  | 'recovering'
  | 'draining'
  | 'released'
  | 'failed';

/**
 * The fields `createInstance` requires.
 *
 * `metadata` and `lifetime` are deliberately NOT optional here, unlike
 * every other field this interface marks optional for a legitimate reason
 * (a generated `id`, an unassigned `poolId`/`profileId`, a system-initiated
 * row with no `createdBySub`). This is the fourth time a field reached
 * `router` fully resolved and was then silently dropped before it reached
 * a store: `clientHints`, `initScripts`, and `remoteEndpointName` all went
 * missing from `BrowserSpecInput` the same way (see
 * `toStoredSpecInput`'s doc, `packages/router/src/router/specMapping.ts`,
 * for the first three incidents), and `Instance.metadata`/`Instance.lifetime`
 * were the fourth and fifth: `AcquireArgs.metadata` let a caller name a
 * browser, and `Instance.lifetime` let a caller ask for `'explicit'`
 * (lives until released or `maxDurationMs`), and both were
 * accepted, validated, and then discarded, because `store-sqlite`'s
 * `rowToInstance` had nothing to read them back from and hardcoded
 * `metadata: {}` / `lifetime: 'viewer-bound'` for every row.
 *
 * Making both fields required here means every call to `createInstance`,
 * production or test, is a compile error until it states an explicit
 * value for both, exactly the defence `store-sqlite`/`store-postgres`'s
 * own `INSTANCE_PATCH_RULES` (`{ [K in keyof Instance]-?: ... }`) already
 * applies to `transitionInstance`'s patch path: a field with no rule fails
 * the build rather than vanishing silently. `createInstance` had no such
 * exhaustiveness check at all before this, which is exactly how `metadata`
 * and `lifetime` went missing in the first place.
 */
export interface NewInstance {
  id?: InstanceId;
  tenantId: TenantId;
  appId: AppId;
  poolId?: PoolId | null;
  specId: string;
  profileId?: ProfileId | null;
  nodeId: NodeId;
  createdBySub?: string | null;
  createdByJti?: string | null;
  /**
   * Caller supplied, free form string-to-string pairs (`Instance.metadata`'s
   * own doc, `entities.ts`). Two conventional keys, `name` and
   * `description`, are recognised by `router`'s
   * `validateAcquireMetadata` (`packages/router/src/router/instanceMetadata.ts`)
   * doc comment and by the REST inventory route as the ones a UI should
   * show by default; every other key is free form and passed through
   * unvalidated beyond the size caps `validateAcquireMetadata` enforces.
   * Pass `{}` for "no metadata", never `undefined`: `undefined` would put
   * this interface back where `clientHints`/`initScripts` used to be.
   */
  metadata: Readonly<Record<string, string>>;
  /**
   * `Instance.lifetime`'s own doc (`entities.ts`, and
   * `packages/router/src/router/config.ts`): `'viewer-bound'` releases
   * once the last viewer leaves; `'explicit'` lives until released or
   * `maxDurationMs`, and is exempted from `BrowserRouter.reaperSweep`'s
   * idle sweep for exactly that reason (still bounded by the sweep's
   * `max_duration` check, which runs unconditionally). Pass
   * `'viewer-bound'` explicitly for the common case rather than relying on
   * a default: a caller who does not care still has to say so, which is
   * the whole point of making this field required.
   */
  lifetime: 'viewer-bound' | 'explicit';
}

/** Filter for `listInstances`. */
export interface InstanceFilter {
  status?: InstanceStatus | readonly InstanceStatus[];
  poolId?: PoolId;
  nodeId?: NodeId;
  createdBySub?: string;
  limit?: number;
  cursor?: string;
}

// ── Sessions, viewers, leases ───────────────────────────────────────────

/** The fields `createSession` requires. */
export interface NewSession {
  id?: SessionId;
  tenantId: TenantId;
  instanceId: InstanceId;
  gatewayId?: string | null;
}

/** The fields `createViewer` requires. */
export interface NewViewer {
  id?: string;
  tenantId: TenantId;
  sessionId: SessionId;
  instanceId: InstanceId;
  sub: string;
  subKind?: string | null;
  displayName?: string | null;
  caps: readonly Capability[];
  inviteId?: string | null;
  tokenJti?: string | null;
  transport?: 'gateway' | 'direct';
  nodeId?: NodeId | null;
  remoteIp?: string | null;
  userAgent?: string | null;
  resumedFrom?: string | null;
}

/** The accumulated counters written once, at disconnect, to a `viewers` row. */
export interface ViewerClose {
  disconnectedAt: Iso;
  closeCode: number;
  closeReason: string | null;
  bytesSent: number;
  framesSent: number;
  framesDropped: number;
}

/** The fields `recordControlGrant` requires. */
export interface NewControlLease {
  id?: string;
  tenantId: TenantId;
  sessionId: SessionId;
  targetId: string;
  viewerId: string;
  sub: string;
  grantedAt: Iso;
}

/** A `control_leases` history row. */
export interface ControlLeaseRow {
  id: string;
  tenantId: TenantId;
  sessionId: SessionId;
  targetId: string;
  viewerId: string;
  sub: string;
  grantedAt: Iso;
  releasedAt: Iso | null;
  releaseReason: string | null;
  displaced: string | null;
  inputEvents: number;
}

// ── Quotas and usage ────────────────────────────────────────────────────

/** One `quotas` row: a metric ceiling scoped to a tenant, a pool, or an app. */
export interface Quota {
  tenantId: TenantId;
  scope: 'tenant' | `pool:${string}` | `app:${string}`;
  metric: string;
  limitValue: number;
  window: 'concurrent' | 'hour' | 'day' | 'month';
  softPct: number;
  action: 'reject' | 'queue' | 'throttle';
  updatedAt: Iso;
}

/** One `incrementUsage` row, a fire and forget metric increment. */
export interface UsageIncrement {
  tenantId: TenantId;
  bucket: string;
  granularity: 'hour' | 'day';
  metric: string;
  dim?: string;
  amount: number;
}

/** One `usage_counters` row returned by `readUsage`. */
export interface UsageRow {
  tenantId: TenantId;
  bucket: string;
  granularity: 'hour' | 'day';
  metric: string;
  dim: string;
  value: number;
  updatedAt: Iso;
}

/**
 * The usage accounting callback contract. `usage_counters`
 * stays the authoritative record; this hook is a convenience only, never
 * retried on failure, and the counter write happens regardless of whether
 * it succeeds.
 */
export interface UsageHook {
  onUsage(batch: UsageBatch): Promise<void> | void;
  onQuotaWarning(w: {
    tenantId: string;
    metric: string;
    value: number;
    limit: number;
    pct: number;
  }): void;
  onQuotaExceeded(e: {
    tenantId: string;
    metric: string;
    action: 'reject' | 'queue' | 'throttle';
  }): void;
}

/** One flushed batch of usage deltas, idempotent per `(tenantId, intervalStart, intervalEnd)`. */
export interface UsageBatch {
  intervalStart: Iso;
  intervalEnd: Iso;
  rows: readonly { tenantId: string; metric: string; dim: string; delta: number }[];
}

// ── Audit ───────────────────────────────────────────────────────────────

/**
 * One `audit_events` row, the shape `Store.appendAudit` and `queryAudit`
 * exchange. Deliberately distinct from `AuditSinkEvent` (`extension-points.ts`),
 * the richer discriminated union `AuditSink.emit` receives: the sink's
 * typed union is what application code constructs, this flat row is what
 * the audit writer persists and what a chained hash covers. No foreign
 * keys, by design, so an audit row survives deletion of the instance,
 * session, or viewer it describes.
 */
export interface AuditEvent {
  id?: string;
  tenantId: TenantId;
  appId?: string | null;
  occurredAt: Iso;
  eventType: string;
  severity?: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical';
  actorSub?: string | null;
  actorKind?: string | null;
  actorName?: string | null;
  onBehalfOf?: string | null;
  inviteId?: string | null;
  instanceId?: string | null;
  sessionId?: string | null;
  viewerId?: string | null;
  targetId?: string | null;
  profileId?: string | null;
  nodeId?: string | null;
  remoteIp?: string | null;
  userAgent?: string | null;
  traceId?: string | null;
  tokenJti?: string | null;
  outcome?: string;
  detail?: Json;
  prevHash?: string | null;
  hash?: string | null;
}

/** Filter and pagination for `queryAudit`. */
export interface AuditQuery {
  actorSub?: string;
  instanceId?: string;
  eventType?: string;
  from?: Iso;
  to?: Iso;
  limit?: number;
  cursor?: string;
}

/** One page of `queryAudit` results, with an opaque cursor for the next page. */
export interface AuditPage {
  events: readonly AuditEvent[];
  nextCursor: string | null;
}

// ── Files ───────────────────────────────────────────────────────────────

/** The fields `createDownload` requires. */
export interface NewDownload {
  id?: string;
  tenantId: TenantId;
  instanceId: InstanceId;
  sessionId?: string | null;
  targetId?: string | null;
  nodeId: NodeId;
  filename: string;
  suggestedName?: string | null;
  mimeType?: string | null;
  storagePath: string;
  sourceUrlHost?: string | null;
  expiresAt: Iso;
}

/** A `downloads` row. */
export interface Download {
  id: string;
  tenantId: TenantId;
  instanceId: InstanceId;
  sessionId: string | null;
  targetId: string | null;
  nodeId: NodeId;
  filename: string;
  suggestedName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  contentHash: string | null;
  storagePath: string;
  sourceUrlHost: string | null;
  status: 'in_progress' | 'complete' | 'failed' | 'fetched' | 'expired' | 'deleted';
  fetchedBy: string | null;
  fetchedAt: Iso | null;
  fetchCount: number;
  expiresAt: Iso;
  createdAt: Iso;
  updatedAt: Iso;
}

/** The fields `createUpload` requires. */
export interface NewUpload {
  id?: string;
  tenantId: TenantId;
  instanceId?: InstanceId | null;
  viewerId?: string | null;
  nodeId?: NodeId | null;
  filename: string;
  mimeType?: string | null;
  declaredBytes: number;
  storagePath: string;
  expiresAt: Iso;
}

/** An `uploads` row. */
export interface Upload {
  id: string;
  tenantId: TenantId;
  instanceId: InstanceId | null;
  viewerId: string | null;
  nodeId: NodeId | null;
  filename: string;
  mimeType: string | null;
  declaredBytes: number;
  receivedBytes: number;
  contentHash: string | null;
  storagePath: string;
  status: 'staging' | 'received' | 'committed' | 'aborted' | 'expired' | 'deleted';
  expiresAt: Iso;
  createdAt: Iso;
  updatedAt: Iso;
}

// ── Tickets, revocations, invites ───────────────────────────────────────

/** The redemption request `redeemAttachTicket` checks and, on success, marks consumed. */
export interface AttachTicketRedeem {
  id: string;
  tenantId: string;
  nodeId: string;
  instanceId: string;
  viewerId: string;
  epoch: number;
  redeemedAt: Iso;
}

/** The fields `putRevocation` requires. */
export interface NewRevocation {
  id?: string;
  tenantId: TenantId;
  kind: 'sub' | 'jti' | 'kid' | 'invite' | 'viewer';
  value: string;
  reason?: string | null;
  issuedBy?: string | null;
  effectiveAt: Iso;
  expiresAt: Iso;
}

/** One revocation lookup key `checkRevoked` tests. */
export interface RevocationCheck {
  kind: 'sub' | 'jti' | 'kid' | 'invite' | 'viewer';
  value: string;
}

/** The fields `createInvite` requires. */
export interface NewInvite {
  id?: string;
  tenantId: TenantId;
  appId: AppId;
  instanceId: InstanceId;
  secretHash: string;
  createdBy: string;
  label?: string | null;
  caps: readonly Capability[];
  scope: Json;
  maxRedemptions?: number;
  detachFromCreator?: boolean;
  expiresAt: Iso;
}

/** An `invites` row: a delegation record letting a holder hand a scoped, capped capability set to someone else. */
export interface Invite {
  id: string;
  tenantId: TenantId;
  appId: AppId;
  instanceId: InstanceId;
  secretHash: string;
  createdBy: string;
  label: string | null;
  caps: readonly Capability[];
  scope: Json;
  maxRedemptions: number;
  redemptions: number;
  detachFromCreator: boolean;
  status: 'active' | 'exhausted' | 'revoked' | 'expired' | 'dead';
  expiresAt: Iso;
  createdAt: Iso;
  updatedAt: Iso;
}

// ── Placement queue ─────────────────────────────────────────────────────

/**
 * The fields `enqueuePlacement` requires. `appId` is required and
 * `profileKey`, when present, must already be the prefixed stored key; the
 * adapter rejects a bare key rather than prefixing one itself.
 */
export interface NewPlacement {
  id?: string;
  tenantId: TenantId;
  appId: AppId;
  poolId: PoolId;
  specId: string;
  profileKey?: string | null;
  priority?: number;
  requestedBy?: string | null;
  deadlineAt: Iso;
}

/** A `placement_queue` row. */
export interface PlacementRow {
  id: string;
  tenantId: TenantId;
  appId: AppId;
  poolId: PoolId;
  specId: string;
  profileKey: string | null;
  priority: number;
  requestedBy: string | null;
  status: 'queued' | 'claimed' | 'placed' | 'failed' | 'abandoned';
  claimedBy: string | null;
  claimedAt: Iso | null;
  instanceId: string | null;
  attempts: number;
  lastError: string | null;
  enqueuedAt: Iso;
  deadlineAt: Iso;
}

// ── Maintenance ─────────────────────────────────────────────────────────

/**
 * The tables `purge` accepts. Each carries its own retention semantics
 * inside the adapter: the signature is uniform, the policy is
 * not. `profiles` and `instances` are not purgeable directly, their rows
 * are retired through the entity lifecycle and the tenant deletion
 * procedure instead.
 */
export type PurgeableTable =
  | 'profile_leases'
  | 'profile_snapshots'
  | 'sessions'
  | 'viewers'
  | 'control_leases'
  | 'audit_events'
  | 'downloads'
  | 'uploads'
  | 'attach_tickets'
  | 'revocations'
  | 'invites'
  | 'placement_queue';

/** The result of `Store.maintain()`. */
export interface MaintenanceReport {
  startedAt: Iso;
  durationMs: number;
  vacuumed: boolean;
  analyzed: boolean;
  notes: readonly string[];
}

/** The result of `Store.migrate()`. */
export interface MigrationReport {
  fromVersion: number;
  toVersion: number;
  applied: readonly { version: number; name: string; durationMs: number }[];
}

// Re-exported so callers importing only from `store-types.js` do not need a
// second import for entity types the Store shapes above reference.
export type { App, BrowserSpec, ControlLeaseState, Instance, Pool, Profile, Tenant, TenantKey };
