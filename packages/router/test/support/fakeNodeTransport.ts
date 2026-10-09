/**
 * A direct in memory `NodeTransport` for `BrowserRouter` level tests: no
 * `LocalNode`/`BrowserRuntime` machinery, `launch()` just fabricates a
 * `LaunchedBrowser` handle synchronously. `LocalNode`/`LocalNodeTransport`
 * have their own dedicated tests (`test/node/**`) against a fake
 * `BrowserRuntime`; this fixture is for exercising `BrowserRouter` itself.
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
import { routerErr } from '../../src/router/errors.js';

export interface FakeNodeTransport extends NodeTransport {
  launchCount: number;
  terminateCount: number;
  /** When set, the next `launch()` call rejects with this error instead of succeeding. */
  failNextLaunch: (Error & { code?: string }) | null;

  /** Every `dispatch()` call this transport received, in order, for a test to assert against (which node, which action). */
  dispatchCalls: { nodeId: NodeId; req: NodeActionRequest }[];
  /**
   * Every `launch()` call this transport received, in order, `nodeId`
   * included. Added for cross node placement tests
   * (`router/acquire.test.ts`'s "places on a foreign node" cases): unlike
   * `dispatchCalls`, this fake's own `launch()` used to accept any
   * `nodeId` with no record of which one, which was fine while
   * `placementCandidates` only ever offered this router's own node id
   * (every launch was trivially "the right one"), and stopped being
   * enough once a test needed to prove `this.nodes.launch(...)` actually
   * reached the WINNING candidate rather than merely succeeding.
   */
  launchCalls: { nodeId: NodeId; req: NodeLaunchRequest }[];
  /**
   * `nodeId`s this fake cannot reach, simulating the owning node being down
   * or partitioned in a multi node deployment: `dispatch()` rejects with
   * `E_NODE_LOST` for any of these rather than fabricating a result, so a
   * router level test can exercise "the owning node is unreachable" without
   * a real second node or a real `WebSocketNodeTransport`.
   */
  unreachableNodeIds: Set<NodeId>;

  /** Every `terminate()` call this transport received, in order, so a test can assert `gracePeriodMs` actually reached this layer. */
  terminateCalls: {
    nodeId: NodeId;
    instanceId: string;
    mode: TerminateMode;
    gracePeriodMs: number | undefined;
  }[];
  /**
   * When true, a `'graceful'` `terminate()` call never settles: it returns
   * a promise that neither resolves nor rejects, simulating a node that
   * never confirms a graceful shutdown within the caller's own deadline.
   * `'force'` calls are unaffected, so a test can drive
   * `BrowserRouter.release()`'s deadline escalation and observe the force
   * call actually landing. Default `false`.
   */
  hangGracefulTerminate: boolean;
  /**
   * When true, a `'detach'` `terminate()` call answers the way a real
   * `LocalNode` in front of a runtime that creates its own browsers does:
   * the detach is refused, the browser is torn down for real, and
   * `effective` says `'clean'` rather than `'detach'`. Lets a router level
   * test drive the "the node would not leave it running" branch without a
   * real `LocalNode` and a real runtime behind it. Default `false`.
   */
  refuseDetach: boolean;
  /**
   * When set, the next `terminate()` call (any mode) rejects with this
   * error instead of succeeding, then clears itself. Simulates the real
   * `runtime-host` terminate ladder's own failure mode (see
   * `packages/runtime-host/src/terminate.ts`'s final "confirm the process
   * is actually gone" step): a process that never dies now REJECTS rather
   * than resolving with a `warnings` entry nobody reads, so a router level
   * test can drive `BrowserRouter.release()`'s existing "the terminate
   * failed" path (revert to `live`, throw `E_TERMINATE_FAILED`, never
   * report `outcome: 'terminated'`) without a real Chrome process.
   */
  failNextTerminate: (Error & { code?: string }) | null;
  /**
   * Like {@link failNextTerminate}, but rejects the next `count` calls
   * (each with `error`) rather than exactly one: lets a test simulate BOTH
   * the graceful attempt and its force escalation failing to confirm
   * death, not only the first.
   */
  failNextTerminates(count: number, error: Error & { code?: string }): void;
}

/** Creates a fresh `FakeNodeTransport`. */
export function createFakeNodeTransport(): FakeNodeTransport {
  let remainingTerminateFailures = 0;
  let terminateFailureError: (Error & { code?: string }) | null = null;
  const transport: FakeNodeTransport = {
    launchCount: 0,
    terminateCount: 0,
    failNextLaunch: null,
    dispatchCalls: [],
    launchCalls: [],
    unreachableNodeIds: new Set<NodeId>(),
    terminateCalls: [],
    hangGracefulTerminate: false,
    refuseDetach: false,
    failNextTerminate: null,
    failNextTerminates(count: number, error: Error & { code?: string }): void {
      remainingTerminateFailures = count;
      terminateFailureError = error;
    },

    heartbeat(nodeId: NodeId, _payload: NodeHeartbeatPayload): Promise<NodeHeartbeatAck> {
      return Promise.resolve({ nodeId, accepted: true, serverTime: Date.now(), drain: null });
    },

    launch(nodeId: NodeId, req: NodeLaunchRequest): Promise<LaunchedBrowser> {
      transport.launchCount += 1;
      transport.launchCalls.push({ nodeId, req });
      if (transport.failNextLaunch) {
        const err = transport.failNextLaunch;
        transport.failNextLaunch = null;
        return Promise.reject(err);
      }
      const handle: LaunchedBrowser = {
        instanceId: req.instanceId as LaunchedBrowser['instanceId'],
        runtimeKind: 'host',
        transport: { kind: 'http', cdpUrl: 'http://127.0.0.1:9222', host: '127.0.0.1', port: 9222 },
        cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake',
        browserGuid: 'fake-guid',
        pid: 1234,
        containerId: null,
        podName: null,
        profilePath: '/tmp/profile',
        containerProfilePath: null,
        engineVersion: 'Chrome/999.0.0.0',
        protocolVersion: '1.3',
        nativeUserAgent: 'fake-ua',
        launchDurationMs: 1,
        launchPhases: { preflight: 0, reconcile: 0, spawn: 1, cdpWait: 0, postLaunch: 0 },
        startedAt: Date.now(),
        adopted: false,
        teardown: (mode: TerminateMode): Promise<TerminateResult> => {
          transport.terminateCount += 1;
          return Promise.resolve({
            mode,
            effective: mode,
            exitCode: 0,
            signal: null,
            durationMs: 1,
            locksCleared: [],
            warnings: [],
          });
        },
        onUnexpectedExit: () => () => undefined,
      };
      return Promise.resolve(handle);
    },

    terminate(
      nodeId: NodeId,
      instanceId: string,
      mode: TerminateMode,
      gracePeriodMs?: number,
    ): Promise<TerminateResult> {
      transport.terminateCount += 1;
      transport.terminateCalls.push({ nodeId, instanceId, mode, gracePeriodMs });
      if (transport.failNextTerminate) {
        const err = transport.failNextTerminate;
        transport.failNextTerminate = null;
        return Promise.reject(err);
      }
      if (remainingTerminateFailures > 0 && terminateFailureError) {
        remainingTerminateFailures -= 1;
        return Promise.reject(terminateFailureError);
      }
      if (mode === 'graceful' && transport.hangGracefulTerminate) {
        // Never settles: simulates a node that never confirms a graceful
        // shutdown, so a test can observe `BrowserRouter.release()`
        // escalating to `'force'` on its own deadline rather than waiting
        // on this promise forever.
        return new Promise<TerminateResult>(() => undefined);
      }
      if (mode === 'detach' && transport.refuseDetach) {
        return Promise.resolve({
          mode: 'detach',
          effective: 'clean',
          exitCode: 0,
          signal: null,
          durationMs: 1,
          locksCleared: [],
          warnings: [
            'fake transport: this runtime creates its own browsers, so the detach was refused',
          ],
        });
      }
      return Promise.resolve({
        mode,
        effective: mode,
        exitCode: 0,
        signal: null,
        durationMs: 1,
        locksCleared: [],
        warnings: [],
      });
    },

    list(_nodeId: NodeId): Promise<readonly RuntimeInventoryEntry[]> {
      return Promise.resolve([]);
    },

    dispatch(nodeId: NodeId, req: NodeActionRequest): Promise<NodeActionResult> {
      transport.dispatchCalls.push({ nodeId, req });
      if (transport.unreachableNodeIds.has(nodeId)) {
        return Promise.reject(
          routerErr('E_NODE_LOST', `fake transport: node ${nodeId} is unreachable`),
        );
      }
      // A minimal, honest result per `req.kind`, real enough for a test to
      // assert `dispatchAction` reached the right node and returned the
      // right shape without a real browser behind it.
      switch (req.kind) {
        case 'navigate':
          return Promise.resolve({ kind: 'navigate' });
        case 'screenshot':
          return Promise.resolve({
            kind: 'screenshot',
            format: req.format ?? 'png',
            data: '',
            width: 0,
            height: 0,
          });
        case 'click':
          return Promise.resolve({ kind: 'click' });
        case 'type':
          return Promise.resolve({ kind: 'type' });
        case 'target.list':
          return Promise.resolve({ kind: 'target.list', targets: [] });
        case 'target.create':
          return Promise.resolve({
            kind: 'target.create',
            target: { targetId: 'fake-target', url: req.url ?? 'about:blank', title: '' },
          });
        case 'target.close':
          return Promise.resolve({ kind: 'target.close' });
        case 'cdp':
          return Promise.resolve({ kind: 'cdp', result: null });
      }
    },
  };
  return transport;
}
