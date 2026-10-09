/**
 * A scriptable fake CDP endpoint for `runtime-remote`'s test suite: a fake
 * `fetch` serving `/json/version`, and a fake websocket serving CDP command
 * responses. Mirrors the pattern `@browserglass/core`'s
 * `test/cdp/fake-cdp-endpoint.ts` uses for the real `CdpBridge`, adapted to
 * this package's own minimal `RemoteCdpClient`.
 */

import type { MinimalFetch, MinimalFetchResponse } from '../src/platform.js';
import {
  type RemoteWebSocketCloseEvent,
  type RemoteWebSocketFactory,
  type RemoteWebSocketLike,
  type RemoteWebSocketMessageEvent,
  WS_READY_STATE,
} from '../src/platform.js';

/** One outbound CDP command, as sent by `RemoteCdpClient`. */
export interface FakeSentMessage {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** A fake, in-memory CDP websocket. Every send is recorded; every reply is driven by an auto-responder. */
export class FakeRemoteWebSocket implements RemoteWebSocketLike {
  readyState: number = WS_READY_STATE.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((ev: RemoteWebSocketCloseEvent) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: RemoteWebSocketMessageEvent) => void) | null = null;

  readonly sent: FakeSentMessage[] = [];
  autoRespond: ((msg: FakeSentMessage, socket: FakeRemoteWebSocket) => void) | null = null;

  constructor(private readonly autoOpen = true) {}

  send(data: string): void {
    const msg = JSON.parse(data) as FakeSentMessage;
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

  /** Delivers a successful command response for request `id`. */
  emitResult(id: number, result: unknown): void {
    this.onmessage?.({ data: JSON.stringify({ id, result }) });
  }

  /** Delivers a protocol error response for request `id`. */
  emitError(id: number, error: { code: number; message: string }): void {
    this.onmessage?.({ data: JSON.stringify({ id, error }) });
  }

  /** Simulates the socket closing unexpectedly, from the remote side. */
  simulateRemoteClose(code = 1006, reason = 'remote closed'): void {
    if (this.readyState === WS_READY_STATE.CLOSED) {
      return;
    }
    this.readyState = WS_READY_STATE.CLOSED;
    this.onclose?.({ code, reason, wasClean: false });
  }

  /** Test control: opens the socket, firing `onopen` on the next microtask so a caller's `await connect()` observes the pending state first. */
  open(): void {
    this.readyState = WS_READY_STATE.OPEN;
    this.onopen?.();
  }

  lastSent(method: string): FakeSentMessage | undefined {
    return [...this.sent].reverse().find((m) => m.method === method);
  }

  allSent(method: string): FakeSentMessage[] {
    return this.sent.filter((m) => m.method === method);
  }
}

/** Installs a default auto-responder covering `Target.getTargets` and `Target.attachToTarget`, everything else answered with `{}`. */
export function installDefaultResponder(
  socket: FakeRemoteWebSocket,
  opts: { pageTargets?: readonly string[] } = {},
): void {
  const pageTargets = opts.pageTargets ?? ['page-1'];
  let attachCounter = 0;
  socket.autoRespond = (msg) => {
    if (msg.method === 'Target.getTargets') {
      socket.emitResult(msg.id, {
        targetInfos: pageTargets.map((targetId) => ({ targetId, type: 'page', attached: false })),
      });
      return;
    }
    if (msg.method === 'Target.attachToTarget') {
      const targetId = msg.params?.['targetId'] as string;
      attachCounter += 1;
      socket.emitResult(msg.id, { sessionId: `S_${targetId}_${attachCounter}` });
      return;
    }
    socket.emitResult(msg.id, {});
  };
}

/** Builds a {@link RemoteWebSocketFactory} that always returns the same socket, opened synchronously the moment it is constructed (matching a real websocket's async-but-fast handshake closely enough for these tests). */
export function fakeWebSocketFactory(socket: FakeRemoteWebSocket): RemoteWebSocketFactory {
  return () => {
    queueMicrotask(() => socket.open());
    return socket;
  };
}

/** One configured fake endpoint: an HTTP origin, a `browserGuid`, and the websocket it answers `/json/version` with. */
export interface FakeEndpointConfig {
  origin: string;
  browserGuid: string;
  product?: string;
  userAgent?: string;
  /** When `false`, `/json/version` returns a non-ok HTTP status (endpoint unreachable). */
  reachable?: boolean;
}

/**
 * Builds a fake `fetch` answering `/json/version` for each configured
 * origin from `guidByOrigin` (mutable: a test may change the guid an origin
 * reports between calls, to script the stale-CDP-race scenarios).
 */
export function fakeFetch(guidByOrigin: Map<string, FakeEndpointConfig>): MinimalFetch {
  return async (url: string): Promise<MinimalFetchResponse> => {
    const origin = url.replace(/\/json\/version$/, '');
    const cfg = guidByOrigin.get(origin);
    if (!cfg || cfg.reachable === false) {
      return { ok: false, status: 502, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        webSocketDebuggerUrl: `ws://${origin.replace(/^https?:\/\//, '')}/devtools/browser/${cfg.browserGuid}`,
        Browser: cfg.product ?? 'Chrome/131.0.6778.86',
        'Protocol-Version': '1.3',
        'User-Agent': cfg.userAgent ?? 'Mozilla/5.0 (fake)',
      }),
    };
  };
}
