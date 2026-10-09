import type { StreamSubscribed, Welcome } from '@browserglass/protocol';
import type { FakeWebSocket, FakeWebSocketHarness } from './fake-websocket.js';

/**
 * Test fixtures for `@browserglass/embed`, adapted from
 * `packages/react/test/support/fixtures.ts` (duplicated rather than
 * imported across the package boundary, same reasoning as
 * `fake-websocket.ts`). The adaptations from the React package's version:
 * `flushAsync` uses a bare `setTimeout` instead of React's `act()` (this
 * package renders no React tree to wrap), and `fixtureWelcome` accepts a
 * list of target ids rather than hardcoding exactly one, since this
 * package's own defining feature is several targets live at once.
 */

/** Flushes pending microtasks (promise continuations) under real timers. `BrowserGlassElement` has no framework scheduler to reconcile afterwards, unlike the React package's `flushAsync`, so this is a plain wait. */
export async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Builds a complete, valid `Welcome` fixture for one or more targets. `re` should be the harness's most recently sent `hello.id`. */
export function fixtureWelcome(
  targetIds: string[],
  overrides: Partial<Welcome> = {},
  re = 'unused',
): Welcome {
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
    targets: targetIds.map((targetId, index) => ({
      targetId,
      kind: 'page' as const,
      title: 'Test',
      url: 'about:blank',
      faviconUrl: null,
      index,
      active: true,
      audible: false,
      muted: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      openerTargetId: null,
      viewers: 0,
      createdAt: Date.now(),
    })),
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
function nextSq(ws: object): number {
  let counter = sqCounters.get(ws);
  if (!counter) {
    counter = { next: 2 };
    sqCounters.set(ws, counter);
  }
  const value = counter.next;
  counter.next += 1;
  return value;
}

let streamIdCounter = 1;

/** Builds a `stream.subscribed` reply for a `stream.subscribe` request, echoing its `id` as `re`. Each call defaults to a fresh `streamId` unless overridden, matching the server minting a new one per subscription. */
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
    streamId: streamIdCounter++,
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

/** Opens `harness`'s latest socket for `url` and completes the handshake with a `welcome` naming `targetIds`. Returns the socket. */
export function completeHandshake(
  harness: FakeWebSocketHarness,
  url: string,
  targetIds: string[],
  overrides: Partial<Welcome> = {},
): FakeWebSocket {
  const ws = harness.latestFor(url);
  ws.simulateOpen();
  const hello = ws.lastSentJson();
  ws.simulateJson(fixtureWelcome(targetIds, overrides, hello.id as string));
  return ws;
}

/**
 * Finds the `stream.subscribe` request on `ws` for `targetId` and answers
 * it with a `stream.subscribed` reply. Throws if none was sent. Looking up
 * by `targetId` rather than "most recent" matters here specifically
 * because this package can have several `<browser-glass>` elements, each
 * subscribing to a different target, sending their own `stream.subscribe`
 * on the one shared socket in close succession; there is exactly one such
 * request per `targetId` per client in the first place, since
 * `BrowserGlassClient.subscribe()` itself dedupes any second call for a
 * `targetId` already subscribed (confirmed by reading
 * `packages/client/src/client/BrowserGlassClient.ts`; see
 * `../../src/client-pool.ts`'s own doc comment for why that matters to
 * this package).
 */
export function answerSubscribeFor(
  ws: FakeWebSocket,
  targetId: string,
  overrides: Partial<StreamSubscribed> = {},
): void {
  const req = ws
    .sentJsonMessages()
    .find((m) => m.t === 'stream.subscribe' && m.targetId === targetId);
  if (!req) throw new Error(`no stream.subscribe sent for ${targetId}`);
  ws.simulateJson(fixtureStreamSubscribed(ws, req.id as string, { targetId, ...overrides }));
}
