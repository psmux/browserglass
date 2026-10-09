import type { StreamSubscribed, Welcome } from '@browserglass/protocol';
import { act } from '@testing-library/react';
import type { FakeWebSocket, FakeWebSocketHarness } from './fake-websocket.js';

/**
 * Flushes pending microtasks (promise continuations, including React's own
 * effect-scheduled work) under real timers, wrapped in `act()` so any
 * state update a resolving promise triggers is not reported as
 * out-of-`act()`. Real timers are used throughout this package's
 * integration tests deliberately: mixing `vi.useFakeTimers()` with React
 * 18's scheduler (which uses `MessageChannel`, not `setTimeout`, for its
 * own internal work) is a known source of tests that hang or under-flush.
 */
export async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Waits `ms` real milliseconds, wrapped in `act()`. Used for this package's few genuinely time-driven assertions (the 100ms StrictMode teardown window). */
export async function realDelay(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
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

/** Builds a `stream.subscribed` reply for a `stream.subscribe` request, echoing its `id` as `re`. */
export function fixtureStreamSubscribed(
  ws: FakeWebSocket,
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

/** Finds and answers the most recent `stream.subscribe` request sent on `ws` with a `stream.subscribed` reply. Throws if none was sent. */
export function answerLatestSubscribe(
  ws: FakeWebSocket,
  overrides: Partial<StreamSubscribed> = {},
): void {
  const sent = ws.sentJsonMessages();
  const req = [...sent]
    .reverse()
    .find((m) => m.t === 'stream.subscribe' || m.t === 'stream.quality');
  if (!req) throw new Error('no stream.subscribe/stream.quality sent yet');
  answerSubscribeById(ws, req.id as string, {
    targetId: (req.targetId as string) ?? 'tgt_00000000000000000000000001',
    ...overrides,
  });
}

/** Answers a specific `stream.subscribe` request id with a `stream.subscribed` reply. */
export function answerSubscribeById(
  ws: FakeWebSocket,
  requestId: string,
  overrides: Partial<StreamSubscribed> = {},
): void {
  ws.simulateJson(fixtureStreamSubscribed(ws, requestId, overrides));
}

/** Opens `harness`'s latest socket and completes the handshake with a `welcome`. Returns the socket. */
export function completeHandshake(
  harness: FakeWebSocketHarness,
  overrides: Partial<Welcome> = {},
): FakeWebSocket {
  const ws = harness.latest();
  ws.simulateOpen();
  const hello = ws.lastSentJson();
  ws.simulateJson(fixtureWelcome(overrides, hello.id as string));
  return ws;
}
