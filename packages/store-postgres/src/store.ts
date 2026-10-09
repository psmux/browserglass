/**
 * `PostgresStore`: the full `@browserglass/protocol` `Store` interface on
 * Postgres via `pg`. Ported from `store-sqlite`'s `SqliteStore`
 * (`store.ts`), which is the behavioural spec this class implements: same
 * tables, same columns, same idempotency and atomicity guarantees, same
 * TTL caches on the same three methods. Two structural differences from
 * that file, both explained where they matter below:
 *
 * - every method is genuinely `async` against `pg`'s own async client,
 *   there is no `withBusyRetry`-wraps-a-synchronous-call shape to port;
 *   `withPgRetry` (`retry.ts`) plays the equivalent role for Postgres
 *   serialisation failures and deadlocks.
 * - `transaction()`/`StoreTx` are the one place this adapter cannot just
 *   port SQLite's shape verbatim: `StoreTx` is synchronous by contract,
 *   `pg` has no synchronous query API, and the fix is the
 *   `sync/bridge.ts` worker thread described there, not a change to the
 *   interface.
 *
 * Where Postgres gives this adapter something SQLite structurally cannot
 * (row-level locking instead of one global writer lock), the SQL says so
 * in a comment naming the exact `store-sqlite` counterpart it replaces:
 * `claimWarmInstance`, `claimPlacements`, and `expireProfileLeases` all use
 * `SELECT ... FOR UPDATE SKIP LOCKED`, and `reserveQuota` uses a real
 * durable counter row instead of `store-sqlite`'s in-process `Map` (see
 * `migrations/0008_concurrent_quota_counters.sql`'s own comment, which
 * quotes the SQLite adapter's own doc admitting a Postgres adapter should
 * do exactly this).
 */
import { createHash } from 'node:crypto';
import type {
  App,
  AppKey,
  AttachTicketRedeem,
  AuditEvent,
  AuditPage,
  AuditQuery,
  Pool as BglsPool,
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
import type { Pool } from 'pg';
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
import { withPgRetry } from './retry.js';
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
import { SyncBridge, type SyncBridgeOptions } from './sync/bridge.js';
import { PgTx } from './sync/tx.js';
import { nowIso, toIso } from './time.js';

// ── transitionInstance patch rules ──────────────────────────────────────
// Identical to `store-sqlite`'s own table: this is pure domain logic (what
// a field of `Instance` means and whether persisting it is legal), not
// anything engine-specific, so it is ported unchanged.

type InstancePatchRule<K extends keyof Instance> =
  | { readonly column: string; readonly encode: (value: Instance[K]) => unknown }
  | { readonly rejected: string };

type LooseInstancePatchRule =
  | { readonly column: string; readonly encode: (value: unknown) => unknown }
  | { readonly rejected: string };

function isoOrNull(value: number | null): string | null {
  return value === null ? null : toIso(value);
}

const INSTANCE_PATCH_RULES: { [K in keyof Instance]-?: InstancePatchRule<K> } = {
  id: { rejected: 'an instance id is immutable; the `id` argument selects the row' },
  tenantId: { rejected: 'an instance never moves tenant; the `tenantId` argument selects the row' },
  appId: {
    rejected:
      'an instance never moves app (instances.app_id is NOT NULL ON DELETE RESTRICT by design)',
  },
  state: {
    rejected: 'the `to` argument is the transition target; a patch must not carry a second one',
  },
  stateChangedAt: {
    rejected:
      'this method stamps instances.status_since itself, at the moment the transition applies',
  },
  poolId: { column: 'pool_id', encode: (value) => value },
  subject: { column: 'created_by_sub', encode: (value) => value },
  stateReason: { column: 'status_detail', encode: (value) => value },
  nodeId: {
    column: 'node_id',
    encode: (value) => {
      if (value === null)
        throw new Error(
          'transitionInstance: instances.node_id is NOT NULL, a patch cannot clear it',
        );
      return value;
    },
  },
  fence: { column: 'epoch', encode: (value) => value },
  profileId: { column: 'profile_id', encode: (value) => value },
  sessionId: { column: 'session_id', encode: (value) => value },
  readyAt: { column: 'launched_at', encode: isoOrNull },
  releasedAt: { column: 'released_at', encode: isoOrNull },
  lastActivityAt: { column: 'last_active_at', encode: toIso },
  expiresAt: { column: 'expires_at', encode: toIso },
  acquiredAt: { rejected: 'instances.created_at is set once, at insert' },
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
  // `0010_instance_metadata_lifetime.sql` gave both of these a real
  // column, but `createInstance` (not this method) is their only writer:
  // both are part of an instance's identity at the moment it is created,
  // not something a later state transition patches. See `store-sqlite`'s
  // identical comment on this same rule for the full reasoning.
  metadata: { rejected: 'set once at createInstance; not patchable through transitionInstance' },
  incidents: { rejected: 'no `instances` column; `rowToInstance` always reads it back as []' },
  lifetime: { rejected: 'set once at createInstance; not patchable through transitionInstance' },

  // See `store-sqlite`'s identical rules on this same five field block for
  // the full reasoning (`entities.ts`'s own doc names each field's real
  // writer, if it has one).
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
  releaseReason: { column: 'release_reason', encode: (value) => value },
};

/**
 * The `store-postgres` implementation of `@browserglass/protocol`'s
 * `Store`. One instance owns one `pg.Pool`; `connOpts` is the same
 * connection information the pool was opened with, kept separately
 * because `transaction()`'s sync bridge (`sync/bridge.ts`) opens its own,
 * independent `pg.Client` on a worker thread rather than borrowing a
 * connection out of this pool.
 */
export class PostgresStore implements Store {
  private readonly appKeyCache = new TtlCache<string, AppKey | null>(
    30_000,
    (v) => v === null,
    5_000,
  );
  private readonly quotaCache = new TtlCache<string, Quota[]>(30_000, () => false);
  private readonly revokedCache = new TtlCache<string, string | null>(2_000, () => false);

  constructor(
    private readonly pool: Pool,
    private readonly migrationsDir: string,
    private readonly connOpts: SyncBridgeOptions,
    private readonly poolMax: number = 10,
  ) {}

  // ── lifecycle ─────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // init() never migrates on its own. Verifies connectivity, the
    // same contract `store-sqlite`'s `init()` states for its own
    // `PRAGMA quick_check`; `createPostgresStore` (`index.ts`) is where a
    // connection failure here is turned into a clear error naming the
    // responsible setting.
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const startedAt = performance.now();
    try {
      await this.pool.query('SELECT 1');
      return { ok: true, latencyMs: performance.now() - startedAt };
    } catch {
      return { ok: false, latencyMs: performance.now() - startedAt };
    }
  }

  capabilities(): StoreCapabilities {
    return {
      transactions: true,
      advisoryLocks: true,
      skipLocked: true,
      notify: true,
      concurrentWriters: true,
      maxWriteConcurrency: this.poolMax,
    };
  }

  // ── transactions ──────────────────────────────────────────────────────

  /**
   * Runs `fn` inside a real Postgres transaction, via a `SyncBridge`
   * (`sync/bridge.ts`) so the synchronous `StoreTx` contract can be
   * honoured against a genuinely async driver. See that file's top
   * comment for the mechanism. `opts.retries`, when given, overrides the
   * default backoff schedule length for a serialisation failure/deadlock
   * (`40001`/`40P01`), which re-runs `fn` from scratch against a fresh
   * transaction, matching the interface's own requirement that `fn` be
   * idempotent.
   */
  async transaction<T>(
    fn: (tx: StoreTx) => T,
    opts?: { isolation?: 'read-committed' | 'serializable'; retries?: number },
  ): Promise<T> {
    return withPgRetry(
      async () => {
        const bridge = new SyncBridge(this.connOpts);
        try {
          bridge.begin(opts?.isolation);
          const tx = new PgTx(bridge);
          let result: T;
          try {
            result = fn(tx);
          } catch (err) {
            bridge.rollback();
            throw err;
          }
          bridge.commit();
          return result;
        } finally {
          await bridge.close();
        }
      },
      'transaction',
      opts?.retries,
    );
  }

  // ── tenants / apps / keys ────────────────────────────────────────────

  private async loadQuotaLimits(tenantId: string, scope: string): Promise<QuotaLimits> {
    const { rows } = await this.pool.query<{ metric: string; limit_value: number }>(
      'SELECT metric, limit_value FROM quotas WHERE tenant_id = $1 AND scope = $2',
      [tenantId, scope],
    );
    const result: Record<string, number> = { ...DEFAULT_QUOTA_LIMITS };
    for (const r of rows) {
      if (r.metric in result) result[r.metric] = r.limit_value;
    }
    return result as unknown as QuotaLimits;
  }

  async getTenant(id: string): Promise<Tenant | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<TenantRow>('SELECT * FROM tenants WHERE id = $1', [
        id,
      ]);
      const row = rows[0];
      if (!row) return null;
      return rowToTenant(row, await this.loadQuotaLimits(row.id, 'tenant'));
    }, 'getTenant');
  }

  async listTenants(f?: { status?: TenantStatus }): Promise<Tenant[]> {
    return withPgRetry(async () => {
      const { rows } = f?.status
        ? await this.pool.query<TenantRow>(
            'SELECT * FROM tenants WHERE status = $1 ORDER BY created_at',
            [f.status],
          )
        : await this.pool.query<TenantRow>(
            "SELECT * FROM tenants WHERE status <> 'deleted' ORDER BY created_at",
          );
      return Promise.all(
        rows.map(async (row) => rowToTenant(row, await this.loadQuotaLimits(row.id, 'tenant'))),
      );
    }, 'listTenants');
  }

  async createTenant(t: NewTenant): Promise<Tenant> {
    return withPgRetry(async () => {
      const id = t.id ?? (newBrandedId('ten') as Tenant['id']);
      const now = nowIso();
      const policy = toJsonColumn({
        ...(t.policy ?? {}),
        defaults: t.defaults ?? {},
        labels: t.labels ?? {},
      });
      const { rows } = await this.pool.query<TenantRow>(
        `INSERT INTO tenants (id, name, status, allowed_caps, node_pin, policy, audit_chain, created_at, updated_at, deleted_at)
         VALUES ($1, $2, 'active', $3, $4, $5, 0, $6, $6, NULL) RETURNING *`,
        [
          id,
          t.name,
          toJsonColumn(t.allowedCaps ?? []),
          t.nodePin ? toJsonColumn(t.nodePin) : null,
          policy,
          now,
        ],
      );
      return rowToTenant(rows[0] as TenantRow, t.quotas ?? DEFAULT_QUOTA_LIMITS);
    }, 'createTenant');
  }

  async updateTenant(id: string, patch: Partial<Tenant>): Promise<Tenant> {
    return withPgRetry(async () => {
      const now = nowIso();
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [now];
      if (patch.name !== undefined) {
        params.push(patch.name);
        sets.push(`name = $${params.length}`);
      }
      if (patch.labels !== undefined || patch.defaults !== undefined) {
        const existing = await this.pool.query<{ policy: string }>(
          'SELECT policy FROM tenants WHERE id = $1',
          [id],
        );
        const current = parseJsonColumn<Record<string, unknown>>(
          existing.rows[0]?.policy ?? '{}',
          {},
        );
        params.push(
          toJsonColumn({
            ...current,
            labels: patch.labels ?? current['labels'],
            defaults: patch.defaults ?? current['defaults'],
          }),
        );
        sets.push(`policy = $${params.length}`);
      }
      params.push(id);
      const { rows } = await this.pool.query<TenantRow>(
        `UPDATE tenants SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
        params,
      );
      const row = rows[0];
      if (!row) throw new Error(`updateTenant: no tenant with id ${id}`);
      return rowToTenant(row, patch.quotas ?? (await this.loadQuotaLimits(id, 'tenant')));
    }, 'updateTenant');
  }

  async setTenantStatus(id: string, status: TenantStatus): Promise<void> {
    await withPgRetry(async () => {
      const deletedAt = status === 'deleted' ? nowIso() : null;
      await this.pool.query(
        'UPDATE tenants SET status = $1, updated_at = $2, deleted_at = $3 WHERE id = $4',
        [status, nowIso(), deletedAt, id],
      );
    }, 'setTenantStatus');
  }

  async getApp(tenantId: string, appId: string): Promise<App | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<AppRow>(
        'SELECT * FROM apps WHERE tenant_id = $1 AND id = $2',
        [tenantId, appId],
      );
      return rows[0] ? rowToApp(rows[0]) : null;
    }, 'getApp');
  }

  async listApps(tenantId: string): Promise<App[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<AppRow>(
        'SELECT * FROM apps WHERE tenant_id = $1 ORDER BY created_at',
        [tenantId],
      );
      return rows.map(rowToApp);
    }, 'listApps');
  }

  async createApp(a: NewApp): Promise<App> {
    return withPgRetry(async () => {
      const id = a.id ?? (newBrandedId('app') as App['id']);
      const now = nowIso();
      const { rows } = await this.pool.query<AppRow>(
        `INSERT INTO apps (id, tenant_id, name, max_caps, default_pool_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $6) RETURNING *`,
        [
          id,
          a.tenantId,
          a.name,
          toJsonColumn(a.maxCaps ?? a.grantableCapabilities ?? []),
          a.defaultPoolId ?? null,
          now,
        ],
      );
      return rowToApp(rows[0] as AppRow);
    }, 'createApp');
  }

  async updateApp(tenantId: string, appId: string, p: Partial<App>): Promise<App> {
    return withPgRetry(async () => {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [nowIso()];
      if (p.name !== undefined) {
        params.push(p.name);
        sets.push(`name = $${params.length}`);
      }
      if (p.state !== undefined) {
        params.push(p.state);
        sets.push(`status = $${params.length}`);
      }
      if (p.grantableCapabilities !== undefined) {
        params.push(toJsonColumn(p.grantableCapabilities));
        sets.push(`max_caps = $${params.length}`);
      }
      if (p.defaultPoolId !== undefined) {
        params.push(p.defaultPoolId);
        sets.push(`default_pool_id = $${params.length}`);
      }
      params.push(tenantId, appId);
      const { rows } = await this.pool.query<AppRow>(
        `UPDATE apps SET ${sets.join(', ')} WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING *`,
        params,
      );
      const row = rows[0];
      if (!row) throw new Error(`updateApp: no app ${appId} in tenant ${tenantId}`);
      return rowToApp(row);
    }, 'updateApp');
  }

  async getAppKey(appId: string, kid: string): Promise<AppKey | null> {
    const cacheKey = `${appId}:${kid}`;
    const now = Date.now();
    const cached = this.appKeyCache.get(cacheKey, now);
    if (cached.hit) return cached.value;
    const value = await withPgRetry(async () => {
      const { rows } = await this.pool.query<AppKeyRow>(
        'SELECT * FROM app_keys WHERE app_id = $1 AND id = $2',
        [appId, kid],
      );
      return rows[0] ? rowToAppKey(rows[0]) : null;
    }, 'getAppKey');
    this.appKeyCache.set(cacheKey, value, now);
    return value;
  }

  async listAppKeys(appId: string): Promise<AppKey[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<AppKeyRow>(
        'SELECT * FROM app_keys WHERE app_id = $1 ORDER BY created_at',
        [appId],
      );
      return rows.map(rowToAppKey);
    }, 'listAppKeys');
  }

  async createAppKey(k: NewAppKey): Promise<AppKey> {
    if (k.publicKey && k.secretEnc) {
      throw new Error('createAppKey: a key row must not carry both publicKey and secretEnc');
    }
    return withPgRetry(async () => {
      const id = k.id ?? newBrandedId('key');
      const now = nowIso();
      const { rows } = await this.pool.query<AppKeyRow>(
        `INSERT INTO app_keys (id, app_id, tenant_id, alg, public_key, secret_enc, status, not_before, not_after, activated_at, retired_at, revoked_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8, NULL, NULL, NULL, $9) RETURNING *`,
        [
          id,
          k.appId,
          k.tenantId,
          k.alg,
          k.publicKey ?? null,
          k.secretEnc ?? null,
          k.notBefore,
          k.notAfter ?? null,
          now,
        ],
      );
      return rowToAppKey(rows[0] as AppKeyRow);
    }, 'createAppKey');
  }

  /**
   * `tx-required`: activating a key retires the current active key. Ported
   * verbatim from `store-sqlite`'s `rotateAppKey`, using `tx.raw` exactly
   * as that version does; only the placeholder syntax `tx.raw` itself
   * fills in differs (`PgTx`, `sync/tx.ts`, uses `$N`).
   */
  rotateAppKey(tx: StoreTx, appId: string, newKid: string): void {
    const now = nowIso();
    tx.raw('UPDATE app_keys SET status = $1, retired_at = $2 WHERE app_id = $3 AND status = $4', [
      'retiring',
      now,
      appId,
      'active',
    ]);
    tx.raw('UPDATE app_keys SET status = $1, activated_at = $2 WHERE app_id = $3 AND id = $4', [
      'active',
      now,
      appId,
      newKid,
    ]);
  }

  async revokeAppKey(appId: string, kid: string, immediate: boolean): Promise<void> {
    await withPgRetry(async () => {
      const status = immediate ? 'revoked' : 'retiring';
      const now = nowIso();
      const column = immediate ? 'revoked_at' : 'retired_at';
      await this.pool.query(
        `UPDATE app_keys SET status = $1, ${column} = $2 WHERE app_id = $3 AND id = $4`,
        [status, now, appId, kid],
      );
      this.appKeyCache.invalidate(`${appId}:${kid}`);
    }, 'revokeAppKey');
  }

  // ── pools and specs ──────────────────────────────────────────────────

  private async loadSpecForPool(row: PoolRow): Promise<StoredBrowserSpec> {
    const { rows } = await this.pool.query<BrowserSpecRow>(
      'SELECT * FROM browser_specs WHERE id = $1',
      [row.spec_id],
    );
    return rowToStoredBrowserSpec(rows[0] as BrowserSpecRow);
  }

  async getPool(tenantId: string, poolId: string): Promise<BglsPool | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<PoolRow>(
        'SELECT * FROM pools WHERE tenant_id = $1 AND id = $2',
        [tenantId, poolId],
      );
      const row = rows[0];
      return row ? rowToPool(row, await this.loadSpecForPool(row)) : null;
    }, 'getPool');
  }

  async getPoolByName(tenantId: string, name: string): Promise<BglsPool | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<PoolRow>(
        'SELECT * FROM pools WHERE tenant_id = $1 AND name = $2',
        [tenantId, name],
      );
      const row = rows[0];
      return row ? rowToPool(row, await this.loadSpecForPool(row)) : null;
    }, 'getPoolByName');
  }

  async listPools(tenantId: string): Promise<BglsPool[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<PoolRow>(
        'SELECT * FROM pools WHERE tenant_id = $1 ORDER BY created_at',
        [tenantId],
      );
      return Promise.all(rows.map(async (row) => rowToPool(row, await this.loadSpecForPool(row))));
    }, 'listPools');
  }

  async createPool(p: NewPool): Promise<BglsPool> {
    return withPgRetry(async () => {
      const id = p.id ?? (newBrandedId('pol') as BglsPool['id']);
      const now = nowIso();
      const { rows } = await this.pool.query<PoolRow>(
        `INSERT INTO pools (id, tenant_id, name, spec_id, min_warm, max_instances, placement, idle_timeout_ms, max_duration_ms, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, $10) RETURNING *`,
        [
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
        ],
      );
      const row = rows[0] as PoolRow;
      return rowToPool(row, await this.loadSpecForPool(row));
    }, 'createPool');
  }

  async updatePool(tenantId: string, poolId: string, p: Partial<BglsPool>): Promise<BglsPool> {
    return withPgRetry(async () => {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [nowIso()];
      if (p.name !== undefined) {
        params.push(p.name);
        sets.push(`name = $${params.length}`);
      }
      if (p.state !== undefined) {
        params.push(p.state === 'paused' ? 'draining' : p.state);
        sets.push(`status = $${params.length}`);
      }
      // See `store-sqlite`'s `updatePool` for why `specId` is read via a
      // narrow local cast rather than a typed `Partial<Pool>` field.
      const specId = (p as Partial<BglsPool> & { specId?: string }).specId;
      if (specId !== undefined) {
        params.push(specId);
        sets.push(`spec_id = $${params.length}`);
      }
      if (p.limits?.maxInstances !== undefined) {
        params.push(p.limits.maxInstances);
        sets.push(`max_instances = $${params.length}`);
      }
      if (p.limits?.sessionMaxDurationMs !== undefined) {
        params.push(p.limits.sessionMaxDurationMs);
        sets.push(`max_duration_ms = $${params.length}`);
      }
      const idleTimeoutMs = p.limits?.sessionIdleMs ?? p.warm?.maxIdleMs;
      if (idleTimeoutMs !== undefined) {
        params.push(idleTimeoutMs);
        sets.push(`idle_timeout_ms = $${params.length}`);
      }
      if (p.warm?.min !== undefined) {
        params.push(p.warm.min);
        sets.push(`min_warm = $${params.length}`);
      }
      if (p.placement !== undefined) {
        params.push(toJsonColumn(p.placement));
        sets.push(`placement = $${params.length}`);
      }
      params.push(tenantId, poolId);
      const { rows } = await this.pool.query<PoolRow>(
        `UPDATE pools SET ${sets.join(', ')} WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING *`,
        params,
      );
      const row = rows[0];
      if (!row) throw new Error(`updatePool: no pool ${poolId} in tenant ${tenantId}`);
      return rowToPool(row, await this.loadSpecForPool(row));
    }, 'updatePool');
  }

  /**
   * Content addressed upsert. `INSERT ... ON CONFLICT (tenant_id, digest)
   * DO NOTHING RETURNING *`, falling back to a plain `SELECT` when the
   * conflict means the row already exists; never a `SELECT` before the
   * `INSERT` (that would be the exact race this is trying to avoid).
   */
  async upsertBrowserSpec(tenantId: string, spec: BrowserSpecInput): Promise<StoredBrowserSpec> {
    return withPgRetry(async () => {
      const digest = digestOfSpec(spec);
      const id = newBrandedId('bsp');
      const { rows } = await this.pool.query<BrowserSpecRow>(
        `INSERT INTO browser_specs (id, tenant_id, digest, engine, channel, headless, isolation, viewport_w, viewport_h, dpr, locale, timezone, user_agent, client_hints, init_scripts, remote_endpoint_name, proxy, args, extensions, stealth, limits, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
         ON CONFLICT (tenant_id, digest) DO NOTHING
         RETURNING *`,
        [
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
        ],
      );
      if (rows[0]) return rowToStoredBrowserSpec(rows[0]);
      const existing = await this.pool.query<BrowserSpecRow>(
        'SELECT * FROM browser_specs WHERE tenant_id = $1 AND digest = $2',
        [tenantId, digest],
      );
      return rowToStoredBrowserSpec(existing.rows[0] as BrowserSpecRow);
    }, 'upsertBrowserSpec');
  }

  async getBrowserSpec(tenantId: string, specId: string): Promise<StoredBrowserSpec | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<BrowserSpecRow>(
        'SELECT * FROM browser_specs WHERE tenant_id = $1 AND id = $2',
        [tenantId, specId],
      );
      return rows[0] ? rowToStoredBrowserSpec(rows[0]) : null;
    }, 'getBrowserSpec');
  }

  // ── profiles ──────────────────────────────────────────────────────────

  private async loadLiveLease(profileId: string): Promise<ProfileLease | null> {
    const { rows } = await this.pool.query<ProfileLeaseRow>(
      'SELECT * FROM profile_leases WHERE profile_id = $1 AND released_at IS NULL',
      [profileId],
    );
    return rows[0] ? rowToProfileLease(rows[0]) : null;
  }

  async getProfile(tenantId: string, profileId: string): Promise<Profile | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<ProfileRow>(
        'SELECT * FROM profiles WHERE tenant_id = $1 AND id = $2',
        [tenantId, profileId],
      );
      const row = rows[0];
      return row ? rowToProfile(row, await this.loadLiveLease(row.id)) : null;
    }, 'getProfile');
  }

  async getProfileByKey(tenantId: string, appId: string, key: string): Promise<Profile | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<ProfileRow>(
        'SELECT * FROM profiles WHERE tenant_id = $1 AND app_id = $2 AND key = $3',
        [tenantId, appId, key],
      );
      const row = rows[0];
      return row ? rowToProfile(row, await this.loadLiveLease(row.id)) : null;
    }, 'getProfileByKey');
  }

  async listProfiles(tenantId: string, f?: ProfileFilter): Promise<Profile[]> {
    return withPgRetry(async () => {
      const clauses = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (f?.appId) {
        params.push(f.appId);
        clauses.push(`app_id = $${params.length}`);
      }
      if (f?.state) {
        const states = Array.isArray(f.state) ? f.state : [f.state];
        const placeholders = states.map((_, i) => `$${params.length + i + 1}`).join(', ');
        params.push(...states);
        clauses.push(`state IN (${placeholders})`);
      }
      if (f?.homeNodeId) {
        params.push(f.homeNodeId);
        clauses.push(`home_node_id = $${params.length}`);
      }
      if (f?.keyPrefix) {
        params.push(`${f.keyPrefix}%`);
        clauses.push(`key LIKE $${params.length}`);
      }
      params.push(f?.limit ?? 200);
      const { rows } = await this.pool.query<ProfileRow>(
        `SELECT * FROM profiles WHERE ${clauses.join(' AND ')} ORDER BY created_at LIMIT $${params.length}`,
        params,
      );
      return Promise.all(
        rows.map(async (row) => rowToProfile(row, await this.loadLiveLease(row.id))),
      );
    }, 'listProfiles');
  }

  async createProfile(p: NewProfile): Promise<Profile> {
    return withPgRetry(async () => {
      const id = p.id ?? (newBrandedId('prf') as Profile['id']);
      const now = nowIso();
      const { rows } = await this.pool.query<ProfileRow>(
        `INSERT INTO profiles (id, tenant_id, app_id, key, mode, template_id, storage_path, home_node_id, size_bytes, size_measured_at, encryption_key_id, state, ttl_ms, expires_at, last_used_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NULL, $9, 'creating', $10, NULL, NULL, $11, $11) RETURNING *`,
        [
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
        ],
      );
      return rowToProfile(rows[0] as ProfileRow, null);
    }, 'createProfile');
  }

  async updateProfile(tenantId: string, id: string, p: Partial<Profile>): Promise<Profile> {
    return withPgRetry(async () => {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [nowIso()];
      if (p.state !== undefined) {
        params.push(p.state);
        sets.push(`state = $${params.length}`);
      }
      if (p.sizeBytes !== undefined) {
        params.push(p.sizeBytes, nowIso());
        sets.push(`size_bytes = $${params.length - 1}, size_measured_at = $${params.length}`);
      }
      if (p.lastUsedAt !== undefined) {
        params.push(toIso(p.lastUsedAt));
        sets.push(`last_used_at = $${params.length}`);
      }
      if (p.expiresAt !== undefined) {
        params.push(p.expiresAt === null ? null : toIso(p.expiresAt));
        sets.push(`expires_at = $${params.length}`);
      }
      if (p.homeNodeId !== undefined) {
        params.push(p.homeNodeId);
        sets.push(`home_node_id = $${params.length}`);
      }
      params.push(tenantId, id);
      const { rows } = await this.pool.query<ProfileRow>(
        `UPDATE profiles SET ${sets.join(', ')} WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING *`,
        params,
      );
      const row = rows[0];
      if (!row) throw new Error(`updateProfile: no profile ${id} in tenant ${tenantId}`);
      return rowToProfile(row, await this.loadLiveLease(row.id));
    }, 'updateProfile');
  }

  async setProfileState(tenantId: string, id: string, s: ProfileState): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        'UPDATE profiles SET state = $1, updated_at = $2 WHERE tenant_id = $3 AND id = $4',
        [s, nowIso(), tenantId, id],
      );
    }, 'setProfileState');
  }

  async deleteProfile(tenantId: string, id: string): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query('DELETE FROM profiles WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        id,
      ]);
    }, 'deleteProfile');
  }

  /**
   * THE critical method. Never a SELECT to check for an
   * existing live lease followed by an INSERT: the fence is computed in a
   * CTE and the INSERT's own `ON CONFLICT (profile_id) WHERE released_at
   * IS NULL DO NOTHING` against the partial unique index
   * `idx_profile_lease_live` IS the mutual exclusion boundary, resolved by
   * Postgres's own MVCC/unique-index machinery across genuinely separate
   * connections, not by any lock this process takes. Two callers racing
   * this INSERT for the identical profile can both compute the same
   * candidate fence value from the CTE, but only one of their rows can
   * ever actually commit against the partial unique index, so a fence
   * value is never persisted twice.
   */
  async acquireProfileLease(req: {
    tenantId: string;
    profileId: string;
    nodeId: string;
    instanceId?: string;
    holderPid?: number;
    ttlMs: number;
  }): Promise<ProfileLease | null> {
    return withPgRetry(async () => {
      const id = newBrandedId('plse');
      const now = Date.now();
      const nowStr = toIso(now);
      const expiresStr = toIso(now + req.ttlMs);
      const { rows } = await this.pool.query<ProfileLeaseRow>(
        `WITH next_fence AS (
           SELECT COALESCE(MAX(fence), 0) + 1 AS fence FROM profile_leases WHERE profile_id = $1
         )
         INSERT INTO profile_leases (id, profile_id, tenant_id, instance_id, node_id, holder_pid, fence, acquired_at, heartbeat_at, expires_at, released_at, release_reason)
         SELECT $2, $1, $3, $4, $5, $6, next_fence.fence, $7, $7, $8, NULL, NULL FROM next_fence
         ON CONFLICT (profile_id) WHERE released_at IS NULL DO NOTHING
         RETURNING *`,
        [
          req.profileId,
          id,
          req.tenantId,
          req.instanceId ?? null,
          req.nodeId,
          req.holderPid ?? null,
          nowStr,
          expiresStr,
        ],
      );
      return rows[0] ? rowToProfileLease(rows[0]) : null;
    }, 'acquireProfileLease');
  }

  async heartbeatProfileLease(leaseId: string, ttlMs: number): Promise<boolean> {
    return withPgRetry(async () => {
      const now = Date.now();
      const result = await this.pool.query(
        'UPDATE profile_leases SET heartbeat_at = $1, expires_at = $2 WHERE id = $3 AND released_at IS NULL',
        [toIso(now), toIso(now + ttlMs), leaseId],
      );
      return (result.rowCount ?? 0) > 0;
    }, 'heartbeatProfileLease');
  }

  async releaseProfileLease(leaseId: string, reason: string): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        'UPDATE profile_leases SET released_at = $1, release_reason = $2 WHERE id = $3 AND released_at IS NULL',
        [nowIso(), reason, leaseId],
      );
    }, 'releaseProfileLease');
  }

  /**
   * Sweeper. `SELECT ... FOR UPDATE SKIP LOCKED` in the subquery, unlike
   * `store-sqlite`'s per-row loop inside its single writer lock: a second
   * sweeper (or any other process racing an individual
   * `releaseProfileLease` against one of the same candidate rows) is
   * skipped rather than blocked or double-reclaimed, so two sweepers
   * running concurrently partition the expired set between them instead
   * of one blocking on the other.
   */
  async expireProfileLeases(now: string, limit: number): Promise<ProfileLease[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<ProfileLeaseRow>(
        `UPDATE profile_leases SET released_at = $1, release_reason = 'expired'
         WHERE id IN (
           SELECT id FROM profile_leases WHERE released_at IS NULL AND expires_at < $1 LIMIT $2 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [now, limit],
      );
      return rows.map(rowToProfileLease);
    }, 'expireProfileLeases');
  }

  async createSnapshot(s: NewSnapshot): Promise<ProfileSnapshot> {
    return withPgRetry(async () => {
      const id = s.id ?? newBrandedId('snp');
      const { rows } = await this.pool.query<ProfileSnapshotRow>(
        `INSERT INTO profile_snapshots (id, profile_id, tenant_id, label, storage_path, size_bytes, content_hash, encryption_key_id, created_by, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'creating', $10) RETURNING *`,
        [
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
        ],
      );
      return rowToProfileSnapshot(rows[0] as ProfileSnapshotRow);
    }, 'createSnapshot');
  }

  async listSnapshots(tenantId: string, profileId: string): Promise<ProfileSnapshot[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<ProfileSnapshotRow>(
        'SELECT * FROM profile_snapshots WHERE tenant_id = $1 AND profile_id = $2 ORDER BY created_at DESC',
        [tenantId, profileId],
      );
      return rows.map(rowToProfileSnapshot);
    }, 'listSnapshots');
  }

  async deleteSnapshot(tenantId: string, snapshotId: string): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query('DELETE FROM profile_snapshots WHERE tenant_id = $1 AND id = $2', [
        tenantId,
        snapshotId,
      ]);
    }, 'deleteSnapshot');
  }

  // ── nodes ─────────────────────────────────────────────────────────────

  private async loadHeartbeat(nodeId: string): Promise<NodeHeartbeatRow | null> {
    const { rows } = await this.pool.query<NodeHeartbeatRow>(
      'SELECT * FROM node_heartbeats WHERE node_id = $1',
      [nodeId],
    );
    return rows[0] ?? null;
  }

  private async loadHostedProfileKeys(nodeId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ key: string }>(
      "SELECT key FROM profiles WHERE home_node_id = $1 AND state <> 'deleted'",
      [nodeId],
    );
    return rows.map((r) => r.key);
  }

  /** Upserts on `id`, identical semantics to `store-sqlite`'s `registerNode`: see that file's own doc comment for the full rationale. */
  async registerNode(n: NewNode): Promise<Node> {
    return withPgRetry(async () => {
      const id = n.id ?? (newBrandedId('nod') as Node['id']);
      const now = nowIso();
      const capacity = {
        maxInstances: n.capacity?.maxInstances,
        memMiB: n.capacity?.maxMemoryMb,
        cpus: n.capacity?.cpuCores,
        profileDiskMb: n.capacity?.profileDiskMb,
        maxConcurrentLaunches: n.capacity?.maxConcurrentLaunches,
      };
      const { rows } = await this.pool.query<NodeRow>(
        `INSERT INTO nodes (id, name, region, zone, runtime, address, data_address, registration_secret_enc, labels, tenant_pin, capacity, version, status, status_since, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'joining', $13, $13, $13)
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
        [
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
        ],
      );
      const row = rows[0] as NodeRow;
      return rowToNode(
        row,
        await this.loadHeartbeat(row.id),
        await this.loadHostedProfileKeys(row.id),
      );
    }, 'registerNode');
  }

  async getNode(id: string): Promise<Node | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<NodeRow>('SELECT * FROM nodes WHERE id = $1', [id]);
      const row = rows[0];
      return row
        ? rowToNode(row, await this.loadHeartbeat(row.id), await this.loadHostedProfileKeys(row.id))
        : null;
    }, 'getNode');
  }

  async listNodes(f?: { status?: NodeStatus[]; region?: string }): Promise<Node[]> {
    return withPgRetry(async () => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (f?.status && f.status.length > 0) {
        const placeholders = f.status.map((_, i) => `$${i + 1}`).join(', ');
        params.push(...f.status);
        clauses.push(`status IN (${placeholders})`);
      }
      if (f?.region) {
        params.push(f.region);
        clauses.push(`region = $${params.length}`);
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await this.pool.query<NodeRow>(
        `SELECT * FROM nodes ${where} ORDER BY created_at`,
        params,
      );
      return Promise.all(
        rows.map(async (row) =>
          rowToNode(
            row,
            await this.loadHeartbeat(row.id),
            await this.loadHostedProfileKeys(row.id),
          ),
        ),
      );
    }, 'listNodes');
  }

  async setNodeStatus(id: string, s: NodeStatus, detail?: string): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        'UPDATE nodes SET status = $1, status_since = $2, updated_at = $2 WHERE id = $3',
        [s, nowIso(), id],
      );
      void detail; // the nodes DDL has no status_detail column; kept as a caller-facing hint only, matching store-sqlite.
    }, 'setNodeStatus');
  }

  async heartbeatNode(h: NodeHeartbeat): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        `INSERT INTO node_heartbeats (node_id, beat_at, seq, live_instances, mem_free_mib, cpu_load_pct, disk_free_mib, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (node_id) DO UPDATE SET
           beat_at = excluded.beat_at, seq = excluded.seq, live_instances = excluded.live_instances,
           mem_free_mib = excluded.mem_free_mib, cpu_load_pct = excluded.cpu_load_pct,
           disk_free_mib = excluded.disk_free_mib, detail = excluded.detail`,
        [
          h.nodeId,
          h.beatAt,
          h.seq,
          h.liveInstances,
          h.memFreeMib ?? null,
          h.cpuLoadPct ?? null,
          h.diskFreeMib ?? null,
          toJsonColumn(h.detail ?? {}),
        ],
      );
    }, 'heartbeatNode');
  }

  async findStaleNodes(olderThan: string): Promise<Node[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<NodeRow>(
        `SELECT nodes.* FROM nodes
         LEFT JOIN node_heartbeats ON node_heartbeats.node_id = nodes.id
         WHERE nodes.status IN ('ready', 'draining')
           AND (node_heartbeats.beat_at IS NULL OR node_heartbeats.beat_at < $1)`,
        [olderThan],
      );
      return Promise.all(
        rows.map(async (row) =>
          rowToNode(
            row,
            await this.loadHeartbeat(row.id),
            await this.loadHostedProfileKeys(row.id),
          ),
        ),
      );
    }, 'findStaleNodes');
  }

  // ── instances ─────────────────────────────────────────────────────────

  private async loadInstanceDeps(
    row: InstanceRow,
  ): Promise<{ spec: BrowserSpec; profile: Profile | null }> {
    const specResult = await this.pool.query<BrowserSpecRow>(
      'SELECT * FROM browser_specs WHERE id = $1',
      [row.spec_id],
    );
    const spec = storedSpecToBrowserSpec(
      rowToStoredBrowserSpec(specResult.rows[0] as BrowserSpecRow),
    );
    let profile: Profile | null = null;
    if (row.profile_id) {
      const profileResult = await this.pool.query<ProfileRow>(
        'SELECT * FROM profiles WHERE id = $1',
        [row.profile_id],
      );
      const profileRow = profileResult.rows[0];
      profile = profileRow
        ? rowToProfile(profileRow, await this.loadLiveLease(profileRow.id))
        : null;
    }
    return { spec, profile };
  }

  private async hydrateInstance(row: InstanceRow): Promise<Instance> {
    const { spec, profile } = await this.loadInstanceDeps(row);
    return rowToInstance(row, spec, profile);
  }

  async createInstance(i: NewInstance): Promise<Instance> {
    return withPgRetry(async () => {
      const id = i.id ?? (newBrandedId('inst') as Instance['id']);
      const now = nowIso();
      const { rows } = await this.pool.query<InstanceRow>(
        `INSERT INTO instances (id, tenant_id, app_id, pool_id, spec_id, profile_id, node_id, epoch, cdp_endpoint, os_pid, container_id, status, status_since, status_detail, created_by_sub, created_by_jti, launched_at, first_viewer_at, last_active_at, released_at, release_reason, restart_count, peak_rss_mib, expires_at, session_id, metadata, lifetime, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, NULL, NULL, NULL, 'launching', $8, NULL, $9, $10, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, NULL, $11, $12, $8, $8) RETURNING *`,
        [
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
        ],
      );
      return this.hydrateInstance(rows[0] as InstanceRow);
    }, 'createInstance');
  }

  async getInstance(tenantId: string, id: string): Promise<Instance | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<InstanceRow>(
        'SELECT * FROM instances WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      );
      return rows[0] ? this.hydrateInstance(rows[0]) : null;
    }, 'getInstance');
  }

  async listInstances(tenantId: string, f?: InstanceFilter): Promise<Instance[]> {
    return withPgRetry(async () => {
      const clauses = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (f?.status) {
        const statuses = Array.isArray(f.status) ? f.status : [f.status];
        const placeholders = statuses.map((_, i) => `$${params.length + i + 1}`).join(', ');
        params.push(...statuses);
        clauses.push(`status IN (${placeholders})`);
      }
      if (f?.poolId) {
        params.push(f.poolId);
        clauses.push(`pool_id = $${params.length}`);
      }
      if (f?.nodeId) {
        params.push(f.nodeId);
        clauses.push(`node_id = $${params.length}`);
      }
      if (f?.createdBySub) {
        params.push(f.createdBySub);
        clauses.push(`created_by_sub = $${params.length}`);
      }
      params.push(f?.limit ?? 200);
      const { rows } = await this.pool.query<InstanceRow>(
        `SELECT * FROM instances WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
        params,
      );
      return Promise.all(rows.map((row) => this.hydrateInstance(row)));
    }, 'listInstances');
  }

  /** Compare-and-set on `instances.status`. Identical field handling to `store-sqlite`'s (see {@link INSTANCE_PATCH_RULES}); a single `UPDATE ... WHERE status IN (...)` is atomic on Postgres the same way it is on SQLite, via Postgres's own per-row write lock rather than a global writer lock. */
  async transitionInstance(
    tenantId: string,
    id: string,
    from: InstanceStatus[],
    to: InstanceStatus,
    patch?: Partial<Instance>,
  ): Promise<boolean> {
    return withPgRetry(async () => {
      const sets: string[] = ['status = $1', 'status_since = $2', 'updated_at = $2'];
      const params: unknown[] = [to, nowIso()];
      for (const [field, value] of Object.entries(patch ?? {})) {
        if (value === undefined) continue;
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
        params.push(rule.encode(value));
        sets.push(`${rule.column} = $${params.length}`);
      }
      params.push(tenantId, id);
      const tenantIdx = params.length - 1;
      const idIdx = params.length;
      const fromPlaceholders = from.map((_, i) => `$${params.length + i + 1}`).join(', ');
      params.push(...from);
      const result = await this.pool.query(
        `UPDATE instances SET ${sets.join(', ')} WHERE tenant_id = $${tenantIdx} AND id = $${idIdx} AND status IN (${fromPlaceholders})`,
        params,
      );
      return (result.rowCount ?? 0) > 0;
    }, 'transitionInstance');
  }

  async bumpInstanceEpoch(tenantId: string, id: string): Promise<number> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<{ epoch: number }>(
        'UPDATE instances SET epoch = epoch + 1, restart_count = restart_count + 1, updated_at = $1 WHERE tenant_id = $2 AND id = $3 RETURNING epoch',
        [nowIso(), tenantId, id],
      );
      const row = rows[0];
      if (!row) throw new Error(`bumpInstanceEpoch: no instance ${id} in tenant ${tenantId}`);
      return row.epoch;
    }, 'bumpInstanceEpoch');
  }

  async touchInstance(tenantId: string, id: string, at: string): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        'UPDATE instances SET last_active_at = $1 WHERE tenant_id = $2 AND id = $3',
        [at, tenantId, id],
      );
    }, 'touchInstance');
  }

  /**
   * Claims and moves a warm instance to `live` in one statement, the
   * genuinely concurrent Postgres counterpart of `store-sqlite`'s
   * `claimWarmInstance`: the inner `SELECT ... FOR UPDATE SKIP LOCKED`
   * means two callers racing this against a pool with two or more warm
   * instances each win a DIFFERENT instance in parallel, neither blocking
   * on the other and neither retrying, where `store-sqlite`'s single
   * writer lock made every caller queue up one at a time regardless of
   * how many warm instances existed.
   */
  async claimWarmInstance(req: {
    tenantId: string;
    poolId: string;
    specId: string;
    profileId?: string;
    nodeIds?: string[];
  }): Promise<Instance | null> {
    return withPgRetry(async () => {
      const clauses = ["status = 'warm'", 'tenant_id = $1', 'pool_id = $2', 'spec_id = $3'];
      const params: unknown[] = [req.tenantId, req.poolId, req.specId];
      if (req.profileId) {
        params.push(req.profileId);
        clauses.push(`profile_id = $${params.length}`);
      }
      if (req.nodeIds && req.nodeIds.length > 0) {
        const placeholders = req.nodeIds.map((_, i) => `$${params.length + i + 1}`).join(', ');
        params.push(...req.nodeIds);
        clauses.push(`node_id IN (${placeholders})`);
      }
      params.push(nowIso());
      const nowIdx = params.length;
      const { rows } = await this.pool.query<InstanceRow>(
        `UPDATE instances SET status = 'live', status_since = $${nowIdx}, updated_at = $${nowIdx}, first_viewer_at = COALESCE(first_viewer_at, $${nowIdx})
         WHERE id = (
           SELECT id FROM instances WHERE ${clauses.join(' AND ')} ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        params,
      );
      return rows[0] ? this.hydrateInstance(rows[0]) : null;
    }, 'claimWarmInstance');
  }

  // ── sessions, viewers, leases ─────────────────────────────────────────

  private async nodeIdOfInstance(instanceId: string): Promise<string> {
    const { rows } = await this.pool.query<{ node_id: string }>(
      'SELECT node_id FROM instances WHERE id = $1',
      [instanceId],
    );
    return rows[0]?.node_id ?? '';
  }

  async createSession(s: NewSession): Promise<SessionRow> {
    return withPgRetry(async () => {
      const id = s.id ?? (newBrandedId('sess') as SessionRow['id']);
      const now = nowIso();
      const { rows } = await this.pool.query<SessionRowDb>(
        `INSERT INTO sessions (id, tenant_id, instance_id, gateway_id, status, peak_viewers, total_viewers, started_at, ended_at, end_reason, end_close_code)
         VALUES ($1, $2, $3, $4, 'live', 0, 0, $5, NULL, NULL, NULL) RETURNING *`,
        [id, s.tenantId, s.instanceId, s.gatewayId ?? null, now],
      );
      const row = rows[0] as SessionRowDb;
      return rowToSessionRow(row, await this.nodeIdOfInstance(row.instance_id));
    }, 'createSession');
  }

  async getSession(tenantId: string, id: string): Promise<SessionRow | null> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<SessionRowDb>(
        'SELECT * FROM sessions WHERE tenant_id = $1 AND id = $2',
        [tenantId, id],
      );
      const row = rows[0];
      return row ? rowToSessionRow(row, await this.nodeIdOfInstance(row.instance_id)) : null;
    }, 'getSession');
  }

  async endSession(tenantId: string, id: string, reason: string, code: number): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        "UPDATE sessions SET status = 'ended', ended_at = $1, end_reason = $2, end_close_code = $3 WHERE tenant_id = $4 AND id = $5",
        [nowIso(), reason, code, tenantId, id],
      );
    }, 'endSession');
  }

  async listSessionsByGateway(gatewayId: string): Promise<SessionRow[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<SessionRowDb>(
        "SELECT * FROM sessions WHERE gateway_id = $1 AND status <> 'ended'",
        [gatewayId],
      );
      return Promise.all(
        rows.map(async (row) => rowToSessionRow(row, await this.nodeIdOfInstance(row.instance_id))),
      );
    }, 'listSessionsByGateway');
  }

  private async appIdOfInstance(instanceId: string): Promise<string> {
    const { rows } = await this.pool.query<{ app_id: string }>(
      'SELECT app_id FROM instances WHERE id = $1',
      [instanceId],
    );
    return rows[0]?.app_id ?? '';
  }

  async createViewer(v: NewViewer): Promise<Viewer> {
    return withPgRetry(async () => {
      const id = v.id ?? (newBrandedId('vwr') as Viewer['id']);
      const now = nowIso();
      const { rows } = await this.pool.query<ViewerRow>(
        `INSERT INTO viewers (id, tenant_id, session_id, instance_id, sub, sub_kind, display_name, caps, invite_id, token_jti, transport, node_id, remote_ip, user_agent, resume_token_hash, resumed_from, connected_at, disconnected_at, close_code, close_reason, bytes_sent, frames_sent, frames_dropped)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, $15, $16, NULL, NULL, NULL, 0, 0, 0) RETURNING *`,
        [
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
        ],
      );
      const row = rows[0] as ViewerRow;
      return rowToViewer(row, await this.appIdOfInstance(row.instance_id));
    }, 'createViewer');
  }

  async closeViewer(id: string, close: ViewerClose): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        `UPDATE viewers SET disconnected_at = $1, close_code = $2, close_reason = $3, bytes_sent = $4, frames_sent = $5, frames_dropped = $6
         WHERE id = $7`,
        [
          close.disconnectedAt,
          close.closeCode,
          close.closeReason,
          close.bytesSent,
          close.framesSent,
          close.framesDropped,
          id,
        ],
      );
    }, 'closeViewer');
  }

  async listViewers(tenantId: string, sessionId: string): Promise<Viewer[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<ViewerRow>(
        'SELECT * FROM viewers WHERE tenant_id = $1 AND session_id = $2 ORDER BY connected_at DESC',
        [tenantId, sessionId],
      );
      return Promise.all(
        rows.map(async (row) => rowToViewer(row, await this.appIdOfInstance(row.instance_id))),
      );
    }, 'listViewers');
  }

  async recordControlGrant(g: NewControlLease): Promise<ControlLeaseRow> {
    return withPgRetry(async () => {
      const id = g.id ?? newBrandedId('lse');
      const { rows } = await this.pool.query<ControlLeaseRowDb>(
        `INSERT INTO control_leases (id, tenant_id, session_id, target_id, viewer_id, sub, granted_at, released_at, release_reason, displaced, input_events)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, NULL, NULL, 0) RETURNING *`,
        [id, g.tenantId, g.sessionId, g.targetId, g.viewerId, g.sub, g.grantedAt],
      );
      return rowToControlLeaseRow(rows[0] as ControlLeaseRowDb);
    }, 'recordControlGrant');
  }

  async recordControlRelease(id: string, reason: string, inputEvents: number): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        'UPDATE control_leases SET released_at = $1, release_reason = $2, input_events = $3 WHERE id = $4',
        [nowIso(), reason, inputEvents, id],
      );
    }, 'recordControlRelease');
  }

  // ── quotas and usage ────────────────────────────────────────────────────

  async getQuotas(tenantId: string): Promise<Quota[]> {
    const now = Date.now();
    const cached = this.quotaCache.get(tenantId, now);
    if (cached.hit) return cached.value;
    const value = await withPgRetry(async () => {
      const { rows } = await this.pool.query<QuotaRow>(
        'SELECT * FROM quotas WHERE tenant_id = $1',
        [tenantId],
      );
      return rows.map(rowToQuota);
    }, 'getQuotas');
    this.quotaCache.set(tenantId, value, now);
    return value;
  }

  async setQuota(q: Quota): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        `INSERT INTO quotas (tenant_id, scope, metric, limit_value, "window", soft_pct, action, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, scope, metric, "window") DO UPDATE SET
           limit_value = excluded.limit_value, soft_pct = excluded.soft_pct, action = excluded.action, updated_at = excluded.updated_at`,
        [q.tenantId, q.scope, q.metric, q.limitValue, q.window, q.softPct, q.action, nowIso()],
      );
      this.quotaCache.invalidate(q.tenantId);
    }, 'setQuota');
  }

  /**
   * Atomic check and increment for concurrency window quotas, against the
   * durable `concurrent_quota_counters` row (`migrations/
   * 0008_concurrent_quota_counters.sql`), THE genuine concurrency
   * improvement over `store-sqlite`'s in-process `Map`: that `Map` is
   * silently wrong the moment two `bgls serve` processes share one
   * database, since each process would keep its own independent count.
   * The `UPDATE ... WHERE value + $amount <= $limit` is what makes the
   * check-and-increment atomic: Postgres evaluates the `SET` and `WHERE`
   * clauses against the same row version under that row's own write lock,
   * so two concurrent callers against the identical counter serialise on
   * that one row (one blocks briefly on the other's row lock, exactly the
   * "held for microseconds" cost row-level locking is supposed to have)
   * rather than both reading a stale value and both believing they won.
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
    return withPgRetry(async () => {
      const now = nowIso();
      await this.pool.query(
        `INSERT INTO concurrent_quota_counters (tenant_id, scope, metric, value, updated_at) VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (tenant_id, scope, metric) DO NOTHING`,
        [req.tenantId, req.scope, req.metric, now],
      );
      const limitRow = await this.pool.query<{ limit_value: number }>(
        'SELECT limit_value FROM quotas WHERE tenant_id = $1 AND scope = $2 AND metric = $3 AND "window" = \'concurrent\'',
        [req.tenantId, req.scope, req.metric],
      );
      const limit = limitRow.rows[0]?.limit_value ?? Number.MAX_SAFE_INTEGER;
      const updated = await this.pool.query<{ value: number }>(
        `UPDATE concurrent_quota_counters SET value = value + $4, updated_at = $5
         WHERE tenant_id = $1 AND scope = $2 AND metric = $3 AND value + $4 <= $6
         RETURNING value`,
        [req.tenantId, req.scope, req.metric, req.amount, now, limit],
      );
      if (updated.rows[0]) {
        return { allowed: true, value: updated.rows[0].value, limit };
      }
      const current = await this.pool.query<{ value: number }>(
        'SELECT value FROM concurrent_quota_counters WHERE tenant_id = $1 AND scope = $2 AND metric = $3',
        [req.tenantId, req.scope, req.metric],
      );
      return { allowed: false, value: current.rows[0]?.value ?? 0, limit };
    }, 'reserveQuota');
  }

  async releaseQuota(req: {
    tenantId: string;
    scope: string;
    metric: string;
    amount: number;
  }): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        `UPDATE concurrent_quota_counters SET value = GREATEST(0, value - $4), updated_at = $5
         WHERE tenant_id = $1 AND scope = $2 AND metric = $3`,
        [req.tenantId, req.scope, req.metric, req.amount, nowIso()],
      );
    }, 'releaseQuota');
  }

  /** `INSERT ... ON CONFLICT DO UPDATE SET value = value + EXCLUDED.value`: a genuine atomic increment, exactly what `store-sqlite`'s own `migrations/pg-only/p0002_usage_upsert.sql` scaffold anticipated a real Postgres adapter using in place of a read-modify-write upsert made safe only by a single writer lock. Rows for distinct keys increment fully in parallel; rows for the same key serialise on that row's write lock and still sum correctly. */
  async incrementUsage(rows: UsageIncrement[]): Promise<void> {
    await withPgRetry(async () => {
      const now = nowIso();
      await Promise.all(
        rows.map((item) =>
          this.pool.query(
            `INSERT INTO usage_counters (tenant_id, bucket, granularity, metric, dim, value, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (tenant_id, bucket, granularity, metric, dim) DO UPDATE SET
               value = usage_counters.value + excluded.value, updated_at = excluded.updated_at`,
            [
              item.tenantId,
              item.bucket,
              item.granularity,
              item.metric,
              item.dim ?? '',
              item.amount,
              now,
            ],
          ),
        ),
      );
    }, 'incrementUsage');
  }

  async readUsage(
    tenantId: string,
    from: string,
    to: string,
    metric?: string,
  ): Promise<UsageRow[]> {
    return withPgRetry(async () => {
      const clauses = ['tenant_id = $1', 'bucket >= $2', 'bucket <= $3'];
      const params: unknown[] = [tenantId, from, to];
      if (metric) {
        params.push(metric);
        clauses.push(`metric = $${params.length}`);
      }
      const { rows } = await this.pool.query<UsageCounterRow>(
        `SELECT * FROM usage_counters WHERE ${clauses.join(' AND ')} ORDER BY bucket`,
        params,
      );
      return rows.map(rowToUsageRow);
    }, 'readUsage');
  }

  // ── audit ─────────────────────────────────────────────────────────────

  /** Batched insert. Each row is its own statement, run concurrently via `Promise.all` (order is not part of `appendAudit`'s contract; only `appendAuditChained` needs to serialise), a genuine concurrency improvement over `store-sqlite`'s single-writer-lock transaction. */
  async appendAudit(events: AuditEvent[]): Promise<void> {
    await withPgRetry(async () => {
      await Promise.all(
        events.map((e) =>
          this.pool.query(
            `INSERT INTO audit_events (id, tenant_id, app_id, occurred_at, event_type, severity, actor_sub, actor_kind, actor_name, on_behalf_of, invite_id, instance_id, session_id, viewer_id, target_id, profile_id, node_id, remote_ip, user_agent, trace_id, token_jti, outcome, detail, prev_hash, hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)`,
            [
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
            ],
          ),
        ),
      );
    }, 'appendAudit');
  }

  async queryAudit(tenantId: string, q: AuditQuery): Promise<AuditPage> {
    return withPgRetry(async () => {
      const clauses = ['tenant_id = $1'];
      const params: unknown[] = [tenantId];
      if (q.actorSub) {
        params.push(q.actorSub);
        clauses.push(`actor_sub = $${params.length}`);
      }
      if (q.instanceId) {
        params.push(q.instanceId);
        clauses.push(`instance_id = $${params.length}`);
      }
      if (q.eventType) {
        params.push(q.eventType);
        clauses.push(`event_type = $${params.length}`);
      }
      if (q.from) {
        params.push(q.from);
        clauses.push(`occurred_at >= $${params.length}`);
      }
      if (q.to) {
        params.push(q.to);
        clauses.push(`occurred_at <= $${params.length}`);
      }
      if (q.cursor) {
        params.push(q.cursor);
        clauses.push(`occurred_at < $${params.length}`);
      }
      const limit = q.limit ?? 100;
      params.push(limit + 1);
      const { rows } = await this.pool.query<AuditEventRow>(
        `SELECT * FROM audit_events WHERE ${clauses.join(' AND ')} ORDER BY occurred_at DESC LIMIT $${params.length}`,
        params,
      );
      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      return {
        events: page.map(rowToAuditEvent),
        nextCursor: hasMore ? (page[page.length - 1] as AuditEventRow).occurred_at : null,
      };
    }, 'queryAudit');
  }

  /** `tx-required`: the chain must serialise. Ported verbatim from `store-sqlite`'s `appendAuditChained`, using `tx.raw`/`tx.insert` exactly as that version does. */
  appendAuditChained(tx: StoreTx, tenantId: string, e: AuditEvent): void {
    const prev = tx.raw<{ hash: string | null }>(
      'SELECT hash FROM audit_events WHERE tenant_id = $1 ORDER BY occurred_at DESC LIMIT 1',
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
    return withPgRetry(async () => {
      const id = d.id ?? newRawId('dl');
      const now = nowIso();
      const { rows } = await this.pool.query<DownloadRow>(
        `INSERT INTO downloads (id, tenant_id, instance_id, session_id, target_id, node_id, filename, suggested_name, mime_type, size_bytes, content_hash, storage_path, source_url_host, status, fetched_by, fetched_at, fetch_count, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, NULL, $10, $11, 'in_progress', NULL, NULL, 0, $12, $13, $13) RETURNING *`,
        [
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
        ],
      );
      return rowToDownload(rows[0] as DownloadRow);
    }, 'createDownload');
  }

  async updateDownload(tenantId: string, id: string, p: Partial<Download>): Promise<Download> {
    return withPgRetry(async () => {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [nowIso()];
      if (p.status !== undefined) {
        params.push(p.status);
        sets.push(`status = $${params.length}`);
      }
      if (p.sizeBytes !== undefined) {
        params.push(p.sizeBytes);
        sets.push(`size_bytes = $${params.length}`);
      }
      if (p.contentHash !== undefined) {
        params.push(p.contentHash);
        sets.push(`content_hash = $${params.length}`);
      }
      if (p.fetchedBy !== undefined) {
        params.push(p.fetchedBy, nowIso());
        sets.push(
          `fetched_by = $${params.length - 1}, fetched_at = $${params.length}, fetch_count = fetch_count + 1`,
        );
      }
      if (p.expiresAt !== undefined) {
        params.push(p.expiresAt);
        sets.push(`expires_at = $${params.length}`);
      }
      params.push(tenantId, id);
      const { rows } = await this.pool.query<DownloadRow>(
        `UPDATE downloads SET ${sets.join(', ')} WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING *`,
        params,
      );
      const row = rows[0];
      if (!row) throw new Error(`updateDownload: no download ${id} in tenant ${tenantId}`);
      return rowToDownload(row);
    }, 'updateDownload');
  }

  async listDownloads(tenantId: string, instanceId: string): Promise<Download[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<DownloadRow>(
        'SELECT * FROM downloads WHERE tenant_id = $1 AND instance_id = $2 ORDER BY created_at DESC',
        [tenantId, instanceId],
      );
      return rows.map(rowToDownload);
    }, 'listDownloads');
  }

  async createUpload(u: NewUpload): Promise<Upload> {
    return withPgRetry(async () => {
      const id = u.id ?? newRawId('ul');
      const now = nowIso();
      const { rows } = await this.pool.query<UploadRow>(
        `INSERT INTO uploads (id, tenant_id, instance_id, viewer_id, node_id, filename, mime_type, declared_bytes, received_bytes, content_hash, storage_path, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, NULL, $9, 'staging', $10, $11, $11) RETURNING *`,
        [
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
        ],
      );
      return rowToUpload(rows[0] as UploadRow);
    }, 'createUpload');
  }

  async updateUpload(tenantId: string, id: string, p: Partial<Upload>): Promise<Upload> {
    return withPgRetry(async () => {
      const sets: string[] = ['updated_at = $1'];
      const params: unknown[] = [nowIso()];
      if (p.status !== undefined) {
        params.push(p.status);
        sets.push(`status = $${params.length}`);
      }
      if (p.receivedBytes !== undefined) {
        params.push(p.receivedBytes);
        sets.push(`received_bytes = $${params.length}`);
      }
      if (p.contentHash !== undefined) {
        params.push(p.contentHash);
        sets.push(`content_hash = $${params.length}`);
      }
      params.push(tenantId, id);
      const { rows } = await this.pool.query<UploadRow>(
        `UPDATE uploads SET ${sets.join(', ')} WHERE tenant_id = $${params.length - 1} AND id = $${params.length} RETURNING *`,
        params,
      );
      const row = rows[0];
      if (!row) throw new Error(`updateUpload: no upload ${id} in tenant ${tenantId}`);
      return rowToUpload(row);
    }, 'updateUpload');
  }

  async findStaleUploads(olderThan: string, limit: number): Promise<Upload[]> {
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<UploadRow>(
        "SELECT * FROM uploads WHERE status = 'staging' AND updated_at < $1 LIMIT $2",
        [olderThan, limit],
      );
      return rows.map(rowToUpload);
    }, 'findStaleUploads');
  }

  // ── tickets, revocations, invites ───────────────────────────────────────

  async redeemAttachTicket(t: AttachTicketRedeem): Promise<boolean> {
    return withPgRetry(async () => {
      const result = await this.pool.query(
        `UPDATE attach_tickets SET redeemed_at = $1
         WHERE id = $2 AND tenant_id = $3 AND node_id = $4 AND instance_id = $5 AND viewer_id = $6 AND epoch = $7 AND redeemed_at IS NULL`,
        [t.redeemedAt, t.id, t.tenantId, t.nodeId, t.instanceId, t.viewerId, t.epoch],
      );
      return (result.rowCount ?? 0) > 0;
    }, 'redeemAttachTicket');
  }

  async putRevocation(r: NewRevocation): Promise<void> {
    await withPgRetry(async () => {
      const id = r.id ?? newRawId('rev');
      await this.pool.query(
        `INSERT INTO revocations (id, tenant_id, kind, value, reason, issued_by, effective_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (tenant_id, kind, value) DO UPDATE SET
           reason = excluded.reason, issued_by = excluded.issued_by, effective_at = excluded.effective_at, expires_at = excluded.expires_at`,
        [
          id,
          r.tenantId,
          r.kind,
          r.value,
          r.reason ?? null,
          r.issuedBy ?? null,
          r.effectiveAt,
          r.expiresAt,
        ],
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
      const found = await withPgRetry(async () => {
        const { rows } = await this.pool.query<{ id: string }>(
          'SELECT id FROM revocations WHERE tenant_id = $1 AND kind = $2 AND value = $3 AND effective_at <= $4 AND expires_at > $4',
          [tenantId, check.kind, check.value, nowIso()],
        );
        return rows[0]?.id ?? null;
      }, 'checkRevoked');
      this.revokedCache.set(cacheKey, found, now);
      if (found) return found;
    }
    return null;
  }

  async createInvite(i: NewInvite): Promise<Invite> {
    return withPgRetry(async () => {
      const id = i.id ?? (newBrandedId('inv') as Invite['id']);
      const now = nowIso();
      const { rows } = await this.pool.query<InviteRow>(
        `INSERT INTO invites (id, tenant_id, app_id, instance_id, secret_hash, created_by, label, caps, scope, max_redemptions, redemptions, detach_from_creator, status, expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, 'active', $12, $13, $13) RETURNING *`,
        [
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
        ],
      );
      return rowToInvite(rows[0] as InviteRow);
    }, 'createInvite');
  }

  /** `tx-required`. Ported verbatim from `store-sqlite`'s `redeemInvite`, using `tx.raw`/`tx.update` exactly as that version does. */
  redeemInvite(tx: StoreTx, secretHash: string, now: string): Invite | null {
    const rows = tx.raw<InviteRow>('SELECT * FROM invites WHERE secret_hash = $1', [secretHash]);
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
    return withPgRetry(async () => {
      const { rows } = await this.pool.query<InviteRow>(
        "UPDATE invites SET status = 'revoked', updated_at = $1 WHERE tenant_id = $2 AND id = $3 RETURNING *",
        [nowIso(), tenantId, id],
      );
      const row = rows[0];
      if (!row) throw new Error(`revokeInvite: no invite ${id} in tenant ${tenantId}`);
      void by; // the invites DDL has no revoked_by column; matches store-sqlite.
      return rowToInvite(row);
    }, 'revokeInvite');
  }

  // ── placement queue ───────────────────────────────────────────────────

  async enqueuePlacement(p: NewPlacement): Promise<PlacementRow> {
    return withPgRetry(async () => {
      const id = p.id ?? newRawId('plc');
      const now = nowIso();
      const { rows } = await this.pool.query<PlacementQueueRow>(
        `INSERT INTO placement_queue (id, tenant_id, app_id, pool_id, spec_id, profile_key, priority, requested_by, status, claimed_by, claimed_at, instance_id, attempts, last_error, enqueued_at, deadline_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'queued', NULL, NULL, NULL, 0, NULL, $9, $10) RETURNING *`,
        [
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
        ],
      );
      return rowToPlacementRow(rows[0] as PlacementQueueRow);
    }, 'enqueuePlacement');
  }

  /**
   * `SELECT ... FOR UPDATE SKIP LOCKED`, exactly what `store-sqlite`'s own `claimPlacements`
   * cannot do (its own comment: "SQLite: an UPDATE with a subquery inside
   * the writer lock, equivalent because there is only one writer"). On
   * Postgres this is the real multi-router concurrency case: N router
   * processes calling this concurrently each walk `idx_queue_ready` and
   * skip whatever row another caller already holds, so they partition the
   * queue between them in one round trip each, with no shared lock and no
   * busy-wait retry loop.
   */
  async claimPlacements(routerId: string, limit: number): Promise<PlacementRow[]> {
    return withPgRetry(async () => {
      const now = nowIso();
      const { rows } = await this.pool.query<PlacementQueueRow>(
        `UPDATE placement_queue SET status = 'claimed', claimed_by = $1, claimed_at = $2
         WHERE id IN (
           SELECT id FROM placement_queue WHERE status = 'queued' ORDER BY priority ASC, enqueued_at ASC LIMIT $3 FOR UPDATE SKIP LOCKED
         )
         RETURNING *`,
        [routerId, now, limit],
      );
      return rows.map(rowToPlacementRow);
    }, 'claimPlacements');
  }

  async completePlacement(id: string, instanceId: string): Promise<void> {
    await withPgRetry(async () => {
      await this.pool.query(
        "UPDATE placement_queue SET status = 'placed', instance_id = $1 WHERE id = $2",
        [instanceId, id],
      );
    }, 'completePlacement');
  }

  async failPlacement(id: string, error: string, retry: boolean): Promise<void> {
    await withPgRetry(async () => {
      if (retry) {
        await this.pool.query(
          "UPDATE placement_queue SET status = 'queued', attempts = attempts + 1, last_error = $1, claimed_by = NULL, claimed_at = NULL WHERE id = $2",
          [error, id],
        );
      } else {
        await this.pool.query(
          "UPDATE placement_queue SET status = 'failed', attempts = attempts + 1, last_error = $1 WHERE id = $2",
          [error, id],
        );
      }
    }, 'failPlacement');
  }

  // ── maintenance ───────────────────────────────────────────────────────

  async purge(table: PurgeableTable, olderThan: string, limit: number): Promise<number> {
    return withPgRetry(() => purgeTable(this.pool, table, olderThan, limit), 'purge');
  }

  /** `ANALYZE`, Postgres's own statistics refresh (`store-sqlite`'s equivalent runs `PRAGMA optimize`/`incremental_vacuum`, SQLite's own housekeeping pragmas). */
  async maintain(): Promise<MaintenanceReport> {
    const startedAt = nowIso();
    const start = performance.now();
    return withPgRetry(async () => {
      await this.pool.query('ANALYZE');
      return {
        startedAt,
        durationMs: Math.round(performance.now() - start),
        vacuumed: false,
        analyzed: true,
        notes: ['ANALYZE'],
      };
    }, 'maintain');
  }

  async migrate(target?: number): Promise<MigrationReport> {
    try {
      return await runMigrations(this.pool, this.migrationsDir, target);
    } catch (err) {
      if (err instanceof MigrationChecksumError) throw err;
      throw err;
    }
  }

  async schemaVersion(): Promise<number> {
    return schemaVersionOf(this.pool);
  }
}

/** A stable content digest for a `BrowserSpecInput`, identical to `store-sqlite`'s own `digestOfSpec` (pure JS, no engine dependency), used by `upsertBrowserSpec`'s content addressing so the two adapters mint the same digest for the same logical spec. */
function digestOfSpec(spec: BrowserSpecInput): string {
  const canonical = JSON.stringify({
    engine: spec.engine,
    channel: spec.channel,
    headless: spec.headless,
    isolation: spec.isolation ?? 'tab',
    viewportW: spec.viewportW,
    viewportH: spec.viewportH,
    dpr: spec.dpr,
    locale: spec.locale,
    timezone: spec.timezone,
    userAgent: spec.userAgent,
    clientHints: spec.clientHints ?? null,
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
