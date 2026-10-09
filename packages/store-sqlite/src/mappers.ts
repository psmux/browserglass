/**
 * Row to entity mapping. Every function here takes a `snake_case` DDL row
 * (see `rows.ts`) plus whatever auxiliary data its entity needs that the
 * row alone does not carry (a joined `StoredBrowserSpec` for a `Pool`'s
 * `template`, a resolved `ProfileLease` for a `Profile`'s `lease`), and
 * returns the `@browserglass/protocol` domain shape.
 *
 * Several `@browserglass/protocol` entities mix durable DDL columns with
 * fields the protocol itself documents as in memory only, derived, or belonging
 * to a concept this DDL never modelled (`NodeLoad`, `Instance.runtime`,
 * `Instance.incidents`, a `Viewer`'s subscription `Set`s and token bucket,
 * a `Tenant`'s nested `TenantDefaults`, a `Pool`'s `profileTemplate`). This
 * adapter persists the durable columns faithfully and fills every such
 * field with a typed, documented default from `defaults.ts`; reconstructing
 * true runtime state from a cold row is a gateway process responsibility
 * (its reconciliation loop), not the store's.
 */
import type {
  App,
  AppKey,
  AuditEvent,
  BrowserSpec,
  Capability,
  ClientHintsSpec,
  ControlLeaseRow,
  Download,
  ExtensionRef,
  Instance,
  InstanceLifecycleState,
  Invite,
  Node,
  NodeCapacity,
  NodeState,
  PlacementRow,
  Pool,
  Profile,
  ProfileLease,
  ProfileSnapshot,
  ProfileState,
  Quota,
  ResolvedProfileSpec,
  SessionRow,
  StoredBrowserSpec,
  Tenant,
  Upload,
  UsageRow,
  Viewer,
} from '@browserglass/protocol';
import {
  DEFAULT_POOL_LIMITS,
  DEFAULT_QUOTA_LIMITS,
  DEFAULT_TENANT_DEFAULTS,
  zeroNodeLoad,
} from './defaults.js';
import { parseJsonColumn } from './json.js';
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
import { fromIso, fromIsoRequired } from './time.js';

// ── Tenant ──────────────────────────────────────────────────────────────

/** DDL `tenants.status` has a fourth, tombstoned value (`deleted`) the domain `Tenant.state` union does not carry; folded into `deleting`, since a caller holding a `Tenant` object never needs to distinguish "being deleted" from "already gone". */
function tenantStatusToState(status: TenantRow['status']): Tenant['state'] {
  return status === 'deleted' ? 'deleting' : status;
}

/**
 * `quotas` is resolved by the caller (a join against the `quotas` table
 * scoped `'tenant'`) since this mapper only sees the `tenants` row;
 * defaults to {@link DEFAULT_QUOTA_LIMITS} when the tenant has no rows.
 */
export function rowToTenant(
  row: TenantRow,
  quotas: Tenant['quotas'] = DEFAULT_QUOTA_LIMITS,
): Tenant {
  const policy = parseJsonColumn<{
    defaults?: Partial<typeof DEFAULT_TENANT_DEFAULTS>;
    labels?: Record<string, string>;
  }>(row.policy, {});
  return {
    id: row.id as Tenant['id'],
    name: row.name,
    state: tenantStatusToState(row.status),
    createdAt: fromIsoRequired(row.created_at),
    updatedAt: fromIsoRequired(row.updated_at),
    // No DDL table carries a per-tenant signing key list (app_keys is
    // scoped to an app, not a tenant); always empty.
    keys: [],
    quotas,
    defaults: { ...DEFAULT_TENANT_DEFAULTS, ...policy.defaults },
    labels: policy.labels ?? {},
  };
}

// ── App ─────────────────────────────────────────────────────────────────

export function rowToApp(row: AppRow): App {
  return {
    id: row.id as App['id'],
    tenantId: row.tenant_id as App['tenantId'],
    name: row.name,
    state: row.status,
    createdAt: fromIsoRequired(row.created_at),
    // `apps.max_caps` is the ceiling for tokens this app signs, the same
    // concept the protocol names `grantableCapabilities`.
    grantableCapabilities: parseJsonColumn<Capability[]>(row.max_caps, []),
    quotas: {},
    defaultPoolId: (row.default_pool_id as App['defaultPoolId']) ?? null,
    metadata: {},
  };
}

// ── App keys ────────────────────────────────────────────────────────────

export function rowToAppKey(row: AppKeyRow): AppKey {
  return {
    id: row.id,
    appId: row.app_id as AppKey['appId'],
    tenantId: row.tenant_id as AppKey['tenantId'],
    alg: row.alg,
    publicKey: row.public_key,
    secretEnc: row.secret_enc,
    status: row.status,
    notBefore: row.not_before,
    notAfter: row.not_after,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
  };
}

// ── Browser specs ───────────────────────────────────────────────────────

interface StoredProxy {
  server: string;
  bypass: readonly string[];
}
/** The JSON shape `browser_specs.init_scripts` round-trips, matching `BrowserSpec.initScripts[number]` (`entities.ts`) field for field. */
interface StoredInitScript {
  name: string;
  source: string;
}
interface StoredLimits {
  memMiB?: number;
  cpus?: number;
  pids?: number;
  diskMiB?: number;
}

export function rowToStoredBrowserSpec(row: BrowserSpecRow): StoredBrowserSpec {
  return {
    id: row.id,
    tenantId: row.tenant_id as StoredBrowserSpec['tenantId'],
    digest: row.digest,
    engine: 'chromium',
    channel: row.channel as StoredBrowserSpec['channel'],
    headless: row.headless as StoredBrowserSpec['headless'],
    // Narrowed to a concrete value rather than cast to
    // `StoredBrowserSpec['isolation']`, which is optional and so includes
    // `undefined`: under `exactOptionalPropertyTypes` an optional property
    // cannot be assigned an explicit `undefined`. The column is
    // `NOT NULL DEFAULT 'tab'` and migration 0002 backfilled every row that
    // predates it, so a null here is not reachable in practice; the
    // fallback states the same default the DDL does rather than trusting
    // the cast to launder it.
    isolation: (row.isolation as 'tab' | 'window' | null) ?? 'tab',
    viewportW: row.viewport_w,
    viewportH: row.viewport_h,
    dpr: row.dpr,
    locale: row.locale,
    timezone: row.timezone,
    userAgent: row.user_agent,
    // Added by migration 0005; a row written before it has no `client_hints`
    // column value at all (SQLite hands back NULL for it), which
    // `parseJsonColumn` already treats identically to a caller who set
    // `clientHints: null` on purpose. See `rows.ts`'s `client_hints` doc.
    clientHints: parseJsonColumn<ClientHintsSpec | null>(row.client_hints, null),
    // Added by migration 0006; a row written before it has no `init_scripts`
    // column value at all (SQLite hands back NULL for it), which
    // `parseJsonColumn` already treats identically to a caller who set
    // `initScripts: null` on purpose. See `rows.ts`'s `init_scripts` doc.
    initScripts: parseJsonColumn<StoredInitScript[] | null>(row.init_scripts, null),
    // Added by migration 0007; a row written before it has no
    // `remote_endpoint_name` column value at all (SQLite hands back NULL
    // for it), which is the same fact as a caller who never set
    // `remoteEndpointName`. Plain string, not `parseJsonColumn`: this field
    // has no nested structure. See `rows.ts`'s `remote_endpoint_name` doc.
    remoteEndpointName: row.remote_endpoint_name,
    proxy: parseJsonColumn<StoredProxy | null>(row.proxy, null),
    args: parseJsonColumn<string[]>(row.args, []),
    extensions: parseJsonColumn<string[]>(row.extensions, []),
    stealth: row.stealth as StoredBrowserSpec['stealth'],
    limits: parseJsonColumn<Record<string, unknown>>(row.limits, {}),
    createdAt: row.created_at,
  };
}

/** Expands a stored, content addressed spec into the fully merged `BrowserSpec` domain shape `Pool.template`/`Instance.spec` carry. Fields `StoredBrowserSpec` has no column for take documented, conservative defaults. */
export function storedSpecToBrowserSpec(stored: StoredBrowserSpec): BrowserSpec {
  const limits = stored.limits as StoredLimits;
  const extensions: readonly ExtensionRef[] = stored.extensions.map((value) => ({
    kind: 'path' as const,
    value,
    trusted: true,
  }));
  return {
    engine: stored.engine,
    channel: stored.channel,
    executablePath: null,
    headless: stored.headless,
    viewport: { width: stored.viewportW, height: stored.viewportH, deviceScaleFactor: stored.dpr },
    window: null,
    // `stored.isolation` is optional on `StoredBrowserSpec` because it is a
    // column added by a migration after the table existed, so a row written
    // before it carries no opinion; `'tab'` is the correct expansion of an
    // absent value, since it is the only isolation mode that ever existed
    // before this field did. (This used to say `toStoredSpecInput` "does
    // not set it yet". It does, and that mapper is now typed
    // `Required<BrowserSpecInput>` so it cannot quietly stop.)
    isolation: stored.isolation ?? 'tab',
    userAgent: stored.userAgent,
    // `stored.clientHints` is optional on `StoredBrowserSpec` for the same
    // reason `isolation` above is: a caller assembling a `BrowserSpecInput`
    // before migration 0005 added the column, or a row written before it,
    // carries no opinion at all, and that is indistinguishable from an
    // explicit `null` as far as `BrowserSpec.clientHints` is concerned
    // ("Derived from `userAgent` when null", `entities.ts:339`). This used
    // to be hardcoded `null` unconditionally, which meant a caller-supplied
    // `clientHints` was accepted, content addressed into the spec's digest,
    // written to `browser_specs`, and then silently discarded on every
    // single read; see `docs/cdp-and-interception.md` section 4.
    clientHints: stored.clientHints ?? null,
    // `stored.initScripts` is optional on `StoredBrowserSpec` for the same
    // reason `clientHints` above is: a caller assembling a
    // `BrowserSpecInput` before migration 0006 added the column, or a row
    // written before it, carries no opinion at all, and `[]` (no scripts
    // installed) is both the correct expansion of an absent value and the
    // value every caller got before this field existed, so an old row's
    // meaning does not change.
    initScripts: stored.initScripts ?? [],
    // `stored.remoteEndpointName` is optional on `StoredBrowserSpec` for
    // the same reason `initScripts` above is: a caller assembling a
    // `BrowserSpecInput` before migration 0007 added the column, or a row
    // written before it, carries no opinion at all, and `null` (no
    // registered endpoint named) is both the correct expansion of an
    // absent value and the only meaning `RemoteRuntime.launch`
    // (`packages/runtime-remote/src/runtime.ts`) has ever had for it. This
    // used to have no column to read at all, which is the exact bug that
    // made `runtime-remote` unreachable: see `store-types.ts`'s
    // `remoteEndpointName` doc for the full incident.
    remoteEndpointName: stored.remoteEndpointName ?? null,
    locale: stored.locale,
    timezoneId: stored.timezone,
    geolocation: null,
    permissions: [],
    colorScheme: 'no-preference',
    reducedMotion: 'no-preference',
    proxy: stored.proxy
      ? { server: stored.proxy.server, bypass: stored.proxy.bypass, username: null, password: null }
      : null,
    extraArgs: stored.args,
    ignoreDefaultArgs: [],
    env: {},
    extensions,
    stealth: stored.stealth,
    ignoreHttpsErrors: false,
    downloadDir: null,
    uploadDir: null,
    acceptDownloads: true,
    maxDownloadBytes: null,
    resources: {
      cpus: limits.cpus ?? null,
      memoryMb: limits.memMiB ?? null,
      shmMb: null,
      pidsLimit: limits.pids ?? null,
    },
    initialUrl: null,
    launchTimeoutMs: 45000,
  };
}

// ── Pools ───────────────────────────────────────────────────────────────

/** DDL `pools.status` has three values (`active`, `draining`, `deleted`), one of which (`draining`) is not in the domain `Pool.state` union (`active`, `paused`, `deleting`). `draining` maps to `paused`: both mean "not accepting new placements, existing instances unaffected". */
const POOL_STATUS_TO_STATE: Record<PoolRow['status'], Pool['state']> = {
  active: 'active',
  draining: 'paused',
  deleted: 'deleting',
};

export function rowToPool(row: PoolRow, spec: StoredBrowserSpec): Pool {
  const placement = parseJsonColumn<{ policy?: string; params?: Record<string, unknown> }>(
    row.placement,
    {},
  );
  return {
    id: row.id as Pool['id'],
    tenantId: row.tenant_id as Pool['tenantId'],
    name: row.name,
    state: POOL_STATUS_TO_STATE[row.status],
    template: storedSpecToBrowserSpec(spec),
    // pools carries no profile template column; a caller-named ProfileSpec
    // arrives per acquire request instead.
    profileTemplate: { mode: 'ephemeral' },
    warm: {
      min: row.min_warm,
      max: Math.max(row.min_warm, 1),
      maxIdleMs: row.idle_timeout_ms,
      minAcquiresPerMinute: 0,
      allowPersistentAdoption: false,
    },
    placement: { policy: placement.policy ?? 'default', params: placement.params ?? {} },
    limits: {
      ...DEFAULT_POOL_LIMITS,
      maxInstances: row.max_instances,
      sessionIdleMs: row.idle_timeout_ms,
      sessionMaxDurationMs: row.max_duration_ms,
    },
    nodeSelector: {},
    createdAt: fromIsoRequired(row.created_at),
    updatedAt: fromIsoRequired(row.updated_at),
  };
}

// ── Profiles ────────────────────────────────────────────────────────────

export function rowToProfile(row: ProfileRow, lease: ProfileLease | null): Profile {
  return {
    id: row.id as Profile['id'],
    tenantId: row.tenant_id as Profile['tenantId'],
    appId: row.app_id as Profile['appId'],
    key: row.key,
    mode: row.mode,
    state: row.state as ProfileState,
    homeNodeId: (row.home_node_id as Profile['homeNodeId']) ?? null,
    replicaNodeIds: [],
    path: row.storage_path,
    lease,
    sizeBytes: row.size_bytes,
    fileCount: 0,
    measuredAt: fromIso(row.size_measured_at) ?? 0,
    templateId: row.template_id,
    latestSnapshot: null,
    createdAt: fromIsoRequired(row.created_at),
    lastUsedAt: fromIso(row.last_used_at) ?? fromIsoRequired(row.created_at),
    expiresAt: fromIso(row.expires_at),
    quarantine:
      row.state === 'quarantined'
        ? { reason: 'quarantined', at: fromIsoRequired(row.updated_at), byNodeId: null }
        : null,
    encryption: { atRest: row.encryption_key_id !== null, keyId: row.encryption_key_id },
    labels: {},
  };
}

export function rowToProfileLease(row: ProfileLeaseRow): ProfileLease {
  return {
    id: row.id as ProfileLease['id'],
    profileId: row.profile_id as ProfileLease['profileId'],
    tenantId: row.tenant_id as ProfileLease['tenantId'],
    holderInstanceId: (row.instance_id as ProfileLease['holderInstanceId']) ?? null,
    holderNodeId: row.node_id as ProfileLease['holderNodeId'],
    holderPid: row.holder_pid,
    fence: row.fence,
    grantedAt: fromIsoRequired(row.acquired_at),
    heartbeatAt: fromIsoRequired(row.heartbeat_at),
    expiresAt: fromIsoRequired(row.expires_at),
    // Not a DDL column: the `profile_leases` table does not carry the
    // renewal cadence separately from the TTL the caller supplied at
    // acquire time, so the interval is approximated as the TTL itself.
    renewIntervalMs: Math.max(
      1,
      fromIsoRequired(row.expires_at) - fromIsoRequired(row.acquired_at),
    ),
    releasedAt: fromIso(row.released_at),
    releaseReason: row.release_reason,
  };
}

export function rowToProfileSnapshot(row: ProfileSnapshotRow): ProfileSnapshot {
  return {
    id: row.id,
    profileId: row.profile_id as ProfileSnapshot['profileId'],
    tenantId: row.tenant_id as ProfileSnapshot['tenantId'],
    label: row.label,
    storagePath: row.storage_path,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    encryptionKeyId: row.encryption_key_id,
    createdBy: row.created_by,
    status: row.status,
    createdAt: row.created_at,
  };
}

// ── Nodes ───────────────────────────────────────────────────────────────

const NODE_STATUS_TO_STATE: Record<NodeRow['status'], NodeState> = {
  joining: 'registering',
  ready: 'ready',
  draining: 'draining',
  cordoned: 'quarantined',
  lost: 'lost',
  retired: 'drained',
};

interface StoredCapacity {
  maxInstances?: number;
  memMiB?: number;
  cpus?: number;
  profileDiskMb?: number;
  maxConcurrentLaunches?: number;
}

/**
 * The shape `BrowserRouter.tickHeartbeat` (`@browserglass/router`) packs
 * into `NodeHeartbeat.detail` for its own node's live heartbeat, and this
 * file reads back below. Not a DDL column: `node_heartbeats` has no
 * `warm_instances`/`launching_instances`/`load_avg1` columns (adding them
 * would need a migration for data that is only ever live), and `detail` is exactly the JSON escape hatch
 * `NodeHeartbeat.detail?: Json` (`store-types.ts`) already provides for
 * data a caller wants to persist without a schema change. Both sides of
 * this contract must stay in agreement informally; there is no compiler
 * link between a JSON blob one package writes and another package parses.
 */
interface StoredHeartbeatDetail {
  warmInstances?: number;
  launchingInstances?: number;
  loadAvg1?: number;
}

export function rowToNode(
  row: NodeRow,
  heartbeat: NodeHeartbeatRow | null,
  hostsProfiles: readonly string[],
): Node {
  const labels = parseJsonColumn<Record<string, string>>(row.labels, {});
  const capacity = parseJsonColumn<StoredCapacity>(row.capacity, {});
  const nodeCapacity: NodeCapacity = {
    maxInstances: capacity.maxInstances ?? 10,
    maxMemoryMb: capacity.memMiB ?? 4096,
    cpuCores: capacity.cpus ?? 2,
    profileDiskMb: capacity.profileDiskMb ?? 10240,
    maxConcurrentLaunches: capacity.maxConcurrentLaunches ?? 2,
  };
  const lastHeartbeatAt = heartbeat
    ? fromIsoRequired(heartbeat.beat_at)
    : fromIsoRequired(row.created_at);
  const tenantPin = parseJsonColumn<string[] | null>(row.tenant_pin, null);
  const firstPinnedTenant = (tenantPin?.[0] as Node['tenantId'] | undefined) ?? null;
  // `heartbeat.mem_free_mib`/`disk_free_mib` are stored FREE (what a
  // reporting node actually knows about itself), but `NodeLoad.memoryUsedMb`/
  // `profileDiskUsedMb` are USED (what `placementCandidates`'s headroom
  // check, `packages/router/src/placement/candidates.ts`, subtracts from
  // `capacity` before comparing against the memory/disk a new instance
  // would need). Before this fix this branch hardcoded both USED fields to
  // `0` unconditionally, which meant every node's memory and disk headroom
  // read as "fully free" regardless of what its own heartbeat reported,
  // silently defeating `placementCandidates`'s memory/disk feasibility
  // checks for any node whose `NodeSnapshot` came from this store (every
  // node other than the one process's own live, in-memory `NodeRegistry`
  // snapshot; see `docs/scaling.md`'s placement section). Converting here,
  // once, is what makes a memory-starved remote node actually excludable.
  const heartbeatDetail = heartbeat
    ? parseJsonColumn<StoredHeartbeatDetail>(heartbeat.detail, {})
    : {};
  return {
    id: row.id as Node['id'],
    tenantId: firstPinnedTenant,
    name: row.name,
    state: NODE_STATUS_TO_STATE[row.status],
    labels,
    dataPlaneUrl: row.data_address ?? row.address,
    runtimes: [row.runtime],
    capacity: nodeCapacity,
    load: heartbeat
      ? {
          liveInstances: heartbeat.live_instances,
          // No DDL column for either; carried in `detail` (`StoredHeartbeatDetail`'s
          // own comment above). Absent (an older heartbeat row, or a peer
          // running before this field was added), `0` is the same safe
          // default `zeroNodeLoad` already used everywhere else in this file.
          warmInstances: heartbeatDetail.warmInstances ?? 0,
          launchingInstances: heartbeatDetail.launchingInstances ?? 0,
          cpuPercent: heartbeat.cpu_load_pct ?? 0,
          memoryUsedMb:
            heartbeat.mem_free_mib != null
              ? Math.max(0, nodeCapacity.maxMemoryMb - heartbeat.mem_free_mib)
              : 0,
          profileDiskUsedMb:
            heartbeat.disk_free_mib != null
              ? Math.max(0, nodeCapacity.profileDiskMb - heartbeat.disk_free_mib)
              : 0,
          loadAvg1: heartbeatDetail.loadAvg1 ?? 0,
          sampledAt: lastHeartbeatAt,
        }
      : zeroNodeLoad(lastHeartbeatAt),
    agentVersion: row.version ?? '',
    protocolVersions: [1],
    registeredAt: fromIsoRequired(row.created_at),
    lastHeartbeatAt,
    // Not a DDL column; the router's in-memory registration epoch is not
    // persisted. Defaults to 0, which is safe because it is compared only
    // against itself within one router process's lifetime.
    epoch: 0,
    leaseExpiresAt: 0,
    hostsProfiles,
    drain: null,
    lastError: null,
  };
}

// ── Instances ───────────────────────────────────────────────────────────

const INSTANCE_STATUS_TO_STATE: Record<InstanceRow['status'], InstanceLifecycleState> = {
  launching: 'launching',
  warm: 'ready',
  live: 'ready',
  recovering: 'recovering',
  draining: 'draining',
  released: 'released',
  failed: 'failed',
};

export function rowToInstance(
  row: InstanceRow,
  spec: BrowserSpec,
  profile: Profile | null,
): Instance {
  const acquiredAt = fromIsoRequired(row.created_at);
  const profileSpec: ResolvedProfileSpec = {
    mode: profile?.mode ?? 'ephemeral',
    tenantId: row.tenant_id as ResolvedProfileSpec['tenantId'],
    key: profile?.key ?? `eph:${row.id}`,
    templateId: profile?.templateId ?? null,
    seed: null,
    destroyOnRelease: (profile?.mode ?? 'ephemeral') === 'ephemeral',
    snapshotOnRelease: false,
    // Not derivable from Profile: the domain Profile entity carries an
    // absolute expiresAt, not the configured ttlMs duration.
    ttlMs: null,
    profileId: (row.profile_id as ResolvedProfileSpec['profileId']) ?? null,
  };
  return {
    id: row.id as Instance['id'],
    tenantId: row.tenant_id as Instance['tenantId'],
    appId: row.app_id as Instance['appId'],
    poolId: (row.pool_id as Instance['poolId']) ?? null,
    subject: row.created_by_sub,
    state: INSTANCE_STATUS_TO_STATE[row.status],
    stateReason: row.status_detail,
    stateChangedAt: fromIsoRequired(row.status_since),
    nodeId: row.node_id as Instance['nodeId'],
    fence: row.epoch,
    spec,
    profileSpec,
    profileId: (row.profile_id as Instance['profileId']) ?? null,
    // `0004_instance_session_id.sql`: set by `transitionInstance`'s patch
    // handling when `BrowserRouter.placeAndLaunch` lands the instance on
    // `'live'`. This was a hardcoded `null` before that column existed,
    // which is why `server/src/session/factory.ts` minted a fresh session
    // id for a session the router had already created a row for. NULL for
    // an instance not yet live, and for every row written before the
    // migration, which is the same thing this field always meant.
    sessionId: (row.session_id as Instance['sessionId']) ?? null,
    runtime: null,
    acquiredAt,
    readyAt: fromIso(row.launched_at),
    releasedAt: fromIso(row.released_at),
    // `0003_instance_expires_at.sql`: `expires_at`
    // is set by `transitionInstance`'s patch handling when `BrowserRouter.placeAndLaunch`
    // lands the instance on `'live'` with the caller's real `ttlMs`. NULL
    // until then (still `launching`/`warm`), or for a row written before
    // this migration existed, in which case this falls back to the same
    // acquiredAt-plus-default-maxDurationMs approximation this field
    // always used (the default four hour maximum duration).
    expiresAt: fromIso(row.expires_at) ?? acquiredAt + 14_400_000,
    lastActivityAt: fromIso(row.last_active_at) ?? acquiredAt,
    // `0008_instance_metadata_lifetime.sql`. Was hardcoded `{}` before this
    // column existed, which was the bug: `AcquireArgs.metadata`
    // (`router/src/router/types.ts`) let a caller name a browser on
    // acquire, but nothing wrote it anywhere, so it never survived past
    // the acquiring call. `{}` remains the correct fallback for a
    // (theoretical) row written before this migration: the column carries
    // `NOT NULL DEFAULT '{}'`, so a real pre-migration row reads back the
    // same `{}` this hardcode always returned, and no caller's meaning
    // changes underneath them.
    metadata: parseJsonColumn<Record<string, string>>(row.metadata, {}),
    incidents: [],
    // `0008_instance_metadata_lifetime.sql`. Was hardcoded `'viewer-bound'`
    // before this column existed, which made `Instance.lifetime`'s
    // `'explicit'` value (`router/src/router/config.ts`)
    // impossible to express: nowhere for a caller's choice to land, so
    // every instance behaved as `'viewer-bound'` regardless of what
    // `AcquireRequest.lifetime` asked for.
    lifetime: row.lifetime,
    // The five fields below existed on `instances` since `0001_initial.sql`
    // and were never read into `Instance` at all: exactly the same "the
    // row has it, `rowToInstance` drops it" shape as `metadata`/`lifetime`
    // above, this time surfaced for `GET /v1/instances/:instanceId/history`
    // (`packages/server/src/rest/routes/inventory.ts`), which used to
    // report all five as `null` in a `historyFieldsUnavailable` marker for
    // exactly this reason. See `entities.ts`'s own doc on each field for
    // what actually writes it (`firstViewerAt`/`releaseReason` have real
    // writers; `peakRssMib`/`osPid` do not yet, so they read `null` on
    // every real instance today, which is honest, not a mapping bug).
    firstViewerAt: fromIso(row.first_viewer_at),
    releaseReason: row.release_reason,
    restartCount: row.restart_count,
    peakRssMib: row.peak_rss_mib,
    osPid: row.os_pid,
  };
}

// ── Sessions ────────────────────────────────────────────────────────────

/** `nodeId` is not a `sessions` column; the caller resolves it through `instances.node_id` (the session's own instance) and passes it in. */
export function rowToSessionRow(row: SessionRowDb, nodeId: string): SessionRow {
  return {
    id: row.id as SessionRow['id'],
    instanceId: row.instance_id as SessionRow['instanceId'],
    tenantId: row.tenant_id as SessionRow['tenantId'],
    nodeId: nodeId as SessionRow['nodeId'],
    state: row.status === 'ended' ? 'ended' : row.status === 'recovering' ? 'recovering' : 'live',
    startedAt: fromIsoRequired(row.started_at),
    endedAt: fromIso(row.ended_at),
    endReason: row.end_reason,
    peakViewers: row.peak_viewers,
  };
}

// ── Viewers ─────────────────────────────────────────────────────────────

/** `appId` is not a `viewers` column; the caller resolves it through `instances.app_id` (the viewer's own instance) and passes it in. */
export function rowToViewer(row: ViewerRow, appId: string): Viewer {
  const caps = parseJsonColumn<Capability[]>(row.caps, []);
  const connectedAt = fromIsoRequired(row.connected_at);
  return {
    id: row.id as Viewer['id'],
    sessionId: row.session_id as Viewer['sessionId'],
    tenantId: row.tenant_id as Viewer['tenantId'],
    appId: appId as Viewer['appId'],
    subject: row.sub,
    displayName: row.display_name,
    state: row.disconnected_at ? 'disconnected' : 'attached',
    capabilities: caps,
    transport: {
      protocolVersion: 1,
      connectedAt,
      remoteAddress: row.remote_ip ?? '',
      userAgent: row.user_agent,
      rttMs: null,
      lastMessageAt: connectedAt,
    },
    // The resume token, subscription set, and held-lease set are process
    // memory only; a row freshly read from the store
    // never carries live socket state, so these are always empty/blank.
    resume: {
      token: '',
      windowMs: 120000,
      expiresAt: connectedAt,
      snapshot: {
        sid: row.session_id as Viewer['sessionId'],
        vid: row.id as Viewer['id'],
        subs: [],
        leases: [],
        caps,
        issuedAt: connectedAt,
      },
    },
    subscriptions: new Set(),
    heldLeases: new Set(),
    inputTokens: 300,
    inputRatePerSec: 300,
    lastRefillAt: connectedAt,
    nextStreamId: 1,
    disconnectedAt: fromIso(row.disconnected_at),
  };
}

// ── Control leases ──────────────────────────────────────────────────────

export function rowToControlLeaseRow(row: ControlLeaseRowDb): ControlLeaseRow {
  return {
    id: row.id,
    tenantId: row.tenant_id as ControlLeaseRow['tenantId'],
    sessionId: row.session_id as ControlLeaseRow['sessionId'],
    targetId: row.target_id,
    viewerId: row.viewer_id,
    sub: row.sub,
    grantedAt: row.granted_at,
    releasedAt: row.released_at,
    releaseReason: row.release_reason,
    displaced: row.displaced,
    inputEvents: row.input_events,
  };
}

// ── Quotas and usage ────────────────────────────────────────────────────

export function rowToQuota(row: QuotaRow): Quota {
  return {
    tenantId: row.tenant_id as Quota['tenantId'],
    scope: row.scope as Quota['scope'],
    metric: row.metric,
    limitValue: row.limit_value,
    window: row.window,
    softPct: row.soft_pct,
    action: row.action,
    updatedAt: row.updated_at,
  };
}

export function rowToUsageRow(row: UsageCounterRow): UsageRow {
  return {
    tenantId: row.tenant_id as UsageRow['tenantId'],
    bucket: row.bucket,
    granularity: row.granularity,
    metric: row.metric,
    dim: row.dim,
    value: row.value,
    updatedAt: row.updated_at,
  };
}

// ── Audit ───────────────────────────────────────────────────────────────

export function rowToAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    id: row.id,
    // `exactOptionalPropertyTypes` forbids assigning `undefined` to an
    // optional property; the key is omitted entirely via spread when the
    // column is NULL, rather than present with an undefined value.
    ...(row.detail !== null
      ? { detail: parseJsonColumn<Record<string, unknown>>(row.detail, {}) }
      : {}),
    tenantId: row.tenant_id as AuditEvent['tenantId'],
    appId: row.app_id,
    occurredAt: row.occurred_at,
    eventType: row.event_type,
    severity: row.severity as 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical',
    actorSub: row.actor_sub,
    actorKind: row.actor_kind,
    actorName: row.actor_name,
    onBehalfOf: row.on_behalf_of,
    inviteId: row.invite_id,
    instanceId: row.instance_id,
    sessionId: row.session_id,
    viewerId: row.viewer_id,
    targetId: row.target_id,
    profileId: row.profile_id,
    nodeId: row.node_id,
    remoteIp: row.remote_ip,
    userAgent: row.user_agent,
    traceId: row.trace_id,
    tokenJti: row.token_jti,
    outcome: row.outcome,
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

// ── Files ───────────────────────────────────────────────────────────────

export function rowToDownload(row: DownloadRow): Download {
  return {
    id: row.id,
    tenantId: row.tenant_id as Download['tenantId'],
    instanceId: row.instance_id as Download['instanceId'],
    sessionId: row.session_id,
    targetId: row.target_id,
    nodeId: row.node_id as Download['nodeId'],
    filename: row.filename,
    suggestedName: row.suggested_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    contentHash: row.content_hash,
    storagePath: row.storage_path,
    sourceUrlHost: row.source_url_host,
    status: row.status,
    fetchedBy: row.fetched_by,
    fetchedAt: row.fetched_at,
    fetchCount: row.fetch_count,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function rowToUpload(row: UploadRow): Upload {
  return {
    id: row.id,
    tenantId: row.tenant_id as Upload['tenantId'],
    instanceId: (row.instance_id as Upload['instanceId']) ?? null,
    viewerId: row.viewer_id,
    nodeId: (row.node_id as Upload['nodeId']) ?? null,
    filename: row.filename,
    mimeType: row.mime_type,
    declaredBytes: row.declared_bytes,
    receivedBytes: row.received_bytes,
    contentHash: row.content_hash,
    storagePath: row.storage_path,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Invites ─────────────────────────────────────────────────────────────

export function rowToInvite(row: InviteRow): Invite {
  return {
    id: row.id,
    tenantId: row.tenant_id as Invite['tenantId'],
    appId: row.app_id as Invite['appId'],
    instanceId: row.instance_id as Invite['instanceId'],
    secretHash: row.secret_hash,
    createdBy: row.created_by,
    label: row.label,
    caps: parseJsonColumn<Capability[]>(row.caps, []),
    scope: parseJsonColumn<Record<string, unknown>>(row.scope, {}),
    maxRedemptions: row.max_redemptions,
    redemptions: row.redemptions,
    detachFromCreator: row.detach_from_creator === 1,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Placement queue ─────────────────────────────────────────────────────

export function rowToPlacementRow(row: PlacementQueueRow): PlacementRow {
  return {
    id: row.id,
    tenantId: row.tenant_id as PlacementRow['tenantId'],
    appId: row.app_id as PlacementRow['appId'],
    poolId: row.pool_id as PlacementRow['poolId'],
    specId: row.spec_id,
    profileKey: row.profile_key,
    priority: row.priority,
    requestedBy: row.requested_by,
    status: row.status,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    instanceId: row.instance_id,
    attempts: row.attempts,
    lastError: row.last_error,
    enqueuedAt: row.enqueued_at,
    deadlineAt: row.deadline_at,
  };
}
