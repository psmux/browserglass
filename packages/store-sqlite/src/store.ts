/**
 * `SqliteStore`: the full `@browserglass/protocol` `Store` interface on
 * SQLite via `better-sqlite3`.
 */
import { createHash } from 'node:crypto';
import type {
  App,
  AppKey,
  AttachTicketRedeem,
  AuditEvent,
  AuditPage,
  AuditQuery,
  BrowserSpec,
  BrowserSpecInput,
  ControlLeaseRow,
  Download,
  Instance,
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
  Node,
  NodeHeartbeat,
  NodeStatus,
  PlacementRow,
  Pool,
  Profile,
  ProfileFilter,
  ProfileLease,
  ProfileSnapshot,
  ProfileState,
  PurgeableTable,
  Quota,
  QuotaLimits,
  RevocationCheck,
  SessionRow,
  Store,
  StoreCapabilities,
  StoreTx,
  StoredBrowserSpec,
  Tenant,
  TenantStatus,
  Upload,
  UsageIncrement,
  UsageRow,
  Viewer,
  ViewerClose,
} from '@browserglass/protocol';
import type Database from 'better-sqlite3';
import { TtlCache } from './caches.js';
import { DEFAULT_QUOTA_LIMITS } from './defaults.js';
import { newBrandedId, newRawId } from './ids.js';
import { parseJsonColumn, toJsonColumn } from './json.js';
import {
  rowToApp,
  rowToAppKey,
  rowToAuditEvent,
  rowToControlLeaseRow,
  rowToDownload,
  rowToInstance,
  rowToInvite,
  rowToNode,
  rowToPlacementRow,
  rowToPool,
  rowToProfile,
  rowToProfileLease,
  rowToProfileSnapshot,
  rowToQuota,
  rowToSessionRow,
  rowToStoredBrowserSpec,
  rowToTenant,
  rowToUpload,
  rowToUsageRow,
  rowToViewer,
  storedSpecToBrowserSpec,
} from './mappers.js';
import { MigrationChecksumError, runMigrations, schemaVersionOf } from './migrate.js';
import { purgeTable } from './purge.js';
import { withBusyRetry } from './retry.js';
import type {
  AppKeyRow,
  AppRow,
  AuditEventRow,
  BrowserSpecRow,
  ControlLeaseRowDb,
  DownloadRow,
  InstanceRow,
  InviteRow,
  NodeHeartbeatRow,
  NodeRow,
  PlacementQueueRow,
  PoolRow,
  ProfileLeaseRow,
  ProfileRow,
  ProfileSnapshotRow,
  QuotaRow,
  SessionRowDb,
  TenantRow,
  UploadRow,
  UsageCounterRow,
  ViewerRow,
} from './rows.js';
import { nowIso, toIso } from './time.js';
import { SqliteTx } from './tx.js';

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code?: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

/** In-process concurrency-window quota counters, keyed `${tenantId}:${scope}:${metric}`. See {@link SqliteStore.reserveQuota}'s TSDoc for why this is safe under SQLite's single-writer model without a DDL column. */
type ConcurrentQuotaKey = string;

// ── transitionInstance patch rules ──────────────────────────────────────

/** What `transitionInstance` does with one field of its `Partial<Instance>` patch: write it to `column` (encoding the domain value into the column's storage form), or refuse it and say why. */
type InstancePatchRule<K extends keyof Instance> =
  | { readonly column: string; readonly encode: (value: Instance[K]) => unknown }
  | { readonly rejected: string };

/** {@link InstancePatchRule} with the per-field `encode` signature erased, for the one dispatch site that looks a rule up by a runtime key. */
type LooseInstancePatchRule =
  | { readonly column: string; readonly encode: (value: unknown) => unknown }
  | { readonly rejected: string };

/** Encodes an optional epoch millisecond field into its nullable `TEXT` timestamp column. */
function isoOrNull(value: number | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * Every field of `Instance`, and what `transitionInstance` does with it
 * when a caller puts it in a patch. Nothing is left out and nothing is
 * ignored: a field is either persisted to a real column or refused with a
 * reason the caller can read.
 *
 * This is a mapped type over `keyof Instance` rather than a run of `if
 * (patch?.x !== undefined)` branches, and that is the actual fix. The old
 * shape handled four fields out of twenty three and dropped the rest in
 * silence, because `patch?: Partial<Instance>` makes passing an unhandled
 * field neither a compile error nor a runtime error. It cost two separate
 * defects: `expiresAt` (`0003_instance_expires_at.sql`, every instance's
 * TTL replaced by a fixed default) and then `profileId` and `sessionId`
 * (`instances.profile_id` NULL on all 46 rows of a live demo database,
 * which permanently closed `BrowserRouter.release()`'s `if
 * (instance.profileId)` guard and leaked roughly 3 GB of ephemeral profile
 * directories that were never destroyed).
 *
 * Written this way the trap cannot be re-set. The type annotation makes
 * every key of `Instance` REQUIRED here, so adding a field to the entity
 * fails this file's build until somebody states, in one line, what
 * persisting it means. And a field that reaches the dispatch loop with no
 * rule, or with a `rejected` rule, throws rather than vanishing: a store
 * that discards its caller's data without saying so is worse than one that
 * refuses it.
 */
const INSTANCE_PATCH_RULES: { [K in keyof Instance]-?: InstancePatchRule<K> } = {
  // Identity. These three name the row rather than describe it; `tenantId`
  // and `id` are already the method's own arguments, and an instance never
  // changes app (`instances.app_id` is NOT NULL ON DELETE RESTRICT
  // precisely so an orphaned instance cannot drift between apps, see the FK
  // reasoning block in `0001_initial.sql`).
  id: { rejected: 'an instance id is immutable; the `id` argument selects the row' },
  tenantId: { rejected: 'an instance never moves tenant; the `tenantId` argument selects the row' },
  appId: {
    rejected:
      'an instance never moves app (instances.app_id is NOT NULL ON DELETE RESTRICT by design)',
  },

  // The status transition itself. `to` is the target state and this method
  // stamps `status_since`/`updated_at` from its own clock, so a patch
  // carrying either would be a second, unreconciled opinion about the same
  // two columns.
  state: {
    rejected: 'the `to` argument is the transition target; a patch must not carry a second one',
  },
  stateChangedAt: {
    rejected:
      'this method stamps instances.status_since itself, at the moment the transition applies',
  },

  // Persisted, in DDL column order.
  poolId: { column: 'pool_id', encode: (value) => value },
  subject: { column: 'created_by_sub', encode: (value) => value },
  stateReason: { column: 'status_detail', encode: (value) => value },
  nodeId: {
    column: 'node_id',
    encode: (value) => {
      // `Instance.nodeId` is `NodeId | null` but `instances.node_id` is NOT
      // NULL (ON DELETE CASCADE from `nodes`): an instance always belongs
      // to some node. Caught here so the caller gets the field name rather
      // than a bare SQLITE_CONSTRAINT_NOTNULL from six frames down.
      if (value === null)
        throw new Error(
          'transitionInstance: instances.node_id is NOT NULL, a patch cannot clear it',
        );
      return value;
    },
  },
  // `Instance.fence` reads back from `instances.epoch` (`rowToInstance`),
  // and the router treats the two as one token: `placeAndLaunch` and
  // `reacquireProfileForRestart` both write the PROFILE LEASE's fence here,
  // and `buildResult` reports it straight back out. Written plainly, not as
  // `MAX(epoch, ?)`: silently improving on the caller's value is the same
  // class of bug as silently dropping it. Worth knowing that
  // `Store.bumpInstanceEpoch` increments the same column on a different
  // counter (per instance restarts, versus the lease's per profile grants)
  // and has no production caller today, so this patch is `epoch`'s only
  // writer in practice. If that ever changes, the two counters need
  // reconciling in the router, not papering over here.
  fence: { column: 'epoch', encode: (value) => value },
  profileId: { column: 'profile_id', encode: (value) => value },
  // `0004_instance_session_id.sql`.
  sessionId: { column: 'session_id', encode: (value) => value },
  // `Instance.readyAt` reads back from `instances.launched_at`
  // (`rowToInstance`); there is no `ready_at` column and no need for one.
  readyAt: { column: 'launched_at', encode: isoOrNull },
  releasedAt: { column: 'released_at', encode: isoOrNull },
  lastActivityAt: { column: 'last_active_at', encode: toIso },
  // `0003_instance_expires_at.sql`.
  // `BrowserRouter.placeAndLaunch` computes this from the caller's `ttlMs`
  // and has always passed it in the patch that lands a new instance on
  // `'live'`; this method silently dropped it before the column existed, so
  // `rowToInstance` (mappers.ts) fell back to a fixed
  // `acquiredAt + 14_400_000` no matter what `ttlMs` asked for.
  expiresAt: { column: 'expires_at', encode: toIso },
  acquiredAt: { rejected: 'instances.created_at is set once, at insert' },

  // Not columns on `instances`, and not silently droppable either. Each of
  // these is either derived on read or memory only, so honouring a patch
  // for it would mean writing somewhere this method does not own.
  spec: {
    rejected:
      'the spec is a `browser_specs` row referenced by instances.spec_id; changing it is a relaunch, not a patch',
  },
  profileSpec: {
    rejected:
      'derived on read by `rowToInstance` from the joined `profiles` row, not stored on `instances`',
  },
  runtime: {
    rejected:
      'process memory only (see InstanceRuntimeInfo); the router holds it in `liveRuntimeByInstance`',
  },
  // `0008_instance_metadata_lifetime.sql` gave both of these a real
  // column, but `createInstance` (not this method) is their only writer:
  // both are part of an instance's identity at the moment it is created
  // (what a caller named it, whether it should be reaped on idle), not
  // something a later state transition patches. Still rejected here on
  // purpose, not merely because there is nothing to write to: if a future
  // caller needs to rename a live instance, that is a deliberate new
  // capability to design, not a silent side door through this generic
  // patch.
  metadata: { rejected: 'set once at createInstance; not patchable through transitionInstance' },
  incidents: { rejected: 'no `instances` column; `rowToInstance` always reads it back as []' },
  lifetime: { rejected: 'set once at createInstance; not patchable through transitionInstance' },

  // `entities.ts`'s own doc on each of these five names the one real
  // writer, if it has one. None of the four `rejected` below are silently
  // droppable either: each already has an owner, and a generic patch here
  // would be a second, unreconciled writer of the same column.
  firstViewerAt: {
    rejected:
      "written only by claimWarmInstance's own COALESCE(first_viewer_at, ?); not a generic patch field",
  },
  restartCount: {
    rejected: "written only by bumpInstanceEpoch's own dedicated UPDATE; not a generic patch field",
  },
  peakRssMib: {
    rejected:
      'no writer exists yet (see entities.ts); reserved for a future memory sampling loop, not this generic patch',
  },
  osPid: {
    rejected:
      'no writer exists yet (see entities.ts); reserved for a future writer, not this generic patch',
  },
  // The one WRITABLE field added most recently: `BrowserRouter.release()`'s
  // terminal `'draining' -> 'released'` transition now passes
  // `{ releaseReason: opts.reason ?? 'requested' }` here instead of `{}`,
  // which is what turned this from a column `rowToInstance` silently
  // dropped into one that actually answers "why did this browser close"
  // (`GET /v1/instances/:instanceId/history`, the route this exists for).
  releaseReason: { column: 'release_reason', encode: (value) => value },
};

/**
 * The `store-sqlite` implementation of `@browserglass/protocol`'s `Store`.
 * One instance owns exactly one `better-sqlite3` connection (or one primary
 * plus whatever the caller opens separately for reads; every connection
 * must go through `openSqlite`, never a bare `new Database`, since
 * `foreign_keys = ON` is per-connection).
 */
export class SqliteStore implements Store {
  private readonly appKeyCache = new TtlCache<string, AppKey | null>(
    30_000,
    (v) => v === null,
    5_000,
  );
  private readonly quotaCache = new TtlCache<string, Quota[]>(30_000, () => false);
  private readonly revokedCache = new TtlCache<string, string | null>(2_000, () => false);
  private readonly concurrentQuota = new Map<ConcurrentQuotaKey, number>();

  constructor(
    private readonly db: Database.Database,
    private readonly migrationsDir: string,
  ) {}

  // ── lifecycle ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // init() never migrates on its own; migrate() is an explicit
    // start() step, so a test harness can open a store without mutating it.
    this.db.pragma('quick_check');
  }

  async close(): Promise<void> {
    this.db.close();
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = performance.now();
    this.db.prepare('SELECT 1').get();
    return { ok: true, latencyMs: performance.now() - startedAt };
  }

  capabilities(): StoreCapabilities {
    return {
      transactions: true,
      advisoryLocks: false,
      skipLocked: false,
      notify: false,
      concurrentWriters: false,
      maxWriteConcurrency: 1,
    };
  }

  // ── transactions ──────────────────────────────────────────────────────

  async transaction<T>(
    fn: (tx: StoreTx) => T,
    _opts?: { isolation?: 'read-committed' | 'serializable'; retries?: number },
  ): Promise<T> {
    return withBusyRetry(() => {
      const tx = new SqliteTx(this.db);
      const wrapped = this.db.transaction((): T => fn(tx));
      return wrapped.immediate();
    }, 'transaction');
  }

  // ── tenants / apps / keys ────────────────────────────────────────────

  private loadQuotaLimits(tenantId: string, scope: string): QuotaLimits {
    const rows = this.db
      .prepare('SELECT metric, limit_value FROM quotas WHERE tenant_id = ? AND scope = ?')
      .all(tenantId, scope) as { metric: string; limit_value: number }[];
    const result: Record<string, number> = { ...DEFAULT_QUOTA_LIMITS };
    for (const r of rows) {
      if (r.metric in result) result[r.metric] = r.limit_value;
    }
    return result as unknown as QuotaLimits;
  }

  async getTenant(id: string): Promise<Tenant | null> {
    return withBusyRetry(() => {
      const row = this.db.prepare('SELECT * FROM tenants WHERE id = ?').get(id) as
        | TenantRow
        | undefined;
      if (!row) return null;
      return rowToTenant(row, this.loadQuotaLimits(row.id, 'tenant'));
    }, 'getTenant');
  }

  async listTenants(f?: { status?: TenantStatus }): Promise<Tenant[]> {
    return withBusyRetry(() => {
      const rows = (
        f?.status
          ? this.db
              .prepare('SELECT * FROM tenants WHERE status = ? ORDER BY created_at')
              .all(f.status)
          : this.db
              .prepare("SELECT * FROM tenants WHERE status <> 'deleted' ORDER BY created_at")
              .all()
      ) as TenantRow[];
      return rows.map((row) => rowToTenant(row, this.loadQuotaLimits(row.id, 'tenant')));
    }, 'listTenants');
  }

  async createTenant(t: NewTenant): Promise<Tenant> {
    return withBusyRetry(() => {
      const id = t.id ?? (newBrandedId('ten') as Tenant['id']);
      const now = nowIso();
      const policy = toJsonColumn({
        ...(t.policy ?? {}),
        defaults: t.defaults ?? {},
        labels: t.labels ?? {},
      });
      const row = this.db
        .prepare(
          `INSERT INTO tenants (id, name, status, allowed_caps, node_pin, policy, audit_chain, created_at, updated_at, deleted_at)
           VALUES (?, ?, 'active', ?, ?, ?, 0, ?, ?, NULL) RETURNING *`,
        )
        .get(
          id,
          t.name,
          toJsonColumn(t.allowedCaps ?? []),
          t.nodePin ? toJsonColumn(t.nodePin) : null,
          policy,
          now,
          now,
        ) as TenantRow;
      return rowToTenant(row, t.quotas ?? DEFAULT_QUOTA_LIMITS);
    }, 'createTenant');
  }

  async updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant> {
    return withBusyRetry(() => {
      const now = nowIso();
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [now];
      if (patch.name !== undefined) {
        sets.push('name = ?');
        params.push(patch.name);
      }
      if (patch.labels !== undefined || patch.defaults !== undefined) {
        const existing = this.db.prepare('SELECT policy FROM tenants WHERE id = ?').get(id) as
          | { policy: string }
          | undefined;
        const current = parseJsonColumn<Record<string, unknown>>(existing?.policy ?? '{}', {});
        sets.push('policy = ?');
        params.push(
          toJsonColumn({
            ...current,
            labels: patch.labels ?? current['labels'],
            defaults: patch.defaults ?? current['defaults'],
          }),
        );
      }
      params.push(id);
      const row = this.db
        .prepare(`UPDATE tenants SET ${sets.join(', ')} WHERE id = ? RETURNING *`)
        .get(...params) as TenantRow | undefined;
      if (!row) throw new Error(`updateTenant: no tenant with id ${id}`);
      return rowToTenant(row, patch.quotas ?? this.loadQuotaLimits(id, 'tenant'));
    }, 'updateTenant');
  }

  async setTenantStatus(id: string, status: TenantStatus): Promise<void> {
    await withBusyRetry(() => {
      const deletedAt = status === 'deleted' ? nowIso() : null;
      this.db
        .prepare('UPDATE tenants SET status = ?, updated_at = ?, deleted_at = ? WHERE id = ?')
        .run(status, nowIso(), deletedAt, id);
    }, 'setTenantStatus');
  }

  async getApp(tenantId: string, appId: string): Promise<App | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM apps WHERE tenant_id = ? AND id = ?')
        .get(tenantId, appId) as AppRow | undefined;
      return row ? rowToApp(row) : null;
    }, 'getApp');
  }

  async listApps(tenantId: string): Promise<App[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare('SELECT * FROM apps WHERE tenant_id = ? ORDER BY created_at')
        .all(tenantId) as AppRow[];
      return rows.map(rowToApp);
    }, 'listApps');
  }

  async createApp(a: NewApp): Promise<App> {
    return withBusyRetry(() => {
      const id = a.id ?? (newBrandedId('app') as App['id']);
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO apps (id, tenant_id, name, max_caps, default_pool_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?) RETURNING *`,
        )
        .get(
          id,
          a.tenantId,
          a.name,
          toJsonColumn(a.maxCaps ?? a.grantableCapabilities ?? []),
          a.defaultPoolId ?? null,
          now,
          now,
        ) as AppRow;
      return rowToApp(row);
    }, 'createApp');
  }

  async updateApp(tenantId: string, appId: string, p: Partial<App>): Promise<App> {
    return withBusyRetry(() => {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso()];
      if (p.name !== undefined) {
        sets.push('name = ?');
        params.push(p.name);
      }
      if (p.state !== undefined) {
        sets.push('status = ?');
        params.push(p.state);
      }
      if (p.grantableCapabilities !== undefined) {
        sets.push('max_caps = ?');
        params.push(toJsonColumn(p.grantableCapabilities));
      }
      if (p.defaultPoolId !== undefined) {
        sets.push('default_pool_id = ?');
        params.push(p.defaultPoolId);
      }
      params.push(tenantId, appId);
      const row = this.db
        .prepare(`UPDATE apps SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ? RETURNING *`)
        .get(...params) as AppRow | undefined;
      if (!row) throw new Error(`updateApp: no app ${appId} in tenant ${tenantId}`);
      return rowToApp(row);
    }, 'updateApp');
  }

  async getAppKey(appId: string, kid: string): Promise<AppKey | null> {
    const cacheKey = `${appId}:${kid}`;
    const now = Date.now();
    const cached = this.appKeyCache.get(cacheKey, now);
    if (cached.hit) return cached.value;
    const value = await withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM app_keys WHERE app_id = ? AND id = ?')
        .get(appId, kid) as AppKeyRow | undefined;
      return row ? rowToAppKey(row) : null;
    }, 'getAppKey');
    this.appKeyCache.set(cacheKey, value, now);
    return value;
  }

  async listAppKeys(appId: string): Promise<AppKey[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare('SELECT * FROM app_keys WHERE app_id = ? ORDER BY created_at')
        .all(appId) as AppKeyRow[];
      return rows.map(rowToAppKey);
    }, 'listAppKeys');
  }

  async createAppKey(k: NewAppKey): Promise<AppKey> {
    // A row must never carry both publicKey and secretEnc,
    // enforced here in the application layer, not by a database CHECK.
    if (k.publicKey && k.secretEnc) {
      throw new Error('createAppKey: a key row must not carry both publicKey and secretEnc');
    }
    return withBusyRetry(() => {
      const id = k.id ?? newBrandedId('key');
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO app_keys (id, app_id, tenant_id, alg, public_key, secret_enc, status, not_before, not_after, activated_at, retired_at, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, NULL, ?) RETURNING *`,
        )
        .get(
          id,
          k.appId,
          k.tenantId,
          k.alg,
          k.publicKey ?? null,
          k.secretEnc ?? null,
          k.notBefore,
          k.notAfter ?? null,
          now,
        ) as AppKeyRow;
      return rowToAppKey(row);
    }, 'createAppKey');
  }

  rotateAppKey(tx: StoreTx, appId: string, newKid: string): void {
    const now = nowIso();
    tx.raw('UPDATE app_keys SET status = ?, retired_at = ? WHERE app_id = ? AND status = ?', [
      'retiring',
      now,
      appId,
      'active',
    ]);
    tx.raw('UPDATE app_keys SET status = ?, activated_at = ? WHERE app_id = ? AND id = ?', [
      'active',
      now,
      appId,
      newKid,
    ]);
  }

  async revokeAppKey(appId: string, kid: string, immediate: boolean): Promise<void> {
    await withBusyRetry(() => {
      const status = immediate ? 'revoked' : 'retiring';
      const now = nowIso();
      this.db
        .prepare(
          `UPDATE app_keys SET status = ?, ${immediate ? 'revoked_at' : 'retired_at'} = ? WHERE app_id = ? AND id = ?`,
        )
        .run(status, now, appId, kid);
      this.appKeyCache.invalidate(`${appId}:${kid}`);
    }, 'revokeAppKey');
  }

  // ── pools and specs ──────────────────────────────────────────────────

  private loadSpecForPool(row: PoolRow): StoredBrowserSpec {
    const specRow = this.db
      .prepare('SELECT * FROM browser_specs WHERE id = ?')
      .get(row.spec_id) as BrowserSpecRow;
    return rowToStoredBrowserSpec(specRow);
  }

  async getPool(tenantId: string, poolId: string): Promise<Pool | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM pools WHERE tenant_id = ? AND id = ?')
        .get(tenantId, poolId) as PoolRow | undefined;
      return row ? rowToPool(row, this.loadSpecForPool(row)) : null;
    }, 'getPool');
  }

  async getPoolByName(tenantId: string, name: string): Promise<Pool | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM pools WHERE tenant_id = ? AND name = ?')
        .get(tenantId, name) as PoolRow | undefined;
      return row ? rowToPool(row, this.loadSpecForPool(row)) : null;
    }, 'getPoolByName');
  }

  async listPools(tenantId: string): Promise<Pool[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare('SELECT * FROM pools WHERE tenant_id = ? ORDER BY created_at')
        .all(tenantId) as PoolRow[];
      return rows.map((row) => rowToPool(row, this.loadSpecForPool(row)));
    }, 'listPools');
  }

  async createPool(p: NewPool): Promise<Pool> {
    return withBusyRetry(() => {
      const id = p.id ?? (newBrandedId('pol') as Pool['id']);
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO pools (id, tenant_id, name, spec_id, min_warm, max_instances, placement, idle_timeout_ms, max_duration_ms, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) RETURNING *`,
        )
        .get(
          id,
          p.tenantId,
          p.name,
          p.specId,
          p.minWarm ?? 0,
          p.maxInstances ?? 10,
          toJsonColumn(p.placement ?? {}),
          p.idleTimeoutMs ?? 900000,
          p.maxDurationMs ?? 14400000,
          now,
          now,
        ) as PoolRow;
      return rowToPool(row, this.loadSpecForPool(row));
    }, 'createPool');
  }

  async updatePool(tenantId: string, poolId: string, p: Partial<Pool>): Promise<Pool> {
    return withBusyRetry(() => {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso()];
      if (p.name !== undefined) {
        sets.push('name = ?');
        params.push(p.name);
      }
      if (p.state !== undefined) {
        sets.push('status = ?');
        params.push(p.state === 'paused' ? 'draining' : p.state);
      }
      // `Pool.template` carries the full resolved `BrowserSpec`, never a
      // raw content addressed id, so a caller repointing a pool at an
      // already-upserted `browser_specs` row (`upsertBrowserSpec` mints a
      // new id on any spec edit, since it addresses by digest) has no
      // typed field on `Partial<Pool>` to put it in. Read here via a
      // narrow local cast rather than widening `Store.updatePool`'s shared
      // interface (protocol's surface, not this package's to change).
      // Without this, a long lived pool row was stuck on whatever spec it
      // was created with forever: exactly what the demo hit, its pool row
      // surviving in `data/bgls.db` across restarts with a stale `spec_id`
      // no matter how the spec content changed.
      const specId = (p as Partial<Pool> & { specId?: string }).specId;
      if (specId !== undefined) {
        sets.push('spec_id = ?');
        params.push(specId);
      }
      if (p.limits?.maxInstances !== undefined) {
        sets.push('max_instances = ?');
        params.push(p.limits.maxInstances);
      }
      if (p.limits?.sessionMaxDurationMs !== undefined) {
        sets.push('max_duration_ms = ?');
        params.push(p.limits.sessionMaxDurationMs);
      }
      // `idle_timeout_ms` backs both `Pool.warm.maxIdleMs` and
      // `Pool.limits.sessionIdleMs` (see `rowToPool` in mappers.ts): one
      // column, two mapped fields. `limits.sessionIdleMs` wins if a patch
      // somehow sets both.
      const idleTimeoutMs = p.limits?.sessionIdleMs ?? p.warm?.maxIdleMs;
      if (idleTimeoutMs !== undefined) {
        sets.push('idle_timeout_ms = ?');
        params.push(idleTimeoutMs);
      }
      if (p.warm?.min !== undefined) {
        sets.push('min_warm = ?');
        params.push(p.warm.min);
      }
      if (p.placement !== undefined) {
        sets.push('placement = ?');
        params.push(toJsonColumn(p.placement));
      }
      params.push(tenantId, poolId);
      const row = this.db
        .prepare(`UPDATE pools SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ? RETURNING *`)
        .get(...params) as PoolRow | undefined;
      if (!row) throw new Error(`updatePool: no pool ${poolId} in tenant ${tenantId}`);
      return rowToPool(row, this.loadSpecForPool(row));
    }, 'updatePool');
  }

  async upsertBrowserSpec(tenantId: string, spec: BrowserSpecInput): Promise<StoredBrowserSpec> {
    return withBusyRetry(() => {
      const digest = digestOfSpec(spec);
      const existing = this.db
        .prepare('SELECT * FROM browser_specs WHERE tenant_id = ? AND digest = ?')
        .get(tenantId, digest) as BrowserSpecRow | undefined;
      if (existing) return rowToStoredBrowserSpec(existing);
      const id = newBrandedId('bsp');
      const row = this.db
        .prepare(
          `INSERT INTO browser_specs (id, tenant_id, digest, engine, channel, headless, isolation, viewport_w, viewport_h, dpr, locale, timezone, user_agent, client_hints, init_scripts, remote_endpoint_name, proxy, args, extensions, stealth, limits, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          tenantId,
          digest,
          spec.engine,
          spec.channel,
          spec.headless,
          spec.isolation ?? 'tab',
          spec.viewportW,
          spec.viewportH,
          spec.dpr,
          spec.locale,
          spec.timezone,
          spec.userAgent,
          spec.clientHints ? toJsonColumn(spec.clientHints) : null,
          spec.initScripts ? toJsonColumn(spec.initScripts) : null,
          spec.remoteEndpointName ?? null,
          spec.proxy ? toJsonColumn(spec.proxy) : null,
          toJsonColumn(spec.args),
          toJsonColumn(spec.extensions),
          spec.stealth,
          toJsonColumn(spec.limits),
          nowIso(),
        ) as BrowserSpecRow;
      return rowToStoredBrowserSpec(row);
    }, 'upsertBrowserSpec');
  }

  async getBrowserSpec(tenantId: string, specId: string): Promise<StoredBrowserSpec | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM browser_specs WHERE tenant_id = ? AND id = ?')
        .get(tenantId, specId) as BrowserSpecRow | undefined;
      return row ? rowToStoredBrowserSpec(row) : null;
    }, 'getBrowserSpec');
  }

  // ── profiles ──────────────────────────────────────────────────────────

  private loadLiveLease(profileId: string): ProfileLease | null {
    const row = this.db
      .prepare('SELECT * FROM profile_leases WHERE profile_id = ? AND released_at IS NULL')
      .get(profileId) as ProfileLeaseRow | undefined;
    return row ? rowToProfileLease(row) : null;
  }

  async getProfile(tenantId: string, profileId: string): Promise<Profile | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM profiles WHERE tenant_id = ? AND id = ?')
        .get(tenantId, profileId) as ProfileRow | undefined;
      return row ? rowToProfile(row, this.loadLiveLease(row.id)) : null;
    }, 'getProfile');
  }

  async getProfileByKey(tenantId: string, appId: string, key: string): Promise<Profile | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM profiles WHERE tenant_id = ? AND app_id = ? AND key = ?')
        .get(tenantId, appId, key) as ProfileRow | undefined;
      return row ? rowToProfile(row, this.loadLiveLease(row.id)) : null;
    }, 'getProfileByKey');
  }

  async listProfiles(tenantId: string, f?: ProfileFilter): Promise<Profile[]> {
    return withBusyRetry(() => {
      const clauses = ['tenant_id = ?'];
      const params: unknown[] = [tenantId];
      if (f?.appId) {
        clauses.push('app_id = ?');
        params.push(f.appId);
      }
      if (f?.state) {
        const states = Array.isArray(f.state) ? f.state : [f.state];
        clauses.push(`state IN (${states.map(() => '?').join(', ')})`);
        params.push(...states);
      }
      if (f?.homeNodeId) {
        clauses.push('home_node_id = ?');
        params.push(f.homeNodeId);
      }
      if (f?.keyPrefix) {
        clauses.push('key LIKE ?');
        params.push(`${f.keyPrefix}%`);
      }
      const limit = f?.limit ?? 200;
      const rows = this.db
        .prepare(
          `SELECT * FROM profiles WHERE ${clauses.join(' AND ')} ORDER BY created_at LIMIT ?`,
        )
        .all(...params, limit) as ProfileRow[];
      return rows.map((row) => rowToProfile(row, this.loadLiveLease(row.id)));
    }, 'listProfiles');
  }

  async createProfile(p: NewProfile): Promise<Profile> {
    return withBusyRetry(() => {
      const id = p.id ?? (newBrandedId('prf') as Profile['id']);
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO profiles (id, tenant_id, app_id, key, mode, template_id, storage_path, home_node_id, size_bytes, size_measured_at, encryption_key_id, state, ttl_ms, expires_at, last_used_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'creating', ?, NULL, NULL, ?, ?) RETURNING *`,
        )
        .get(
          id,
          p.tenantId,
          p.appId,
          p.key,
          p.mode,
          p.templateId ?? null,
          p.storagePath,
          p.homeNodeId ?? null,
          p.encryptionKeyId ?? null,
          p.ttlMs ?? null,
          now,
          now,
        ) as ProfileRow;
      return rowToProfile(row, null);
    }, 'createProfile');
  }

  async updateProfile(tenantId: string, id: string, p: Partial<Profile>): Promise<Profile> {
    return withBusyRetry(() => {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso()];
      if (p.state !== undefined) {
        sets.push('state = ?');
        params.push(p.state);
      }
      if (p.sizeBytes !== undefined) {
        sets.push('size_bytes = ?, size_measured_at = ?');
        params.push(p.sizeBytes, nowIso());
      }
      if (p.lastUsedAt !== undefined) {
        sets.push('last_used_at = ?');
        params.push(toIso(p.lastUsedAt));
      }
      if (p.expiresAt !== undefined) {
        sets.push('expires_at = ?');
        params.push(p.expiresAt === null ? null : toIso(p.expiresAt));
      }
      if (p.homeNodeId !== undefined) {
        sets.push('home_node_id = ?');
        params.push(p.homeNodeId);
      }
      params.push(tenantId, id);
      const row = this.db
        .prepare(
          `UPDATE profiles SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ? RETURNING *`,
        )
        .get(...params) as ProfileRow | undefined;
      if (!row) throw new Error(`updateProfile: no profile ${id} in tenant ${tenantId}`);
      return rowToProfile(row, this.loadLiveLease(row.id));
    }, 'updateProfile');
  }

  async setProfileState(tenantId: string, id: string, s: ProfileState): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare('UPDATE profiles SET state = ?, updated_at = ? WHERE tenant_id = ? AND id = ?')
        .run(s, nowIso(), tenantId, id);
    }, 'setProfileState');
  }

  async deleteProfile(tenantId: string, id: string): Promise<void> {
    await withBusyRetry(() => {
      this.db.prepare('DELETE FROM profiles WHERE tenant_id = ? AND id = ?').run(tenantId, id);
    }, 'deleteProfile');
  }

  /**
   * THE critical method. Never a SELECT to check for an
   * existing live lease followed by an INSERT: the INSERT itself, relying
   * on the partial unique index `idx_profile_lease_live`, IS the mutual
   * exclusion boundary. `fence` is computed as `max(fence) + 1` inside the
   * same `BEGIN IMMEDIATE` transaction that holds SQLite's single writer
   * lock for its whole duration, so no other write can interleave between
   * the read and the insert.
   */
  async acquireProfileLease(req: {
    tenantId: string;
    profileId: string;
    nodeId: string;
    instanceId?: string;
    holderPid?: number;
    ttlMs: number;
  }): Promise<ProfileLease | null> {
    return withBusyRetry(() => {
      const wrapped = this.db.transaction((): ProfileLease | null => {
        const maxFence = this.db
          .prepare('SELECT MAX(fence) AS f FROM profile_leases WHERE profile_id = ?')
          .get(req.profileId) as {
          f: number | null;
        };
        const fence = (maxFence.f ?? 0) + 1;
        const id = newBrandedId('plse');
        const now = Date.now();
        const nowStr = toIso(now);
        const expiresStr = toIso(now + req.ttlMs);
        let row: ProfileLeaseRow;
        try {
          row = this.db
            .prepare(
              `INSERT INTO profile_leases (id, profile_id, tenant_id, instance_id, node_id, holder_pid, fence, acquired_at, heartbeat_at, expires_at, released_at, release_reason)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL) RETURNING *`,
            )
            .get(
              id,
              req.profileId,
              req.tenantId,
              req.instanceId ?? null,
              req.nodeId,
              req.holderPid ?? null,
              fence,
              nowStr,
              nowStr,
              expiresStr,
            ) as ProfileLeaseRow;
        } catch (err) {
          if (isUniqueConstraintError(err)) return null; // another live lease already exists
          throw err;
        }
        return rowToProfileLease(row);
      });
      return wrapped.immediate();
    }, 'acquireProfileLease');
  }

  async heartbeatProfileLease(leaseId: string, ttlMs: number): Promise<boolean> {
    return withBusyRetry(() => {
      const now = Date.now();
      const info = this.db
        .prepare(
          'UPDATE profile_leases SET heartbeat_at = ?, expires_at = ? WHERE id = ? AND released_at IS NULL',
        )
        .run(toIso(now), toIso(now + ttlMs), leaseId);
      return info.changes > 0;
    }, 'heartbeatProfileLease');
  }

  async releaseProfileLease(leaseId: string, reason: string): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare(
          'UPDATE profile_leases SET released_at = ?, release_reason = ? WHERE id = ? AND released_at IS NULL',
        )
        .run(nowIso(), reason, leaseId);
    }, 'releaseProfileLease');
  }

  async expireProfileLeases(now: string, limit: number): Promise<ProfileLease[]> {
    return withBusyRetry(() => {
      const wrapped = this.db.transaction((): ProfileLease[] => {
        const candidates = this.db
          .prepare(
            'SELECT id FROM profile_leases WHERE released_at IS NULL AND expires_at < ? LIMIT ?',
          )
          .all(now, limit) as { id: string }[];
        const reclaimed: ProfileLease[] = [];
        for (const { id } of candidates) {
          const row = this.db
            .prepare(
              "UPDATE profile_leases SET released_at = ?, release_reason = 'expired' WHERE id = ? AND released_at IS NULL RETURNING *",
            )
            .get(now, id) as ProfileLeaseRow | undefined;
          if (row) reclaimed.push(rowToProfileLease(row));
        }
        return reclaimed;
      });
      return wrapped.immediate();
    }, 'expireProfileLeases');
  }

  async createSnapshot(s: NewSnapshot): Promise<ProfileSnapshot> {
    return withBusyRetry(() => {
      const id = s.id ?? newBrandedId('snp');
      const row = this.db
        .prepare(
          `INSERT INTO profile_snapshots (id, profile_id, tenant_id, label, storage_path, size_bytes, content_hash, encryption_key_id, created_by, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'creating', ?) RETURNING *`,
        )
        .get(
          id,
          s.profileId,
          s.tenantId,
          s.label ?? null,
          s.storagePath,
          s.sizeBytes,
          s.contentHash,
          s.encryptionKeyId ?? null,
          s.createdBy ?? null,
          nowIso(),
        ) as ProfileSnapshotRow;
      return rowToProfileSnapshot(row);
    }, 'createSnapshot');
  }

  async listSnapshots(tenantId: string, profileId: string): Promise<ProfileSnapshot[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare(
          'SELECT * FROM profile_snapshots WHERE tenant_id = ? AND profile_id = ? ORDER BY created_at DESC',
        )
        .all(tenantId, profileId) as ProfileSnapshotRow[];
      return rows.map(rowToProfileSnapshot);
    }, 'listSnapshots');
  }

  async deleteSnapshot(tenantId: string, snapshotId: string): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare('DELETE FROM profile_snapshots WHERE tenant_id = ? AND id = ?')
        .run(tenantId, snapshotId);
    }, 'deleteSnapshot');
  }

  // ── nodes ─────────────────────────────────────────────────────────────

  private loadHeartbeat(nodeId: string): NodeHeartbeatRow | null {
    return (
      (this.db.prepare('SELECT * FROM node_heartbeats WHERE node_id = ?').get(nodeId) as
        | NodeHeartbeatRow
        | undefined) ?? null
    );
  }

  private loadHostedProfileKeys(nodeId: string): string[] {
    const rows = this.db
      .prepare("SELECT key FROM profiles WHERE home_node_id = ? AND state <> 'deleted'")
      .all(nodeId) as {
      key: string;
    }[];
    return rows.map((r) => r.key);
  }

  /**
   * Upserts on `id`: registering with an id already present in `nodes`
   * updates that row in place (name, address, `dataAddress`, capacity,
   * labels, `registrationSecretEnc`, status reset to `'joining'`) rather
   * than throwing on the primary key or minting a second row, so a node
   * process that restarts under the SAME `id` (an operator configured
   * `peer.nodeId`, `@browserglass/server`'s `docs/scaling.md`) keeps the
   * durable identity every `instances.node_id`/`profile_leases.node_id`
   * foreign key already points at, instead of orphaning them under a dead
   * id. `created_at` is deliberately left out of the `DO UPDATE SET` list,
   * so it keeps the row's original registration time across every
   * re-register; `status` is reset to `'joining'` on every registration,
   * fresh or repeat, since a node that just started has not gone through
   * `setNodeStatus('ready')`/a heartbeat again yet, matching exactly what
   * a brand new row's own initial status already meant. Omitting `id`
   * still mints a fresh one every call, unchanged.
   */
  async registerNode(n: NewNode): Promise<Node> {
    return withBusyRetry(() => {
      const id = n.id ?? (newBrandedId('nod') as Node['id']);
      const now = nowIso();
      const capacity = {
        maxInstances: n.capacity?.maxInstances,
        memMiB: n.capacity?.maxMemoryMb,
        cpus: n.capacity?.cpuCores,
        profileDiskMb: n.capacity?.profileDiskMb,
        maxConcurrentLaunches: n.capacity?.maxConcurrentLaunches,
      };
      const row = this.db
        .prepare(
          `INSERT INTO nodes (id, name, region, zone, runtime, address, data_address, registration_secret_enc, labels, tenant_pin, capacity, version, status, status_since, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'joining', ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET
             name = excluded.name,
             region = excluded.region,
             zone = excluded.zone,
             runtime = excluded.runtime,
             address = excluded.address,
             data_address = excluded.data_address,
             registration_secret_enc = excluded.registration_secret_enc,
             labels = excluded.labels,
             tenant_pin = excluded.tenant_pin,
             capacity = excluded.capacity,
             version = excluded.version,
             status = 'joining',
             status_since = excluded.status_since,
             updated_at = excluded.updated_at
           RETURNING *`,
        )
        .get(
          id,
          n.name,
          n.region ?? null,
          n.zone ?? null,
          n.runtime,
          n.address,
          n.dataAddress ?? null,
          n.registrationSecretEnc,
          toJsonColumn(n.labels ?? {}),
          n.tenantPin ? toJsonColumn(n.tenantPin) : null,
          toJsonColumn(capacity),
          n.version ?? null,
          now,
          now,
          now,
        ) as NodeRow;
      // `loadHeartbeat`/`loadHostedProfileKeys`, not the fresh-insert `null`/`[]`
      // a genuinely new row would have: a re-registration keeps whatever
      // `node_heartbeats`/hosted profile rows the node's PREVIOUS life left
      // behind (this upsert never touches either table), so the returned
      // `Node` should report them honestly rather than pretend a restart
      // erased history it did not.
      return rowToNode(row, this.loadHeartbeat(row.id), this.loadHostedProfileKeys(row.id));
    }, 'registerNode');
  }

  async getNode(id: string): Promise<Node | null> {
    return withBusyRetry(() => {
      const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
        | NodeRow
        | undefined;
      return row
        ? rowToNode(row, this.loadHeartbeat(row.id), this.loadHostedProfileKeys(row.id))
        : null;
    }, 'getNode');
  }

  async listNodes(f?: { status?: NodeStatus[]; region?: string }): Promise<Node[]> {
    return withBusyRetry(() => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (f?.status && f.status.length > 0) {
        clauses.push(`status IN (${f.status.map(() => '?').join(', ')})`);
        params.push(...f.status);
      }
      if (f?.region) {
        clauses.push('region = ?');
        params.push(f.region);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = this.db
        .prepare(`SELECT * FROM nodes ${where} ORDER BY created_at`)
        .all(...params) as NodeRow[];
      return rows.map((row) =>
        rowToNode(row, this.loadHeartbeat(row.id), this.loadHostedProfileKeys(row.id)),
      );
    }, 'listNodes');
  }

  async setNodeStatus(id: string, s: NodeStatus, detail?: string): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare('UPDATE nodes SET status = ?, status_since = ?, updated_at = ? WHERE id = ?')
        .run(s, nowIso(), nowIso(), id);
      void detail; // the nodes DDL has no status_detail column; kept as a caller-facing hint only.
    }, 'setNodeStatus');
  }

  async heartbeatNode(h: NodeHeartbeat): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare(
          `INSERT INTO node_heartbeats (node_id, beat_at, seq, live_instances, mem_free_mib, cpu_load_pct, disk_free_mib, detail)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (node_id) DO UPDATE SET
             beat_at = excluded.beat_at, seq = excluded.seq, live_instances = excluded.live_instances,
             mem_free_mib = excluded.mem_free_mib, cpu_load_pct = excluded.cpu_load_pct,
             disk_free_mib = excluded.disk_free_mib, detail = excluded.detail`,
        )
        .run(
          h.nodeId,
          h.beatAt,
          h.seq,
          h.liveInstances,
          h.memFreeMib ?? null,
          h.cpuLoadPct ?? null,
          h.diskFreeMib ?? null,
          toJsonColumn(h.detail ?? {}),
        );
    }, 'heartbeatNode');
  }

  async findStaleNodes(olderThan: string): Promise<Node[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare(
          `SELECT nodes.* FROM nodes
           LEFT JOIN node_heartbeats ON node_heartbeats.node_id = nodes.id
           WHERE nodes.status IN ('ready', 'draining')
             AND (node_heartbeats.beat_at IS NULL OR node_heartbeats.beat_at < ?)`,
        )
        .all(olderThan) as NodeRow[];
      return rows.map((row) =>
        rowToNode(row, this.loadHeartbeat(row.id), this.loadHostedProfileKeys(row.id)),
      );
    }, 'findStaleNodes');
  }

  // ── instances ─────────────────────────────────────────────────────────

  private loadInstanceDeps(row: InstanceRow): { spec: BrowserSpec; profile: Profile | null } {
    const specRow = this.db
      .prepare('SELECT * FROM browser_specs WHERE id = ?')
      .get(row.spec_id) as BrowserSpecRow;
    const spec = storedSpecToBrowserSpec(rowToStoredBrowserSpec(specRow));
    const profile = row.profile_id
      ? (() => {
          const profileRow = this.db
            .prepare('SELECT * FROM profiles WHERE id = ?')
            .get(row.profile_id) as ProfileRow | undefined;
          return profileRow ? rowToProfile(profileRow, this.loadLiveLease(profileRow.id)) : null;
        })()
      : null;
    return { spec, profile };
  }

  private hydrateInstance(row: InstanceRow): Instance {
    const { spec, profile } = this.loadInstanceDeps(row);
    return rowToInstance(row, spec, profile);
  }

  async createInstance(i: NewInstance): Promise<Instance> {
    return withBusyRetry(() => {
      const id = i.id ?? (newBrandedId('inst') as Instance['id']);
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO instances (id, tenant_id, app_id, pool_id, spec_id, profile_id, node_id, epoch, cdp_endpoint, os_pid, container_id, status, status_since, status_detail, created_by_sub, created_by_jti, launched_at, first_viewer_at, last_active_at, released_at, release_reason, restart_count, peak_rss_mib, expires_at, session_id, metadata, lifetime, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, 'launching', ?, NULL, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          i.tenantId,
          i.appId,
          i.poolId ?? null,
          i.specId,
          i.profileId ?? null,
          i.nodeId,
          now,
          i.createdBySub ?? null,
          i.createdByJti ?? null,
          toJsonColumn(i.metadata),
          i.lifetime,
          now,
          now,
        ) as InstanceRow;
      return this.hydrateInstance(row);
    }, 'createInstance');
  }

  async getInstance(tenantId: string, id: string): Promise<Instance | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM instances WHERE tenant_id = ? AND id = ?')
        .get(tenantId, id) as InstanceRow | undefined;
      return row ? this.hydrateInstance(row) : null;
    }, 'getInstance');
  }

  async listInstances(tenantId: string, f?: InstanceFilter): Promise<Instance[]> {
    return withBusyRetry(() => {
      const clauses = ['tenant_id = ?'];
      const params: unknown[] = [tenantId];
      if (f?.status) {
        const statuses = Array.isArray(f.status) ? f.status : [f.status];
        clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`);
        params.push(...statuses);
      }
      if (f?.poolId) {
        clauses.push('pool_id = ?');
        params.push(f.poolId);
      }
      if (f?.nodeId) {
        clauses.push('node_id = ?');
        params.push(f.nodeId);
      }
      if (f?.createdBySub) {
        clauses.push('created_by_sub = ?');
        params.push(f.createdBySub);
      }
      const limit = f?.limit ?? 200;
      const rows = this.db
        .prepare(
          `SELECT * FROM instances WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...params, limit) as InstanceRow[];
      return rows.map((row) => this.hydrateInstance(row));
    }, 'listInstances');
  }

  /**
   * Compare-and-set on `instances.status`, one of the store's "atomic
   * five" (#4). Every field of `patch` is either written to its column or
   * refused with an error; see {@link INSTANCE_PATCH_RULES} for why it is
   * spelled as an exhaustive table rather than a run of `if` statements.
   */
  async transitionInstance(
    tenantId: string,
    id: string,
    from: InstanceStatus[],
    to: InstanceStatus,
    patch?: Partial<Instance>,
  ): Promise<boolean> {
    return withBusyRetry(() => {
      const sets: string[] = ['status = ?', 'status_since = ?', 'updated_at = ?'];
      const params: unknown[] = [to, nowIso(), nowIso()];
      for (const [field, value] of Object.entries(patch ?? {})) {
        // `exactOptionalPropertyTypes` still lets a caller write
        // `{ stateReason: undefined }` explicitly, and every historical
        // branch here treated that as "not supplied". Keep that.
        if (value === undefined) continue;
        // The table's own type guarantees a rule exists for every key of
        // `Instance`; this cast is only to collapse the per field `encode`
        // signatures, which as a union would demand an argument satisfying
        // all of them at once. `field` can still be a key `Instance` does
        // not declare (a caller who widened the type on its way in), which
        // is what the `undefined` arm below is for.
        const rule = INSTANCE_PATCH_RULES[field as keyof Instance] as
          | LooseInstancePatchRule
          | undefined;
        if (rule === undefined) {
          throw new Error(
            `transitionInstance: patch field ${JSON.stringify(field)} is not a field of Instance, so this store has no column for it`,
          );
        }
        if ('rejected' in rule) {
          throw new Error(
            `transitionInstance: refusing patch field ${JSON.stringify(field)}: ${rule.rejected}`,
          );
        }
        sets.push(`${rule.column} = ?`);
        params.push(rule.encode(value));
      }
      const fromPlaceholders = from.map(() => '?').join(', ');
      params.push(tenantId, id, ...from);
      const info = this.db
        .prepare(
          `UPDATE instances SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ? AND status IN (${fromPlaceholders})`,
        )
        .run(...params);
      return info.changes > 0;
    }, 'transitionInstance');
  }

  async bumpInstanceEpoch(tenantId: string, id: string): Promise<number> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare(
          'UPDATE instances SET epoch = epoch + 1, restart_count = restart_count + 1, updated_at = ? WHERE tenant_id = ? AND id = ? RETURNING epoch',
        )
        .get(nowIso(), tenantId, id) as { epoch: number } | undefined;
      if (!row) throw new Error(`bumpInstanceEpoch: no instance ${id} in tenant ${tenantId}`);
      return row.epoch;
    }, 'bumpInstanceEpoch');
  }

  async touchInstance(tenantId: string, id: string, at: string): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare('UPDATE instances SET last_active_at = ? WHERE tenant_id = ? AND id = ?')
        .run(at, tenantId, id);
    }, 'touchInstance');
  }

  /** Claims and moves a warm instance to `live` in one statement, one of the store's "atomic five" (#3): `UPDATE ... WHERE id = (SELECT ...) RETURNING *`, never a separate SELECT then UPDATE. */
  async claimWarmInstance(req: {
    tenantId: string;
    poolId: string;
    specId: string;
    profileId?: string;
    nodeIds?: string[];
  }): Promise<Instance | null> {
    return withBusyRetry(() => {
      const clauses = ["status = 'warm'", 'tenant_id = ?', 'pool_id = ?', 'spec_id = ?'];
      const params: unknown[] = [req.tenantId, req.poolId, req.specId];
      if (req.profileId) {
        clauses.push('profile_id = ?');
        params.push(req.profileId);
      }
      if (req.nodeIds && req.nodeIds.length > 0) {
        clauses.push(`node_id IN (${req.nodeIds.map(() => '?').join(', ')})`);
        params.push(...req.nodeIds);
      }
      const row = this.db
        .prepare(
          `UPDATE instances SET status = 'live', status_since = ?, updated_at = ?, first_viewer_at = COALESCE(first_viewer_at, ?)
           WHERE id = (SELECT id FROM instances WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC LIMIT 1)
           RETURNING *`,
        )
        .get(nowIso(), nowIso(), nowIso(), ...params) as InstanceRow | undefined;
      return row ? this.hydrateInstance(row) : null;
    }, 'claimWarmInstance');
  }

  // ── sessions, viewers, leases ─────────────────────────────────────────

  private nodeIdOfInstance(instanceId: string): string {
    const row = this.db.prepare('SELECT node_id FROM instances WHERE id = ?').get(instanceId) as
      | { node_id: string }
      | undefined;
    return row?.node_id ?? '';
  }

  async createSession(s: NewSession): Promise<SessionRow> {
    return withBusyRetry(() => {
      const id = s.id ?? (newBrandedId('sess') as SessionRow['id']);
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO sessions (id, tenant_id, instance_id, gateway_id, status, peak_viewers, total_viewers, started_at, ended_at, end_reason, end_close_code)
           VALUES (?, ?, ?, ?, 'live', 0, 0, ?, NULL, NULL, NULL) RETURNING *`,
        )
        .get(id, s.tenantId, s.instanceId, s.gatewayId ?? null, now) as SessionRowDb;
      return rowToSessionRow(row, this.nodeIdOfInstance(row.instance_id));
    }, 'createSession');
  }

  async getSession(tenantId: string, id: string): Promise<SessionRow | null> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare('SELECT * FROM sessions WHERE tenant_id = ? AND id = ?')
        .get(tenantId, id) as SessionRowDb | undefined;
      return row ? rowToSessionRow(row, this.nodeIdOfInstance(row.instance_id)) : null;
    }, 'getSession');
  }

  async endSession(tenantId: string, id: string, reason: string, code: number): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare(
          "UPDATE sessions SET status = 'ended', ended_at = ?, end_reason = ?, end_close_code = ? WHERE tenant_id = ? AND id = ?",
        )
        .run(nowIso(), reason, code, tenantId, id);
    }, 'endSession');
  }

  async listSessionsByGateway(gatewayId: string): Promise<SessionRow[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare("SELECT * FROM sessions WHERE gateway_id = ? AND status <> 'ended'")
        .all(gatewayId) as SessionRowDb[];
      return rows.map((row) => rowToSessionRow(row, this.nodeIdOfInstance(row.instance_id)));
    }, 'listSessionsByGateway');
  }

  private appIdOfInstance(instanceId: string): string {
    const row = this.db.prepare('SELECT app_id FROM instances WHERE id = ?').get(instanceId) as
      | { app_id: string }
      | undefined;
    return row?.app_id ?? '';
  }

  async createViewer(v: NewViewer): Promise<Viewer> {
    return withBusyRetry(() => {
      const id = v.id ?? (newBrandedId('vwr') as Viewer['id']);
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO viewers (id, tenant_id, session_id, instance_id, sub, sub_kind, display_name, caps, invite_id, token_jti, transport, node_id, remote_ip, user_agent, resume_token_hash, resumed_from, connected_at, disconnected_at, close_code, close_reason, bytes_sent, frames_sent, frames_dropped)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL, NULL, 0, 0, 0) RETURNING *`,
        )
        .get(
          id,
          v.tenantId,
          v.sessionId,
          v.instanceId,
          v.sub,
          v.subKind ?? null,
          v.displayName ?? null,
          toJsonColumn(v.caps),
          v.inviteId ?? null,
          v.tokenJti ?? null,
          v.transport ?? 'gateway',
          v.nodeId ?? null,
          v.remoteIp ?? null,
          v.userAgent ?? null,
          v.resumedFrom ?? null,
          now,
        ) as ViewerRow;
      return rowToViewer(row, this.appIdOfInstance(row.instance_id));
    }, 'createViewer');
  }

  async closeViewer(id: string, close: ViewerClose): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare(
          `UPDATE viewers SET disconnected_at = ?, close_code = ?, close_reason = ?, bytes_sent = ?, frames_sent = ?, frames_dropped = ?
           WHERE id = ?`,
        )
        .run(
          close.disconnectedAt,
          close.closeCode,
          close.closeReason,
          close.bytesSent,
          close.framesSent,
          close.framesDropped,
          id,
        );
    }, 'closeViewer');
  }

  async listViewers(tenantId: string, sessionId: string): Promise<Viewer[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare(
          'SELECT * FROM viewers WHERE tenant_id = ? AND session_id = ? ORDER BY connected_at DESC',
        )
        .all(tenantId, sessionId) as ViewerRow[];
      return rows.map((row) => rowToViewer(row, this.appIdOfInstance(row.instance_id)));
    }, 'listViewers');
  }

  async recordControlGrant(g: NewControlLease): Promise<ControlLeaseRow> {
    return withBusyRetry(() => {
      const id = g.id ?? newBrandedId('lse');
      const row = this.db
        .prepare(
          `INSERT INTO control_leases (id, tenant_id, session_id, target_id, viewer_id, sub, granted_at, released_at, release_reason, displaced, input_events)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0) RETURNING *`,
        )
        .get(
          id,
          g.tenantId,
          g.sessionId,
          g.targetId,
          g.viewerId,
          g.sub,
          g.grantedAt,
        ) as ControlLeaseRowDb;
      return rowToControlLeaseRow(row);
    }, 'recordControlGrant');
  }

  async recordControlRelease(id: string, reason: string, inputEvents: number): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare(
          'UPDATE control_leases SET released_at = ?, release_reason = ?, input_events = ? WHERE id = ?',
        )
        .run(nowIso(), reason, inputEvents, id);
    }, 'recordControlRelease');
  }

  // ── quotas and usage ────────────────────────────────────────────────────

  async getQuotas(tenantId: string): Promise<Quota[]> {
    const now = Date.now();
    const cached = this.quotaCache.get(tenantId, now);
    if (cached.hit) return cached.value;
    const value = await withBusyRetry(() => {
      const rows = this.db
        .prepare('SELECT * FROM quotas WHERE tenant_id = ?')
        .all(tenantId) as QuotaRow[];
      return rows.map(rowToQuota);
    }, 'getQuotas');
    this.quotaCache.set(tenantId, value, now);
    return value;
  }

  async setQuota(q: Quota): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare(
          `INSERT INTO quotas (tenant_id, scope, metric, limit_value, window, soft_pct, action, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, scope, metric, window) DO UPDATE SET
             limit_value = excluded.limit_value, soft_pct = excluded.soft_pct, action = excluded.action, updated_at = excluded.updated_at`,
        )
        .run(q.tenantId, q.scope, q.metric, q.limitValue, q.window, q.softPct, q.action, nowIso());
      this.quotaCache.invalidate(q.tenantId);
    }, 'setQuota');
  }

  /**
   * `reserveQuota`/`releaseQuota` implement the `'concurrent'` window via
   * an in-process counter map, not a DDL column: the
   * `quotas` table stores only the ceiling (`limit_value`), never a live
   * usage counter, and no other table in the schema tracks "how many of
   * metric X are outstanding right now" generically. This is safe under
   * `store-sqlite`'s single writer, single process deployment model
   * (only one process may write): the check and the
   * increment below never `await` between them, so no other JS turn can
   * observe the counter mid update. A Postgres adapter would use a real
   * `SELECT ... FOR UPDATE` against a durable counter row instead.
   */
  async reserveQuota(req: {
    tenantId: string;
    scope: string;
    metric: string;
    amount: number;
  }): Promise<{
    allowed: boolean;
    value: number;
    limit: number;
  }> {
    return withBusyRetry(() => {
      const limitRow = this.db
        .prepare(
          'SELECT limit_value FROM quotas WHERE tenant_id = ? AND scope = ? AND metric = ? AND window = ?',
        )
        .get(req.tenantId, req.scope, req.metric, 'concurrent') as
        | { limit_value: number }
        | undefined;
      const limit = limitRow?.limit_value ?? Number.MAX_SAFE_INTEGER;
      const key = `${req.tenantId}:${req.scope}:${req.metric}`;
      const current = this.concurrentQuota.get(key) ?? 0;
      const next = current + req.amount;
      if (next > limit) {
        return { allowed: false, value: current, limit };
      }
      this.concurrentQuota.set(key, next);
      return { allowed: true, value: next, limit };
    }, 'reserveQuota');
  }

  async releaseQuota(req: {
    tenantId: string;
    scope: string;
    metric: string;
    amount: number;
  }): Promise<void> {
    const key = `${req.tenantId}:${req.scope}:${req.metric}`;
    const current = this.concurrentQuota.get(key) ?? 0;
    this.concurrentQuota.set(key, Math.max(0, current - req.amount));
  }

  async incrementUsage(rows: UsageIncrement[]): Promise<void> {
    await withBusyRetry(() => {
      const stmt = this.db.prepare(
        `INSERT INTO usage_counters (tenant_id, bucket, granularity, metric, dim, value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, bucket, granularity, metric, dim) DO UPDATE SET
           value = value + excluded.value, updated_at = excluded.updated_at`,
      );
      const now = nowIso();
      const txFn = this.db.transaction((items: UsageIncrement[]) => {
        for (const item of items) {
          stmt.run(
            item.tenantId,
            item.bucket,
            item.granularity,
            item.metric,
            item.dim ?? '',
            item.amount,
            now,
          );
        }
      });
      txFn.immediate(rows);
    }, 'incrementUsage');
  }

  async readUsage(
    tenantId: string,
    from: string,
    to: string,
    metric?: string,
  ): Promise<UsageRow[]> {
    return withBusyRetry(() => {
      const clauses = ['tenant_id = ?', 'bucket >= ?', 'bucket <= ?'];
      const params: unknown[] = [tenantId, from, to];
      if (metric) {
        clauses.push('metric = ?');
        params.push(metric);
      }
      const rows = this.db
        .prepare(`SELECT * FROM usage_counters WHERE ${clauses.join(' AND ')} ORDER BY bucket`)
        .all(...params) as UsageCounterRow[];
      return rows.map(rowToUsageRow);
    }, 'readUsage');
  }

  // ── audit ─────────────────────────────────────────────────────────────

  async appendAudit(events: AuditEvent[]): Promise<void> {
    await withBusyRetry(() => {
      const stmt = this.db.prepare(
        `INSERT INTO audit_events (id, tenant_id, app_id, occurred_at, event_type, severity, actor_sub, actor_kind, actor_name, on_behalf_of, invite_id, instance_id, session_id, viewer_id, target_id, profile_id, node_id, remote_ip, user_agent, trace_id, token_jti, outcome, detail, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const txFn = this.db.transaction((items: AuditEvent[]) => {
        for (const e of items) {
          stmt.run(
            e.id ?? newRawId('rev').replace('rev_', 'evt_'),
            e.tenantId,
            e.appId ?? null,
            e.occurredAt,
            e.eventType,
            e.severity ?? 'info',
            e.actorSub ?? null,
            e.actorKind ?? null,
            e.actorName ?? null,
            e.onBehalfOf ?? null,
            e.inviteId ?? null,
            e.instanceId ?? null,
            e.sessionId ?? null,
            e.viewerId ?? null,
            e.targetId ?? null,
            e.profileId ?? null,
            e.nodeId ?? null,
            e.remoteIp ?? null,
            e.userAgent ?? null,
            e.traceId ?? null,
            e.tokenJti ?? null,
            e.outcome ?? 'ok',
            e.detail ? toJsonColumn(e.detail) : null,
            e.prevHash ?? null,
            e.hash ?? null,
          );
        }
      });
      txFn.immediate(events);
    }, 'appendAudit');
  }

  async queryAudit(tenantId: string, q: AuditQuery): Promise<AuditPage> {
    return withBusyRetry(() => {
      const clauses = ['tenant_id = ?'];
      const params: unknown[] = [tenantId];
      if (q.actorSub) {
        clauses.push('actor_sub = ?');
        params.push(q.actorSub);
      }
      if (q.instanceId) {
        clauses.push('instance_id = ?');
        params.push(q.instanceId);
      }
      if (q.eventType) {
        clauses.push('event_type = ?');
        params.push(q.eventType);
      }
      if (q.from) {
        clauses.push('occurred_at >= ?');
        params.push(q.from);
      }
      if (q.to) {
        clauses.push('occurred_at <= ?');
        params.push(q.to);
      }
      if (q.cursor) {
        clauses.push('occurred_at < ?');
        params.push(q.cursor);
      }
      const limit = q.limit ?? 100;
      const rows = this.db
        .prepare(
          `SELECT * FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC LIMIT ?`,
        )
        .all(...params, limit + 1) as AuditEventRow[];
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        events: page.map(rowToAuditEvent),
        nextCursor: hasMore ? (page[page.length - 1] as AuditEventRow).occurred_at : null,
      };
    }, 'queryAudit');
  }

  appendAuditChained(tx: StoreTx, tenantId: string, e: AuditEvent): void {
    const prev = tx.raw<{ hash: string | null }>(
      'SELECT hash FROM audit_events WHERE tenant_id = ? ORDER BY occurred_at DESC LIMIT 1',
      [tenantId],
    );
    const prevHash = prev[0]?.hash ?? null;
    const id = e.id ?? newRawId('rev').replace('rev_', 'evt_');
    tx.insert('audit_events', {
      id,
      tenant_id: tenantId,
      app_id: e.appId ?? null,
      occurred_at: e.occurredAt,
      event_type: e.eventType,
      severity: e.severity ?? 'info',
      actor_sub: e.actorSub ?? null,
      actor_kind: e.actorKind ?? null,
      actor_name: e.actorName ?? null,
      on_behalf_of: e.onBehalfOf ?? null,
      invite_id: e.inviteId ?? null,
      instance_id: e.instanceId ?? null,
      session_id: e.sessionId ?? null,
      viewer_id: e.viewerId ?? null,
      target_id: e.targetId ?? null,
      profile_id: e.profileId ?? null,
      node_id: e.nodeId ?? null,
      remote_ip: e.remoteIp ?? null,
      user_agent: e.userAgent ?? null,
      trace_id: e.traceId ?? null,
      token_jti: e.tokenJti ?? null,
      outcome: e.outcome ?? 'ok',
      detail: e.detail ? toJsonColumn(e.detail) : null,
      prev_hash: prevHash,
      hash: e.hash ?? null,
    });
  }

  // ── files ─────────────────────────────────────────────────────────────

  async createDownload(d: NewDownload): Promise<Download> {
    return withBusyRetry(() => {
      const id = d.id ?? newRawId('dl');
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO downloads (id, tenant_id, instance_id, session_id, target_id, node_id, filename, suggested_name, mime_type, size_bytes, content_hash, storage_path, source_url_host, status, fetched_by, fetched_at, fetch_count, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 'in_progress', NULL, NULL, 0, ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          d.tenantId,
          d.instanceId,
          d.sessionId ?? null,
          d.targetId ?? null,
          d.nodeId,
          d.filename,
          d.suggestedName ?? null,
          d.mimeType ?? null,
          d.storagePath,
          d.sourceUrlHost ?? null,
          d.expiresAt,
          now,
          now,
        ) as DownloadRow;
      return rowToDownload(row);
    }, 'createDownload');
  }

  async updateDownload(tenantId: string, id: string, p: Partial<Download>): Promise<Download> {
    return withBusyRetry(() => {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso()];
      if (p.status !== undefined) {
        sets.push('status = ?');
        params.push(p.status);
      }
      if (p.sizeBytes !== undefined) {
        sets.push('size_bytes = ?');
        params.push(p.sizeBytes);
      }
      if (p.contentHash !== undefined) {
        sets.push('content_hash = ?');
        params.push(p.contentHash);
      }
      if (p.fetchedBy !== undefined) {
        sets.push('fetched_by = ?, fetched_at = ?, fetch_count = fetch_count + 1');
        params.push(p.fetchedBy, nowIso());
      }
      if (p.expiresAt !== undefined) {
        sets.push('expires_at = ?');
        params.push(p.expiresAt);
      }
      params.push(tenantId, id);
      const row = this.db
        .prepare(
          `UPDATE downloads SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ? RETURNING *`,
        )
        .get(...params) as DownloadRow | undefined;
      if (!row) throw new Error(`updateDownload: no download ${id} in tenant ${tenantId}`);
      return rowToDownload(row);
    }, 'updateDownload');
  }

  async listDownloads(tenantId: string, instanceId: string): Promise<Download[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare(
          'SELECT * FROM downloads WHERE tenant_id = ? AND instance_id = ? ORDER BY created_at DESC',
        )
        .all(tenantId, instanceId) as DownloadRow[];
      return rows.map(rowToDownload);
    }, 'listDownloads');
  }

  async createUpload(u: NewUpload): Promise<Upload> {
    return withBusyRetry(() => {
      const id = u.id ?? newRawId('ul');
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO uploads (id, tenant_id, instance_id, viewer_id, node_id, filename, mime_type, declared_bytes, received_bytes, content_hash, storage_path, status, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 'staging', ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          u.tenantId,
          u.instanceId ?? null,
          u.viewerId ?? null,
          u.nodeId ?? null,
          u.filename,
          u.mimeType ?? null,
          u.declaredBytes,
          u.storagePath,
          u.expiresAt,
          now,
          now,
        ) as UploadRow;
      return rowToUpload(row);
    }, 'createUpload');
  }

  async updateUpload(tenantId: string, id: string, p: Partial<Upload>): Promise<Upload> {
    return withBusyRetry(() => {
      const sets: string[] = ['updated_at = ?'];
      const params: unknown[] = [nowIso()];
      if (p.status !== undefined) {
        sets.push('status = ?');
        params.push(p.status);
      }
      if (p.receivedBytes !== undefined) {
        sets.push('received_bytes = ?');
        params.push(p.receivedBytes);
      }
      if (p.contentHash !== undefined) {
        sets.push('content_hash = ?');
        params.push(p.contentHash);
      }
      params.push(tenantId, id);
      const row = this.db
        .prepare(`UPDATE uploads SET ${sets.join(', ')} WHERE tenant_id = ? AND id = ? RETURNING *`)
        .get(...params) as UploadRow | undefined;
      if (!row) throw new Error(`updateUpload: no upload ${id} in tenant ${tenantId}`);
      return rowToUpload(row);
    }, 'updateUpload');
  }

  async findStaleUploads(olderThan: string, limit: number): Promise<Upload[]> {
    return withBusyRetry(() => {
      const rows = this.db
        .prepare("SELECT * FROM uploads WHERE status = 'staging' AND updated_at < ? LIMIT ?")
        .all(olderThan, limit) as UploadRow[];
      return rows.map(rowToUpload);
    }, 'findStaleUploads');
  }

  // ── tickets, revocations, invites ───────────────────────────────────────

  /** One of the store's "atomic five" (#5): the single-use redemption boundary. */
  async redeemAttachTicket(t: AttachTicketRedeem): Promise<boolean> {
    return withBusyRetry(() => {
      const info = this.db
        .prepare(
          `UPDATE attach_tickets SET redeemed_at = ?
           WHERE id = ? AND tenant_id = ? AND node_id = ? AND instance_id = ? AND viewer_id = ? AND epoch = ? AND redeemed_at IS NULL`,
        )
        .run(t.redeemedAt, t.id, t.tenantId, t.nodeId, t.instanceId, t.viewerId, t.epoch);
      return info.changes > 0;
    }, 'redeemAttachTicket');
  }

  async putRevocation(r: NewRevocation): Promise<void> {
    await withBusyRetry(() => {
      const id = r.id ?? newRawId('rev');
      this.db
        .prepare(
          `INSERT INTO revocations (id, tenant_id, kind, value, reason, issued_by, effective_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (tenant_id, kind, value) DO UPDATE SET
             reason = excluded.reason, issued_by = excluded.issued_by, effective_at = excluded.effective_at, expires_at = excluded.expires_at`,
        )
        .run(
          id,
          r.tenantId,
          r.kind,
          r.value,
          r.reason ?? null,
          r.issuedBy ?? null,
          r.effectiveAt,
          r.expiresAt,
        );
      this.revokedCache.clear();
    }, 'putRevocation');
  }

  async checkRevoked(tenantId: string, checks: RevocationCheck[]): Promise<string | null> {
    const now = Date.now();
    for (const check of checks) {
      const cacheKey = `${tenantId}:${check.kind}:${check.value}`;
      const cached = this.revokedCache.get(cacheKey, now);
      if (cached.hit) {
        if (cached.value) return cached.value;
        continue;
      }
      const found = await withBusyRetry(() => {
        const row = this.db
          .prepare(
            'SELECT id FROM revocations WHERE tenant_id = ? AND kind = ? AND value = ? AND effective_at <= ? AND expires_at > ?',
          )
          .get(tenantId, check.kind, check.value, nowIso(), nowIso()) as { id: string } | undefined;
        return row ? row.id : null;
      }, 'checkRevoked');
      this.revokedCache.set(cacheKey, found, now);
      if (found) return found;
    }
    return null;
  }

  async createInvite(i: NewInvite): Promise<Invite> {
    return withBusyRetry(() => {
      const id = i.id ?? (newBrandedId('inv') as Invite['id']);
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO invites (id, tenant_id, app_id, instance_id, secret_hash, created_by, label, caps, scope, max_redemptions, redemptions, detach_from_creator, status, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?) RETURNING *`,
        )
        .get(
          id,
          i.tenantId,
          i.appId,
          i.instanceId,
          i.secretHash,
          i.createdBy,
          i.label ?? null,
          toJsonColumn(i.caps),
          toJsonColumn(i.scope),
          i.maxRedemptions ?? 1,
          i.detachFromCreator ? 1 : 0,
          i.expiresAt,
          now,
          now,
        ) as InviteRow;
      return rowToInvite(row);
    }, 'createInvite');
  }

  redeemInvite(tx: StoreTx, secretHash: string, now: string): Invite | null {
    const rows = tx.raw<InviteRow>('SELECT * FROM invites WHERE secret_hash = ?', [secretHash]);
    const row = rows[0];
    if (!row) return null;
    if (row.status !== 'active' || row.expires_at <= now || row.redemptions >= row.max_redemptions)
      return null;
    const redemptions = row.redemptions + 1;
    const status = redemptions >= row.max_redemptions ? 'exhausted' : 'active';
    tx.update('invites', { id: row.id }, { redemptions, status, updated_at: now });
    return rowToInvite({ ...row, redemptions, status });
  }

  async revokeInvite(tenantId: string, id: string, by: string): Promise<Invite> {
    return withBusyRetry(() => {
      const row = this.db
        .prepare(
          "UPDATE invites SET status = 'revoked', updated_at = ? WHERE tenant_id = ? AND id = ? RETURNING *",
        )
        .get(nowIso(), tenantId, id) as InviteRow | undefined;
      if (!row) throw new Error(`revokeInvite: no invite ${id} in tenant ${tenantId}`);
      void by; // the invites DDL has no revoked_by column; caller records this in the audit trail instead.
      return rowToInvite(row);
    }, 'revokeInvite');
  }

  // ── placement queue ───────────────────────────────────────────────────

  async enqueuePlacement(p: NewPlacement): Promise<PlacementRow> {
    return withBusyRetry(() => {
      const id = p.id ?? newRawId('plc');
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO placement_queue (id, tenant_id, app_id, pool_id, spec_id, profile_key, priority, requested_by, status, claimed_by, claimed_at, instance_id, attempts, last_error, enqueued_at, deadline_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, NULL, NULL, 0, NULL, ?, ?) RETURNING *`,
        )
        .get(
          id,
          p.tenantId,
          p.appId,
          p.poolId,
          p.specId,
          p.profileKey ?? null,
          p.priority ?? 100,
          p.requestedBy ?? null,
          now,
          p.deadlineAt,
        ) as PlacementQueueRow;
      return rowToPlacementRow(row);
    }, 'enqueuePlacement');
  }

  /** SQLite equivalent of `SELECT ... FOR UPDATE SKIP LOCKED`: an `UPDATE` with a subquery inside the single writer lock, since there is only one writer to skip. */
  async claimPlacements(routerId: string, limit: number): Promise<PlacementRow[]> {
    return withBusyRetry(() => {
      const wrapped = this.db.transaction((): PlacementRow[] => {
        const ids = this.db
          .prepare(
            "SELECT id FROM placement_queue WHERE status = 'queued' ORDER BY priority ASC, enqueued_at ASC LIMIT ?",
          )
          .all(limit) as { id: string }[];
        const claimed: PlacementRow[] = [];
        const now = nowIso();
        for (const { id } of ids) {
          const row = this.db
            .prepare(
              "UPDATE placement_queue SET status = 'claimed', claimed_by = ?, claimed_at = ? WHERE id = ? RETURNING *",
            )
            .get(routerId, now, id) as PlacementQueueRow;
          claimed.push(rowToPlacementRow(row));
        }
        return claimed;
      });
      return wrapped.immediate();
    }, 'claimPlacements');
  }

  async completePlacement(id: string, instanceId: string): Promise<void> {
    await withBusyRetry(() => {
      this.db
        .prepare("UPDATE placement_queue SET status = 'placed', instance_id = ? WHERE id = ?")
        .run(instanceId, id);
    }, 'completePlacement');
  }

  async failPlacement(id: string, error: string, retry: boolean): Promise<void> {
    await withBusyRetry(() => {
      if (retry) {
        this.db
          .prepare(
            "UPDATE placement_queue SET status = 'queued', attempts = attempts + 1, last_error = ?, claimed_by = NULL, claimed_at = NULL WHERE id = ?",
          )
          .run(error, id);
      } else {
        this.db
          .prepare(
            "UPDATE placement_queue SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?",
          )
          .run(error, id);
      }
    }, 'failPlacement');
  }

  // ── maintenance ───────────────────────────────────────────────────────

  async purge(table: PurgeableTable, olderThan: string, limit: number): Promise<number> {
    return withBusyRetry(() => purgeTable(this.db, table, olderThan, limit), 'purge');
  }

  async maintain(): Promise<MaintenanceReport> {
    const startedAt = nowIso();
    const start = performance.now();
    return withBusyRetry(() => {
      this.db.pragma('optimize');
      this.db.pragma('incremental_vacuum');
      return {
        startedAt,
        durationMs: Math.round(performance.now() - start),
        vacuumed: true,
        analyzed: true,
        notes: ['PRAGMA optimize', 'PRAGMA incremental_vacuum'],
      };
    }, 'maintain');
  }

  async migrate(target?: number): Promise<MigrationReport> {
    try {
      return runMigrations(this.db, this.migrationsDir, target);
    } catch (err) {
      if (err instanceof MigrationChecksumError) throw err;
      throw err;
    }
  }

  async schemaVersion(): Promise<number> {
    return schemaVersionOf(this.db);
  }
}

/** A stable content digest for a `BrowserSpecInput`, used by `upsertBrowserSpec`'s content addressing. Field order is fixed by `JSON.stringify`'s own key order for an object literal, which is deterministic within one process. */
function digestOfSpec(spec: BrowserSpecInput): string {
  const canonical = JSON.stringify({
    engine: spec.engine,
    channel: spec.channel,
    headless: spec.headless,
    // Defaulted rather than left absent, so a caller that never mentions
    // isolation and a caller that spells out 'tab' explicitly (the same
    // meaning) hash identically and share one row, while a genuine
    // 'tab' vs 'window' difference always produces two.
    isolation: spec.isolation ?? 'tab',
    viewportW: spec.viewportW,
    viewportH: spec.viewportH,
    dpr: spec.dpr,
    locale: spec.locale,
    timezone: spec.timezone,
    userAgent: spec.userAgent,
    // Defaulted rather than left absent for the same reason `isolation`
    // above is: two specs that genuinely differ only in `clientHints` must
    // never collapse onto the same content-addressed row (a browser
    // launched with one Chrome brand list masquerading as another is
    // exactly the inconsistency this field exists to prevent), so it has to
    // be part of the digest. A caller that never mentions it and a caller
    // that spells out `null` explicitly are the same request and correctly
    // hash identically.
    clientHints: spec.clientHints ?? null,
    // Defaulted rather than left absent for the same reason `clientHints`
    // above is: two specs that genuinely differ only in which JavaScript
    // runs before every page script (a submit gate present on one, absent
    // on the other) must never collapse onto the same content-addressed
    // row, so `initScripts` has to be part of the digest too. A caller
    // that never mentions it and a caller that spells out `null`
    // explicitly are the same request and correctly hash identically.
    initScripts: spec.initScripts ?? null,
    // Defaulted rather than left absent for the same reason `initScripts`
    // above is: two specs that genuinely differ only in which registered
    // `RemoteEndpoint` a launch attaches to must never collapse onto the
    // same content-addressed row, since one endpoint is a browser this
    // deployment's operator actually controls and another may not be, so
    // `remoteEndpointName` has to be part of the digest too. A caller that
    // never mentions it and a caller that spells out `null` explicitly are
    // the same request and correctly hash identically.
    remoteEndpointName: spec.remoteEndpointName ?? null,
    proxy: spec.proxy,
    args: spec.args,
    extensions: spec.extensions,
    stealth: spec.stealth,
    limits: spec.limits,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
