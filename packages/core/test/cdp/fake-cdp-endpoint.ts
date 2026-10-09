/**
 * A scriptable, fake CDP WebSocket for `@browserglass/core`'s CDP layer
 * tests. There is no real Chrome dependency at this layer: `CdpBridge` only
 * needs something structurally matching `CdpWebSocketLike`, and this file
 * provides one, plus a default responder covering the connect handshake,
 * discovery setup, and attach, so most tests only need to script the one
 * behaviour they care about.
 */

import type {
  CdpWebSocketCloseEvent,
  CdpWebSocketLike,
  CdpWebSocketMessageEvent,
} from '../../src/cdp/platform.js';
import { WS_READY_STATE } from '../../src/cdp/platform.js';
import type { CdpWebSocketFactory } from '../../src/cdp/types.js';

/** One outbound CDP command, as sent by `CdpBridge`. */
export interface FakeCdpSentMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** A fake, in-memory CDP WebSocket. Every send is recorded; every reply is driven by the test. */
export class FakeCdpWebSocket implements CdpWebSocketLike {
  readyState: number = WS_READY_STATE.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((ev: CdpWebSocketCloseEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: CdpWebSocketMessageEvent) => void) | null = null;

  /** Every message sent through this socket, in order. */
  readonly sent: FakeCdpSentMessage[] = [];

  /** Optional scripted responder, invoked synchronously for every sent message, in addition to any test-driven `emit*` call. */
  autoRespond: ((msg: FakeCdpSentMessage, socket: FakeCdpWebSocket) => void) | null = null;

  send(data: string): void {
    const msg = JSON.parse(data) as FakeCdpSentMessage;
    this.sent.push(msg);
    this.autoRespond?.(msg, this);
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === WS_READY_STATE.CLOSED) {
      return;
    }
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.({ code, reason, wasClean: true });
  }

  /** Test control: transitions the socket to open and fires `onopen`. */
  open(): void {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.();
  }

  /** Test control: delivers a successful command response for request `id`. */
  emitResult(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }

  /** Test control: delivers a protocol error response for request `id`. */
  emitError(id: number, error: { code: number; message: string }): void {
    this.onmessage?.({ data: JSON.stringify({ id, error }) });
  }

  /** Test control: delivers a CDP event, browser-scoped when `sessionId` is omitted. */
  emitEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    this.onmessage?.({ data: JSON.stringify({ method, params, sessionId }) });
  }

  /** Test control: simulates the socket closing, from Chrome's side or the network. */
  simulateClose(code: number, reason: string, wasClean = false): void {
    if (this.readyState === WS_READY_STATE.CLOSED) {
      return;
    }
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }

  /** Test control: simulates a failed dial, e.g. a redial against a browser process that no longer exists (connection refused). Fires `onerror` only, never `onopen`, matching a WebSocket that never completed its handshake. */
  failToOpen(err: unknown = new Error('connect failed')): void {
    this.readyState = WS_READY_STATE.CLOSED;
    this.onerror?.(err);
  }

  /** The last sent message with this `method`, or `undefined`. */
  lastSent(method: string): FakeCdpSentMessage | undefined {
    return [...this.sent].reverse().find((m) => m.method === method);
  }

  /** Every sent message with this `method`, in order. */
  allSent(method: string): FakeCdpSentMessage[] {
    return this.sent.filter((m) => m.method === method);
  }
}

/** Mutable state a {@link installDefaultResponder} responder reads on every `Target.getTargets`. */
export interface FakeCdpWorld {
  targetInfos: Array<{
    targetId: string;
    type: string;
    title: string;
    url: string;
    attached: boolean;
    openerId?: string;
    browserContextId?: string;
  }>;
}

/**
 * Installs a default auto-responder covering the connect handshake
 * (`Browser.getVersion`, the three feature probes), `TargetRegistry`
 * discovery setup (`Target.setDiscoverTargets`, `Target.setAutoAttach`),
 * `Target.getTargets` (answered from `world.targetInfos`), and
 * `Target.attachToTarget` (a deterministic synthesised session id). Any
 * method not covered here gets a bare `{}` success, so an uninteresting
 * command never has to be scripted by hand. Returns `world`, whose
 * `targetInfos` array a test can mutate before calling `resync()`.
 */
export function installDefaultResponder(
  socket: FakeCdpWebSocket,
  opts: { productVersion?: string } = {},
): FakeCdpWorld {
  const world: FakeCdpWorld = { targetInfos: [] };
  const product = opts.productVersion ?? 'Chrome/131.0.6778.86';
  let attachCounter = 0;
  let scriptCounter = 0;

  socket.autoRespond = (msg) => {
    if (msg.method === 'Browser.getVersion') {
      socket.emitResult(msg.id, {
        protocolVersion: '1.3',
        product,
        revision: '@abcdef',
        userAgent: 'Mozilla/5.0 (fake)',
        jsVersion: '13.1.0',
      });
      return;
    }
    if (msg.method === 'Target.getTargets') {
      socket.emitResult(msg.id, { targetInfos: world.targetInfos });
      return;
    }
    if (msg.method === 'Target.attachToTarget') {
      const targetId = msg.params?.['targetId'] as string;
      attachCounter += 1;
      // A fresh session id per attach, matching real Chrome: cdpSessionId
      // changes on every reattach even though the target's own id is stable.
      socket.emitResult(msg.id, { sessionId: `S_${targetId}_${attachCounter}` });
      return;
    }
    if (msg.method === 'Page.addScriptToEvaluateOnNewDocument') {
      scriptCounter += 1;
      // A fresh identifier per call, matching real Chrome: re-registering
      // the same source on a new session gets a new identifier, never the
      // one issued on whatever earlier session called for it.
      socket.emitResult(msg.id, { identifier: `SCRIPT_${scriptCounter}` });
      return;
    }
    socket.emitResult(msg.id, {});
  };

  return world;
}

/** Constructs a {@link CdpWebSocketFactory} that always returns the same {@link FakeCdpWebSocket}, and hands back that socket for the test to drive. */
export function fakeWebSocketFactory(): { factory: CdpWebSocketFactory; socket: FakeCdpWebSocket } {
  const socket = new FakeCdpWebSocket();
  const factory: CdpWebSocketFactory = () => socket;
  return { factory, socket };
}

/**
 * Constructs a {@link CdpWebSocketFactory} that hands out a fresh
 * {@link FakeCdpWebSocket} on every call, collected in `sockets` in order.
 * `CdpBridgeImpl` calls its `wsFactory` once for the first `connect()` and
 * once per redial the reconnect loop attempts after an unexpected drop, so
 * `sockets[0]` is the initial connection and `sockets[1]`, `sockets[2]`, ...
 * are the reconnect attempts, for a test that needs to drive more than one
 * socket over a single bridge's lifetime.
 */
export function sequentialFakeWebSocketFactory(): {
  factory: CdpWebSocketFactory;
  sockets: FakeCdpWebSocket[];
} {
  const sockets: FakeCdpWebSocket[] = [];
  const factory: CdpWebSocketFactory = () => {
    const socket = new FakeCdpWebSocket();
    sockets.push(socket);
    return socket;
  };
  return { factory, sockets };
}
