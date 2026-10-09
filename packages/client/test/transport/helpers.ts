import type { Welcome } from '@browserglass/protocol';
import { vi } from 'vitest';
import { Transport } from '../../src/transport/transport.js';
import type { TransportOptions } from '../../src/transport/types.js';
import { type FakeWebSocketHarness, createFakeWebSocketHarness } from './fake-websocket.js';

/**
 * Flushes the microtask queue (and any due fake timers). `Transport`
 * always awaits credential resolution, even on the synchronous cached-
 * ticket fast path, before constructing a socket, so every test that
 * calls `connect()` and then immediately wants to see the socket must
 * flush a tick first. Requires `vi.useFakeTimers()` to already be active.
 */
export async function flushMicrotasks(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

/** A minimal, complete `TransportHelloOptions` fixture. */
export function fixtureHello(): TransportOptions['hello'] {
  return {
    client: { name: 'test-client', version: '0.0.0', runtime: 'browser' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 800, height: 600, dpr: 1, visible: true, fitMode: 'contain' },
  };
}

/**
 * Builds `TransportOptions` for a test, with a fresh fake WebSocket harness
 * wired in. `overrides.transport` is merged onto (not replacing) the
 * harness's `WebSocketImpl`, so a test can override e.g.
 * `handshakeTimeoutMs` without losing the fake socket wiring. Defaults to
 * a usable `ticket`; pass `noDefaultTicket: true` for the credential-
 * failure tests, which need no ticket, no token, and no `credentials()`
 * to be present at all (an explicit `ticket: undefined` would fail
 * `exactOptionalPropertyTypes`, so the default is opt-out, not
 * overridable-to-undefined).
 */
export function fixtureOptions(
  overrides: Partial<TransportOptions> & { noDefaultTicket?: boolean } = {},
): { options: TransportOptions; harness: FakeWebSocketHarness } {
  const harness = createFakeWebSocketHarness();
  const { transport: transportOverrides, noDefaultTicket, ...rest } = overrides;
  const options: TransportOptions = {
    url: 'wss://example.test/browserglass/socket',
    ...(noDefaultTicket ? {} : { ticket: 'tkt_initial' }),
    hello: fixtureHello(),
    ...rest,
    transport: {
      WebSocketImpl: harness.Impl,
      handshakeTimeoutMs: 10000,
      pingIntervalMs: 5000,
      healthTimeoutMs: 5000,
      ...transportOverrides,
    },
  };
  return { options, harness };
}

/** Builds a complete, valid `Welcome` fixture, `re` pre-filled from the harness's most recently sent `hello.id`. */
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
    targets: [],
    granted: ['view'],
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

/** Constructs a `Transport` plus its fake WebSocket harness, ready for `connect()`. */
export function makeTransport(
  overrides: Partial<TransportOptions> & { noDefaultTicket?: boolean } = {},
): { transport: Transport; harness: FakeWebSocketHarness } {
  const { options, harness } = fixtureOptions(overrides);
  return { transport: new Transport(options), harness };
}

/** Drives a `Transport` through `connect()` up to and including a plain (non-resumed) `welcome`, returning the socket. */
export async function connectToLive(
  transport: Transport,
  harness: FakeWebSocketHarness,
): Promise<void> {
  const connectPromise = transport.connect();
  await flushMicrotasks();
  const ws = harness.latest();
  ws.simulateOpen();
  const hello = ws.lastSentJson();
  ws.simulateJson(fixtureWelcome({}, hello.id as string));
  await connectPromise;
}

/** A `sq` generator matching what a real server would send: gapless, starting right after `welcome`'s `sq: 1`. */
export function sqCounter(start = 1): () => number {
  let sq = start;
  return () => {
    sq += 1;
    return sq;
  };
}

/** Builds a valid `pong` fixture. `sq` must come from the same counter driving every other simulated message on this socket. */
export function fixturePong(cts: number, sq: number): Record<string, unknown> {
  return { v: 1, t: 'pong', ts: Date.now(), sq, cts, sts: Date.now() };
}

/** Extracts the `cts` of the most recently sent `ping` message. */
export function lastPingCts(ws: { sentJsonMessages(): Array<Record<string, unknown>> }): number {
  const pings = ws.sentJsonMessages().filter((m) => m.t === 'ping');
  const last = pings[pings.length - 1];
  if (!last) throw new Error('no ping sent yet');
  return last.cts as number;
}
