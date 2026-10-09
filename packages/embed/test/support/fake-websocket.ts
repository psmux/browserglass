import type {
  WebSocketCloseEventLike,
  WebSocketConstructorLike,
  WebSocketDataLike,
  WebSocketLike,
  WebSocketMessageEventLike,
} from '@browserglass/client';

/**
 * A scripted, fully synchronous `WebSocketLike` test double, built against
 * `@browserglass/client`'s own public `WebSocketConstructorLike` contract.
 * Duplicated from `packages/react/test/support/fake-websocket.ts` rather
 * than imported across the package boundary (test directories are not
 * part of either package's public surface).
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

  /** Delivers `bytes` as a binary frame message, matching `packages/client/test/transport/fake-websocket.ts`'s own helper of the same name. */
  simulateBinary(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    this.simulateMessage(buf);
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

/**
 * A fresh, isolated `WebSocketConstructorLike` for one test, plus
 * accessors onto every instance it constructs, keyed by the `url` each
 * was opened with (this package's tests need to address several
 * concurrent sockets by URL, unlike `packages/react`'s own harness which
 * only ever has one at a time).
 *
 * `latestFor` matches by prefix, not exact equality:
 * `Transport.buildUrl()` (`packages/client/src/transport/transport.ts`)
 * always appends at least `?v=1`, and a ticket/resume query string beyond
 * that, so the socket actually opened for `wss://gateway.test/ws` is
 * `wss://gateway.test/ws?v=1`, never the bare url a test constructs a
 * client with.
 */
export interface FakeWebSocketHarness {
  Impl: WebSocketConstructorLike;
  instances: FakeWebSocket[];
  /** The most recently constructed instance, across every URL. Throws if none exists yet. */
  latest: () => FakeWebSocket;
  /** The most recently constructed instance whose URL starts with `url`. Throws if none exists yet. */
  latestFor: (url: string) => FakeWebSocket;
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
    latestFor: (url: string) => {
      const forUrl = instances.filter((i) => i.url.startsWith(url));
      const inst = forUrl[forUrl.length - 1];
      if (!inst) throw new Error(`no FakeWebSocket instance constructed yet for ${url}`);
      return inst;
    },
  };
}
