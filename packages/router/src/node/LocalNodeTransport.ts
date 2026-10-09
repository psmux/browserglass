/**
 * `LocalNodeTransport`: `NodeTransport` implemented by direct in process
 * call to a `LocalNode`, rather than over a `WebSocketNodeTransport`.
 * Constructs and consumes the exact same
 * `NodeHeartbeatPayload`, `NodeHeartbeatAck`, and `NodeLaunchRequest`
 * shapes a networked transport would, so the boundary
 * between "in process call" and "over the wire" stays real even though no
 * socket crosses it in this build.
 */

import type {
  LaunchedBrowser,
  NodeActionRequest,
  NodeActionResult,
  NodeHeartbeatAck,
  NodeHeartbeatPayload,
  NodeId,
  NodeLaunchRequest,
  NodeTransport,
  RuntimeInventoryEntry,
  TerminateMode,
  TerminateResult,
} from '@browserglass/protocol';
import type { Clock } from '../router/clock.js';
import { routerErr } from '../router/errors.js';
import type { LocalNode } from './LocalNode.js';
import type { NodeRegistry } from './NodeRegistry.js';

/**
 * The single node `NodeTransport`. `BrowserRouter` is constructed with an
 * instance of this in the embedded build, and would be constructed with a
 * `WebSocketNodeTransport` in a multi node build,
 * with no other code change: `BrowserRouter` only ever sees `NodeTransport`.
 */
export class LocalNodeTransport implements NodeTransport {
  constructor(
    private readonly node: LocalNode,
    private readonly registry: NodeRegistry,
    private readonly clock: Clock,
  ) {}

  heartbeat(nodeId: NodeId, _payload: NodeHeartbeatPayload): Promise<NodeHeartbeatAck> {
    const drain = this.registry.drainState();
    return Promise.resolve({ nodeId, accepted: true, serverTime: this.clock.now(), drain });
  }

  /**
   * `nodeId !== this.registry.id()` used to be silently ignored here:
   * this method called `this.node.launch(req)` regardless of which
   * `nodeId` was asked for, so a caller that believed it was launching on
   * a REMOTE node (any candidate `placementCandidates` returns other than
   * this process's own snapshot, now that `BrowserRouter.doAcquire`'s
   * `remoteNodeSnapshots` can put one in the candidate list) would in fact
   * get a browser launched right here, on this node, silently. That is
   * exactly the failure mode that matters most here: a
   * placement bug that does not throw, and strands a Chrome nobody will
   * ever reap, because `Instance.nodeId` would (correctly, after this same
   * change) be stamped with the REMOTE node's id, so this node's own
   * `orphanSweepScope` (`@browserglass/server`'s `lifecycle/wiring.ts`,
   * scoped to `instance.node_id === ourNodeId`) would never touch the row,
   * and the remote node's own sweep would never find a process it never
   * launched. Rejecting instead, matching `dispatch()`'s own established
   * contract below, is what makes this transport safe to hand a placement
   * decision that includes candidates it cannot actually reach, rather
   * than requiring every caller to already know, out of band, which
   * `NodeTransport` implementation it happens to be holding.
   */
  launch(nodeId: NodeId, req: NodeLaunchRequest): Promise<LaunchedBrowser> {
    if (nodeId !== this.registry.id()) {
      return Promise.reject(
        routerErr(
          'E_NODE_LOST',
          `LocalNodeTransport: node ${nodeId} is not this process's local node (${this.registry.id()}), cannot launch on it`,
        ),
      );
    }
    return this.node.launch(req);
  }

  /** See `launch()`'s own comment: the identical foreign `nodeId` guard, for the identical reason. `instance.nodeId ?? this.nodeRegistry.id()` (`BrowserRouter.release()`/`restart()`) only ever names a foreign id once `launch()` above has actually placed an instance on one, so this was unreachable with a wrong answer before that could happen and stays unreachable now; kept consistent with `dispatch()` and `launch()` rather than left as the one method in this class still trusting an argument it does not use. */
  terminate(
    nodeId: NodeId,
    instanceId: string,
    mode: TerminateMode,
    gracePeriodMs?: number,
  ): Promise<TerminateResult> {
    if (nodeId !== this.registry.id()) {
      return Promise.reject(
        routerErr(
          'E_NODE_LOST',
          `LocalNodeTransport: node ${nodeId} is not this process's local node (${this.registry.id()}), cannot terminate an instance on it`,
        ),
      );
    }
    return this.node.terminate(instanceId, mode, gracePeriodMs);
  }

  /** See `launch()`'s own comment: the identical foreign `nodeId` guard. Nothing in this package currently calls `NodeTransport.list()` with any `nodeId` (a `grep` across `router/src` and `server/src` at the time of this change found zero call sites), so this is defense in depth for a future caller rather than a fix for an observed defect, kept for the same reason `dispatch()` already had this guard: silent misdirection is the one behaviour this class must never have, on any of its five methods. */
  list(nodeId: NodeId): Promise<readonly RuntimeInventoryEntry[]> {
    if (nodeId !== this.registry.id()) {
      return Promise.reject(
        routerErr(
          'E_NODE_LOST',
          `LocalNodeTransport: node ${nodeId} is not this process's local node (${this.registry.id()}), cannot list its runtime inventory`,
        ),
      );
    }
    return this.node.list();
  }

  /**
   * `nodeId === this.registry.id()` is the only address this transport can
   * ever legitimately be asked to reach: a single node build has no other
   * node to hop to. That case calls straight into `this.node.dispatch`,
   * with no encoding, no queue, and no await boundary beyond the call
   * itself, which is what `NodeTransport.dispatch`'s own doc calls "no
   * serialisation" for the local path: a `WebSocketNodeTransport` reaching
   * its OWN node would still pay an encode/decode round trip, this never
   * does. Any other `nodeId` cannot be reached from here at all (that is
   * exactly what a `WebSocketNodeTransport` would
   * carry the request the rest of the way for), so it throws `E_NODE_LOST`
   * rather than "not found": the instance may well exist and be perfectly
   * live, this transport just has no path to it, which is a distinct,
   * retryable condition (`ACQUIRE_ERROR_TABLE.E_NODE_LOST.retryable`).
   */
  dispatch(nodeId: NodeId, req: NodeActionRequest): Promise<NodeActionResult> {
    if (nodeId !== this.registry.id()) {
      return Promise.reject(
        routerErr(
          'E_NODE_LOST',
          `LocalNodeTransport: node ${nodeId} is not this process's local node (${this.registry.id()}), cannot dispatch '${req.kind}'`,
        ),
      );
    }
    return this.node.dispatch(req);
  }
}
