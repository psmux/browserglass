/**
 * An in memory `Store` implementation for router level tests, satisfying
 * the full `@browserglass/protocol` `Store` interface. Real, atomic
 * semantics for the methods `BrowserRouter` actually depends on for
 * correctness under concurrency (`reserveQuota`/`releaseQuota`,
 * `transitionInstance`, `claimWarmInstance`, `claimPlacements`); trivial,
 * honest stubs for everything else the router code does not call.
 *
 * `Instance.profileSpec` cannot be reconstructed from `NewInstance` alone
 * (see `BrowserRouter.buildResult`'s TSDoc): this mock synthesises a
 * placeholder ephemeral spec for every created instance, and exposes
 * `seedProfileSpec()` (not part of `Store`) for a test that needs a
 * persistent profile's `release()` behaviour to seed something more
 * specific.
 */

import type {
  App,
  AppKey,
  AttachTicketRedeem,
  AuditEvent,
  AuditPage,
  AuditQuery,
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
  NodeState,
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
  ResolvedProfileSpec,
  RevocationCheck,
  Session,
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
  ViewerClose,
} from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';

const LIFECYCLE_BY_STATUS: Record<InstanceStatus, (subject: string | null) => Instance['state']> = {
  launching: () => 'launching',
  warm: () => 'ready',
  live: () => 'ready',
  recovering: () => 'recovering',
  draining: () => 'draining',
  released: () => 'released',
  failed: () => 'failed',
};

interface InternalInstance {
  id: string;
  tenantId: string;
  appId: string;
  poolId: string | null;
  subject: string | null;
  status: InstanceStatus;
  stateReason: string | null;
  stateChangedAt: number;
  nodeId: string | null;
  fence: number;
  specId: string;
  profileId: string | null;
  profileSpec: ResolvedProfileSpec;
  sessionId: string | null;
  acquiredAt: number;
  readyAt: number | null;
  releasedAt: number | null;
  expiresAt: number;
  lastActivityAt: number;
  metadata: Readonly<Record<string, string>>;
  lifetime: 'viewer-bound' | 'explicit';
  firstViewerAt: number | null;
  releaseReason: string | null;
  restartCount: number;
  peakRssMib: number | null;
  osPid: number | null;
}

function defaultProfileSpec(tenantId: string, instanceId: string): ResolvedProfileSpec {
  return {
    mode: 'ephemeral',
    tenantId: tenantId as ResolvedProfileSpec['tenantId'],
    key: `eph:${instanceId}`,
    templateId: null,
    seed: null,
    destroyOnRelease: true,
    snapshotOnRelease: false,
    ttlMs: null,
    profileId: null,
  };
}

/** The seedable clock a `MockStore` uses for `now()`, matching the router's own `Clock` shape without importing it (keeps this fixture importable from any test). */
export interface MockNow {
  now(): number;
}

/** Creates a fresh in memory `Store`. `nowSource` should be the same fake clock a test drives `BrowserRouter` with, so store timestamps and router decisions agree. */
export function createMockStore(
  nowSource: MockNow,
): Store & { seedProfileSpec(instanceId: string, spec: ResolvedProfileSpec): void } {
  const tenants = new Map<string, Tenant>();
  const apps = new Map<string, App>();
  const pools = new Map<string, Pool>();
  const specs = new Map<string, StoredBrowserSpec>();
  const instances = new Map<string, InternalInstance>();
  const sessions = new Map<string, SessionRow>();
  const quotaGauges = new Map<string, number>();
  const placementQueue = new Map<string, PlacementRow>();
  const profiles = new Map<string, Profile>();
  const nodes = new Map<string, Node>();

  function toInstance(row: InternalInstance): Instance {
    return {
      id: row.id as Instance['id'],
      tenantId: row.tenantId as Instance['tenantId'],
      appId: row.appId as Instance['appId'],
      poolId: row.poolId as Instance['poolId'],
      subject: row.subject,
      state: LIFECYCLE_BY_STATUS[row.status](row.subject),
      stateReason: row.stateReason,
      stateChangedAt: row.stateChangedAt,
      nodeId: row.nodeId as Instance['nodeId'],
      fence: row.fence,
      spec: specs.get(row.specId)
        ? storedToBrowserSpec(specs.get(row.specId) as StoredBrowserSpec)
        : DEFAULT_TEST_SPEC,
      profileSpec: row.profileSpec,
      profileId: row.profileId as Instance['profileId'],
      sessionId: row.sessionId as Instance['sessionId'],
      runtime: null,
      acquiredAt: row.acquiredAt,
      readyAt: row.readyAt,
      releasedAt: row.releasedAt,
      expiresAt: row.expiresAt,
      lastActivityAt: row.lastActivityAt,
      metadata: row.metadata,
      incidents: [],
      // Was `row.subject === null ? 'explicit' : 'viewer-bound'`: a
      // heuristic that happened to agree with `createInstance`'s hardcoded
      // `metadata: {}`/no-`lifetime`-field defaults for every test that
      // never set `subject`, but had nothing to do with the real
      // `NewInstance.lifetime` a caller passes. `row.lifetime` is now the
      // value `createInstance` actually stored, the same round trip
      // `store-sqlite`/`store-postgres` give a real caller.
      lifetime: row.lifetime,
      firstViewerAt: row.firstViewerAt,
      releaseReason: row.releaseReason,
      restartCount: row.restartCount,
      peakRssMib: row.peakRssMib,
      osPid: row.osPid,
    };
  }

  const store: Store & { seedProfileSpec(instanceId: string, spec: ResolvedProfileSpec): void } = {
    init: async () => undefined,
    close: async () => undefined,
    ping: async () => ({ ok: true, latencyMs: 0 }),
    capabilities: (): StoreCapabilities => ({
      transactions: true,
      advisoryLocks: false,
      skipLocked: false,
      notify: false,
      concurrentWriters: false,
      maxWriteConcurrency: 1,
    }),

    transaction: async <T>(fn: (tx: StoreTx) => T): Promise<T> => {
      const tx: StoreTx = {
        kind: 'sqlite',
        get: () => null,
        insert: () => undefined,
        update: () => 0,
        delete: () => 0,
        raw: () => [],
      };
      return fn(tx);
    },

    getTenant: async (id: string) => tenants.get(id) ?? null,
    listTenants: async (f?: { status?: TenantStatus }) =>
      [...tenants.values()].filter((t) => !f?.status || t.state === f.status),
    createTenant: async (t: NewTenant) => {
      const id = t.id ?? newId('ten');
      const tenant: Tenant = {
        id,
        name: t.name,
        state: 'active',
        createdAt: nowSource.now(),
        updatedAt: nowSource.now(),
        keys: [],
        quotas: t.quotas ?? DEFAULT_QUOTA_LIMITS,
        defaults: t.defaults ?? DEFAULT_TENANT_DEFAULTS,
        labels: t.labels ?? {},
      };
      tenants.set(id, tenant);
      return tenant;
    },
    updateTenant: async (id: string, patch: Partial<Tenant>) => {
      const existing = tenants.get(id);
      if (!existing) throw new Error(`no tenant ${id}`);
      const updated = { ...existing, ...patch };
      tenants.set(id, updated);
      return updated;
    },
    setTenantStatus: async (id: string, status: TenantStatus) => {
      const existing = tenants.get(id);
      if (existing) tenants.set(id, { ...existing, state: status as Tenant['state'] });
    },

    getApp: async (tenantId: string, appId: string) => {
      const app = apps.get(appId);
      return app && app.tenantId === tenantId ? app : null;
    },
    listApps: async (tenantId: string) => [...apps.values()].filter((a) => a.tenantId === tenantId),
    createApp: async (a: NewApp) => {
      const id = a.id ?? newId('app');
      const app: App = {
        id,
        tenantId: a.tenantId,
        name: a.name,
        state: 'active',
        createdAt: nowSource.now(),
        grantableCapabilities: a.grantableCapabilities ?? [
          'view',
          'control',
          'navigate',
          'tabs.manage',
        ],
        quotas: a.quotas ?? {},
        defaultPoolId: a.defaultPoolId ?? null,
        metadata: a.metadata ?? {},
      };
      apps.set(id, app);
      return app;
    },
    updateApp: async (_tenantId: string, appId: string, p: Partial<App>) => {
      const existing = apps.get(appId);
      if (!existing) throw new Error(`no app ${appId}`);
      const updated = { ...existing, ...p };
      apps.set(appId, updated);
      return updated;
    },

    getAppKey: async () => null,
    listAppKeys: async () => [] as AppKey[],
    createAppKey: async (k: NewAppKey) => ({
      id: k.id ?? newId('key'),
      appId: k.appId,
      tenantId: k.tenantId,
      alg: k.alg,
      publicKey: k.publicKey ?? null,
      secretEnc: k.secretEnc ?? null,
      status: 'active',
      notBefore: k.notBefore,
      notAfter: k.notAfter ?? null,
      activatedAt: null,
      retiredAt: null,
      revokedAt: null,
      createdAt: new Date(nowSource.now()).toISOString(),
    }),
    rotateAppKey: () => undefined,
    revokeAppKey: async () => undefined,

    getPool: async (tenantId: string, poolId: string) => {
      const pool = pools.get(poolId);
      return pool && pool.tenantId === tenantId ? pool : null;
    },
    getPoolByName: async (tenantId: string, name: string) =>
      [...pools.values()].find((p) => p.tenantId === tenantId && p.name === name) ?? null,
    listPools: async (tenantId: string) =>
      [...pools.values()].filter((p) => p.tenantId === tenantId),
    createPool: async (_p: NewPool) => {
      throw new Error(
        'createPool not implemented in MockStore; seed pools directly via the store fixture',
      );
    },
    updatePool: async (_tenantId: string, poolId: string, p: Partial<Pool>) => {
      const existing = pools.get(poolId);
      if (!existing) throw new Error(`no pool ${poolId}`);
      const updated = { ...existing, ...p };
      pools.set(poolId, updated);
      return updated;
    },

    upsertBrowserSpec: async (tenantId: string, spec: BrowserSpecInput) => {
      const digest = JSON.stringify(spec);
      const existing = [...specs.values()].find(
        (s) => s.tenantId === tenantId && s.digest === digest,
      );
      if (existing) return existing;
      const row: StoredBrowserSpec = {
        id: newId('bsp'),
        tenantId: tenantId as StoredBrowserSpec['tenantId'],
        digest,
        createdAt: new Date(nowSource.now()).toISOString(),
        ...spec,
      };
      specs.set(row.id, row);
      return row;
    },
    getBrowserSpec: async (_tenantId: string, specId: string) => specs.get(specId) ?? null,

    getProfile: async (_tenantId: string, profileId: string) => profiles.get(profileId) ?? null,
    getProfileByKey: async (tenantId: string, appId: string, key: string) =>
      [...profiles.values()].find(
        (p) => p.tenantId === tenantId && p.appId === appId && p.key === key,
      ) ?? null,
    listProfiles: async (tenantId: string, f?: ProfileFilter) =>
      [...profiles.values()].filter(
        (p) => p.tenantId === tenantId && (!f?.appId || p.appId === f.appId),
      ),
    createProfile: async (p: NewProfile) => {
      const id = p.id ?? newId('prf');
      const profile: Profile = {
        id,
        tenantId: p.tenantId,
        appId: p.appId,
        key: p.key,
        mode: p.mode,
        state: 'free' as ProfileState,
        homeNodeId: p.homeNodeId ?? null,
        replicaNodeIds: [],
        path: p.storagePath,
        lease: null,
        sizeBytes: 0,
        fileCount: 0,
        measuredAt: nowSource.now(),
        templateId: p.templateId ?? null,
        latestSnapshot: null,
        createdAt: nowSource.now(),
        lastUsedAt: nowSource.now(),
        expiresAt: null,
        quarantine: null,
        encryption: { atRest: false, keyId: null },
        labels: {},
      };
      profiles.set(id, profile);
      return profile;
    },
    updateProfile: async (_tenantId: string, id: string, p: Partial<Profile>) => {
      const existing = profiles.get(id);
      if (!existing) throw new Error(`no profile ${id}`);
      const updated = { ...existing, ...p };
      profiles.set(id, updated);
      return updated;
    },
    setProfileState: async (_tenantId: string, id: string, s: ProfileState) => {
      const existing = profiles.get(id);
      if (existing) profiles.set(id, { ...existing, state: s });
    },
    deleteProfile: async (_tenantId: string, id: string) => {
      profiles.delete(id);
    },

    acquireProfileLease: async () => null,
    heartbeatProfileLease: async () => false,
    releaseProfileLease: async () => undefined,
    expireProfileLeases: async () => [] as ProfileLease[],

    createSnapshot: async () => {
      throw new Error('not implemented in MockStore');
    },
    listSnapshots: async () => [] as ProfileSnapshot[],
    deleteSnapshot: async () => undefined,

    registerNode: async (n: NewNode) => {
      const id = n.id ?? (newId('nod') as Node['id']);
      // Mirrors `store-sqlite`'s own `registerNode`: a bare insert, no
      // upsert. Re-registering an id already present is a caller bug in a
      // real deployment (that store's `PRIMARY KEY` would reject it the
      // same way), so this fake throws too rather than silently
      // overwriting a previous registration's `epoch`/`dataPlaneUrl`.
      if (nodes.has(id))
        throw new Error(`MockStore.registerNode: node ${id} is already registered`);
      const node: Node = {
        id,
        tenantId: null,
        name: n.name,
        state: 'ready',
        labels: n.labels ?? {},
        dataPlaneUrl: n.dataAddress ?? n.address,
        runtimes: [n.runtime],
        capacity: n.capacity ?? DEFAULT_CAPACITY,
        load: DEFAULT_LOAD,
        agentVersion: n.version ?? '0.0.0',
        protocolVersions: [1],
        registeredAt: nowSource.now(),
        lastHeartbeatAt: nowSource.now(),
        epoch: 0,
        leaseExpiresAt: nowSource.now() + 60_000,
        hostsProfiles: [],
        drain: null,
        lastError: null,
      };
      nodes.set(id, node);
      return node;
    },
    getNode: async (id: string) => nodes.get(id) ?? null,
    // The `status` filter is deliberately NOT applied here: this mock
    // returns every registered node regardless, and correctness of "only
    // ready, unstale, undraining nodes are placement candidates" is
    // `placementCandidates`'s own job (`src/placement/candidates.ts`),
    // exercised against whatever `Node.state`/`lastHeartbeatAt` this map
    // actually holds. `BrowserRouter.remoteNodeSnapshots` calls
    // `listNodes({ status: ['ready'] })` as a real store's own
    // pre-filtering optimisation, never as its sole correctness
    // mechanism, so a fake that skips the optimisation and returns
    // everything is still a faithful `Store` for every test in this
    // package's own suite.
    listNodes: async () => [...nodes.values()],
    // `NodeStatus` (this method's own parameter) and `Node.state` are
    // deliberately distinct enums (`store-types.ts`'s own top comment on
    // the analogous instance status/state split), the exact mirror of
    // `store-sqlite`'s own `NODE_STATUS_TO_STATE` (`mappers.ts`) this fake
    // cannot import (`store-sqlite` is this package's `devDependency`,
    // never a runtime one, and a test fixture keeping the same boundary
    // as production code is the point). A router level cross node
    // placement test (`BrowserRouter.acquire` picking a foreign node from
    // `remoteNodeSnapshots`) needs this to be real: without it, nothing
    // could ever move a registered node from `'registering'` to `'ready'`
    // in this store, and every such node would be excluded by
    // `placementCandidates`'s own `n.state !== 'ready'` check forever.
    setNodeStatus: async (id: string, s: NodeStatus) => {
      const existing = nodes.get(id);
      if (!existing) return;
      nodes.set(id, { ...existing, state: MOCK_NODE_STATUS_TO_STATE[s] });
    },
    // Mirrors `store-sqlite`'s own `rowToNode` conversion
    // (`mem_free_mib`/`disk_free_mib` stored FREE, `NodeLoad.memoryUsedMb`/
    // `profileDiskUsedMb` USED) so a test asserting `placementCandidates`
    // excludes a memory- or launch-pressured foreign node behaves the same
    // against this fake as it would against the real store.
    heartbeatNode: async (h: NodeHeartbeat) => {
      const existing = nodes.get(h.nodeId);
      if (!existing) return;
      const detail = (h.detail ?? {}) as {
        warmInstances?: number;
        launchingInstances?: number;
        loadAvg1?: number;
      };
      const at = nowSource.now();
      nodes.set(h.nodeId, {
        ...existing,
        lastHeartbeatAt: at,
        load: {
          liveInstances: h.liveInstances,
          warmInstances: detail.warmInstances ?? existing.load.warmInstances,
          launchingInstances: detail.launchingInstances ?? existing.load.launchingInstances,
          cpuPercent: h.cpuLoadPct ?? existing.load.cpuPercent,
          memoryUsedMb:
            h.memFreeMib != null
              ? Math.max(0, existing.capacity.maxMemoryMb - h.memFreeMib)
              : existing.load.memoryUsedMb,
          profileDiskUsedMb:
            h.diskFreeMib != null
              ? Math.max(0, existing.capacity.profileDiskMb - h.diskFreeMib)
              : existing.load.profileDiskUsedMb,
          loadAvg1: detail.loadAvg1 ?? existing.load.loadAvg1,
          sampledAt: at,
        },
      });
    },
    findStaleNodes: async () => [] as Node[],

    createInstance: async (i: NewInstance) => {
      const id = i.id ?? newId('inst');
      const now = nowSource.now();
      const row: InternalInstance = {
        id,
        tenantId: i.tenantId,
        appId: i.appId,
        poolId: i.poolId ?? null,
        subject: i.createdBySub ?? null,
        status: 'launching',
        stateReason: null,
        stateChangedAt: now,
        nodeId: i.nodeId,
        fence: 0,
        specId: i.specId,
        profileId: i.profileId ?? null,
        profileSpec: defaultProfileSpec(i.tenantId, id),
        sessionId: null,
        acquiredAt: now,
        readyAt: null,
        releasedAt: null,
        expiresAt: now + 14_400_000,
        lastActivityAt: now,
        metadata: i.metadata,
        lifetime: i.lifetime,
        firstViewerAt: null,
        releaseReason: null,
        restartCount: 0,
        peakRssMib: null,
        osPid: null,
      };
      instances.set(id, row);
      return toInstance(row);
    },
    getInstance: async (tenantId: string, id: string) => {
      const row = instances.get(id);
      return row && row.tenantId === tenantId ? toInstance(row) : null;
    },
    listInstances: async (tenantId: string, f?: InstanceFilter) => {
      const statuses = f?.status ? (Array.isArray(f.status) ? f.status : [f.status]) : null;
      return [...instances.values()]
        .filter((r) => r.tenantId === tenantId)
        .filter((r) => !statuses || statuses.includes(r.status))
        .filter((r) => !f?.poolId || r.poolId === f.poolId)
        .filter((r) => !f?.nodeId || r.nodeId === f.nodeId)
        .filter((r) => !f?.createdBySub || r.subject === f.createdBySub)
        .map(toInstance);
    },
    transitionInstance: async (
      tenantId: string,
      id: string,
      from: InstanceStatus[],
      to: InstanceStatus,
      patch?: Partial<Instance>,
    ) => {
      const row = instances.get(id);
      if (!row || row.tenantId !== tenantId || !from.includes(row.status)) return false;
      row.status = to;
      row.stateChangedAt = nowSource.now();
      if (patch) {
        if (patch.stateReason !== undefined) row.stateReason = patch.stateReason;
        if (patch.nodeId !== undefined) row.nodeId = patch.nodeId as string | null;
        if (patch.fence !== undefined) row.fence = patch.fence;
        if (patch.profileId !== undefined) row.profileId = patch.profileId as string | null;
        if (patch.sessionId !== undefined) row.sessionId = patch.sessionId as string | null;
        if (patch.readyAt !== undefined) row.readyAt = patch.readyAt;
        if (patch.releasedAt !== undefined) row.releasedAt = patch.releasedAt;
        if (patch.expiresAt !== undefined) row.expiresAt = patch.expiresAt;
        if (patch.lastActivityAt !== undefined) row.lastActivityAt = patch.lastActivityAt;
        // The one writable field of the five `entities.ts`'s `Instance`
        // doc names as diagnostic-only: `BrowserRouter.release()`'s
        // terminal transition passes this now, mirroring
        // `store-sqlite`/`store-postgres`'s own `INSTANCE_PATCH_RULES`
        // `releaseReason: { column: 'release_reason', ... }` entry.
        if (patch.releaseReason !== undefined) row.releaseReason = patch.releaseReason;
      }
      return true;
    },
    bumpInstanceEpoch: async () => 1,
    touchInstance: async (_tenantId: string, id: string, at: string) => {
      const row = instances.get(id);
      if (row) row.lastActivityAt = new Date(at).getTime();
    },
    claimWarmInstance: async (req: {
      tenantId: string;
      poolId: string;
      specId: string;
      profileId?: string;
    }) => {
      const candidate = [...instances.values()].find(
        (r) =>
          r.tenantId === req.tenantId &&
          r.poolId === req.poolId &&
          r.specId === req.specId &&
          r.status === 'warm',
      );
      if (!candidate) return null;
      candidate.status = 'live';
      candidate.stateChangedAt = nowSource.now();
      // Matches `store-sqlite`/`store-postgres`'s own `COALESCE(first_viewer_at, ?)`:
      // set once, on the warm claim, never overwritten after.
      candidate.firstViewerAt ??= nowSource.now();
      return toInstance(candidate);
    },

    createSession: async (s: NewSession) => {
      const id = s.id ?? newId('sess');
      const row: SessionRow = {
        id,
        instanceId: s.instanceId,
        tenantId: s.tenantId,
        nodeId: '' as SessionRow['nodeId'],
        state: 'live',
        startedAt: nowSource.now(),
        endedAt: null,
        endReason: null,
        peakViewers: 0,
      };
      sessions.set(id, row);
      return row;
    },
    getSession: async (_tenantId: string, id: string) => sessions.get(id) ?? null,
    endSession: async (_tenantId: string, id: string, reason: string) => {
      const row = sessions.get(id);
      if (row)
        sessions.set(id, { ...row, state: 'ended', endedAt: nowSource.now(), endReason: reason });
    },
    listSessionsByGateway: async () => [] as SessionRow[],

    createViewer: async (_v: NewViewer) => {
      throw new Error('not implemented in MockStore');
    },
    closeViewer: async (_id: string, _close: ViewerClose) => undefined,
    listViewers: async () => [] as import('@browserglass/protocol').Viewer[],

    recordControlGrant: async (g: NewControlLease) => {
      const id = g.id ?? newId('lse');
      const row: ControlLeaseRow = {
        id,
        tenantId: g.tenantId,
        sessionId: g.sessionId,
        targetId: g.targetId,
        viewerId: g.viewerId,
        sub: g.sub,
        grantedAt: g.grantedAt,
        releasedAt: null,
        releaseReason: null,
        displaced: null,
        inputEvents: 0,
      };
      return row;
    },
    recordControlRelease: async () => undefined,

    getQuotas: async () => [] as Quota[],
    setQuota: async () => undefined,
    // Unconditional atomic increment, per `reserveAdmission`'s documented
    // contract (`src/admission/reserve.ts`'s top comment): this mock has
    // no independent notion of a configured limit, so it always
    // increments and reports the post increment value; the caller
    // (`reserveAdmission`) compares that value against its own known
    // limit and calls `releaseQuota` to roll back an over-limit increment.
    reserveQuota: async (req: {
      tenantId: string;
      scope: string;
      metric: string;
      amount: number;
    }) => {
      const key = `${req.tenantId}|${req.scope}|${req.metric}`;
      const next = (quotaGauges.get(key) ?? 0) + req.amount;
      quotaGauges.set(key, next);
      return { allowed: true, value: next, limit: Number.POSITIVE_INFINITY };
    },
    releaseQuota: async (req: {
      tenantId: string;
      scope: string;
      metric: string;
      amount: number;
    }) => {
      const key = `${req.tenantId}|${req.scope}|${req.metric}`;
      const current = quotaGauges.get(key) ?? 0;
      quotaGauges.set(key, Math.max(0, current - req.amount));
    },

    incrementUsage: async (_rows: UsageIncrement[]) => undefined,
    readUsage: async () => [] as UsageRow[],

    appendAudit: async (_events: AuditEvent[]) => undefined,
    queryAudit: async (): Promise<AuditPage> => ({ events: [], nextCursor: null }),
    appendAuditChained: () => undefined,

    createDownload: async () => {
      throw new Error('not implemented in MockStore');
    },
    updateDownload: async () => {
      throw new Error('not implemented in MockStore');
    },
    listDownloads: async () => [] as Download[],
    createUpload: async () => {
      throw new Error('not implemented in MockStore');
    },
    updateUpload: async () => {
      throw new Error('not implemented in MockStore');
    },
    findStaleUploads: async () => [] as Upload[],

    redeemAttachTicket: async (_t: AttachTicketRedeem) => true,
    putRevocation: async (_r: NewRevocation) => undefined,
    checkRevoked: async (_tenantId: string, _checks: RevocationCheck[]) => null,

    createInvite: async () => {
      throw new Error('not implemented in MockStore');
    },
    redeemInvite: () => null,
    revokeInvite: async () => {
      throw new Error('not implemented in MockStore');
    },

    enqueuePlacement: async (p: NewPlacement) => {
      const id = p.id ?? newId('inst');
      const row: PlacementRow = {
        id,
        tenantId: p.tenantId,
        appId: p.appId,
        poolId: p.poolId,
        specId: p.specId,
        profileKey: p.profileKey ?? null,
        priority: p.priority ?? 100,
        requestedBy: p.requestedBy ?? null,
        status: 'queued',
        claimedBy: null,
        claimedAt: null,
        instanceId: null,
        attempts: 0,
        lastError: null,
        enqueuedAt: new Date(nowSource.now()).toISOString(),
        deadlineAt: p.deadlineAt,
      };
      placementQueue.set(id, row);
      return row;
    },
    claimPlacements: async (routerId: string, limit: number) => {
      const claimed: PlacementRow[] = [];
      for (const row of placementQueue.values()) {
        if (claimed.length >= limit) break;
        if (row.status !== 'queued') continue;
        row.status = 'claimed';
        row.claimedBy = routerId;
        row.claimedAt = new Date(nowSource.now()).toISOString();
        claimed.push(row);
      }
      return claimed;
    },
    completePlacement: async (id: string, instanceId: string) => {
      const row = placementQueue.get(id);
      if (row) {
        row.status = 'placed';
        row.instanceId = instanceId;
      }
    },
    failPlacement: async (id: string, error: string, retry: boolean) => {
      const row = placementQueue.get(id);
      if (!row) return;
      row.lastError = error;
      row.attempts += 1;
      row.status = retry ? 'queued' : 'failed';
      if (retry) row.claimedBy = null;
    },

    purge: async () => 0,
    maintain: async (): Promise<MaintenanceReport> => ({
      startedAt: new Date(nowSource.now()).toISOString(),
      durationMs: 0,
      vacuumed: false,
      analyzed: false,
      notes: [],
    }),
    migrate: async (): Promise<MigrationReport> => ({ fromVersion: 1, toVersion: 1, applied: [] }),
    schemaVersion: async () => 1,

    seedProfileSpec: (instanceId: string, spec: ResolvedProfileSpec) => {
      const row = instances.get(instanceId);
      if (row) row.profileSpec = spec;
    },
  };

  // Expose the underlying maps for test seeding (tenants/apps/pools), via
  // properties tests can reach through a cast; kept off the typed `Store`
  // surface so production code never sees them.
  (
    store as unknown as { __tenants: typeof tenants; __apps: typeof apps; __pools: typeof pools }
  ).__tenants = tenants;
  (
    store as unknown as { __tenants: typeof tenants; __apps: typeof apps; __pools: typeof pools }
  ).__apps = apps;
  (
    store as unknown as { __tenants: typeof tenants; __apps: typeof apps; __pools: typeof pools }
  ).__pools = pools;

  return store;
}

const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxInstances: 1000,
  maxInstancesPerApp: 1000,
  maxInstancesPerUser: 1000,
  maxViewers: 1000,
  maxProfiles: 1000,
  maxProfileBytes: 1_000_000_000,
  maxSessionMinutesPerDay: 100_000,
  maxAcquiresPerMinute: 1000,
  maxFrameBytesPerMinute: 1_000_000_000,
};

const DEFAULT_TENANT_DEFAULTS: Tenant['defaults'] = {
  browserSpec: {},
  profileTtlMs: 0,
  sessionIdleMs: 1_800_000,
  sessionMaxDurationMs: 14_400_000,
  controlLeaseMs: 60_000,
  controlForceClaim: 'allowed',
  maxViewersPerStream: 8,
  maxStreamsPerSession: 8,
  maxStreamsPerViewer: 4,
};

const DEFAULT_CAPACITY = {
  maxInstances: 100,
  maxMemoryMb: 32_000,
  cpuCores: 8,
  profileDiskMb: 500_000,
  maxConcurrentLaunches: 4,
};
const DEFAULT_LOAD = {
  liveInstances: 0,
  warmInstances: 0,
  launchingInstances: 0,
  cpuPercent: 0,
  memoryUsedMb: 0,
  profileDiskUsedMb: 0,
  loadAvg1: 0,
  sampledAt: 0,
};

/** This fake's own copy of `store-sqlite`'s `NODE_STATUS_TO_STATE` (`mappers.ts`); see `setNodeStatus`'s own comment above for why it cannot be imported instead. */
const MOCK_NODE_STATUS_TO_STATE: Record<NodeStatus, NodeState> = {
  joining: 'registering',
  ready: 'ready',
  draining: 'draining',
  cordoned: 'quarantined',
  lost: 'lost',
  retired: 'drained',
};

const DEFAULT_TEST_SPEC = {
  engine: 'chromium' as const,
  channel: 'chrome' as const,
  executablePath: null,
  headless: 'new' as const,
  viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
  window: null,
  isolation: 'tab' as const,
  userAgent: null,
  clientHints: null,
  locale: null,
  timezoneId: null,
  geolocation: null,
  permissions: [],
  colorScheme: 'light' as const,
  reducedMotion: 'no-preference' as const,
  proxy: null,
  extraArgs: [],
  ignoreDefaultArgs: [],
  env: {},
  extensions: [],
  stealth: 'off' as const,
  ignoreHttpsErrors: false,
  downloadDir: null,
  uploadDir: null,
  acceptDownloads: false,
  maxDownloadBytes: null,
  resources: { cpus: null, memoryMb: null, shmMb: null, pidsLimit: null },
  initialUrl: null,
  launchTimeoutMs: 30_000,
};

function storedToBrowserSpec(row: StoredBrowserSpec) {
  return {
    ...DEFAULT_TEST_SPEC,
    channel: row.channel,
    headless: row.headless,
    // Mirrors the real `storedSpecToBrowserSpec` (store-sqlite/src/mappers.ts):
    // a stored row written before this column existed has no `isolation` at
    // all, and that always meant `'tab'`.
    isolation: row.isolation ?? 'tab',
    viewport: { width: row.viewportW, height: row.viewportH, deviceScaleFactor: row.dpr },
    locale: row.locale,
    timezoneId: row.timezone,
    userAgent: row.userAgent,
    proxy: row.proxy
      ? { server: row.proxy.server, bypass: row.proxy.bypass, username: null, password: null }
      : null,
    extraArgs: row.args,
    stealth: row.stealth,
    launchTimeoutMs:
      typeof row.limits['launchTimeoutMs'] === 'number'
        ? (row.limits['launchTimeoutMs'] as number)
        : 30_000,
  };
}

/** Seeds a minimal tenant, app, and pool into a `MockStore`, returning their ids. Every router test starts from this. */
export function seedBasics(
  store: Store,
  opts?: {
    tenantId?: string;
    appId?: string;
    poolId?: string;
    maxInstances?: number;
    onFull?: 'reject' | 'queue' | 'evictIdle';
    /** The pool template's `BrowserSpec.isolation`. Defaults to `'tab'`, the historical behaviour. */
    isolation?: 'tab' | 'window';
  },
): { tenantId: string; appId: string; poolId: string } {
  const tenantId = opts?.tenantId ?? newId('ten');
  const appId = opts?.appId ?? newId('app');
  const poolId = opts?.poolId ?? newId('pol');
  const internal = store as unknown as {
    __tenants: Map<string, Tenant>;
    __apps: Map<string, App>;
    __pools: Map<string, Pool>;
  };
  internal.__tenants.set(tenantId, {
    id: tenantId as Tenant['id'],
    name: 'test-tenant',
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
    keys: [],
    quotas: DEFAULT_QUOTA_LIMITS,
    defaults: DEFAULT_TENANT_DEFAULTS,
    labels: {},
  });
  internal.__apps.set(appId, {
    id: appId as App['id'],
    tenantId: tenantId as App['tenantId'],
    name: 'test-app',
    state: 'active',
    createdAt: 0,
    grantableCapabilities: ['view', 'control', 'navigate', 'tabs.manage', 'instance.create'],
    quotas: {},
    defaultPoolId: poolId as App['defaultPoolId'],
    metadata: {},
  });
  internal.__pools.set(poolId, {
    id: poolId as Pool['id'],
    tenantId: tenantId as Pool['tenantId'],
    name: 'default',
    state: 'active',
    template: (opts?.isolation !== undefined
      ? { ...DEFAULT_TEST_SPEC, isolation: opts.isolation }
      : DEFAULT_TEST_SPEC) as Pool['template'],
    profileTemplate: { mode: 'ephemeral' },
    warm: {
      min: 0,
      max: 0,
      maxIdleMs: 300_000,
      minAcquiresPerMinute: 2,
      allowPersistentAdoption: false,
    },
    placement: { policy: 'scoredPlacement', params: {} },
    limits: {
      maxInstances: opts?.maxInstances ?? 100,
      maxInstancesPerUser: 100,
      maxViewersPerStream: 8,
      maxStreamsPerSession: 8,
      sessionIdleMs: 1_800_000,
      sessionMaxDurationMs: 14_400_000,
      onFull: opts?.onFull ?? 'reject',
      queueMaxDepth: 20,
      queueMaxWaitMs: 60_000,
    },
    nodeSelector: {},
    createdAt: 0,
    updatedAt: 0,
  });
  return { tenantId, appId, poolId };
}
