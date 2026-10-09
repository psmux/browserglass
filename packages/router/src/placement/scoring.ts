/**
 * Placement scoring. Implemented fully and tested even
 * though a single node build's "selection" is trivial (one candidate or
 * none), because the affinity and packing maths also document *feasibility*
 * semantics this build wants, and this is the multi node extension point.
 *
 * Excluded from this build: the replica and snapshot branches of the
 * affinity term (`A(n)` stays two valued between "home" and "not home", never 0.9 or 0.6), and
 * the clock skew, agent version, and region penalty rows. The launch
 * failure and incident penalties are kept; they are single node relevant
 * (the mechanism that stops the router hammering a broken local Chrome
 * binary in a tight loop).
 */

import type { NodeCapacity, NodeLoad } from '@browserglass/protocol';
import type { PlacementWeightKey } from '../router/config.js';

/** Which node holds a persistent profile's authoritative copy, for the affinity term. */
export interface AffinityInput {
  mode: 'ephemeral' | 'persistent' | 'template';
  /** `true` when this candidate node is the profile's `homeNodeId`. Irrelevant for `ephemeral`/`template`, which are always "no home yet". */
  isHome: boolean;
}

/**
 * Per node scoring signals `scorePlacement` needs beyond the protocol
 * `NodeSnapshot` (which does not carry warm adoptability or a penalty
 * history, both router internal state): whether this node has an
 * adoptable warm instance matching the request, how many launches failed
 * on it within `launchFailurePenaltyWindowMs`, and whether it reported an
 * incident on any instance in the last 60 seconds.
 */
export interface PlacementScoringContext {
  nodeId: string;
  capacity: NodeCapacity;
  load: NodeLoad;
  affinity: AffinityInput;
  hasAdoptableWarm: boolean;
  recentLaunchFailures: number;
  recentIncident: boolean;
  /** Live instances on this node sharing `affinity.spreadKey`; `0` when no spread key was requested. */
  spreadCount: number;
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * `A(n)`, profile affinity, the dominant term. `1.0` when this node is the
 * profile's home, `0.5` when the profile is ephemeral or has no home yet
 * (kept neutral rather than `1.0`, or the term stops discriminating),
 * `0.0` when the profile is persistent and homed elsewhere. The replica
 * (`0.9`) and snapshot restore (`0.6`) branches are out of scope for this
 * build (no second node to hold a replica or restore a snapshot onto).
 */
export function affinityScore(input: AffinityInput): number {
  if (input.mode === 'ephemeral' || input.mode === 'template') return 0.5;
  // persistent
  return input.isHome ? 1.0 : 0.0;
}

/**
 * `P(n)`, packing: prefer a moderately loaded node over an empty or nearly
 * full one, so as not to waste an already warm node's page cache while
 * also not risking a launch failure on a nearly full one.
 */
export function packingScore(
  capacity: NodeCapacity,
  load: NodeLoad,
  targetUtilisation: number,
): number {
  const u =
    capacity.maxInstances > 0
      ? (load.liveInstances + load.launchingInstances) / capacity.maxInstances
      : 1;
  const denom = Math.max(targetUtilisation, 1 - targetUtilisation);
  return clamp01(1 - Math.abs(u - targetUtilisation) / denom);
}

/** `C(n)`, CPU headroom. Linear with a deliberately unsmoothed cliff at 90 percent. */
export function cpuScore(cpuPercent: number): number {
  if (cpuPercent >= 90) return 0;
  if (cpuPercent >= 85) return 0.05;
  return clamp01((85 - cpuPercent) / 85);
}

/** `M(n)`, memory headroom. Saturates at 60 percent free; more free memory past that does not make a launch better. */
export function memoryScore(capacity: NodeCapacity, load: NodeLoad): number {
  const free =
    capacity.maxMemoryMb > 0
      ? (capacity.maxMemoryMb - load.memoryUsedMb) / capacity.maxMemoryMb
      : 0;
  if (free < 0.1) return 0;
  return clamp01((free - 0.1) / 0.5);
}

/** `D(n)`, profile disk headroom on this node. */
export function diskScore(capacity: NodeCapacity, load: NodeLoad): number {
  const freeD =
    capacity.profileDiskMb > 0
      ? (capacity.profileDiskMb - load.profileDiskUsedMb) / capacity.profileDiskMb
      : 0;
  if (freeD < 0.05) return 0;
  return Math.min(1, freeD / 0.3);
}

/** `W(n)`, warm availability. Binary: no meaningful difference between one adoptable warm instance and three. */
export function warmScore(hasAdoptableWarm: boolean): number {
  return hasAdoptableWarm ? 1.0 : 0.0;
}

/** `S(n)`, anti affinity spread. `0` when `affinity.spreadKey` was not set on the request. */
export function spreadScore(spreadKeySet: boolean, spreadCount: number): number {
  if (!spreadKeySet) return 0;
  return 1 / (1 + Math.max(0, spreadCount));
}

/**
 * `penalty(n)`, additive and subtracted from the score; can drive it
 * negative, which is fine, negatives are filtered out before selection.
 * Only the launch failure and incident rows are implemented (clock skew,
 * agent version, and region penalties are out of scope, single node has
 * no remote clock to skew against and no second agent version to compare).
 */
export function penaltyScore(recentLaunchFailures: number, recentIncident: boolean): number {
  const failurePenalty = Math.min(0.75, 0.25 * Math.max(0, recentLaunchFailures));
  const incidentPenalty = recentIncident ? 0.1 : 0;
  return failurePenalty + incidentPenalty;
}

/**
 * `score(n) = w_aff*A + w_pack*P + w_cpu*C + w_mem*M + w_disk*D + w_warm*W
 * + w_spread*S - penalty`. Scores in `[0,1]` before the penalty; the
 * penalty can drive the final score negative. Not clamped to `[0,1]`
 * itself, `placementCandidates`/`selectNode` filter on `scoreFloor`
 * afterward.
 */
export function scorePlacement(
  ctx: PlacementScoringContext,
  weights: Record<PlacementWeightKey, number>,
  targetUtilisation: number,
  spreadKeySet: boolean,
): number {
  const a = affinityScore(ctx.affinity);
  const p = packingScore(ctx.capacity, ctx.load, targetUtilisation);
  const c = cpuScore(ctx.load.cpuPercent);
  const m = memoryScore(ctx.capacity, ctx.load);
  const d = diskScore(ctx.capacity, ctx.load);
  const w = warmScore(ctx.hasAdoptableWarm);
  const s = spreadScore(spreadKeySet, ctx.spreadCount);
  const penalty = penaltyScore(ctx.recentLaunchFailures, ctx.recentIncident);
  return (
    weights.affinity * a +
    weights.pack * p +
    weights.cpu * c +
    weights.memory * m +
    weights.disk * d +
    weights.warm * w +
    weights.spread * s -
    penalty
  );
}

/** One term by term breakdown of a `scorePlacement` call, for `PlacementDecision.ordered[].reasons` and for tests asserting individual terms. */
export interface PlacementScoreBreakdown {
  affinity: number;
  packing: number;
  cpu: number;
  memory: number;
  disk: number;
  warm: number;
  spread: number;
  penalty: number;
  score: number;
}

/** Computes every term plus the combined score, for callers that want the breakdown rather than only the final number. */
export function scorePlacementBreakdown(
  ctx: PlacementScoringContext,
  weights: Record<PlacementWeightKey, number>,
  targetUtilisation: number,
  spreadKeySet: boolean,
): PlacementScoreBreakdown {
  const affinity = affinityScore(ctx.affinity);
  const packing = packingScore(ctx.capacity, ctx.load, targetUtilisation);
  const cpu = cpuScore(ctx.load.cpuPercent);
  const memory = memoryScore(ctx.capacity, ctx.load);
  const disk = diskScore(ctx.capacity, ctx.load);
  const warm = warmScore(ctx.hasAdoptableWarm);
  const spread = spreadScore(spreadKeySet, ctx.spreadCount);
  const penalty = penaltyScore(ctx.recentLaunchFailures, ctx.recentIncident);
  const score =
    weights.affinity * affinity +
    weights.pack * packing +
    weights.cpu * cpu +
    weights.memory * memory +
    weights.disk * disk +
    weights.warm * warm +
    weights.spread * spread -
    penalty;
  return { affinity, packing, cpu, memory, disk, warm, spread, penalty, score };
}
