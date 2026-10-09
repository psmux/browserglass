import type {
  WebSocketCloseEventLike,
  WebSocketConstructorLike,
  WebSocketDataLike,
  WebSocketLike,
  WebSocketMessageEventLike,
} from '@browserglass/client';

/**
 * A scripted, fully synchronous `WebSocketLike` test double, built against
 * `@browserglass/client`'s own public `WebSocketConstructorLike` contract
 * (the transport injection point). This package owns no test-only
 * helpers from `@browserglass/client`'s own `test/` directory (that is not
 * part of either package's public surface), so this is a small,
 * self-contained duplicate scoped to this package's own StrictMode and
 * wheel-scroll tests.
 */
export class FakeWebSocket implements WebSocketLike {
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((ev: WebSocketCloseEventLike) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: WebSocketMessageEventLike) => void) | null = null;

  readonly sent: WebSocketDataLike[] = [];
  readonly closeCalls: Array<{ code: number | undefined; reason: string | undefined }> = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  send(data: WebSocketDataLike): void {
    if (this.readyState !== 1) throw new Error('FakeWebSocket.send() called while not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '', wasClean: true });
  }

  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  simulateMessage(data: WebSocketDataLike): void {
    this.onmessage?.({ data });
  }

  simulateJson(msg: unknown): void {
    this.simulateMessage(JSON.stringify(msg));
  }

  simulateClose(code: number, reason = '', wasClean = code === 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean });
  }

  lastSentJson(): Record<string, unknown> {
    const last = this.sent[this.sent.length - 1];
    if (typeof last !== 'string') throw new Error('no JSON message sent yet');
    return JSON.parse(last) as Record<string, unknown>;
  }

  sentJsonMessages(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }
}

/** A fresh, isolated `WebSocketConstructorLike` for one test, plus accessors onto the instances it constructs. */
export interface FakeWebSocketHarness {
  Impl: WebSocketConstructorLike;
  instances: FakeWebSocket[];
  /** The most recently constructed instance. Throws if none exists yet. */
  latest: () => FakeWebSocket;
}

/** Builds a fresh {@link FakeWebSocketHarness}, isolated from any other test's instances. */
export function createFakeWebSocketHarness(): FakeWebSocketHarness {
  const instances: FakeWebSocket[] = [];

  class ScopedFakeWebSocket extends FakeWebSocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      instances.push(this);
    }
  }

  return {
    Impl: ScopedFakeWebSocket as unknown as WebSocketConstructorLike,
    instances,
    latest: () => {
      const inst = instances[instances.length - 1];
      if (!inst) throw new Error('no FakeWebSocket instance constructed yet');
      return inst;
    },
  };
}
