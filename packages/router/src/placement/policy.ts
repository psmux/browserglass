/**
 * `ScoredPlacementPolicy`, the default `PlacementPolicy`
 * (`name: 'scoredPlacement'`). Wraps the pure `scorePlacement`
 * functions from `./scoring.js` to satisfy the protocol `PlacementPolicy`
 * interface: orders `req.candidates` by score descending, filters anything
 * below `scoreFloor`, and breaks ties by node id ascending for
 * deterministic tests.
 */

import type {
  NodeId,
  PlacementDecision,
  PlacementPolicy,
  PlacementRequest,
} from '@browserglass/protocol';
import type { PlacementWeightKey } from '../router/config.js';
import {
  type PlacementScoreBreakdown,
  type PlacementScoringContext,
  scorePlacementBreakdown,
} from './scoring.js';

/**
 * Per node signals `ScoredPlacementPolicy` needs beyond what a
 * `PlacementRequest` carries: warm adoptability, the launch failure and
 * incident penalty history, and spread counts. All router internal state,
 * not part of the protocol `NodeSnapshot` shape, so it is injected here
 * rather than threaded through the protocol interface.
 */
export interface PlacementSignalsPort {
  hasAdoptableWarm(nodeId: NodeId): boolean;
  recentLaunchFailures(nodeId: NodeId): number;
  recentIncident(nodeId: NodeId): boolean;
  spreadCount(nodeId: NodeId, spreadKey: string): number;
}

/** A `PlacementSignalsPort` that reports nothing: no warm instances, no penalty history, no spread. Suitable when a caller only cares about affinity, packing, and headroom. */
export const NULL_PLACEMENT_SIGNALS: PlacementSignalsPort = Object.freeze({
  hasAdoptableWarm: () => false,
  recentLaunchFailures: () => 0,
  recentIncident: () => false,
  spreadCount: () => 0,
});

function reasonsFor(breakdown: PlacementScoreBreakdown): string[] {
  return [
    `affinity=${breakdown.affinity.toFixed(2)}`,
    `packing=${breakdown.packing.toFixed(2)}`,
    `cpu=${breakdown.cpu.toFixed(2)}`,
    `memory=${breakdown.memory.toFixed(2)}`,
    `disk=${breakdown.disk.toFixed(2)}`,
    `warm=${breakdown.warm.toFixed(2)}`,
    `spread=${breakdown.spread.toFixed(2)}`,
    `penalty=${breakdown.penalty.toFixed(2)}`,
  ];
}

/**
 * The default `PlacementPolicy`. Scores every candidate `scorePlacement`
 * fully, then
 * orders descending and filters below `scoreFloor`. With one candidate
 * (the single node build's normal case) the ordering is trivial but the
 * score is still computed in full, which is what makes the affinity and
 * packing maths meaningful as a feasibility and diagnostic signal even
 * before a second node exists.
 */
export class ScoredPlacementPolicy implements PlacementPolicy {
  readonly name = 'scoredPlacement';

  constructor(
    private readonly weights: Record<PlacementWeightKey, number>,
    private readonly targetUtilisation: number,
    private readonly scoreFloor: number,
    private readonly signals: PlacementSignalsPort = NULL_PLACEMENT_SIGNALS,
  ) {}

  place(req: PlacementRequest): Promise<PlacementDecision> {
    const spreadKeySet = req.affinity.spreadKey != null;
    const scored = req.candidates
      .map((n) => {
        const isHome = req.profileHome != null && req.profileHome.nodeId === n.nodeId;
        const ctx: PlacementScoringContext = {
          nodeId: n.nodeId,
          capacity: n.capacity,
          load: n.load,
          affinity: { mode: req.profile.mode, isHome },
          hasAdoptableWarm: this.signals.hasAdoptableWarm(n.nodeId),
          recentLaunchFailures: this.signals.recentLaunchFailures(n.nodeId),
          recentIncident: this.signals.recentIncident(n.nodeId),
          spreadCount: spreadKeySet
            ? this.signals.spreadCount(n.nodeId, req.affinity.spreadKey as string)
            : 0,
        };
        const breakdown = scorePlacementBreakdown(
          ctx,
          this.weights,
          this.targetUtilisation,
          spreadKeySet,
        );
        return { nodeId: n.nodeId, score: breakdown.score, reasons: reasonsFor(breakdown) };
      })
      .filter((r) => r.score >= this.scoreFloor)
      .sort(
        (a, b) => b.score - a.score || (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0),
      );
    return Promise.resolve({ ordered: scored });
  }
}
