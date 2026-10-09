/**
 * A scripted `NodeSocketLike`, the counterpart `nodeSocket.ts`'s own top
 * comment names: `defaultNodeSocketFactory` satisfies `NodeSocketLike`
 * against the real global `WebSocket` through a structural cast; this
 * file satisfies it directly, so `WebSocketNodeTransport`'s test suite
 * never opens a real socket or depends on a real second process.
 *
 * Deliberately a low level, fully controllable primitive (a test drives
 * `simulateOpen`/`simulateMessage`/`simulateClose` by hand) rather than a
 * pre-scripted "well behaved peer" auto-responder: `WebSocketNodeTransport`'s
 * own tests need to exercise exact frame ordering (the hello before any
 * request), out of order replies, malformed frames, connect timeouts, and
 * mid-connection drops, all of which need this level of control. A test
 * that just wants a normal round trip can still get one in a few lines by
 * calling `simulateOpen()` then replying to whatever request frame it
 * finds in `sent`.
 */

import type {
  NodePeerEndpoint,
  NodeSocketCloseEvent,
  NodeSocketFactory,
  NodeSocketLike,
} from '../../src/node/nodeSocket.js';
import { NODE_SOCKET_READY_STATE } from '../../src/node/nodeSocket.js';

/** One scripted socket instance, plus the test hooks that drive its lifecycle from outside. */
export class FakeNodeSocket implements NodeSocketLike {
  readyState: number = NODE_SOCKET_READY_STATE.CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: ((ev: NodeSocketCloseEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  /** Set once `close()` (the `NodeSocketLike` method, called by the transport under test) has been invoked, so a test can tell a caller initiated close apart from a simulated peer side drop. */
  closedByCaller = false;

  constructor(readonly endpoint: NodePeerEndpoint) {}

  send(data: string): void {
    if (this.readyState !== NODE_SOCKET_READY_STATE.OPEN) {
      throw new Error(
        `FakeNodeSocket: send() called while readyState is ${this.readyState}, not OPEN`,
      );
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.closedByCaller = true;
    if (this.readyState === NODE_SOCKET_READY_STATE.CLOSED) return;
    this.readyState = NODE_SOCKET_READY_STATE.CLOSED;
    this.onclose?.({ code, reason });
  }

  // ── test hooks, never called by production code ─────────────────────

  /** Simulates the peer accepting the connection. */
  simulateOpen(): void {
    this.readyState = NODE_SOCKET_READY_STATE.OPEN;
    this.onopen?.();
  }

  /** Simulates one inbound message (a reply frame, or deliberately malformed data for the "never throw" tests). */
  simulateMessage(data: string): void {
    this.onmessage?.({ data });
  }

  /** Simulates a transport level error, before or after open. */
  simulateError(err: unknown): void {
    this.onerror?.(err);
  }

  /** Simulates the peer (or the network) dropping the connection, code 1006 by default (abnormal closure, no close frame). */
  simulateClose(code = 1006, reason = 'simulated drop'): void {
    if (this.readyState === NODE_SOCKET_READY_STATE.CLOSED) return;
    this.readyState = NODE_SOCKET_READY_STATE.CLOSED;
    this.onclose?.({ code, reason });
  }

  /** The parsed hello frame this socket received as its first `send()`, or `undefined` if none has been sent (yet). */
  firstFrame(): unknown {
    const raw = this.sent[0];
    return raw === undefined ? undefined : JSON.parse(raw);
  }
}

/**
 * A `NodeSocketFactory` that records every `FakeNodeSocket` it creates, in
 * order, so a test can reach into `sockets[0]`, `sockets[1]` (a
 * reconnect after a drop), etc, without threading a socket instance
 * through `WebSocketNodeTransport`'s own construction.
 */
export function createFakeNodeSocketFactory(): {
  factory: NodeSocketFactory;
  sockets: FakeNodeSocket[];
} {
  const sockets: FakeNodeSocket[] = [];
  const factory: NodeSocketFactory = (endpoint) => {
    const socket = new FakeNodeSocket(endpoint);
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}
