import type { NodeSnapshot, ResolvedProfileSpec } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import {
  estimateMemoryMb,
  estimateProfileMb,
  placementCandidates,
} from '../../src/placement/candidates.js';

function nodeAt(overrides: Partial<NodeSnapshot>): NodeSnapshot {
  return {
    nodeId: newId('nod'),
    labels: {},
    state: 'ready',
    capacity: {
      maxInstances: 10,
      maxMemoryMb: 10_000,
      cpuCores: 4,
      profileDiskMb: 100_000,
      maxConcurrentLaunches: 4,
    },
    load: {
      liveInstances: 0,
      warmInstances: 0,
      launchingInstances: 0,
      cpuPercent: 0,
      memoryUsedMb: 0,
      profileDiskUsedMb: 0,
      loadAvg1: 0,
      sampledAt: 0,
    },
    lastHeartbeatAt: 1000,
    hostsProfiles: [],
    ...overrides,
  };
}

const PROFILE: ResolvedProfileSpec = {
  mode: 'ephemeral',
  tenantId: newId('ten'),
  key: 'eph:x',
  templateId: null,
  seed: null,
  destroyOnRelease: true,
  snapshotOnRelease: false,
  ttlMs: null,
  profileId: null,
};

describe('estimateMemoryMb', () => {
  it('uses the headless base by default', () => {
    expect(estimateMemoryMb(DEFAULT_BROWSER_SPEC, 1)).toBe(350);
  });
  it('uses the headful base for off/xvfb-headful', () => {
    expect(estimateMemoryMb({ ...DEFAULT_BROWSER_SPEC, headless: 'off' }, 1)).toBe(550);
  });
  it('adds 120mb per extra expected tab', () => {
    expect(estimateMemoryMb(DEFAULT_BROWSER_SPEC, 3)).toBe(350 + 120 * 2);
  });
  it('honours an explicit resources.memoryMb', () => {
    expect(
      estimateMemoryMb({
        ...DEFAULT_BROWSER_SPEC,
        resources: { cpus: null, memoryMb: 999, shmMb: null, pidsLimit: null },
      }),
    ).toBe(999);
  });
});

describe('estimateProfileMb', () => {
  it('is smaller for ephemeral than persistent', () => {
    expect(estimateProfileMb(PROFILE)).toBeLessThan(
      estimateProfileMb({ ...PROFILE, mode: 'persistent' }),
    );
  });
});

describe('placementCandidates', () => {
  const baseReq = {
    spec: DEFAULT_BROWSER_SPEC,
    profile: PROFILE,
    affinity: {},
    nodeSelector: {},
    now: 1000,
    nodeStaleMs: 12_000,
  };

  it('excludes a non-ready node', () => {
    const nodes = [nodeAt({ state: 'draining' })];
    expect(placementCandidates(nodes, baseReq)).toEqual([]);
  });

  it('excludes a node with a stale heartbeat', () => {
    const nodes = [nodeAt({ lastHeartbeatAt: 1000 - 12_000 })];
    expect(placementCandidates(nodes, baseReq)).toEqual([]);
  });

  it('excludes a node at instance capacity', () => {
    const nodes = [
      nodeAt({
        load: {
          liveInstances: 10,
          warmInstances: 0,
          launchingInstances: 0,
          cpuPercent: 0,
          memoryUsedMb: 0,
          profileDiskUsedMb: 0,
          loadAvg1: 0,
          sampledAt: 0,
        },
      }),
    ];
    expect(placementCandidates(nodes, baseReq)).toEqual([]);
  });

  it('excludes a node without enough free memory', () => {
    const nodes = [
      nodeAt({
        capacity: {
          maxInstances: 10,
          maxMemoryMb: 100,
          cpuCores: 4,
          profileDiskMb: 100_000,
          maxConcurrentLaunches: 4,
        },
      }),
    ];
    expect(placementCandidates(nodes, baseReq)).toEqual([]);
  });

  it('excludes a node whose labels do not match the pool selector', () => {
    const nodes = [nodeAt({ labels: { region: 'us' } })];
    expect(placementCandidates(nodes, { ...baseReq, nodeSelector: { region: 'eu' } })).toEqual([]);
  });

  it('excludes a node that does not match a hard requireNodeId', () => {
    const nodes = [nodeAt({})];
    expect(
      placementCandidates(nodes, { ...baseReq, affinity: { requireNodeId: newId('nod') } }),
    ).toEqual([]);
  });

  it('includes a healthy node with headroom', () => {
    const nodes = [nodeAt({})];
    expect(placementCandidates(nodes, baseReq)).toHaveLength(1);
  });
});
