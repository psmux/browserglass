import type { NodeCapacity, NodeLoad } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import {
  type PlacementScoringContext,
  affinityScore,
  cpuScore,
  diskScore,
  memoryScore,
  packingScore,
  penaltyScore,
  scorePlacementBreakdown,
  spreadScore,
  warmScore,
} from '../../src/placement/scoring.js';
import { DEFAULT_ROUTER_CONFIG } from '../../src/router/config.js';

describe('affinityScore', () => {
  it('is 1.0 when the node is the persistent profile home', () => {
    expect(affinityScore({ mode: 'persistent', isHome: true })).toBe(1.0);
  });
  it('is 0.0 when persistent and homed elsewhere', () => {
    expect(affinityScore({ mode: 'persistent', isHome: false })).toBe(0.0);
  });
  it('is 0.5 for ephemeral, never a constant 1.0 or 0.0', () => {
    expect(affinityScore({ mode: 'ephemeral', isHome: false })).toBe(0.5);
  });
  it('is 0.5 for template', () => {
    expect(affinityScore({ mode: 'template', isHome: false })).toBe(0.5);
  });
});

describe('packingScore', () => {
  const capacity: NodeCapacity = {
    maxInstances: 100,
    maxMemoryMb: 1000,
    cpuCores: 4,
    profileDiskMb: 1000,
    maxConcurrentLaunches: 4,
  };
  const loadAt = (u: number): NodeLoad => ({
    liveInstances: Math.round(u * 100),
    warmInstances: 0,
    launchingInstances: 0,
    cpuPercent: 0,
    memoryUsedMb: 0,
    profileDiskUsedMb: 0,
    loadAvg1: 0,
    sampledAt: 0,
  });

  it('peaks at 1.0 exactly at targetUtilisation', () => {
    expect(packingScore(capacity, loadAt(0.65), 0.65)).toBeCloseTo(1.0, 6);
  });
  it('is lower for an empty node than for one at target', () => {
    const empty = packingScore(capacity, loadAt(0), 0.65);
    const atTarget = packingScore(capacity, loadAt(0.65), 0.65);
    expect(empty).toBeLessThan(atTarget);
  });
  it('is lower near full than at target', () => {
    const nearFull = packingScore(capacity, loadAt(0.95), 0.65);
    const atTarget = packingScore(capacity, loadAt(0.65), 0.65);
    expect(nearFull).toBeLessThan(atTarget);
  });
});

describe('cpuScore', () => {
  it('is 0 at and above 90 percent, the unsmoothed cliff', () => {
    expect(cpuScore(90)).toBe(0);
    expect(cpuScore(99)).toBe(0);
  });
  it('is 0.05 in the 85 to 90 band', () => {
    expect(cpuScore(85)).toBe(0.05);
    expect(cpuScore(89)).toBe(0.05);
  });
  it('is linear in remaining headroom below 85', () => {
    expect(cpuScore(0)).toBeCloseTo(1.0, 6);
    expect(cpuScore(68)).toBeCloseTo(17 / 85, 6);
  });
});

describe('memoryScore', () => {
  const capacity: NodeCapacity = {
    maxInstances: 10,
    maxMemoryMb: 1000,
    cpuCores: 4,
    profileDiskMb: 1000,
    maxConcurrentLaunches: 4,
  };
  it('is 0 below 10 percent free', () => {
    const load: NodeLoad = {
      liveInstances: 0,
      warmInstances: 0,
      launchingInstances: 0,
      cpuPercent: 0,
      memoryUsedMb: 950,
      profileDiskUsedMb: 0,
      loadAvg1: 0,
      sampledAt: 0,
    };
    expect(memoryScore(capacity, load)).toBe(0);
  });
  it('saturates at 60 percent free', () => {
    const load: NodeLoad = {
      liveInstances: 0,
      warmInstances: 0,
      launchingInstances: 0,
      cpuPercent: 0,
      memoryUsedMb: 400,
      profileDiskUsedMb: 0,
      loadAvg1: 0,
      sampledAt: 0,
    };
    expect(memoryScore(capacity, load)).toBeCloseTo(1.0, 6);
  });
});

describe('diskScore', () => {
  const capacity: NodeCapacity = {
    maxInstances: 10,
    maxMemoryMb: 1000,
    cpuCores: 4,
    profileDiskMb: 1000,
    maxConcurrentLaunches: 4,
  };
  it('is 0 below 5 percent free', () => {
    const load: NodeLoad = {
      liveInstances: 0,
      warmInstances: 0,
      launchingInstances: 0,
      cpuPercent: 0,
      memoryUsedMb: 0,
      profileDiskUsedMb: 960,
      loadAvg1: 0,
      sampledAt: 0,
    };
    expect(diskScore(capacity, load)).toBe(0);
  });
  it('saturates at 30 percent free', () => {
    const load: NodeLoad = {
      liveInstances: 0,
      warmInstances: 0,
      launchingInstances: 0,
      cpuPercent: 0,
      memoryUsedMb: 0,
      profileDiskUsedMb: 500,
      loadAvg1: 0,
      sampledAt: 0,
    };
    expect(diskScore(capacity, load)).toBeCloseTo(1.0, 6);
  });
});

describe('warmScore', () => {
  it('is binary', () => {
    expect(warmScore(true)).toBe(1.0);
    expect(warmScore(false)).toBe(0.0);
  });
});

describe('spreadScore', () => {
  it('is 0 when no spread key was requested, regardless of count', () => {
    expect(spreadScore(false, 5)).toBe(0);
  });
  it('is 1 for the first instance of a spread key', () => {
    expect(spreadScore(true, 0)).toBe(1);
  });
  it('decreases as more live instances share the spread key', () => {
    expect(spreadScore(true, 1)).toBeCloseTo(0.5, 6);
    expect(spreadScore(true, 3)).toBeCloseTo(0.25, 6);
  });
});

describe('penaltyScore', () => {
  it('accrues 0.25 per recent launch failure, capped at 0.75', () => {
    expect(penaltyScore(0, false)).toBe(0);
    expect(penaltyScore(1, false)).toBeCloseTo(0.25, 6);
    expect(penaltyScore(2, false)).toBeCloseTo(0.5, 6);
    expect(penaltyScore(10, false)).toBeCloseTo(0.75, 6);
  });
  it('adds 0.10 for a recent incident', () => {
    expect(penaltyScore(0, true)).toBeCloseTo(0.1, 6);
    expect(penaltyScore(1, true)).toBeCloseTo(0.35, 6);
  });
});

/**
 * A three node worked example: a
 * persistent profile homed on node B, node B wins despite being the
 * busiest, hottest, and most memory constrained node, purely on the
 * strength of the affinity term.
 *
 * The original hand worked table for this example (score column: 0.418 /
 * 0.632 / 0.279) is not reproducible from its own per-term values under
 * the default weights (node B's listed terms sum to 0.593, not 0.632,
 * under `w_aff=0.35` etc.). This fixture instead derives node
 * parameters directly from `scorePlacement`'s documented formulas so every
 * intermediate term is independently checkable, landing node B within
 * 0.003 of the original headline 0.632 while preserving the qualitative
 * claim under test: the home node wins by a wide margin despite losing on
 * every other term.
 */
describe('scorePlacement, three node worked example (home node wins at ~0.632)', () => {
  const weights = DEFAULT_ROUTER_CONFIG.placementWeights;
  const targetUtilisation = DEFAULT_ROUTER_CONFIG.targetUtilisation; // 0.65

  const nodeA: PlacementScoringContext = {
    nodeId: 'nod_A',
    capacity: {
      maxInstances: 24,
      maxMemoryMb: 48_000,
      cpuCores: 8,
      profileDiskMb: 100_000,
      maxConcurrentLaunches: 4,
    },
    load: {
      liveInstances: 15,
      warmInstances: 0,
      launchingInstances: 1,
      cpuPercent: 5,
      memoryUsedMb: 5_000,
      profileDiskUsedMb: 10_000,
      loadAvg1: 0,
      sampledAt: 0,
    },
    affinity: { mode: 'persistent', isHome: false },
    hasAdoptableWarm: true,
    recentLaunchFailures: 0,
    recentIncident: false,
    spreadCount: 0,
  };

  const nodeB: PlacementScoringContext = {
    nodeId: 'nod_B',
    capacity: {
      maxInstances: 24,
      maxMemoryMb: 48_000,
      cpuCores: 8,
      profileDiskMb: 100_000,
      maxConcurrentLaunches: 4,
    },
    load: {
      liveInstances: 17,
      warmInstances: 0,
      launchingInstances: 1,
      cpuPercent: 68,
      memoryUsedMb: 38_400,
      profileDiskUsedMb: 50_000,
      loadAvg1: 0,
      sampledAt: 0,
    },
    affinity: { mode: 'persistent', isHome: true }, // home node
    hasAdoptableWarm: false,
    recentLaunchFailures: 0,
    recentIncident: false,
    spreadCount: 0,
  };

  const nodeC: PlacementScoringContext = {
    nodeId: 'nod_C',
    capacity: {
      maxInstances: 24,
      maxMemoryMb: 48_000,
      cpuCores: 8,
      profileDiskMb: 100_000,
      maxConcurrentLaunches: 4,
    },
    load: {
      liveInstances: 10,
      warmInstances: 0,
      launchingInstances: 0,
      cpuPercent: 44,
      memoryUsedMb: 19_000,
      profileDiskUsedMb: 39_000,
      loadAvg1: 0,
      sampledAt: 0,
    },
    affinity: { mode: 'persistent', isHome: false },
    hasAdoptableWarm: false,
    recentLaunchFailures: 1, // a recent launch failure penalises this node
    recentIncident: false,
    spreadCount: 0,
  };

  it('home node B wins, within 0.005 of the source document headline 0.632', () => {
    const scoreB = scorePlacementBreakdown(nodeB, weights, targetUtilisation, false);
    expect(scoreB.affinity).toBe(1.0);
    expect(scoreB.score).toBeCloseTo(0.632, 2);
  });

  it('node B outscores both A and C despite worse CPU, memory, and disk headroom', () => {
    const scoreA = scorePlacementBreakdown(nodeA, weights, targetUtilisation, false);
    const scoreB = scorePlacementBreakdown(nodeB, weights, targetUtilisation, false);
    const scoreC = scorePlacementBreakdown(nodeC, weights, targetUtilisation, false);

    // B is objectively worse than A on every non-affinity term.
    expect(scoreB.cpu).toBeLessThan(scoreA.cpu);
    expect(scoreB.memory).toBeLessThan(scoreA.memory);
    expect(scoreB.disk).toBeLessThanOrEqual(scoreA.disk);
    expect(scoreB.warm).toBeLessThan(scoreA.warm);

    // Yet B wins overall, by a wide margin, purely on affinity.
    expect(scoreB.score).toBeGreaterThan(scoreA.score);
    expect(scoreB.score).toBeGreaterThan(scoreC.score);
    expect(scoreB.score - scoreA.score).toBeGreaterThan(0.04);
  });

  it("node C's recent launch failure penalty is applied and visible", () => {
    const scoreC = scorePlacementBreakdown(nodeC, weights, targetUtilisation, false);
    expect(scoreC.penalty).toBeCloseTo(0.25, 6);
  });
});
