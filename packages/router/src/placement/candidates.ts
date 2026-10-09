/**
 * `placementCandidates` (the feasibility
 * filter run before scoring). Kept as is for a single node build: with one
 * node it returns either `[the local node]` or `[]`, meaning "reject or
 * queue", which is the correct feasibility check even alone (memory, disk,
 * and launch concurrency headroom).
 */

import type {
  AffinityHints,
  BrowserSpec,
  NodeSnapshot,
  ResolvedProfileSpec,
} from '@browserglass/protocol';

/** `estimateMemoryMb`: a conservative, deliberately over, estimate. */
export function estimateMemoryMb(spec: BrowserSpec, expectedTabs = 1): number {
  if (spec.resources.memoryMb != null) return spec.resources.memoryMb;
  const base = spec.headless === 'off' || spec.headless === 'xvfb-headful' ? 550 : 350;
  return base + 120 * Math.max(0, expectedTabs - 1);
}

/**
 * `estimateProfileMb`: a conservative per mode estimate, ephemeral profiles start
 * empty and grow, persistent and template derived profiles are assumed to
 * already carry meaningful browser state.
 */
export function estimateProfileMb(profile: ResolvedProfileSpec): number {
  return profile.mode === 'ephemeral' ? 50 : 500;
}

/** Subset match: every key in `selector` must be present in `labels` with an equal value. Empty selector always matches. */
function matchesSelector(
  labels: Readonly<Record<string, string>>,
  selector: Readonly<Record<string, string>> | undefined,
): boolean {
  if (!selector) return true;
  for (const key of Object.keys(selector)) {
    if (labels[key] !== selector[key]) return false;
  }
  return true;
}

/** One placement request's feasibility inputs, the parts `placementCandidates` needs beyond `NodeSnapshot`. */
export interface PlacementFeasibilityRequest {
  spec: BrowserSpec;
  profile: ResolvedProfileSpec;
  affinity: AffinityHints;
  nodeSelector: Readonly<Record<string, string>>;
  now: number;
  nodeStaleMs: number;
  expectedTabs?: number;
}

/**
 * The hard feasibility filter, run before scoring. A node fails this for
 * any reason is not a placement candidate at all, regardless of score:
 * not `ready`, a stale heartbeat, draining, a label selector mismatch, a
 * hard affinity requirement mismatch, or insufficient headroom on any of
 * instance count, launch concurrency, memory, or profile disk.
 */
export function placementCandidates(
  nodes: readonly NodeSnapshot[],
  req: PlacementFeasibilityRequest,
): NodeSnapshot[] {
  const memNeeded = estimateMemoryMb(req.spec, req.expectedTabs ?? 1);
  const diskNeeded = estimateProfileMb(req.profile);
  return nodes.filter((n) => {
    if (n.state !== 'ready') return false;
    if (req.now - n.lastHeartbeatAt >= req.nodeStaleMs) return false;
    if (!matchesSelector(n.labels, req.nodeSelector)) return false;
    if (!matchesSelector(n.labels, req.affinity.requireLabels)) return false;
    if (req.affinity.requireNodeId != null && n.nodeId !== req.affinity.requireNodeId) return false;
    if (n.load.liveInstances + n.load.launchingInstances >= n.capacity.maxInstances) return false;
    if (n.load.launchingInstances >= n.capacity.maxConcurrentLaunches) return false;
    if (n.capacity.maxMemoryMb - n.load.memoryUsedMb < memNeeded) return false;
    if (n.capacity.profileDiskMb - n.load.profileDiskUsedMb < diskNeeded) return false;
    return true;
  });
}
