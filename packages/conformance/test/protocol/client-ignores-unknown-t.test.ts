import { Transport, type TransportHelloOptions } from '@browserglass/client';
import type {
  WebSocketCloseEventLike,
  WebSocketConstructorLike,
  WebSocketDataLike,
  WebSocketLike,
  WebSocketMessageEventLike,
} from '@browserglass/client';
/**
 * Tested precisely: "Client MUST ignore unknown `t`
 * values without error." A scripted fake `WebSocketImpl` plays a minimal,
 * well formed server: it answers `hello` with a real `welcome`, then sends
 * one envelope carrying a `t` no message catalogue defines, then a real
 * `pong`. The real `@browserglass/client` `Transport` (never a fake) must
 * reach `live`, silently pass over the unknown envelope, and still
 * process the `pong` that follows it. This is a pure client-side unit
 * test, no network and no real gateway: `@browserglass/conformance`'s own
 * `test/e2e/load-bearing.test.ts` separately proves the server's own
 * matching tolerance over a real socket.
 */
import { describe, expect, it } from 'vitest';

/** A scripted, minimal, well formed `bgls.v1` server, just enough to reach `welcome`. */
class ScriptedSocket implements WebSocketLike {
  readyState = 0; // CONNECTING
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onclose: ((ev: WebSocketCloseEventLike) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: WebSocketMessageEventLike) => void) | null = null;

  readonly sent: unknown[] = [];

  constructor(_url: string, _protocols?: string | string[]) {
    queueMicrotask(() => {
      this.readyState = 1; // OPEN
      this.onopen?.();
    });
  }

  send(data: WebSocketDataLike): void {
    if (typeof data !== 'string') return; // binary frames: not sent by this scripted server
    const env = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(env);
    if (env['t'] === 'hello') {
      this.deliver(buildWelcome(env['id'] as string));
      // The case itself: a `t` no message catalogue defines,
      // sent right after `welcome`.
      this.deliver({
        v: 1,
        t: 'totally.unknown.message.type.the.client.has.never.seen',
        ts: Date.now(),
        payload: 'ignored',
      });
    }
    if (env['t'] === 'ping') {
      // Proof of life afterward: a real `pong`, correlated to the
      // client's own real `cts`, which only the client's keepalive
      // machinery can process correctly. `Transport` only fires its
      // semantic `pong` event for a reply matching a `ping` it actually
      // sent, so this echo (not a fabricated one) is what proves the
      // unknown envelope above did not wedge or throw inside the message
      // dispatch loop.
      this.deliver({ v: 1, t: 'pong', ts: Date.now(), cts: env['cts'] });
    }
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code: code ?? 1000, reason: reason ?? '', wasClean: true });
  }

  private deliver(env: Record<string, unknown>): void {
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(env) }));
  }
}

function buildWelcome(helloId: string): Record<string, unknown> {
  return {
    v: 1,
    t: 'welcome',
    re: helloId,
    sq: 1,
    ts: Date.now(),
    version: 1,
    serverVersion: 'conformance-fake/0.0.0',
    downgraded: false,
    viewerId: 'vwr_00000000000000000000000000',
    sessionId: 'sess_0000000000000000000000000',
    tenantId: 'ten_0000000000000000000000000',
    appId: 'app_0000000000000000000000000',
    instance: {
      instanceId: 'inst_000000000000000000000000',
      state: 'live',
      engine: 'chromium',
      channel: 'chrome',
      engineVersion: '151.0.0.0',
      headless: true,
      runtime: 'host',
      nodeId: null,
      profile: { mode: 'ephemeral', key: 'eph:test', sizeBytes: 0 },
      viewport: { width: 1280, height: 720, dpr: 1 },
      startedAt: Date.now(),
    },
    targets: [],
    granted: ['view'],
    lease: {
      byTarget: {},
      defaultTtlMs: 30_000,
      renewWithinMs: 10_000,
      idleReleaseMs: 20_000,
      maxQueue: 10,
    },
    presence: { viewers: [] },
    limits: {
      maxStreams: 4,
      maxBacklog: 8,
      maxBufferedBytes: 1_000_000,
      maxControlMsgBytes: 65_536,
      maxUploadBytes: 0,
      maxUploadChunkBytes: 0,
      inputRatePerSec: 300,
      controlRatePerSec: 30,
      navRatePerSec: 10,
      maxTargets: 20,
      maxSessionDurationMs: 3_600_000,
      idleTimeoutMs: 300_000,
    },
    ack: { policy: 'per-stream', everyNFrames: 1, maxAckIntervalMs: 250, required: true },
    streaming: {
      codec: 'jpeg',
      fallbackCodec: 'jpeg',
      maxFps: 15,
      keyframeIntervalMs: 3000,
      adaptive: true,
      qualityProfiles: ['auto'],
    },
    resume: { token: 'rsm-fake-token', windowMs: 120_000, issuedAt: Date.now() },
    sessionToken: 'session-fake-token',
    sessionTokenExpiresAt: Date.now() + 300_000,
    resumed: false,
    reauth: false,
    serverTime: Date.now(),
    notices: [],
  };
}

const HELLO: TransportHelloOptions = {
  client: { name: 'conformance', version: '0.0.0', runtime: 'node' },
  capabilities: {
    codecs: ['jpeg'],
    binaryFrames: true,
    input: ['mouse', 'key', 'text', 'touch', 'scroll'],
  },
  viewport: { width: 1280, height: 720, dpr: 1, visible: true, fitMode: 'contain' },
};

describe('the client ignores an unknown `t` without error', () => {
  it('reaches live, silently passes over the unknown envelope, and still processes the pong that follows it', async () => {
    let errored: unknown;
    const transport = new Transport({
      url: 'ws://localhost/bgls',
      token: 'fake',
      autoReconnect: false,
      hello: HELLO,
      // A short `pingIntervalMs` so this test's own real application
      // `ping`/`pong` round trip (the "proof of life" this test actually
      // asserts on) happens quickly rather than waiting out the 5s
      // production default.
      transport: {
        WebSocketImpl: ScriptedSocket as unknown as WebSocketConstructorLike,
        allowInsecureTransport: true,
        pingIntervalMs: 100,
      },
    });
    transport.on('fatal', (info) => {
      errored = info;
    });

    const pong = new Promise<void>((resolve) => transport.once('pong', () => resolve()));
    await transport.connect();
    expect(transport.state).toBe('live');
    await pong;

    expect(errored).toBeUndefined();
    expect(transport.state).toBe('live');
    await transport.disconnect();
  });
});
