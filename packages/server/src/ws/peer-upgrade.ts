/**
 * The peer side listener `WebSocketNodeTransport.ts`'s own top comment
 * names as the deliberate gap in that file ("WHAT IS DELIBERATELY NOT
 * HERE: a peer side listener... a distinct piece of work... a second
 * WebSocket endpoint alongside the existing gateway server"). This module
 * is that second endpoint: it accepts a connection a peer's
 * `WebSocketNodeTransport` dialled, verifies the `hello` frame with
 * `nodeAuth.ts`'s `verifyHello` (written and tested there, uncalled by
 * anything until this file), and turns every subsequent request frame into
 * a real call against this node's own `NodeTransport` (a `LocalNodeTransport`
 * wrapping this process's `LocalNode`), replying in the exact frame shape
 * `WebSocketNodeTransport.ts`'s private `PeerConnection` class sends and
 * expects back.
 *
 * Deliberately its own upgrade path (`peer.path`, default
 * `/browserglass/node`), not folded into the `bgls.v1` viewer socket's
 * message loop: a peer connection speaks a different, much smaller
 * protocol (five RPC methods, no capability tokens, no target streaming,
 * no resume window), authenticated a completely different way (one shared
 * secret every gateway in the deployment holds, not a per viewer JWT), and
 * `Connection` (`ws/connection.ts`) has no seam for either of those without
 * growing a branch a viewer socket would never take. `src/index.ts` claims
 * this path the same way it already claims the viewer path: a cheap,
 * pure `shouldHandle*` predicate checked before any socket is consumed,
 * so `createUpgradeDispatcher`-style adapters (`adapters/nextjs.ts`) keep
 * working unmodified for a custom server that has its own upgrade chain.
 *
 * The wire frame shapes below (`NodeReqFrame`/`NodeResFrame`) intentionally
 * duplicate `WebSocketNodeTransport.ts`'s own private types rather than
 * importing them (that file exports no wire types, by design: the wire
 * shape is this pair's implicit contract, not a shared interface). Keep
 * the two definitions in sync by hand; a mismatch here is exactly the kind
 * of thing this suite's own cross node test would catch immediately (every
 * request would time out as `E_NODE_LOST` instead of failing a type check,
 * since both ends parse JSON at the boundary).
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type {
  LaunchedBrowser,
  NodeActionRequest,
  NodeHeartbeatPayload,
  NodeId,
  NodeLaunchRequest,
  NodeTransport,
  TerminateMode,
} from '@browserglass/protocol';
import { type Clock, type NodeAuthHello, verifyHello } from '@browserglass/router';
import { WebSocketServer, type WebSocket as WsWebSocket } from 'ws';
import type { Logger } from '../config/logger.js';

/** Mirrors `WebSocketNodeTransport.ts`'s private `WireMethod`. */
type PeerWireMethod = 'heartbeat' | 'launch' | 'terminate' | 'list' | 'dispatch';

/** Mirrors `WebSocketNodeTransport.ts`'s private `NodeReqFrame`. */
interface PeerReqFrame {
  t: 'req';
  id: number;
  nodeId: NodeId;
  method: PeerWireMethod;
  args: unknown;
}

/** Mirrors `WebSocketNodeTransport.ts`'s private `NodeResFrame`. */
interface PeerResFrame {
  t: 'res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** `LaunchedBrowser` minus its two function valued fields, the shape a `launch` reply carries. Mirrors `WebSocketNodeTransport.ts`'s private `WireLaunchedBrowser`; see that type's own doc for why the two function fields cannot cross a JSON frame. */
type WireLaunchedBrowser = Omit<LaunchedBrowser, 'teardown' | 'onUnexpectedExit'>;

function toWireLaunchedBrowser(handle: LaunchedBrowser): WireLaunchedBrowser {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { teardown, onUnexpectedExit, ...wire } = handle;
  return wire;
}

/** Everything one accepted peer connection needs to authenticate itself and reach this node's real `NodeTransport`. */
export interface PeerUpgradeDeps {
  /** This process's own node id, the only `nodeId` a `PeerReqFrame` may legitimately name (see `handleReq`'s own comment). */
  readonly selfNodeId: NodeId;
  /** This node's own transport, typically a `LocalNodeTransport` wrapping this process's `LocalNode`: exactly what a request addressed to `selfNodeId` is supposed to reach. */
  readonly nodeTransport: NodeTransport;
  /** The operator supplied shared secret every gateway in the deployment holds identically. See `nodeAuth.ts`'s own top comment for exactly what it protects and what it does not. */
  readonly sharedSecret: string;
  readonly clock: Clock;
  /** Hello timestamp tolerance, forwarded to `verifyHello`. Default `DEFAULT_HELLO_SKEW_MS` (30s) when omitted. */
  readonly skewMs?: number;
  readonly logger: Logger;
}

/** How long a freshly accepted connection has to send a valid `hello` before it is closed. Generous relative to `WebSocketNodeTransport`'s own `connectTimeoutMs` default (10s), since a hello is the very next frame a correctly behaving peer sends after `onopen`. */
const HELLO_DEADLINE_MS = 15_000;

/** Close codes this module uses. Outside the RFC 6455 reserved range (3000-4999 is the private use range the WS spec sets aside), matching `ws/connection.ts`'s own `CloseCode` table's general shape without sharing it: a peer link's close reasons are a distinct, much smaller vocabulary. */
const PEER_CLOSE = Object.freeze({
  /** No hello arrived before `HELLO_DEADLINE_MS`, or the hello that did arrive failed shape or MAC verification. This is a fast, explicit refusal: without a listener at all, a bad hello today just means every request on that connection times out as `E_NODE_LOST`; this code means "authentication failed", never left to a caller to infer from a timeout. */
  AUTH_FAILED: 4401,
  /** A frame this module could not parse as JSON, or whose shape matches neither `NodeAuthHello` nor `PeerReqFrame`. */
  BAD_FRAME: 4400,
});

/**
 * One accepted peer connection: the hello handshake, then a request/reply
 * loop translating `PeerReqFrame`s into real `NodeTransport` calls. Not
 * exported; `handlePeerUpgrade` is this module's only public entry point,
 * exactly mirroring `ws/upgrade.ts`'s `Connection`/`completeHandshakeAndServe`
 * split.
 */
class PeerLink {
  private authenticated = false;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly ws: WsWebSocket,
    private readonly deps: PeerUpgradeDeps,
  ) {
    this.helloTimer = setTimeout(() => {
      if (!this.authenticated)
        this.refuse(PEER_CLOSE.AUTH_FAILED, 'no hello received within deadline');
    }, HELLO_DEADLINE_MS);
    this.helloTimer.unref?.();

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => this.onMessage(data));
    ws.on('error', (err: Error) =>
      deps.logger.warn(
        { component: 'peer-ws', nodeId: deps.selfNodeId },
        `peer socket error: ${err.message}`,
      ),
    );
  }

  /** Closes the socket immediately with `code`/`reason`, and stops the hello deadline timer if it is still armed. Never throws: a socket that is already closing or already dead is a no-op here, the same "best effort" every close call in this codebase's WS layer treats a dying socket as. */
  private refuse(code: number, reason: string): void {
    if (this.helloTimer) clearTimeout(this.helloTimer);
    try {
      this.ws.close(code, reason);
    } catch {
      // best effort
    }
  }

  private toUtf8(data: Buffer | ArrayBuffer | Buffer[]): string {
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
    return Buffer.from(data).toString('utf8');
  }

  private onMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.toUtf8(data));
    } catch {
      this.refuse(PEER_CLOSE.BAD_FRAME, 'malformed JSON frame');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.refuse(PEER_CLOSE.BAD_FRAME, 'frame is not a JSON object');
      return;
    }
    if (!this.authenticated) {
      this.handleHello(parsed as Partial<NodeAuthHello>);
      return;
    }
    // Deliberately not awaited here: awaiting would serialise every
    // request on this connection behind whatever the previous one is
    // still doing, which is exactly the "concurrent requests from one
    // peer must not cross" property this class has to preserve, not
    // create a new way to violate. Each call captures its own `id` before
    // any `await`, so replies can and do land out of request order with
    // no risk of answering the wrong one; `WebSocketNodeTransport`'s own
    // `PeerConnection.inflight` map is what correlates them back on the
    // dialling side.
    void this.handleReq(parsed as Partial<PeerReqFrame>);
  }

  /**
   * `hello.nodeId` is the CONNECTING peer's own claimed identity, per
   * `nodeAuth.ts`'s own doc ("the authentication frame sent once per
   * connection"). Nothing here checks it against anything: every node in
   * a deployment shares one secret (`nodeAuth.ts`'s "what this does not
   * protect" section, "any node that has it is fully trusted to dispatch
   * to any other"), so a hello whose MAC verifies is accepted regardless
   * of which node id it claims. This is the documented trust model, not
   * an oversight; a per node credential would need a per node secret
   * table this build does not have.
   */
  private handleHello(hello: Partial<NodeAuthHello>): void {
    if (
      hello.t !== 'hello' ||
      typeof hello.nodeId !== 'string' ||
      typeof hello.ts !== 'number' ||
      typeof hello.mac !== 'string'
    ) {
      this.refuse(PEER_CLOSE.AUTH_FAILED, 'first frame is not a valid hello');
      return;
    }
    if (
      !verifyHello(
        hello as NodeAuthHello,
        this.deps.sharedSecret,
        this.deps.clock.now(),
        this.deps.skewMs,
      )
    ) {
      this.refuse(PEER_CLOSE.AUTH_FAILED, 'hello failed MAC or skew verification');
      return;
    }
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.authenticated = true;
  }

  private async handleReq(frame: Partial<PeerReqFrame>): Promise<void> {
    if (frame.t !== 'req' || typeof frame.id !== 'number' || typeof frame.method !== 'string') {
      return; // not a request frame this class recognises; ignored, mirrors PeerConnection.handleMessage's own tolerance for a stray frame.
    }
    const { id, method, args } = frame;
    // `frame.nodeId` is "the peer's own id, echoed for a peer's own sanity
    // check" (`WebSocketNodeTransport.ts`'s own `NodeReqFrame` doc): the
    // one id a request arriving on THIS listener could ever legitimately
    // name is this process's own, since the connection already implies
    // which node it addresses (there is exactly one node behind one
    // listener). Anything else is refused with the same `E_NODE_LOST` a
    // caller already knows how to treat as "wrong address, not a
    // malformed request" (`ACQUIRE_ERROR_TABLE.E_NODE_LOST.retryable`
    // is `true`, but retrying the SAME wrong address would just fail
    // again; a caller is expected to re-resolve, not loop here).
    if (frame.nodeId !== this.deps.selfNodeId) {
      this.sendError(
        id,
        'E_NODE_LOST',
        `this node is "${this.deps.selfNodeId}", not "${String(frame.nodeId)}"`,
      );
      return;
    }
    try {
      const result = await this.execute(method, args);
      this.sendResult(id, result);
    } catch (err) {
      const { code, message } = errorParts(err);
      this.sendError(id, code, message);
    }
  }

  /** The five `NodeTransport` methods, called against `deps.nodeTransport` with `deps.selfNodeId`: the exact call `LocalNodeTransport` (this node's real, in process transport) expects for its own node id, per its own doc's "the only address this transport can ever legitimately be asked to reach". */
  private async execute(method: PeerWireMethod, args: unknown): Promise<unknown> {
    const nodeId = this.deps.selfNodeId;
    const nodes = this.deps.nodeTransport;
    switch (method) {
      case 'heartbeat':
        return nodes.heartbeat(nodeId, (args as { payload: NodeHeartbeatPayload }).payload);
      case 'launch': {
        const handle = await nodes.launch(nodeId, (args as { req: NodeLaunchRequest }).req);
        return toWireLaunchedBrowser(handle);
      }
      case 'terminate': {
        const a = args as { instanceId: string; mode: TerminateMode; gracePeriodMs?: number };
        return nodes.terminate(nodeId, a.instanceId, a.mode, a.gracePeriodMs);
      }
      case 'list':
        return nodes.list(nodeId);
      case 'dispatch':
        return nodes.dispatch(nodeId, (args as { req: NodeActionRequest }).req);
      default: {
        // Exhaustiveness: `PeerWireMethod` names exactly five values, so
        // this is unreachable for any frame `handleReq`'s own shape check
        // already let through; a genuinely unknown `method` string from a
        // future or buggy peer falls through the `typeof method === 'string'`
        // check above and never reaches here as a recognised switch value,
        // it reaches here as the type system's own exhaustiveness escape.
        const unknownMethod: never = method;
        throw new Error(`peer listener: unknown method '${String(unknownMethod)}'`);
      }
    }
  }

  private sendResult(id: number, result: unknown): void {
    this.send({ t: 'res', id, ok: true, result });
  }

  private sendError(id: number, code: string, message: string): void {
    this.send({ t: 'res', id, ok: false, error: { code, message } });
  }

  private send(frame: PeerResFrame): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // best effort, matches PeerConnection.call's own send catch: the
      // requester's own timeout is what eventually reports this failure.
    }
  }
}

/** Extracts a `{code, message}` pair from whatever `NodeTransport`/`LocalNode` threw. `RouterError`/`BglsError` (the router's and protocol's own error vocabulary) carry both directly; anything else (a plain `Error`, `LocalNode.dispatch`'s own "no NodeActionExecutor configured" throw) is reported as `E_NODE_LOST` with its message preserved, the same fallback `WebSocketNodeTransport.ts`'s own `codeFromWire` uses for a code its error table does not recognise, so a caller-side `codeFromWire` normalises either shape identically. */
function errorParts(err: unknown): { code: string; message: string } {
  if (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
  ) {
    const message =
      err instanceof Error
        ? err.message
        : String((err as { message?: unknown }).message ?? 'unknown error');
    return { code: (err as { code: string }).code, message };
  }
  return { code: 'E_NODE_LOST', message: err instanceof Error ? err.message : String(err) };
}

/** One process wide `noServer` `WebSocketServer` for peer connections, distinct from `ws/upgrade.ts`'s own `wss`: peer connections never negotiate the `bgls.v1` subprotocol (a peer's `WebSocketNodeTransport` dials a bare `new WebSocket(url)`, see `nodeSocket.ts`'s `defaultNodeSocketFactory`), so sharing one `WebSocketServer` between the two would mean either forcing `handleProtocols` to accept "no subprotocol offered" (weakening the viewer path's own negotiation, which HAS to reject a connection that never offers `bgls.v1`) or branching inside one server's handshake callback for no benefit over two separate `noServer` instances. */
const peerWss = new WebSocketServer({ noServer: true });

/** Whether `req`'s URL path is this node's configured peer upgrade path. Cheap and pure, no socket consumption, mirroring `ws/index.ts`'s own `shouldHandleUpgrade` predicate for the viewer path. */
export function shouldHandlePeerUpgrade(req: IncomingMessage, path: string): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return url.pathname === path;
}

/** Completes the peer WS handshake and starts one `PeerLink`'s message loop. Unlike the viewer path's `completeHandshakeAndServe`, there is no pre-socket Origin or subprotocol check here: a peer connection is server to server, never a browser tab with an `Origin` header worth trusting or distrusting, and the shared secret hello is the entire authentication story for this link. */
export function handlePeerUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: PeerUpgradeDeps,
): void {
  peerWss.handleUpgrade(req, socket, head, (ws) => {
    new PeerLink(ws, deps);
  });
}
