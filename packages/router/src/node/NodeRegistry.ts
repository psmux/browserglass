/**
 * The single node registry for an embedded, single node build. A full
 * multi node registry needs registration, epochs, and stale detection
 * across many nodes; this is its single node reduction, which still keeps
 * the concept of one Node row representing this process. Node death
 * detection, leader election, and cross node lease revocation are not
 * implemented here.
 */

import type {
  NodeCapacity,
  NodeId,
  NodeLoad,
  NodeSnapshot,
  NodeState,
} from '@browserglass/protocol';
import type { Clock } from '../router/clock.js';

const ZERO_LOAD: NodeLoad = Object.freeze({
  liveInstances: 0,
  warmInstances: 0,
  launchingInstances: 0,
  cpuPercent: 0,
  memoryUsedMb: 0,
  profileDiskUsedMb: 0,
  loadAvg1: 0,
  sampledAt: 0,
});

/** Construction options for `NodeRegistry`. */
export interface NodeRegistryOptions {
  nodeId: NodeId;
  capacity: NodeCapacity;
  labels?: Readonly<Record<string, string>>;
  region?: string | null;
  /** Default `120000` (`launchFailurePenaltyWindowMs`), the window a recorded launch failure counts toward the placement penalty. */
  launchFailurePenaltyWindowMs?: number;
}

/**
 * Tracks the one local node's state, load, and recent launch failure and
 * incident history, and produces the `NodeSnapshot` `placementCandidates`
 * and `ScoredPlacementPolicy` consume.
 */
export class NodeRegistry {
  private readonly nodeId: NodeId;
  private readonly capacity: NodeCapacity;
  private readonly labels: Readonly<Record<string, string>>;
  readonly region: string | null;
  private readonly launchFailurePenaltyWindowMs: number;

  private state: NodeState = 'registering';
  private load: NodeLoad = ZERO_LOAD;
  private lastHeartbeatAt = 0;
  private hostsProfiles: readonly string[] = [];
  private drain: { deadlineAt: number; mode: 'graceful' | 'force' } | null = null;
  private readonly failureTimestamps: number[] = [];
  private lastIncidentAt: number | null = null;

  constructor(
    private readonly clock: Clock,
    opts: NodeRegistryOptions,
  ) {
    this.nodeId = opts.nodeId;
    this.capacity = opts.capacity;
    this.labels = opts.labels ?? Object.freeze({});
    this.region = opts.region ?? null;
    this.launchFailurePenaltyWindowMs = opts.launchFailurePenaltyWindowMs ?? 120_000;
  }

  /** This registry's node id. */
  id(): NodeId {
    return this.nodeId;
  }

  /** Marks the node `ready` and stamps the first heartbeat. Called once at `BrowserRouter.start()`. */
  markReady(): void {
    this.state = 'ready';
    this.lastHeartbeatAt = this.clock.now();
  }

  /** Marks the node `draining`, the first step of a drain: excludes it from placement immediately. */
  markDraining(deadlineAt: number, mode: 'graceful' | 'force'): void {
    this.state = 'draining';
    this.drain = { deadlineAt, mode };
  }

  /** Marks the node `drained`: draining completed, every instance released. */
  markDrained(): void {
    this.state = 'drained';
  }

  /** The current drain state, or `null` if not draining. */
  drainState(): { deadlineAt: number; mode: 'graceful' | 'force' } | null {
    return this.drain;
  }

  /** Records one heartbeat: refreshes `lastHeartbeatAt` and the load sample. */
  heartbeat(load: Partial<NodeLoad>, hostsProfiles?: readonly string[]): void {
    this.lastHeartbeatAt = this.clock.now();
    this.load = { ...this.load, ...load, sampledAt: this.lastHeartbeatAt };
    if (hostsProfiles) this.hostsProfiles = hostsProfiles;
  }

  /** The last heartbeat time, epoch ms. `0` before the first heartbeat. */
  lastHeartbeat(): number {
    return this.lastHeartbeatAt;
  }

  /** The current load sample. */
  currentLoad(): NodeLoad {
    return this.load;
  }

  /** Records a launch failure on this node, for the placement penalty. */
  recordLaunchFailure(): void {
    this.failureTimestamps.push(this.clock.now());
  }

  /** How many launch failures fall within `launchFailurePenaltyWindowMs` of now. Sweeps stale entries as a side effect. */
  recentLaunchFailures(): number {
    const cutoff = this.clock.now() - this.launchFailurePenaltyWindowMs;
    let i = 0;
    while (i < this.failureTimestamps.length && (this.failureTimestamps[i] as number) < cutoff) i++;
    if (i > 0) this.failureTimestamps.splice(0, i);
    return this.failureTimestamps.length;
  }

  /** Records an incident (a recovery rung, a crash) against this node, for the placement penalty. */
  recordIncident(): void {
    this.lastIncidentAt = this.clock.now();
  }

  /** Whether an incident was recorded within the last 60 seconds. */
  recentIncident(): boolean {
    if (this.lastIncidentAt === null) return false;
    return this.clock.now() - this.lastIncidentAt < 60_000;
  }

  /** This node's `NodeSnapshot`, the shape `placementCandidates` and `ScoredPlacementPolicy` consume. */
  snapshot(): NodeSnapshot {
    return {
      nodeId: this.nodeId,
      labels: this.labels,
      state: this.state,
      capacity: this.capacity,
      load: this.load,
      lastHeartbeatAt: this.lastHeartbeatAt,
      hostsProfiles: this.hostsProfiles,
    };
  }

  /** One row of `BrowserRouter.topology()`'s result. */
  topologyRow(): {
    nodeId: NodeId;
    state: NodeState;
    load: NodeLoad;
    lastHeartbeatAt: number;
    drain: { deadlineAt: number; mode: 'graceful' | 'force' } | null;
  } {
    return {
      nodeId: this.nodeId,
      state: this.state,
      load: this.load,
      lastHeartbeatAt: this.lastHeartbeatAt,
      drain: this.drain,
    };
  }
}
