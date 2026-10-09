import { describe, expect, it } from 'vitest';
import type { Store, StoreCapabilities, StoreTx } from '../../src/domain/store.js';

/**
 * A hand written, fully typed no-op implementation of `Store`. Its only
 * purpose is to prove every method signature in the interface type checks:
 * if a future edit to `Store` or one of its roughly 45 supporting types
 * breaks compatibility with a real adapter's shape, this file fails to
 * compile before any adapter is even written.
 */
const noopCapabilities: StoreCapabilities = {
  transactions: true,
  advisoryLocks: false,
  skipLocked: false,
  notify: false,
  concurrentWriters: false,
  maxWriteConcurrency: 1,
};

const noopTx: StoreTx = {
  kind: 'sqlite',
  get: () => null,
  insert: () => undefined,
  update: () => 0,
  delete: () => 0,
  raw: () => [],
};

const noopStore: Store = {
  init: async () => undefined,
  close: async () => undefined,
  ping: async () => ({ ok: true, latencyMs: 0 }),
  capabilities: () => noopCapabilities,

  transaction: async (fn) => fn(noopTx),

  getTenant: async () => null,
  listTenants: async () => [],
  createTenant: async (t) => ({
    id: t.id ?? ('ten_00000000000000000000000000' as never),
    name: t.name,
    state: 'active',
    createdAt: 0,
    updatedAt: 0,
    keys: [],
    quotas: {
      maxInstances: 0,
      maxInstancesPerApp: 0,
      maxInstancesPerUser: 0,
      maxViewers: 0,
      maxProfiles: 0,
      maxProfileBytes: 0,
      maxSessionMinutesPerDay: 0,
      maxAcquiresPerMinute: 0,
      maxFrameBytesPerMinute: 0,
    },
    defaults: {
      browserSpec: {},
      profileTtlMs: 0,
      sessionIdleMs: 0,
      sessionMaxDurationMs: 0,
      controlLeaseMs: 0,
      controlForceClaim: 'allowed',
      maxViewersPerStream: 0,
      maxStreamsPerSession: 0,
      maxStreamsPerViewer: 0,
    },
    labels: {},
  }),
  updateTenant: async (_id, _patch) => {
    throw new Error('not implemented');
  },
  setTenantStatus: async () => undefined,

  getApp: async () => null,
  listApps: async () => [],
  createApp: async (_a) => {
    throw new Error('not implemented');
  },
  updateApp: async (_t, _a, _p) => {
    throw new Error('not implemented');
  },

  getAppKey: async () => null,
  listAppKeys: async () => [],
  createAppKey: async (_k) => {
    throw new Error('not implemented');
  },
  rotateAppKey: () => undefined,
  revokeAppKey: async () => undefined,

  getPool: async () => null,
  getPoolByName: async () => null,
  listPools: async () => [],
  createPool: async (_p) => {
    throw new Error('not implemented');
  },
  updatePool: async (_t, _id, _p) => {
    throw new Error('not implemented');
  },

  upsertBrowserSpec: async (_t, _spec) => {
    throw new Error('not implemented');
  },
  getBrowserSpec: async () => null,

  getProfile: async () => null,
  getProfileByKey: async () => null,
  listProfiles: async () => [],
  createProfile: async (_p) => {
    throw new Error('not implemented');
  },
  updateProfile: async (_t, _id, _p) => {
    throw new Error('not implemented');
  },
  setProfileState: async () => undefined,
  deleteProfile: async () => undefined,

  acquireProfileLease: async () => null,
  heartbeatProfileLease: async () => false,
  releaseProfileLease: async () => undefined,
  expireProfileLeases: async () => [],

  createSnapshot: async (_s) => {
    throw new Error('not implemented');
  },
  listSnapshots: async () => [],
  deleteSnapshot: async () => undefined,

  registerNode: async (_n) => {
    throw new Error('not implemented');
  },
  getNode: async () => null,
  listNodes: async () => [],
  setNodeStatus: async () => undefined,
  heartbeatNode: async () => undefined,
  findStaleNodes: async () => [],

  createInstance: async (_i) => {
    throw new Error('not implemented');
  },
  getInstance: async () => null,
  listInstances: async () => [],
  transitionInstance: async () => false,
  bumpInstanceEpoch: async () => 1,
  touchInstance: async () => undefined,
  claimWarmInstance: async () => null,

  createSession: async (_s) => {
    throw new Error('not implemented');
  },
  getSession: async () => null,
  endSession: async () => undefined,
  listSessionsByGateway: async () => [],

  createViewer: async (_v) => {
    throw new Error('not implemented');
  },
  closeViewer: async () => undefined,
  listViewers: async () => [],

  recordControlGrant: async (_g) => {
    throw new Error('not implemented');
  },
  recordControlRelease: async () => undefined,

  getQuotas: async () => [],
  setQuota: async () => undefined,
  reserveQuota: async () => ({ allowed: true, value: 0, limit: 0 }),
  releaseQuota: async () => undefined,

  incrementUsage: async () => undefined,
  readUsage: async () => [],

  appendAudit: async () => undefined,
  queryAudit: async () => ({ events: [], nextCursor: null }),
  appendAuditChained: () => undefined,

  createDownload: async (_d) => {
    throw new Error('not implemented');
  },
  updateDownload: async (_t, _id, _p) => {
    throw new Error('not implemented');
  },
  listDownloads: async () => [],
  createUpload: async (_u) => {
    throw new Error('not implemented');
  },
  updateUpload: async (_t, _id, _p) => {
    throw new Error('not implemented');
  },
  findStaleUploads: async () => [],

  redeemAttachTicket: async () => false,
  putRevocation: async () => undefined,
  checkRevoked: async () => null,

  createInvite: async (_i) => {
    throw new Error('not implemented');
  },
  redeemInvite: () => null,
  revokeInvite: async (_t, _id, _by) => {
    throw new Error('not implemented');
  },

  enqueuePlacement: async (_p) => {
    throw new Error('not implemented');
  },
  claimPlacements: async () => [],
  completePlacement: async () => undefined,
  failPlacement: async () => undefined,

  purge: async () => 0,
  maintain: async () => ({
    startedAt: '1970-01-01T00:00:00.000Z',
    durationMs: 0,
    vacuumed: false,
    analyzed: false,
    notes: [],
  }),
  migrate: async () => ({ fromVersion: 0, toVersion: 0, applied: [] }),
  schemaVersion: async () => 0,
};

describe('Store no-op implementation', () => {
  it('type checks against the full Store interface and is callable at runtime', async () => {
    expect(noopStore.capabilities().maxWriteConcurrency).toBe(1);
    const ping = await noopStore.ping();
    expect(ping.ok).toBe(true);
    const result = await noopStore.transaction((tx) => tx.get('tenants', { id: 'x' }));
    expect(result).toBeNull();
  });
});
