/**
 * `WebSocketNodeTransport`: the real multi node `NodeTransport`.
 * `NodeTransport.dispatch` is on the
 * interface (`extension-points.ts`) and `LocalNodeTransport.dispatch()`
 * throws `E_NODE_LOST` for any node id but its own; the routing DECISION
 * was correct and tested before this file existed (`router-authority.test.ts`,
 * conformance, using a fake second node specifically because this one did
 * not exist), and two gateway processes still could not reach each
 * other's instances. `docs/scaling.md`'s own "what is still single node
 * today" section names this file by the name it does not yet have, three
 * times.
 *
 * DESIGN: one `NodeTransport` a `BrowserRouter` can be constructed with in
 * a real multi node build, with no other code change (`LocalNodeTransport`'s
 * own doc already promises this). For `nodeId === selfNodeId`, every
 * method delegates straight to the injected `local` transport (typically a
 * `LocalNodeTransport`), the exact same "no serialisation" in process call
 * `LocalNodeTransport` already provides; this class never opens a socket
 * to reach its own node. For any other `nodeId`, it resolves a peer
 * endpoint (`resolveEndpoint`, real wiring: `BrowserRouter.resolveNode`),
 * opens (or reuses) one authenticated WebSocket connection to that peer,
 * and forwards the call as a small, correlated request/reply frame.
 *
 * WHAT IS NOT HERE: a peer side listener. This class is the client half
 * only, the half that DIALS a peer and sends requests. A real two gateway
 * deployment additionally needs a process listening on the other end of
 * `resolveEndpoint`'s URL, one that accepts a connection, verifies its
 * `hello` frame (`nodeAuth.ts`'s `verifyHello`), and translates incoming
 * `NodeReqFrame`s into real `LocalNode`/`LocalNodeTransport` calls,
 * replying with `NodeResFrame`s in the same shape this class emits and
 * expects back. This package still builds no such listener (it cannot
 * depend on the session/CDP machinery a real listener needs to
 * execute a `dispatch` request against); `@browserglass/server`'s
 * `ws/peer-upgrade.ts` is that listener, a second WebSocket endpoint
 * alongside the existing gateway server, one layer up. Every test in this
 * file's own suite still proves this class's own half of the contract
 * against a scripted fake peer, never a real second process; the real
 * peer is exercised by `@browserglass/server`'s own cross node test
 * instead. See this file's `hydrateLaunchedBrowser` and the
 * `onUnexpectedExit` comment below for one further, specific gap this
 * asymmetry creates.
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
import type { Clock, ClockTimer } from '../router/clock.js';
import { ACQUIRE_ERROR_TABLE, type AcquireErrorCode, routerErr } from '../router/errors.js';
import { signHello } from './nodeAuth.js';
import {
  NODE_SOCKET_READY_STATE,
  type NodeEndpointResolver,
  type NodePeerEndpoint,
  type NodeSocketFactory,
  type NodeSocketLike,
  defaultNodeSocketFactory,
} from './nodeSocket.js';

/** The five `NodeTransport` methods this class forwards over the wire, one wire `method` string per interface method. */
type WireMethod = 'heartbeat' | 'launch' | 'terminate' | 'list' | 'dispatch';

/** One outbound request frame. `nodeId` is the peer's own id, echoed for a peer's own sanity check even though one connection already implies which peer it addresses. */
interface NodeReqFrame {
  t: 'req';
  id: number;
  nodeId: NodeId;
  method: WireMethod;
  args: unknown;
}

/** One inbound reply frame, correlated to a `NodeReqFrame` by `id`. */
interface NodeResFrame {
  t: 'res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/**
 * `LaunchedBrowser` minus its two function valued fields
 * (`teardown`/`onUnexpectedExit`), which cannot cross a JSON wire frame.
 * `hydrateLaunchedBrowser` reconstructs a full `LaunchedBrowser` from this
 * on the calling side; see that function's own comment.
 */
type WireLaunchedBrowser = Omit<LaunchedBrowser, 'teardown' | 'onUnexpectedExit'>;

/** One request awaiting its reply on a `PeerConnection`. */
interface PendingRequest {
  method: WireMethod;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  timer: ClockTimer;
}

/** The reconnect backoff schedule, indexed by consecutive failed connection attempt (1 based). The last entry repeats for every attempt beyond the table's length. */
const DEFAULT_RECONNECT_BACKOFF_MS: readonly number[] = [
  250, 500, 1_000, 2_000, 5_000, 10_000, 30_000,
];

function backoffForAttempt(attempt: number, schedule: readonly number[]): number {
  const idx = Math.min(Math.max(attempt, 1) - 1, schedule.length - 1);
  return schedule[idx] ?? schedule[schedule.length - 1] ?? 30_000;
}

/** Narrows a wire error `code` string to a known `AcquireErrorCode`, falling back to `E_NODE_LOST` for anything this process's error table does not recognise (a newer peer version, a bug on the other end): the caller still gets a real, retryable `RouterError`, never an unhandled shape. */
function codeFromWire(code: string | undefined): AcquireErrorCode {
  if (code !== undefined && Object.hasOwn(ACQUIRE_ERROR_TABLE, code))
    return code as AcquireErrorCode;
  return 'E_NODE_LOST';
}

/**
 * One connection to one peer node: socket lifecycle, the hello handshake,
 * request/reply correlation, and reconnect backoff. Not exported; a
 * `WebSocketNodeTransport` owns one `PeerConnection` per peer `nodeId` it
 * has ever needed to reach, created lazily on first use.
 *
 * RECONNECT DESIGN: connect on demand, gated by a backoff floor, rather
 * than a persistent background reconnect timer. `call()` always ensures a
 * connection before sending; if the last connection attempt failed
 * recently, a new one is refused immediately (`E_NODE_LOST`, no dial at
 * all) until `nextRetryAt` passes, so a caller hammering a dead peer with
 * repeated calls cannot itself hammer the peer with repeated connection
 * attempts. This satisfies "a node restart must not permanently poison
 * the transport" (the next call after the backoff window tries again,
 * and a successful connect resets the failure count to zero) without a
 * timer that has to be started, stopped, and leaked-checked independently
 * of any call ever being made; every other timer in this class already
 * goes through the injected `Clock` for exactly this kind of
 * determinism, and a background timer would be the one thing in this
 * file that could not be driven by a test's fake clock advancing, only
 * by real wall time actually elapsing.
 */
class PeerConnection {
  private socket: NodeSocketLike | null = null;
  private state: 'idle' | 'connecting' | 'open' | 'closed' = 'idle';
  private connectPromise: Promise<void> | null = null;
  private nextReqId = 1;
  private readonly inflight = new Map<number, PendingRequest>();
  private consecutiveFailures = 0;
  private nextRetryAt = 0;

  constructor(
    private readonly nodeId: NodeId,
    private readonly endpoint: NodePeerEndpoint,
    private readonly selfNodeId: NodeId,
    private readonly sharedSecret: string,
    private readonly clock: Clock,
    private readonly socketFactory: NodeSocketFactory,
    private readonly requestTimeoutMs: number,
    private readonly connectTimeoutMs: number,
    private readonly reconnectBackoffMs: readonly number[],
  ) {}

  /** This connection's own peer endpoint URL, so `WebSocketNodeTransport` can tell whether a cached `PeerConnection` is still pointed at the address `resolveEndpoint` currently reports, or needs replacing. */
  get endpointUrl(): string {
    return this.endpoint.url;
  }

  async call<T>(method: WireMethod, args: unknown): Promise<T> {
    await this.ensureConnected();
    // `ensureConnected` either resolved (this.state === 'open') or threw;
    // it never resolves with `this.state` in any other value, so this is
    // a paranoia check, not a reachable branch in ordinary operation.
    if (this.state !== 'open' || !this.socket) {
      throw routerErr(
        'E_NODE_LOST',
        `WebSocketNodeTransport: node ${this.nodeId} has no open connection to send '${method}' on`,
      );
    }
    const socket = this.socket;
    const id = this.nextReqId++;
    return new Promise<T>((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        this.inflight.delete(id);
        reject(
          routerErr(
            'E_NODE_LOST',
            `WebSocketNodeTransport: node ${this.nodeId} did not reply to '${method}' within ${this.requestTimeoutMs}ms`,
            { retryAfterMs: 1000 },
          ),
        );
      }, this.requestTimeoutMs);
      this.inflight.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer });
      const frame: NodeReqFrame = { t: 'req', id, nodeId: this.nodeId, method, args };
      try {
        socket.send(JSON.stringify(frame));
      } catch (err) {
        this.inflight.delete(id);
        this.clock.clearTimeout(timer);
        reject(
          routerErr(
            'E_NODE_LOST',
            `WebSocketNodeTransport: failed to send '${method}' to node ${this.nodeId}: ${String(err)}`,
          ),
        );
      }
    });
  }

  private ensureConnected(): Promise<void> {
    if (
      this.state === 'open' &&
      this.socket &&
      this.socket.readyState === NODE_SOCKET_READY_STATE.OPEN
    ) {
      return Promise.resolve();
    }
    if (this.connectPromise) return this.connectPromise;
    const now = this.clock.now();
    if (now < this.nextRetryAt) {
      return Promise.reject(
        routerErr(
          'E_NODE_LOST',
          `WebSocketNodeTransport: node ${this.nodeId} is backing off after ${this.consecutiveFailures} failed connection attempt(s); next retry at ${new Date(this.nextRetryAt).toISOString()}`,
          {
            retryAfterMs: this.nextRetryAt - now,
          },
        ),
      );
    }
    this.connectPromise = this.doConnect().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  private doConnect(): Promise<void> {
    this.state = 'connecting';
    let socket: NodeSocketLike;
    try {
      socket = this.socketFactory(this.endpoint);
    } catch (err) {
      this.onConnectFailed();
      return Promise.reject(
        routerErr(
          'E_NODE_LOST',
          `WebSocketNodeTransport: failed to construct a socket for node ${this.nodeId}: ${String(err)}`,
        ),
      );
    }
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = this.clock.setTimeout(() => {
        if (settled) return;
        settled = true;
        this.onConnectFailed();
        try {
          socket.close();
        } catch {
          // best effort: a socket that failed to open may already be unusable
        }
        reject(
          routerErr(
            'E_NODE_LOST',
            `WebSocketNodeTransport: connect to node ${this.nodeId} (${this.endpoint.url}) timed out after ${this.connectTimeoutMs}ms`,
          ),
        );
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        this.state = 'open';
        this.consecutiveFailures = 0;
        this.nextRetryAt = 0;
        // The hello frame, sent as the first thing on every fresh
        // connection, before any request frame. Not acknowledged at the
        // WebSocket protocol level (no dedicated "hello ok" reply frame):
        // `@browserglass/server`'s `ws/peer-upgrade.ts` peer listener
        // verifies it and closes the socket immediately on a bad one
        // (`PEER_CLOSE.AUTH_FAILED`), so a real deployment fails fast; a
        // wrong `resolveEndpoint` result that reaches something OTHER
        // than a real peer listener (nothing at all, or an unrelated
        // service on that URL) still surfaces the older way, every
        // subsequent request on this connection timing out as
        // `E_NODE_LOST` (retryable), since there is no listener there to
        // reject anything.
        try {
          socket.send(
            JSON.stringify(signHello(this.sharedSecret, this.selfNodeId, this.clock.now())),
          );
        } catch {
          // A hello send failure means every subsequent request send will
          // fail the same way and be reported then; nothing to do here
          // beyond not throwing out of an event handler.
        }
        resolve();
      };
      socket.onerror = (err: unknown) => {
        if (settled) return;
        settled = true;
        this.clock.clearTimeout(timer);
        this.onConnectFailed();
        reject(
          routerErr(
            'E_NODE_LOST',
            `WebSocketNodeTransport: connection error reaching node ${this.nodeId} (${this.endpoint.url}): ${String(err)}`,
          ),
        );
      };
      socket.onclose = (ev) => {
        if (!settled) {
          settled = true;
          this.clock.clearTimeout(timer);
          this.onConnectFailed();
          reject(
            routerErr(
              'E_NODE_LOST',
              `WebSocketNodeTransport: node ${this.nodeId} closed the connection before it opened (code ${ev.code})`,
            ),
          );
          return;
        }
        // A drop after a successful open: reject every in flight request
        // on this connection now, rather than let each wait out its own
        // timeout, and arm the backoff floor for the next `call()`'s
        // `ensureConnected`.
        this.onDroppedAfterOpen(`closed, code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`);
      };
      socket.onmessage = (ev) => {
        // Never let a malformed or unexpected peer frame throw into the
        // socket's own event handling: `handleMessage` swallows every
        // parse and shape problem itself.
        this.handleMessage(ev.data);
      };
    });
  }

  private onConnectFailed(): void {
    this.state = 'closed';
    this.socket = null;
    this.consecutiveFailures += 1;
    this.nextRetryAt =
      this.clock.now() + backoffForAttempt(this.consecutiveFailures, this.reconnectBackoffMs);
  }

  private onDroppedAfterOpen(reason: string): void {
    this.state = 'closed';
    this.socket = null;
    for (const [id, pending] of [...this.inflight]) {
      this.inflight.delete(id);
      this.clock.clearTimeout(pending.timer);
      pending.reject(
        routerErr(
          'E_NODE_LOST',
          `WebSocketNodeTransport: connection to node ${this.nodeId} dropped (${reason}) while '${pending.method}' was in flight`,
        ),
      );
    }
    this.consecutiveFailures += 1;
    this.nextRetryAt =
      this.clock.now() + backoffForAttempt(this.consecutiveFailures, this.reconnectBackoffMs);
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // malformed JSON: silently ignored, never thrown
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as Partial<NodeResFrame>;
    if (frame.t !== 'res' || typeof frame.id !== 'number') return; // not a reply frame this class recognises: ignored
    const pending = this.inflight.get(frame.id);
    if (!pending) return; // no matching request (a late reply after this side's own timeout, or a stray frame): ignored
    this.inflight.delete(frame.id);
    this.clock.clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.result);
    } else {
      const code = codeFromWire(frame.error?.code);
      pending.reject(
        routerErr(
          code,
          frame.error?.message ??
            `node ${this.nodeId} reported '${pending.method}' failed with no message`,
        ),
      );
    }
  }

  /** Closes this connection and rejects anything still in flight, for `WebSocketNodeTransport.close()`. */
  close(): void {
    if (this.state === 'closed') return;
    const socket = this.socket;
    this.onDroppedAfterOpen('transport closed');
    try {
      socket?.close(1000, 'WebSocketNodeTransport closed');
    } catch {
      // best effort
    }
  }
}

/** `WebSocketNodeTransport` construction options. */
export interface WebSocketNodeTransportOptions {
  /** This process's own node id. A call naming this id is delegated straight to `local`; this class never opens a socket to reach its own node. */
  selfNodeId: NodeId;
  /** The in process transport for this node's own instances, typically a `LocalNodeTransport` wrapping this process's own `LocalNode`. */
  local: NodeTransport;
  /** Resolves a peer node id to its WebSocket address. See `NodeEndpointResolver`'s own doc; the real implementation is `BrowserRouter.resolveNode`, not wired here directly to keep this leaf class from depending back on `BrowserRouter` (see this file's own top comment). */
  resolveEndpoint: NodeEndpointResolver;
  /** The operator supplied shared secret every gateway process in the deployment must be configured with identically. See `nodeAuth.ts`'s own top comment for exactly what it protects and what it does not. */
  sharedSecret: string;
  clock: Clock;
  /** Constructs a `NodeSocketLike` for one peer endpoint. Defaults to `defaultNodeSocketFactory` (the real global `WebSocket`); a test injects a scripted fake. */
  socketFactory?: NodeSocketFactory;
  /** Per request timeout: a request outstanding this long is rejected with `E_NODE_LOST`, the caller's cue to retry. Default 15000. */
  requestTimeoutMs?: number;
  /** Timeout for the initial socket connect (through the hello send), separate from `requestTimeoutMs`. Default 10000. */
  connectTimeoutMs?: number;
  /** Reconnect backoff schedule in ms, indexed by consecutive failed connection attempt. Default `DEFAULT_RECONNECT_BACKOFF_MS`. */
  reconnectBackoffMs?: readonly number[];
}

/**
 * The real multi node `NodeTransport`. See this file's own top comment for
 * the full design and the peer side listener gap. `BrowserRouter` only
 * ever depends on the `NodeTransport` interface, so constructing it with
 * one of these instead of a bare `LocalNodeTransport` is the entire change
 * a caller makes to go from a single node embedded build to one that can
 * genuinely reach another gateway process's instances, once a peer side
 * listener exists to answer it.
 */
export class WebSocketNodeTransport implements NodeTransport {
  private readonly selfNodeId: NodeId;
  private readonly local: NodeTransport;
  private readonly resolveEndpoint: NodeEndpointResolver;
  private readonly sharedSecret: string;
  private readonly clock: Clock;
  private readonly socketFactory: NodeSocketFactory;
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly reconnectBackoffMs: readonly number[];
  private readonly peers = new Map<NodeId, PeerConnection>();

  constructor(opts: WebSocketNodeTransportOptions) {
    this.selfNodeId = opts.selfNodeId;
    this.local = opts.local;
    this.resolveEndpoint = opts.resolveEndpoint;
    this.sharedSecret = opts.sharedSecret;
    this.clock = opts.clock;
    this.socketFactory = opts.socketFactory ?? defaultNodeSocketFactory;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
    this.reconnectBackoffMs = opts.reconnectBackoffMs ?? DEFAULT_RECONNECT_BACKOFF_MS;
  }

  async heartbeat(nodeId: NodeId, payload: NodeHeartbeatPayload): Promise<NodeHeartbeatAck> {
    if (nodeId === this.selfNodeId) return this.local.heartbeat(nodeId, payload);
    return this.callPeer<NodeHeartbeatAck>(nodeId, 'heartbeat', { payload });
  }

  async launch(nodeId: NodeId, req: NodeLaunchRequest): Promise<LaunchedBrowser> {
    if (nodeId === this.selfNodeId) return this.local.launch(nodeId, req);
    const wire = await this.callPeer<WireLaunchedBrowser>(nodeId, 'launch', { req });
    return this.hydrateLaunchedBrowser(nodeId, wire);
  }

  async terminate(
    nodeId: NodeId,
    instanceId: string,
    mode: TerminateMode,
    gracePeriodMs?: number,
  ): Promise<TerminateResult> {
    if (nodeId === this.selfNodeId)
      return this.local.terminate(nodeId, instanceId, mode, gracePeriodMs);
    return this.callPeer<TerminateResult>(nodeId, 'terminate', { instanceId, mode, gracePeriodMs });
  }

  async list(nodeId: NodeId): Promise<readonly RuntimeInventoryEntry[]> {
    if (nodeId === this.selfNodeId) return this.local.list(nodeId);
    return this.callPeer<readonly RuntimeInventoryEntry[]>(nodeId, 'list', {});
  }

  async dispatch(nodeId: NodeId, req: NodeActionRequest): Promise<NodeActionResult> {
    if (nodeId === this.selfNodeId) return this.local.dispatch(nodeId, req);
    return this.callPeer<NodeActionResult>(nodeId, 'dispatch', { req });
  }

  /** Closes every peer connection this transport has opened. Not part of `NodeTransport`; a production wiring should call this during its own shutdown sequence (`BrowserRouter.stop()`'s caller, not `BrowserRouter` itself, since `BrowserRouter` only ever sees the `NodeTransport` interface and has no `close()` to call). */
  close(): void {
    for (const peer of this.peers.values()) peer.close();
    this.peers.clear();
  }

  private async callPeer<T>(nodeId: NodeId, method: WireMethod, args: unknown): Promise<T> {
    const peer = await this.peerFor(nodeId);
    return peer.call<T>(method, args);
  }

  private async peerFor(nodeId: NodeId): Promise<PeerConnection> {
    const endpoint = await this.resolveEndpoint(nodeId);
    if (!endpoint) {
      throw routerErr(
        'E_NODE_LOST',
        `WebSocketNodeTransport: no known endpoint for node ${nodeId}`,
      );
    }
    const existing = this.peers.get(nodeId);
    if (existing && existing.endpointUrl === endpoint.url) return existing;
    // No cached connection, or `resolveEndpoint` now reports a different
    // address for this node id (a real re-placement, or an operator
    // moving a node): close the stale one, if any, and start fresh.
    existing?.close();
    const peer = new PeerConnection(
      nodeId,
      endpoint,
      this.selfNodeId,
      this.sharedSecret,
      this.clock,
      this.socketFactory,
      this.requestTimeoutMs,
      this.connectTimeoutMs,
      this.reconnectBackoffMs,
    );
    this.peers.set(nodeId, peer);
    return peer;
  }

  /**
   * Reconstructs a full `LaunchedBrowser` from the wire shaped
   * `WireLaunchedBrowser` a peer's `launch` reply carries, since
   * `teardown`/`onUnexpectedExit` are functions and cannot cross a JSON
   * frame (`WireLaunchedBrowser`'s own comment).
   *
   * `teardown` is reconstructed as a REAL, working call: it routes back
   * through `this.terminate(nodeId, ...)`, the same wire round trip a
   * direct `terminate()` call would make, so a caller that does hold onto
   * a `LaunchedBrowser` from a remote `launch()` and calls
   * `.teardown(mode)` on it gets a genuine remote terminate, not a stub.
   * (In this codebase's own `BrowserRouter`, nothing actually does this:
   * `placeAndLaunch`/`restart()` both call `this.nodes.terminate(nodeId,
   * instanceId, mode)` directly, never `launched.teardown()`, so this
   * path exists for interface completeness and for any other caller of
   * `NodeTransport.launch()` that does expect a working handle, not
   * because this package's own router needs it.)
   *
   * `onUnexpectedExit` is NOT reconstructed as real: it always returns a
   * no-op unsubscribe and never calls a registered callback. This is an
   * honest, documented gap, not an oversight. `LocalNode`'s own exit
   * notification comes from `runtime-host`'s process supervisor observing
   * the REAL OS process exit on the node that actually launched it; there
   * is no channel in this file's minimal request/reply wire protocol for
   * a peer to PUSH an unsolicited "this instance's browser just died"
   * notification back across an already-open connection unprompted. Bolting
   * one on (a distinct frame kind the peer sends whenever it wants,
   * decoupled from any pending request) is a real, buildable extension,
   * just not one built yet, and not one worth half
   * building silently: a caller that registers here and never gets
   * called deserves that documented in code, not discovered by them
   * debugging a missing event weeks later.
   */
  private hydrateLaunchedBrowser(nodeId: NodeId, wire: WireLaunchedBrowser): LaunchedBrowser {
    return {
      ...wire,
      teardown: (mode: TerminateMode) => this.terminate(nodeId, wire.instanceId, mode),
      onUnexpectedExit: () => () => undefined,
    };
  }
}
