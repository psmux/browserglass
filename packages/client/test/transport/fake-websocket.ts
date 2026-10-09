import type {
  WebSocketCloseEventLike,
  WebSocketConstructorLike,
  WebSocketDataLike,
  WebSocketLike,
  WebSocketMessageEventLike,
} from '../../src/transport/types.js';

/**
 * A scripted, fully synchronous `WebSocketLike` test double. Every test in
 * this directory drives {@link Transport} through this fake rather than a
 * real socket: `simulateOpen()`/`simulateClose()`/`simulateMessage()` are
 * the only way any state transition happens, which is what makes "every
 * transition is driven through a scripted fake WebSocketImpl" literally
 * true rather than aspirational.
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
    if (this.readyState !== 1) {
      throw new Error('FakeWebSocket.send() called while not open');
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '', wasClean: true });
  }

  /** Test driver: completes the upgrade. */
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Test driver: delivers a raw message (string for JSON control frames, `ArrayBuffer` for binary frames). */
  simulateMessage(data: WebSocketDataLike): void {
    this.onmessage?.({ data });
  }

  /** Test driver: delivers `msg` JSON-encoded, as the server would. */
  simulateJson(msg: unknown): void {
    this.simulateMessage(JSON.stringify(msg));
  }

  /** Test driver: delivers `bytes` as a binary frame message. */
  simulateBinary(bytes: Uint8Array): void {
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    this.simulateMessage(buf);
  }

  /** Test driver: the server closes the socket. */
  simulateClose(code: number, reason = '', wasClean = code === 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean });
  }

  /** The last JSON message this socket sent, parsed. Throws if the last send was not JSON or nothing was sent. */
  lastSentJson(): Record<string, unknown> {
    const last = this.sent[this.sent.length - 1];
    if (typeof last !== 'string') throw new Error('no JSON message sent yet');
    return JSON.parse(last) as Record<string, unknown>;
  }

  /** Every JSON message this socket has sent, parsed, in send order. */
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
