import type { StreamSubscribed, Welcome } from '@browserglass/protocol';
import { vi } from 'vitest';
import type { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import type { BrowserGlassClientOptions } from '../../src/client/types.js';
import {
  type FakeWebSocketHarness,
  createFakeWebSocketHarness,
} from '../transport/fake-websocket.js';

/** Flushes the microtask queue. `BrowserGlassClient.connect()` (via `Transport.connect()`) always awaits credential resolution before constructing a socket, so a test driving `connect()` must flush a tick before the socket exists. Requires `vi.useFakeTimers()`. */
export async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** Builds `BrowserGlassClientOptions` with a fresh fake WebSocket harness wired in. */
export function fixtureClientOptions(overrides: Partial<BrowserGlassClientOptions> = {}): {
  options: BrowserGlassClientOptions;
  harness: FakeWebSocketHarness;
} {
  const harness = createFakeWebSocketHarness();
  const { transport: transportOverrides, ...rest } = overrides;
  const options: BrowserGlassClientOptions = {
    url: 'wss://example.test/browserglass/socket',
    ticket: 'tkt_initial',
    ...rest,
    transport: {
      WebSocketImpl: harness.Impl,
      handshakeTimeoutMs: 10000,
      pingIntervalMs: 5000,
      healthTimeoutMs: 5000,
      requestTimeoutMs: 5000,
      ...transportOverrides,
    },
  };
  return { options, harness };
}

/** Builds a complete, valid `Welcome` fixture. `re` should be the harness's most recently sent `hello.id`. */
export function fixtureWelcome(overrides: Partial<Welcome> = {}, re = 'unused'): Welcome {
  return {
    v: 1,
    t: 'welcome',
    re,
    ts: Date.now(),
    sq: 1,
    version: 1,
    serverVersion: '0.0.0-test',
    downgraded: false,
    viewerId: 'vwr_00000000000000000000000001',
    sessionId: 'sess_0000000000000000000000001',
    tenantId: 'ten_00000000000000000000000001',
    appId: 'app_00000000000000000000000001',
    instance: {
      instanceId: 'inst_0000000000000000000000001',
      state: 'running',
      engine: 'chromium',
      channel: 'stable',
      engineVersion: '120.0.0.0',
      headless: true,
      runtime: 'host',
      nodeId: null,
      profile: { mode: 'ephemeral', key: 'eph:1', sizeBytes: 0 },
      viewport: { width: 800, height: 600, dpr: 1 },
      startedAt: Date.now(),
    },
    targets: [
      {
        targetId: 'tgt_00000000000000000000000001',
        kind: 'page',
        title: 'Test',
        url: 'about:blank',
        faviconUrl: null,
        index: 0,
        active: true,
        audible: false,
        muted: false,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        openerTargetId: null,
        viewers: 0,
        createdAt: Date.now(),
      },
    ],
    granted: ['view', 'control', 'navigate', 'tabs.manage', 'capture', 'probe'],
    lease: {
      byTarget: {},
      defaultTtlMs: 30000,
      renewWithinMs: 5000,
      idleReleaseMs: 60000,
      maxQueue: 5,
    },
    presence: { viewers: [] },
    limits: {
      maxStreams: 28,
      maxBacklog: 3,
      maxBufferedBytes: 2097152,
      maxControlMsgBytes: 65536,
      maxUploadBytes: 268435456,
      maxUploadChunkBytes: 65536,
      inputRatePerSec: 300,
      controlRatePerSec: 60,
      navRatePerSec: 4,
      maxTargets: 32,
      maxSessionDurationMs: 3600000,
      idleTimeoutMs: 600000,
    },
    ack: { policy: 'cumulative', everyNFrames: 1, maxAckIntervalMs: 250, required: true },
    streaming: {
      codec: 'jpeg',
      fallbackCodec: 'jpeg',
      maxFps: 30,
      keyframeIntervalMs: 2000,
      adaptive: true,
      qualityProfiles: ['auto', 'low', 'medium', 'high'],
    },
    resume: { token: 'rsm_initial', windowMs: 120000, issuedAt: Date.now() },
    sessionToken: 'session-token',
    sessionTokenExpiresAt: Date.now() + 900000,
    resumed: false,
    reauth: false,
    serverTime: Date.now(),
    notices: [],
    ...overrides,
  };
}

/** Drives a `BrowserGlassClient` through `connect()` up to and including a plain `welcome`. Returns the fake socket. */
export async function connectClientToLive(
  client: BrowserGlassClient,
  harness: FakeWebSocketHarness,
) {
  const connectPromise = client.connect();
  await flushMicrotasks();
  const ws = harness.latest();
  ws.simulateOpen();
  const hello = ws.lastSentJson();
  ws.simulateJson(fixtureWelcome({}, hello.id as string));
  await connectPromise;
  return ws;
}

/**
 * Per-socket `sq` counters (transport's own `sq` gap check closes 1002 on
 * any repeat or skipped value, see `../../src/transport/transport.ts`'s
 * `processEnvelope`): every simulated S to C message on one fake socket
 * after `welcome` (which itself claims `sq: 1`) needs a distinct,
 * gapless, increasing `sq`. Scoped per socket instance so a reconnect's
 * fresh socket starts its own count over at 2.
 */
const sqCounters = new WeakMap<object, { next: number }>();

/** The next `sq` value for `ws`, auto-incrementing from `2` (right after `welcome`'s `sq: 1`). */
export function nextSq(ws: object): number {
  let counter = sqCounters.get(ws);
  if (!counter) {
    counter = { next: 2 };
    sqCounters.set(ws, counter);
  }
  const value = counter.next;
  counter.next += 1;
  return value;
}

/** Builds a `stream.subscribed` reply for a `stream.subscribe` request, echoing its `id` as `re`. `sq` auto-increments per `ws` unless `overrides.sq` is given explicitly. */
export function fixtureStreamSubscribed(
  ws: ReturnType<FakeWebSocketHarness['latest']>,
  re: string,
  overrides: Partial<StreamSubscribed> = {},
): StreamSubscribed {
  return {
    v: 1,
    t: 'stream.subscribed',
    re,
    ts: Date.now(),
    sq: nextSq(ws),
    streamId: 1,
    targetId: 'tgt_00000000000000000000000001',
    quality: 'auto',
    codec: 'jpeg',
    fps: 15,
    width: 800,
    height: 600,
    dpr: 1,
    paused: false,
    sidEpoch: 1,
    gen: 1,
    ...overrides,
  };
}

/** Finds and answers the most recent `stream.subscribe` (or `stream.quality`) request sent on `ws` with a `stream.subscribed` reply. Throws if none was sent. */
export function answerLatestSubscribe(
  ws: ReturnType<FakeWebSocketHarness['latest']>,
  overrides: Partial<StreamSubscribed> = {},
): void {
  const sent = ws.sentJsonMessages();
  const req = [...sent]
    .reverse()
    .find((m) => m.t === 'stream.subscribe' || m.t === 'stream.quality');
  if (!req) throw new Error('no stream.subscribe/stream.quality sent yet');
  ws.simulateJson(
    fixtureStreamSubscribed(ws, req.id as string, {
      targetId: (req.targetId as string) ?? 'tgt_00000000000000000000000001',
      ...overrides,
    }),
  );
}
