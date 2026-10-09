/**
 * The `Store` interface. `transaction`'s callback is synchronous,
 * `(tx: StoreTx) => T`, not `(tx: StoreTx) => Promise<T> | T`.
 * Transaction callbacks are synchronous by design and `StoreTx` has no async methods, which made the `Promise<T>`
 * arm of the original signature unusable; narrowing it turns "no IO other
 * than store calls inside a transaction" into a type error rather than a
 * comment, and matches SQLite holding its single writer lock for the whole
 * transaction body.
 *
 * `Store` and its roughly 45 supporting types live in `@browserglass/protocol`
 * rather than a separate `@browserglass/store` package:
 * protocol already holds every extension point interface,
 * and router, server, and both store adapters all share these types.
 */

import type { Iso } from './common.js';
import type {
  App,
  Instance,
  Node,
  Pool,
  Profile,
  ProfileLease,
  ProfileState,
  SessionRow,
  Tenant,
  Viewer,
} from './entities.js';
import type {
  AppKey,
  AttachTicketRedeem,
  AuditEvent,
  AuditPage,
  AuditQuery,
  BrowserSpecInput,
  ControlLeaseRow,
  Download,
  InstanceFilter,
  InstanceStatus,
  Invite,
  MaintenanceReport,
  MigrationReport,
  NewApp,
  NewAppKey,
  NewControlLease,
  NewDownload,
  NewInstance,
  NewInvite,
  NewNode,
  NewPlacement,
  NewPool,
  NewProfile,
  NewRevocation,
  NewSession,
  NewSnapshot,
  NewTenant,
  NewUpload,
  NewViewer,
  NodeHeartbeat,
  NodeStatus,
  PlacementRow,
  ProfileFilter,
  ProfileSnapshot,
  PurgeableTable,
  Quota,
  RevocationCheck,
  StoredBrowserSpec,
  TenantStatus,
  Upload,
  UsageIncrement,
  UsageRow,
  ViewerClose,
} from './store-types.js';

/** The consistency contract carried on each `Store` method's TSDoc, quoted here for reference by adapter authors. */
export type Consistency = 'strong' | 'advisory' | 'atomic' | 'tx-required';

/** What one `Store` implementation can do, queried once and cached by the caller. */
export interface StoreCapabilities {
  transactions: boolean;
  advisoryLocks: boolean;
  skipLocked: boolean;
  /** LISTEN/NOTIFY or an equivalent. */
  notify: boolean;
  concurrentWriters: boolean;
  /** 1 for SQLite. */
  maxWriteConcurrency: number;
}

/**
 * The synchronous transaction handle passed to a `Store.transaction`
 * callback. Synchronous by design, so nothing can `await` while the write
 * lock is held.
 */
export interface StoreTx {
  readonly kind: 'sqlite' | 'postgres';
  get<T>(table: string, key: Record<string, unknown>): T | null;
  insert(table: string, row: Record<string, unknown>): void;
  update(table: string, key: Record<string, unknown>, patch: Record<string, unknown>): number;
  delete(table: string, key: Record<string, unknown>): number;
  raw<T>(sql: string, params: unknown[]): T[];
}

/**
 * The persistence interface every store adapter implements, fully, on
 * both `store-sqlite` and `store-postgres`. Not an ORM, a finite named
 * operation set, so every operation's consistency contract can be stated
 * once and relied on everywhere.
 */
export interface Store {
  // ── lifecycle ─────────────────────────────────────────────────────────
  init(): Promise<void>;
  close(): Promise<void>;
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
  capabilities(): StoreCapabilities;

  // ── transactions ──────────────────────────────────────────────────────
  /**
   * Runs `fn` inside a real transaction. On SQLite this is IMMEDIATE mode,
   * so the write lock is taken up front (deferred mode upgrades mid
   * transaction and deadlocks under concurrency). On Postgres this is READ
   * COMMITTED unless `isolation` says otherwise.
   *
   * `fn` must be idempotent: it may be retried on a serialisation failure
   * or on `SQLITE_BUSY`, up to `retries` times with exponential backoff.
   * `fn` performs no IO other than store calls: no fetch, no filesystem
   * access, no awaiting a timer, enforced here by `fn` being synchronous.
   */
  transaction<T>(
    fn: (tx: StoreTx) => T,
    opts?: { isolation?: 'read-committed' | 'serializable'; retries?: number },
  ): Promise<T>;

  // ── tenants / apps / keys ─────────────────────────────────────────────
  /** strong */
  getTenant(id: string): Promise<Tenant | null>;
  /** advisory */
  listTenants(f?: { status?: TenantStatus }): Promise<Tenant[]>;
  /** atomic */
  createTenant(t: NewTenant): Promise<Tenant>;
  /** atomic */
  updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant>;
  /** atomic */
  setTenantStatus(id: string, status: TenantStatus): Promise<void>;

  /** strong */
  getApp(tenantId: string, appId: string): Promise<App | null>;
  /** advisory */
  listApps(tenantId: string): Promise<App[]>;
  /** atomic */
  createApp(a: NewApp): Promise<App>;
  updateApp(tenantId: string, appId: string, p: Partial<App>): Promise<App>;

  /** Verification hot path. Cached in process for 30 seconds with negative caching. advisory */
  getAppKey(appId: string, kid: string): Promise<AppKey | null>;
  /** strong */
  listAppKeys(appId: string): Promise<AppKey[]>;
  /** atomic */
  createAppKey(k: NewAppKey): Promise<AppKey>;
  /** tx-required: activating a key retires the current active key. */
  rotateAppKey(tx: StoreTx, appId: string, newKid: string): void;
  revokeAppKey(appId: string, kid: string, immediate: boolean): Promise<void>;

  // ── pools and specs ───────────────────────────────────────────────────
  getPool(tenantId: string, poolId: string): Promise<Pool | null>;
  getPoolByName(tenantId: string, name: string): Promise<Pool | null>;
  listPools(tenantId: string): Promise<Pool[]>;
  createPool(p: NewPool): Promise<Pool>;
  updatePool(tenantId: string, poolId: string, p: Partial<Pool>): Promise<Pool>;

  /** Content addressed upsert. Returns the existing row when the digest matches. atomic */
  upsertBrowserSpec(tenantId: string, spec: BrowserSpecInput): Promise<StoredBrowserSpec>;
  getBrowserSpec(tenantId: string, specId: string): Promise<StoredBrowserSpec | null>;

  // ── profiles ──────────────────────────────────────────────────────────
  getProfile(tenantId: string, profileId: string): Promise<Profile | null>;
  /**
   * `appId` is not optional. A tenant only lookup would cross the app
   * boundary, which is the whole point of the (tenant, app, key) key.
   */
  getProfileByKey(tenantId: string, appId: string, key: string): Promise<Profile | null>;
  listProfiles(tenantId: string, f?: ProfileFilter): Promise<Profile[]>;
  /** atomic */
  createProfile(p: NewProfile): Promise<Profile>;
  updateProfile(tenantId: string, id: string, p: Partial<Profile>): Promise<Profile>;
  setProfileState(tenantId: string, id: string, s: ProfileState): Promise<void>;
  deleteProfile(tenantId: string, id: string): Promise<void>;

  /**
   * THE critical method. Must be atomic against every other process in the
   * deployment. Returns null if another live lease already exists.
   *
   * SQLite: INSERT into `profile_leases` relying on the partial unique
   * index. Postgres: INSERT ... ON CONFLICT DO NOTHING on the same index,
   * RETURNING. Never a SELECT followed by an INSERT. atomic
   */
  acquireProfileLease(req: {
    tenantId: string;
    profileId: string;
    nodeId: string;
    instanceId?: string;
    holderPid?: number;
    ttlMs: number;
  }): Promise<ProfileLease | null>;

  /** Fails (returns false) if the lease was already released or expired. atomic */
  heartbeatProfileLease(leaseId: string, ttlMs: number): Promise<boolean>;
  /** atomic */
  releaseProfileLease(leaseId: string, reason: string): Promise<void>;
  /** Sweeper. Returns the leases it reclaimed so the caller can log them. atomic */
  expireProfileLeases(now: Iso, limit: number): Promise<ProfileLease[]>;

  createSnapshot(s: NewSnapshot): Promise<ProfileSnapshot>;
  listSnapshots(tenantId: string, profileId: string): Promise<ProfileSnapshot[]>;
  deleteSnapshot(tenantId: string, snapshotId: string): Promise<void>;

  // ── nodes ─────────────────────────────────────────────────────────────
  /**
   * atomic. Upsert on `id`: calling this again with an `id` already
   * present updates that node's row in place rather than throwing on a
   * primary key collision or minting a second, unrelated row, so a node
   * process can restart and re-register under the exact durable id it
   * was constructed with (an operator configured identity, not one this
   * call invents) and keep every foreign key already pointing at it.
   * Omitting `id` still mints a fresh one every call, as it always has.
   */
  registerNode(n: NewNode): Promise<Node>;
  getNode(id: string): Promise<Node | null>;
  /** advisory */
  listNodes(f?: { status?: NodeStatus[]; region?: string }): Promise<Node[]>;
  setNodeStatus(id: string, s: NodeStatus, detail?: string): Promise<void>;
  /** High frequency. Single row upsert, never inside a transaction. atomic */
  heartbeatNode(h: NodeHeartbeat): Promise<void>;
  /** Returns nodes whose last beat is older than the threshold. advisory */
  findStaleNodes(olderThan: Iso): Promise<Node[]>;

  // ── instances ─────────────────────────────────────────────────────────
  /** atomic */
  createInstance(i: NewInstance): Promise<Instance>;
  getInstance(tenantId: string, id: string): Promise<Instance | null>;
  listInstances(tenantId: string, f?: InstanceFilter): Promise<Instance[]>;
  /** Compare and set on status. Returns false if `from` did not match. atomic */
  transitionInstance(
    tenantId: string,
    id: string,
    from: InstanceStatus[],
    to: InstanceStatus,
    patch?: Partial<Instance>,
  ): Promise<boolean>;
  /** Bumps epoch and increments `restart_count`. Fences stale attach tickets. atomic */
  bumpInstanceEpoch(tenantId: string, id: string): Promise<number>;
  /** advisory */
  touchInstance(tenantId: string, id: string, at: Iso): Promise<void>;
  /**
   * Warm reuse. Claims a single warm instance matching the spec, moving it
   * to `'live'` in the same operation so two concurrent acquires cannot
   * both win. atomic
   */
  claimWarmInstance(req: {
    tenantId: string;
    poolId: string;
    specId: string;
    profileId?: string;
    nodeIds?: string[];
  }): Promise<Instance | null>;

  // ── sessions, viewers, leases ─────────────────────────────────────────
  createSession(s: NewSession): Promise<SessionRow>;
  getSession(tenantId: string, id: string): Promise<SessionRow | null>;
  endSession(tenantId: string, id: string, reason: string, code: number): Promise<void>;
  /** Reconciliation: sessions this gateway believes it owns. strong */
  listSessionsByGateway(gatewayId: string): Promise<SessionRow[]>;

  createViewer(v: NewViewer): Promise<Viewer>;
  /** Written once, at disconnect, with the accumulated counters. */
  closeViewer(id: string, close: ViewerClose): Promise<void>;
  /** advisory */
  listViewers(tenantId: string, sessionId: string): Promise<Viewer[]>;

  recordControlGrant(g: NewControlLease): Promise<ControlLeaseRow>;
  recordControlRelease(id: string, reason: string, inputEvents: number): Promise<void>;

  // ── quotas and usage ────────────────────────────────────────────────────
  /** advisory, 30 second cache */
  getQuotas(tenantId: string): Promise<Quota[]>;
  setQuota(q: Quota): Promise<void>;
  /**
   * Atomic check and increment for concurrency window quotas. Returns the
   * post increment value and whether the limit was exceeded. The whole
   * point is that two concurrent acquires cannot both pass a limit of one.
   * atomic
   */
  reserveQuota(req: { tenantId: string; scope: string; metric: string; amount: number }): Promise<{
    allowed: boolean;
    value: number;
    limit: number;
  }>;
  releaseQuota(req: {
    tenantId: string;
    scope: string;
    metric: string;
    amount: number;
  }): Promise<void>;

  /** Fire and forget increment. Batched by the caller. Never blocks a request. advisory */
  incrementUsage(rows: UsageIncrement[]): Promise<void>;
  readUsage(tenantId: string, from: Iso, to: Iso, metric?: string): Promise<UsageRow[]>;

  // ── audit ─────────────────────────────────────────────────────────────
  /**
   * Buffered. Returns once the batch is durably written. `severity >=
   * notice` events must not be lost, so the writer fsyncs on those and the
   * caller awaits before completing the operation being audited. atomic
   */
  appendAudit(events: AuditEvent[]): Promise<void>;
  /** advisory */
  queryAudit(tenantId: string, q: AuditQuery): Promise<AuditPage>;
  /** Chained tenants only. tx-required because the chain must serialise. */
  appendAuditChained(tx: StoreTx, tenantId: string, e: AuditEvent): void;

  // ── files ─────────────────────────────────────────────────────────────
  createDownload(d: NewDownload): Promise<Download>;
  updateDownload(tenantId: string, id: string, p: Partial<Download>): Promise<Download>;
  listDownloads(tenantId: string, instanceId: string): Promise<Download[]>;
  createUpload(u: NewUpload): Promise<Upload>;
  updateUpload(tenantId: string, id: string, p: Partial<Upload>): Promise<Upload>;
  findStaleUploads(olderThan: Iso, limit: number): Promise<Upload[]>;

  // ── tickets, revocations, invites ─────────────────────────────────────
  /** Returns false if this ticket id was already redeemed. THE fencing point. atomic */
  redeemAttachTicket(t: AttachTicketRedeem): Promise<boolean>;
  /** atomic */
  putRevocation(r: NewRevocation): Promise<void>;
  /** Hot path at handshake. In process cached for 2 seconds. advisory */
  checkRevoked(tenantId: string, checks: RevocationCheck[]): Promise<string | null>;

  createInvite(i: NewInvite): Promise<Invite>;
  /**
   * tx-required: reading the invite, bumping redemptions, and checking the
   * cap must be one atomic step or `maxRedemptions` is racy.
   */
  redeemInvite(tx: StoreTx, secretHash: string, now: Iso): Invite | null;
  revokeInvite(tenantId: string, id: string, by: string): Promise<Invite>;

  // ── placement queue ───────────────────────────────────────────────────
  enqueuePlacement(p: NewPlacement): Promise<PlacementRow>;
  /**
   * Postgres: `SELECT ... FOR UPDATE SKIP LOCKED`. SQLite: an UPDATE with
   * a subquery inside the writer lock, equivalent because there is only
   * one writer. Every returned row carries `appId` and the full
   * `profileKey`; the caller places none of them and must not infer the
   * app from anything else. atomic
   */
  claimPlacements(routerId: string, limit: number): Promise<PlacementRow[]>;
  completePlacement(id: string, instanceId: string): Promise<void>;
  failPlacement(id: string, error: string, retry: boolean): Promise<void>;

  // ── maintenance ───────────────────────────────────────────────────────
  /** Deletes at most `limit` rows. Called repeatedly by the cleanup job. */
  purge(table: PurgeableTable, olderThan: Iso, limit: number): Promise<number>;
  /** SQLite: `PRAGMA optimize` plus incremental vacuum. Postgres: `ANALYZE`. */
  maintain(): Promise<MaintenanceReport>;
  /** Migration runner entry point. */
  migrate(target?: number): Promise<MigrationReport>;
  schemaVersion(): Promise<number>;
}
