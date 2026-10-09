/**
 * The structural WebSocket contract `WebSocketNodeTransport` needs, the
 * same technique `core`'s `cdp/platform.ts` uses for `CdpWebSocketLike`:
 * this package's tsconfig sets `lib: ["ES2023"]` only, so the real global
 * `WebSocket` Node 22 ships (`engines` in `package.json` requires >=22) has
 * no compile time declaration here either, and no `dom` lib or `ws`
 * dependency is added just to name it. `defaultNodeSocketFactory` below
 * satisfies this against that real global through a structural cast; a
 * test's scripted fake (`test/support/fakeNodeSocket.ts`) satisfies it
 * directly, with no real socket anywhere in this package's suite.
 */

import type { NodeId } from '@browserglass/protocol';

/** A close event as delivered to {@link NodeSocketLike.onclose}. */
export interface NodeSocketCloseEvent {
  code: number;
  reason: string;
}

/** A message event as delivered to {@link NodeSocketLike.onmessage}. */
export interface NodeSocketMessageEvent {
  data: string;
}

/**
 * The minimal structural contract `WebSocketNodeTransport` needs from a
 * WebSocket. The real global `WebSocket` satisfies this structurally; a
 * scripted fake used in this package's tests satisfies it directly.
 */
export interface NodeSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onclose: ((ev: NodeSocketCloseEvent) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: NodeSocketMessageEvent) => void) | null;
}

/** The standard `WebSocket.readyState` values, transcribed since no ambient declaration is visible here (mirrors `core/src/cdp/platform.ts`'s `WS_READY_STATE`). */
export const NODE_SOCKET_READY_STATE = Object.freeze({
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
});

/** One peer node's WebSocket address, whatever `resolveEndpoint` decides that means for a given deployment (a hostname and port, a service mesh name, anything a real socket constructor can dial). */
export interface NodePeerEndpoint {
  url: string;
}

/**
 * Resolves a peer node id to its {@link NodePeerEndpoint} for
 * `WebSocketNodeTransport`. Returns `null` for a node id this deployment
 * has no known address for (a stale placement decision, a node that has
 * since left the cluster), which the transport turns into `E_NODE_LOST`
 * rather than attempting to dial `undefined`.
 *
 * Asynchronous because the honest real implementation is store backed
 * (`BrowserRouter.resolveNode(nodeId)`, reading `Node.dataPlaneUrl`), not
 * a synchronous in memory table; a resolver backed by a plain object or
 * `Map` still satisfies this type trivially (`async (id) => table[id] ??
 * null`, or simply returning a non-Promise value, which `await` accepts
 * unchanged).
 */
export type NodeEndpointResolver = (nodeId: NodeId) => Promise<NodePeerEndpoint | null>;

/**
 * Constructs a {@link NodeSocketLike} for one peer endpoint. Production
 * callers may inject their own (for example one built on the `ws` package,
 * to carry custom TLS options a standard constructor cannot express); a
 * test injects a scripted fake instead.
 */
export type NodeSocketFactory = (endpoint: NodePeerEndpoint) => NodeSocketLike;

/**
 * The default {@link NodeSocketFactory}, against the real global
 * `WebSocket` (Node 22's built in implementation). Production wiring may
 * override this to reach a `wss://` endpoint with custom TLS options, or
 * to carry headers the standard constructor cannot express.
 */
export function defaultNodeSocketFactory(endpoint: NodePeerEndpoint): NodeSocketLike {
  interface GlobalWebSocketCtor {
    new (url: string): NodeSocketLike;
  }
  const Ctor = (globalThis as unknown as { WebSocket: GlobalWebSocketCtor }).WebSocket;
  return new Ctor(endpoint.url);
}
