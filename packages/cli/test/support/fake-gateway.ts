import type {
  WebSocketCloseEventLike,
  WebSocketConstructorLike,
  WebSocketDataLike,
  WebSocketLike,
  WebSocketMessageEventLike,
} from '@browserglass/client';
import type { Welcome } from '@browserglass/protocol';

/**
 * A scripted, fully synchronous `WebSocketLike` test double, playing the
 * server's side of a `bgls.v1` connection, so this package's own
 * browser-driving commands (`instances navigate/click/type/targets/
 * console/network`, `swarm run`) can be exercised end to end without a
 * real `@browserglass/server` process or a real Chrome. Reimplemented
 * here (rather than imported) because `packages/automation/test/
 * fake-gateway.ts` lives in a sibling package's private `test/`
 * directory and is not part of `@browserglass/automation`'s published
 * surface; this is the same fixture, trimmed to the wire messages this
 * package's own commands actually send.
 */
export class FakeGatewaySocket implements WebSocketLike {
  readonly url: string;
  readonly protocols: string | string[] | undefined;
  readyState = 0;
  binaryType = '';
  onopen: (() => void) | null = null;
  onclose: ((ev: WebSocketCloseEventLike) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: WebSocketMessageEventLike) => void) | null = null;

  readonly sent: WebSocketDataLike[] = [];

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  send(data: WebSocketDataLike): void {
    if (this.readyState !== 1) throw new Error('FakeGatewaySocket.send() called while not open');
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1005, reason: reason ?? '', wasClean: true });
  }

  /** Test driver: completes the upgrade. */
  simulateOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Test driver: delivers `msg` JSON encoded, as the server would. */
  simulateJson(msg: unknown): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  /** Every JSON message this socket has sent from the client, parsed, in send order. */
  sentJsonMessages(): Array<Record<string, unknown>> {
    return this.sent
      .filter((d): d is string => typeof d === 'string')
      .map((d) => JSON.parse(d) as Record<string, unknown>);
  }

  /** The last JSON message sent. Throws if none was sent. */
  lastSentJson(): Record<string, unknown> {
    const msgs = this.sentJsonMessages();
    const last = msgs[msgs.length - 1];
    if (!last) throw new Error('no JSON message sent yet');
    return last;
  }
}

/** A fresh, isolated `WebSocketConstructorLike` for one test, plus accessors onto the instances it constructs. Assign `harness.Impl` to `globalThis.WebSocket` (`vi.stubGlobal('WebSocket', harness.Impl)`): `@browserglass/client`'s `Transport` reads `globalThis.WebSocket` fresh on every connect when no `transport.WebSocketImpl` is given, which is what every one of this package's commands relies on (none of them thread a transport override through). */
export interface FakeGatewayHarness {
  Impl: WebSocketConstructorLike;
  instances: FakeGatewaySocket[];
  latest: () => FakeGatewaySocket;
}

export function createFakeGatewayHarness(): FakeGatewayHarness {
  const instances: FakeGatewaySocket[] = [];
  class ScopedFakeGatewaySocket extends FakeGatewaySocket {
    constructor(url: string, protocols?: string | string[]) {
      super(url, protocols);
      instances.push(this);
    }
  }
  return {
    Impl: ScopedFakeGatewaySocket as unknown as WebSocketConstructorLike,
    instances,
    latest: () => {
      const inst = instances[instances.length - 1];
      if (!inst) throw new Error('no FakeGatewaySocket instance constructed yet');
      return inst;
    },
  };
}

/** A complete, valid `Welcome` fixture, overridable per test. `re` is filled from the socket's own last-sent `hello.id`. */
export function fixtureWelcome(ws: FakeGatewaySocket, overrides: Partial<Welcome> = {}): Welcome {
  const hello = ws.lastSentJson();
  return {
    v: 1,
    t: 'welcome',
    re: hello['id'] as string,
    ts: Date.now(),
    sq: 1,
    version: 1,
    serverVersion: '0.0.0-fake-gateway',
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
      viewport: { width: 1280, height: 800, dpr: 1 },
      startedAt: Date.now(),
    },
    targets: [
      {
        targetId: 'tgt_0000000000000000000000001',
        kind: 'page',
        title: 'Example',
        url: 'https://example.test/',
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
    granted: [
      'view',
      'control',
      'navigate',
      'tabs.manage',
      'capture',
      'probe',
      'automation',
      'devtools',
    ],
    lease: {
      byTarget: {},
      defaultTtlMs: 60000,
      renewWithinMs: 15000,
      idleReleaseMs: 20000,
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

/** Drives one `FakeGatewaySocket` through `hello` to `welcome`. */
export function completeHandshake(
  harness: FakeGatewayHarness,
  welcomeOverrides: Partial<Welcome> = {},
): FakeGatewaySocket {
  const ws = harness.latest();
  ws.simulateOpen();
  ws.simulateJson(fixtureWelcome(ws, welcomeOverrides));
  return ws;
}

let leaseCounter = 0;
let genCounter = 1;

/**
 * A minimal, stateful `bgls.v1` server auto-responder: replies to the
 * message types this package's own `AutomationClient`-driven commands
 * send, tracking just enough state (one lease, one generation, one nav
 * state) to make connect, acquire-control, navigate, click, type,
 * screenshot, tabs, diagnostics, and release work end to end.
 */
export class ScriptedGateway {
  readonly ws: FakeGatewaySocket;
  leaseId: string | null = null;
  gen = 0;
  /** Targets `target.list` answers with; a test overrides this to shape `instances targets`' output. */
  targets: Array<Record<string, unknown>> = [];
  /** What this gateway answers `recording.start` with; a test overrides this to script an error reply. Unset, the default answers `recording.started` with `recordingId: 'rec_1'`. */
  recordingStartResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null =
    null;
  /** Every `recording.start` this gateway received, in send order. */
  readonly recordingStartCalls: Array<Record<string, unknown>> = [];
  /** Same pattern as {@link recordingStartResponder}, for `recording.stop`. Unset, the default answers `recording.stopped` with `framesWritten: 3, failed: false`. */
  recordingStopResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `recording.stop` this gateway received, in send order. */
  readonly recordingStopCalls: Array<Record<string, unknown>> = [];

  constructor(
    private readonly harness: FakeGatewayHarness,
    ws: FakeGatewaySocket,
  ) {
    this.ws = ws;
  }

  /** Installs the auto-responder on this gateway's socket. Call after `completeHandshake()`. */
  start(): void {
    const originalSend = this.ws.send.bind(this.ws);
    this.ws.send = (data: WebSocketDataLike) => {
      originalSend(data);
      if (typeof data === 'string') this.handle(JSON.parse(data) as Record<string, unknown>);
    };
  }

  private reply(re: string, t: string, extra: Record<string, unknown>): void {
    this.ws.simulateJson({ v: 1, t, re, ts: Date.now(), ...extra });
  }

  private handle(msg: Record<string, unknown>): void {
    const t = msg['t'];
    const id = msg['id'] as string | undefined;
    switch (t) {
      case 'control.request': {
        leaseCounter += 1;
        this.leaseId = `lease_${leaseCounter}`;
        if (id)
          this.reply(id, 'control.granted', {
            targetId: msg['targetId'],
            leaseId: this.leaseId,
            expiresAt: Date.now() + ((msg['ttlMs'] as number) ?? 60000),
            renewWithinMs: 15000,
            idleReleaseMs: 20000,
            mode: 'exclusive',
          });
        break;
      }
      case 'nav.goto': {
        if (id)
          this.reply(id, 'nav.state', {
            targetId: msg['targetId'],
            url: msg['url'],
            title: 'Navigated',
            loading: false,
            canGoBack: true,
            canGoForward: false,
            securityState: 'secure',
          });
        break;
      }
      case 'target.probe': {
        // Every coordinate-level interaction (`clickAt`/`type`/`moveTo`/
        // `pressKey`/`scroll`) calls `AutomationCore.ensureGen()` first,
        // which sends this when no `gen` is cached yet for the target
        // (`core.ts`'s own `ensureGen`); without a reply here every one
        // of those methods hangs forever waiting for `target.probed`.
        genCounter += 1;
        this.gen = genCounter;
        if (id)
          this.reply(id, 'target.probed', {
            targetId: msg['targetId'],
            detail: msg['detail'] ?? 'hover',
            gen: this.gen,
            hit: false,
          });
        break;
      }
      case 'target.capture': {
        if (id)
          this.reply(id, 'target.captured', {
            captureId: `cap_${id}`,
            targetId: msg['targetId'],
            format: (msg['format'] as string) ?? 'png',
            width: 1280,
            height: 800,
            dpr: 1,
            sizeBytes: 4,
            gen: this.gen || genCounter,
            fullPage: false,
            data: 'ZmFrZQ==',
            downscaled: false,
          });
        break;
      }
      case 'target.list': {
        if (id) this.reply(id, 'target.listed', { targets: this.targets });
        break;
      }
      case 'recording.start': {
        this.recordingStartCalls.push(msg);
        if (!id) break;
        const body = this.recordingStartResponder?.(msg) ?? {
          t: 'recording.started',
          recordingId: 'rec_1',
          targetId: msg['targetId'],
          mode: (msg['mode'] as string | undefined) ?? 'live',
          startedAtMs: Date.now(),
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'recording.started', rest);
        break;
      }
      case 'recording.stop': {
        this.recordingStopCalls.push(msg);
        if (!id) break;
        const body = this.recordingStopResponder?.(msg) ?? {
          t: 'recording.stopped',
          recordingId: msg['recordingId'],
          targetId: 'tgt_0000000000000000000000001',
          startedAtMs: Date.now() - 1000,
          stoppedAtMs: Date.now(),
          framesWritten: 3,
          failed: false,
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'recording.stopped', rest);
        break;
      }
      case 'target.new': {
        if (id)
          this.reply(id, 'target.created', {
            target: {
              targetId: 'tgt_new',
              kind: 'page',
              title: '',
              url: (msg['url'] as string) ?? 'about:blank',
              faviconUrl: null,
              index: 1,
              active: false,
              audible: false,
              muted: false,
              loading: true,
              canGoBack: false,
              canGoForward: false,
              openerTargetId: null,
              viewers: 0,
              createdAt: Date.now(),
            },
          });
        break;
      }
      case 'target.close':
      case 'target.activate': {
        if (id) this.reply(id, 'ack', {});
        break;
      }
      case 'diagnostics.subscribe': {
        if (id) {
          this.reply(id, 'diagnostics.subscribed', {
            targetId: msg['targetId'],
            console: (msg['console'] as boolean | undefined) ?? true,
            errors: (msg['errors'] as boolean | undefined) ?? true,
            network: (msg['network'] as boolean | undefined) ?? false,
          });
        }
        break;
      }
      case 'control.release':
      case 'input.mouse':
      case 'input.key':
      case 'input.text':
      case 'nav.stop':
      case 'diagnostics.unsubscribe':
        // fire-and-forget on the wire; nothing to reply with
        break;
      default:
        break;
    }
  }

  /** Broadcasts one `console.entry` for `targetId`. */
  sendConsoleEntry(
    targetId: string,
    entry: { level?: 'log' | 'info' | 'warn' | 'error' | 'debug'; text: string },
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'console.entry',
      ts: Date.now(),
      targetId,
      level: entry.level ?? 'log',
      text: entry.text,
    });
  }

  /** Broadcasts one `network.request` for `targetId`. */
  sendNetworkRequest(targetId: string, entry: { url: string; status?: number | null }): void {
    this.ws.simulateJson({
      v: 1,
      t: 'network.request',
      ts: Date.now(),
      targetId,
      requestId: `req_${targetId}`,
      method: 'GET',
      url: entry.url,
      resourceType: 'fetch',
      status: entry.status ?? 200,
      errorText: null,
      fromCache: false,
      durationMs: 12,
      encodedBytes: 256,
      startedAt: Date.now(),
    });
  }
}

/** Builds a `ScriptedGateway` bound to `harness`'s most recently constructed socket, having already completed the handshake. */
export function startScriptedGateway(
  harness: FakeGatewayHarness,
  welcomeOverrides: Partial<Welcome> = {},
): ScriptedGateway {
  const ws = completeHandshake(harness, welcomeOverrides);
  const gateway = new ScriptedGateway(harness, ws);
  gateway.start();
  return gateway;
}
