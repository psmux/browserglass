import type {
  WebSocketCloseEventLike,
  WebSocketConstructorLike,
  WebSocketDataLike,
  WebSocketLike,
  WebSocketMessageEventLike,
} from '@browserglass/client';
import { MsgType, decodeBinaryHeader, decodeUploadChunkPayload } from '@browserglass/protocol';
import type { Welcome } from '@browserglass/protocol';

/**
 * A scripted, fully synchronous `WebSocketLike` test double, playing the
 * server's side of the connection, so `AutomationClient` is driven end to
 * end without a real running gateway, speaking just enough of `bgls.v1` to exercise
 * connect, acquire control, navigate, click, screenshot, and release.
 * Modelled directly on `packages/client/test/transport/fake-websocket.ts`'s
 * `FakeWebSocket` (the client package's own test double), reimplemented here
 * because that file lives in a sibling package's private `test/` directory
 * and is not part of `@browserglass/client`'s published surface.
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

  /** Test driver: the server closes the socket. */
  simulateClose(code: number, reason = '', wasClean = code === 1000): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean });
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

/** A fresh, isolated `WebSocketConstructorLike` for one test, plus accessors onto the instances it constructs. */
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
    granted: ['view', 'control', 'navigate', 'tabs.manage', 'capture', 'probe', 'automation'],
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

/**
 * Drives one `FakeGatewaySocket` through `hello` to `welcome`. The caller
 * is expected to have already called `AutomationClient.connect()` (or
 * `transport.connect()`); this resolves the handshake half of that promise.
 */
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
 * message types `AutomationClient` sends with the reply that message
 * expects, tracking just enough state (one lease, one generation, one nav
 * state) to make a realistic connect, acquire-control, navigate, click,
 * screenshot, release sequence work end to end. A test overrides
 * `onMessage` (or reads `ws.sentJsonMessages()` directly) for anything more
 * specific, such as a preemption sequence.
 */
export class ScriptedGateway {
  readonly ws: FakeGatewaySocket;
  leaseId: string | null = null;
  gen = 0;
  /**
   * What this gateway answers `page.evaluate` with. Set by a test to
   * script the exact `page.evaluated` (or `error`) body it wants; unset,
   * the default below returns `null` by value, which is enough for the
   * tests that only care that the request was well formed.
   *
   * A responder rather than a fixed reply, because the point of the
   * evaluate tests is that one message type has to carry a value, an
   * `undefined`, an unserialisable description, a page exception and an
   * error, and the client has a different job for each.
   */
  evaluateResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `page.evaluate` this gateway received, in send order. */
  readonly evaluateCalls: Array<Record<string, unknown>> = [];

  /**
   * What this gateway answers `page.responsebody.get` with. Same shape as
   * {@link evaluateResponder} and for the same reason: unset, the default
   * below answers a small `page.responsebody.got`, enough for a test that
   * only cares the request was well formed; a test that needs the
   * `too_large`/`unavailable`/`unknown_request` refusals, or a binary
   * `base64Encoded` body, scripts this instead.
   */
  responseBodyResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `page.responsebody.get` this gateway received, in send order. */
  readonly responseBodyCalls: Array<Record<string, unknown>> = [];

  /**
   * What this gateway answers `page.a11y.get` with. Same shape as
   * {@link evaluateResponder} and for the same reason: unset, the default
   * below answers an empty `page.a11y.got` (no nodes, `marker: null`),
   * enough for a test that only cares the request was well formed; a test
   * exercising `a11y()`'s own shaping, truncation, or the `role=` engine's
   * rewrite scripts this instead.
   */
  a11yResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `page.a11y.get` this gateway received, in send order. */
  readonly a11yCalls: Array<Record<string, unknown>> = [];

  /**
   * What this gateway answers `page.map.get` with. Same shape as
   * {@link a11yResponder} and for the same reason: unset, the default below
   * answers an empty `page.map.got` (no nodes, epoch `'epoch_1'`), enough
   * for a test that only cares the request was well formed; a test
   * exercising `pageMap()`'s own shaping, truncation, or degradation
   * scripts this instead.
   */
  pageMapResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `page.map.get` this gateway received, in send order. */
  readonly pageMapCalls: Array<Record<string, unknown>> = [];

  /** Same pattern as {@link pageMapResponder}, for `page.map.stamp`. Unset, the default answers every requested index stamped, marker `'data-bgls-pm-fake'`. */
  pageMapStampResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `page.map.stamp` this gateway received, in send order. */
  readonly pageMapStampCalls: Array<Record<string, unknown>> = [];

  /**
   * What this gateway answers `page.pdf.get` with. Same shape as
   * {@link evaluateResponder} and for the same reason: unset, the default
   * below answers a small inline `page.pdf.got` (`data: 'ZmFrZQ=='`),
   * enough for a test that only cares the request was well formed; a test
   * exercising `pdf()`'s own download-delivery shape (`downloadId`/`url`
   * instead of `data`) scripts this instead.
   */
  pdfResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `page.pdf.get` this gateway received, in send order. */
  readonly pdfCalls: Array<Record<string, unknown>> = [];

  /**
   * What this gateway answers `recording.start` with. Same pattern as
   * {@link pdfResponder}: unset, the default below answers a small
   * `recording.started` (`recordingId: 'rec_1'`), enough for a test that
   * only cares the request was well formed; a test exercising the
   * `E_RECORDING_UNAVAILABLE`/`E_RECORDING_NOT_FOUND`/target-not-found
   * error mapping scripts this instead.
   */
  recordingStartResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null =
    null;
  /** Every `recording.start` this gateway received, in send order. */
  readonly recordingStartCalls: Array<Record<string, unknown>> = [];

  /** Same pattern as {@link recordingStartResponder}, for `recording.stop`. Unset, the default answers `recording.stopped` with `framesWritten: 3, failed: false`. */
  recordingStopResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `recording.stop` this gateway received, in send order. */
  readonly recordingStopCalls: Array<Record<string, unknown>> = [];

  /** Same pattern as {@link recordingStartResponder}, for `recording.list`. Unset, the default answers `recording.listed` with an empty list. */
  recordingListResponder: ((msg: Record<string, unknown>) => Record<string, unknown>) | null = null;
  /** Every `recording.list` this gateway received, in send order. */
  readonly recordingListCalls: Array<Record<string, unknown>> = [];

  /**
   * The upload side of the fake, standing in for
   * `@browserglass/server`'s `UploadStore`. Keyed by the `binaryId` this
   * gateway mints in `upload.accepted`, because that is what an
   * `UPLOAD_CHUNK` frame actually carries: a client that sends its chunks
   * under the wrong key never reaches its own upload, which is exactly
   * the failure this fake has to be able to show.
   */
  readonly uploadsByBinaryId = new Map<
    string,
    { uploadId: string; name: string; declared: number; chunks: Uint8Array[] }
  >();
  /** By `uploadId`, for the JSON half of the handshake. */
  readonly uploadsById = new Map<
    string,
    { binaryId: string; name: string; declared: number; chunks: Uint8Array[] }
  >();
  /** Every `files.set` this gateway received, in send order. */
  readonly filesSetCalls: Array<Record<string, unknown>> = [];
  /** Upload ids this gateway was asked to cancel. */
  readonly cancelledUploads: string[] = [];
  /** When set, `files.set` answers with this error code instead of succeeding. */
  filesSetError: string | null = null;
  private binaryCounter = 0;

  /** The bytes actually received for `uploadId`, concatenated in arrival order. */
  bytesFor(uploadId: string): Uint8Array {
    const rec = this.uploadsById.get(uploadId);
    if (!rec) throw new Error(`no upload ${uploadId} on this fake gateway`);
    const total = rec.chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of rec.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

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
      else this.handleBinary(data);
    };
  }

  /**
   * One inbound binary frame. Decoded with the protocol's own
   * `decodeBinaryHeader`/`decodeUploadChunkPayload` rather than by hand, so
   * a client that framed a chunk wrongly fails here the way it would fail
   * against the real gateway.
   */
  private handleBinary(data: ArrayBuffer | ArrayBufferView): void {
    const header = decodeBinaryHeader(data);
    if (header.msgType !== MsgType.UPLOAD_CHUNK) return;
    const { uploadId, chunk } = decodeUploadChunkPayload(header.payload);
    const binaryId = [...uploadId].map((b) => b.toString(16).padStart(2, '0')).join('');
    const rec = this.uploadsByBinaryId.get(binaryId);
    if (!rec) return;
    rec.chunks.push(Uint8Array.prototype.slice.call(chunk));
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
      case 'control.renew': {
        if (id)
          this.reply(id, 'control.granted', {
            targetId: msg['targetId'],
            leaseId: msg['leaseId'],
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
      case 'nav.back':
      case 'nav.forward':
      case 'nav.reload': {
        if (id)
          this.reply(id, 'nav.state', {
            targetId: msg['targetId'],
            url: 'https://example.test/',
            title: 'Example',
            loading: false,
            canGoBack: true,
            canGoForward: true,
            securityState: 'secure',
          });
        break;
      }
      case 'target.probe': {
        genCounter += 1;
        this.gen = genCounter;
        if (id)
          this.reply(id, 'target.probed', {
            targetId: msg['targetId'],
            detail: msg['detail'] ?? 'hover',
            gen: this.gen,
            hit: true,
            rect: { x: (msg['x'] as number) ?? 0, y: (msg['y'] as number) ?? 0, w: 10, h: 10 },
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
      case 'page.pdf.get': {
        this.pdfCalls.push(msg);
        if (!id) break;
        const body = this.pdfResponder?.(msg) ?? {
          t: 'page.pdf.got',
          pdfId: `pdf_${id}`,
          targetId: msg['targetId'],
          sizeBytes: 4,
          gen: this.gen || genCounter,
          data: 'ZmFrZQ==',
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'page.pdf.got', rest);
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
      case 'recording.list': {
        this.recordingListCalls.push(msg);
        if (!id) break;
        const body = this.recordingListResponder?.(msg) ?? {
          t: 'recording.listed',
          recordings: [],
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'recording.listed', rest);
        break;
      }
      // `page.evaluate.internal` (`@browserglass/protocol`'s
      // `PageEvaluateInternal`) is the locator surface's own
      // resolve/verify bookkeeping (`AutomationClient`'s `evaluateFunction`
      // port), sent instead of `page.evaluate` so it is charged to a
      // separate, smaller rate-limit bucket server-side
      // (`packages/server/src/wire/rate-limit.ts`'s `evaluateInternal`).
      // This fake gateway does not model rate limiting at all, so both
      // message types get the identical scripted response and land in the
      // same `evaluateCalls` log: every existing assertion against
      // `evaluateCalls` (the resolver's functionDeclaration, click's
      // DISPATCH_CLICK_SCRIPT, select's SELECT_SCRIPT, and so on) keeps
      // working unchanged, since those calls now arrive as
      // `page.evaluate.internal` rather than `page.evaluate`.
      case 'page.evaluate':
      case 'page.evaluate.internal': {
        this.evaluateCalls.push(msg);
        if (!id) break;
        const body = this.evaluateResponder?.(msg) ?? {
          t: 'page.evaluated',
          targetId: msg['targetId'],
          ok: true,
          resultType: 'value',
          value: null,
          sizeBytes: 4,
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'page.evaluated', rest);
        break;
      }
      case 'page.responsebody.get': {
        this.responseBodyCalls.push(msg);
        if (!id) break;
        const body = this.responseBodyResponder?.(msg) ?? {
          t: 'page.responsebody.got',
          targetId: msg['targetId'],
          requestId: msg['requestId'],
          body: 'fake body',
          base64Encoded: false,
          sizeBytes: 9,
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'page.responsebody.got', rest);
        break;
      }
      case 'page.a11y.get': {
        this.a11yCalls.push(msg);
        if (!id) break;
        const body = this.a11yResponder?.(msg) ?? {
          t: 'page.a11y.got',
          targetId: msg['targetId'],
          nodes: [],
          total: 0,
          truncated: false,
          marker: null,
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'page.a11y.got', rest);
        break;
      }
      case 'page.map.get': {
        this.pageMapCalls.push(msg);
        if (!id) break;
        const body = this.pageMapResponder?.(msg) ?? {
          t: 'page.map.got',
          targetId: msg['targetId'],
          epoch: 'epoch_1',
          nodes: [],
          total: 0,
          truncated: false,
          truncatedByReason: { offscreen: 0, onscreen: 0, unpositioned: 0 },
          degraded: { framesAttempted: 1, framesFailed: 0, failures: [], listeners: 'ok' },
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'page.map.got', rest);
        break;
      }
      case 'page.map.stamp': {
        this.pageMapStampCalls.push(msg);
        if (!id) break;
        const indices = (msg['indices'] as number[] | undefined) ?? [];
        const body = this.pageMapStampResponder?.(msg) ?? {
          t: 'page.map.stamped',
          targetId: msg['targetId'],
          results: indices.map((index) => ({ index, stamped: true })),
          marker: indices.length > 0 ? 'data-bgls-pm-fake' : null,
        };
        const { t: replyType, ...rest } = body as { t?: string } & Record<string, unknown>;
        this.reply(id, replyType ?? 'page.map.stamped', rest);
        break;
      }
      case 'upload.begin': {
        this.binaryCounter += 1;
        const binaryId = this.binaryCounter.toString(16).padStart(32, '0');
        const uploadId = msg['uploadId'] as string;
        const rec = {
          uploadId,
          binaryId,
          name: msg['name'] as string,
          declared: (msg['sizeBytes'] as number) ?? 0,
          chunks: [] as Uint8Array[],
        };
        this.uploadsByBinaryId.set(binaryId, rec);
        this.uploadsById.set(uploadId, rec);
        // A deliberately small `chunkBytes`, so a test with a few hundred
        // bytes still exercises the multi-frame path rather than always
        // fitting in one.
        if (id)
          this.reply(id, 'upload.accepted', {
            uploadId,
            chunkBytes: 64,
            maxInFlight: 4,
            binaryId,
            expiresAt: Date.now() + 300000,
          });
        break;
      }
      case 'upload.complete': {
        const uploadId = msg['uploadId'] as string;
        const rec = this.uploadsById.get(uploadId);
        if (!id) break;
        if (!rec) {
          this.reply(id, 'error', {
            code: 'bgls.error.upload.not_found',
            category: 'upload',
            message: 'no such upload',
            fatal: false,
            retryable: false,
          });
          break;
        }
        const received = rec.chunks.reduce((n, c) => n + c.byteLength, 0);
        if (received !== rec.declared) {
          this.reply(id, 'error', {
            code: 'bgls.error.upload.bad_offset',
            category: 'upload',
            message: `declared ${rec.declared}, received ${received}`,
            fatal: false,
            retryable: false,
          });
          break;
        }
        this.reply(id, 'upload.done', {
          uploadId,
          path: `bgls-upload://${uploadId}/${rec.name}`,
          sizeBytes: received,
        });
        break;
      }
      case 'upload.cancel': {
        this.cancelledUploads.push(msg['uploadId'] as string);
        break;
      }
      case 'files.set': {
        this.filesSetCalls.push(msg);
        if (!id) break;
        if (this.filesSetError !== null) {
          this.reply(id, 'error', {
            code: this.filesSetError,
            category: 'capture',
            message: 'no element matched',
            fatal: false,
            retryable: false,
          });
          break;
        }
        const ids = (msg['uploadIds'] as string[]) ?? [];
        this.reply(id, 'files.set.result', {
          targetId: msg['targetId'],
          selector: msg['selector'],
          files: ids.map((u) => this.uploadsById.get(u)?.name ?? u),
        });
        break;
      }
      case 'target.list': {
        if (id) this.reply(id, 'target.listed', { targets: [] });
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
      case 'instance.restart': {
        this.ws.simulateJson({
          v: 1,
          t: 'instance.recovered',
          re: id,
          ts: Date.now(),
          instanceId: msg['instanceId'],
          rung: 'R4',
          durationMs: 500,
          targetsPreserved: false,
          streamsResubscribed: [],
          streamsLost: [],
        });
        break;
      }
      case 'diagnostics.subscribe': {
        // Echoes back what was requested, defaulting the same way the
        // real wire message does (console and errors on, network off):
        // api-contract-diagnostics.md section 1.
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

  /**
   * Broadcasts preemption step 1 to the current holder.
   *
   * `reason` defaults to `'human_takeover'`, the value the DOCUMENTED
   * contract says a human takeover carries. As of this change the engine
   * hardcodes `'priority'` for every non-admin preemption and emits
   * `'human_takeover'` nowhere, so a test
   * that only ever passes the documented value would prove nothing about
   * the gateway agents actually connect to today. Tests therefore drive
   * BOTH: `'human_takeover'` for the contract, and `'priority'` with a
   * `human` requester in presence for what is really on the wire right
   * now.
   */
  sendPreemptRequest(
    targetId: string,
    opts: {
      byLabel: string;
      graceMs: number;
      deadlineInMs: number;
      reason?: 'priority' | 'force_claim' | 'human_takeover';
      byViewerId?: string;
    },
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'control.preempt.request',
      ts: Date.now(),
      targetId,
      leaseId: this.leaseId,
      byViewerId: opts.byViewerId ?? 'vwr_00000000000000000000000099',
      byLabel: opts.byLabel,
      reason: opts.reason ?? 'human_takeover',
      graceMs: opts.graceMs,
      deadline: Date.now() + opts.deadlineInMs,
    });
  }

  /**
   * Sends the SHARED-mode yield notice: a person driving a shared target
   * asking this agent to stand down while the other human holders keep
   * driving.
   *
   * Deliberately not a variant of {@link sendPreemptRequest}. The wire
   * message is a different one (`control.yield.request`), it carries a
   * free-text `reason` the requester typed rather than a member of the
   * preemption reason union, and no `control.preempted` ever follows it,
   * because nothing is being handed to a waiting requester.
   *
   * This driver exists because the client had NO case for this message at
   * all: it fell through `default: break`, so the agent was never told,
   * never shut its dispatch gate, and kept its lease until the engine
   * ended the tenure at `agentPreemptGraceMs`. Measured in the demo, a
   * takeover took 2008ms instead of the few milliseconds the preemption
   * path achieves, and the agent's next action threw `LEASE_NOT_HELD` at
   * the person who had just taken over.
   */
  sendYieldRequest(
    targetId: string,
    opts: {
      byLabel: string;
      graceMs: number;
      deadlineInMs: number;
      reason?: string;
      byViewerId?: string;
    },
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'control.yield.request',
      ts: Date.now(),
      targetId,
      leaseId: this.leaseId,
      byViewerId: opts.byViewerId ?? 'vwr_00000000000000000000000099',
      byLabel: opts.byLabel,
      graceMs: opts.graceMs,
      deadline: Date.now() + opts.deadlineInMs,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    });
  }

  /** Broadcasts preemption step 2: the lease is taken. */
  sendPreempted(
    targetId: string,
    opts: {
      byLabel: string;
      released: boolean;
      requeueAfterMs: number;
      reason?: 'priority' | 'force_claim' | 'human_takeover';
      byViewerId?: string;
    },
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'control.preempted',
      ts: Date.now(),
      targetId,
      leaseId: this.leaseId,
      byViewerId: opts.byViewerId ?? 'vwr_00000000000000000000000099',
      byLabel: opts.byLabel,
      reason: opts.reason ?? 'human_takeover',
      released: opts.released,
      lastDispatchedInputSeq: 0,
      mayRequeue: true,
      requeueAfterMs: opts.requeueAfterMs,
    });
    this.leaseId = null;
  }

  /** Broadcasts `control.preempt.cancelled`: the requester withdrew and the holder keeps the lease it never lost. */
  sendPreemptCancelled(
    targetId: string,
    reason: 'withdrawn' | 'requester_gone' | 'admin' = 'withdrawn',
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'control.preempt.cancelled',
      ts: Date.now(),
      targetId,
      leaseId: this.leaseId,
      reason,
    });
  }

  /** Broadcasts one `presence.state` roster. This is what `PreemptionRequest.byKind` and `ControlYieldEvent.human` resolve a requester's kind against. */
  sendPresence(
    viewers: Array<{ viewerId: string; label: string; kind: 'human' | 'agent' | 'service' }>,
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'presence.state',
      ts: Date.now(),
      viewers: viewers.map((v) => ({
        ...v,
        colour: '#888888',
        controlling: [],
        watching: [],
        idle: false,
        joinedAt: Date.now(),
      })),
    });
  }

  /** Broadcasts one `control.state` lease table. `holderViewerId: null` means the target is free, which is half of what `waitForResume()` waits for. */
  sendControlState(targetId: string, holder: { viewerId: string; label: string } | null): void {
    this.ws.simulateJson({
      v: 1,
      t: 'control.state',
      ts: Date.now(),
      leases: [
        {
          targetId,
          holderViewerId: holder?.viewerId ?? null,
          holderLabel: holder?.label ?? null,
          grantedAt: holder === null ? null : Date.now(),
          expiresAt: holder === null ? null : Date.now() + 60000,
          mode: 'exclusive',
          holders: holder === null ? [] : [{ viewerId: holder.viewerId, label: holder.label }],
          queue: [],
        },
      ],
    });
  }

  /** Broadcasts one `console.entry` for `targetId`, as if a page's `console.*` call had just been captured and forwarded (api-contract-diagnostics.md section 1). */
  sendConsoleEntry(
    targetId: string,
    entry: {
      level?: 'log' | 'info' | 'warn' | 'error' | 'debug';
      text: string;
      url?: string;
      line?: number;
    },
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'console.entry',
      ts: Date.now(),
      targetId,
      level: entry.level ?? 'log',
      text: entry.text,
      ...(entry.url !== undefined ? { url: entry.url } : {}),
      ...(entry.line !== undefined ? { line: entry.line } : {}),
    });
  }

  /** Broadcasts one `network.request` for `targetId`. */
  sendNetworkRequest(
    targetId: string,
    entry: { requestId?: string; method?: string; url: string; status?: number | null },
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'network.request',
      ts: Date.now(),
      targetId,
      requestId: entry.requestId ?? `req_${targetId}`,
      method: entry.method ?? 'GET',
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

  /**
   * Broadcasts one `network.summary` for `targetId`, including `inFlight`
   * (`packages/core/src/diagnostics/types.ts`'s `NetworkSummaryPayload.inFlight`).
   * `inFlight` is passed straight through as given, deliberately including
   * `undefined` when a test omits it: that is how this fake stands in for
   * a gateway whose own `network.summary` (`packages/protocol/src/wire/messages/diagnostics.ts`'s
   * `NetworkSummary`) has not yet been updated to carry the field at all,
   * which `AutomationClient.waitForNetworkIdle()`'s own doc says it must
   * tolerate rather than fabricate a value for.
   */
  sendNetworkSummary(
    targetId: string,
    opts: { inFlight?: number; requests?: number; failed?: number } = {},
  ): void {
    this.ws.simulateJson({
      v: 1,
      t: 'network.summary',
      ts: Date.now(),
      targetId,
      windowMs: 5000,
      requests: opts.requests ?? 0,
      failed: opts.failed ?? 0,
      bytesIn: 0,
      bytesOut: 0,
      slowest: [],
      ...(opts.inFlight !== undefined ? { inFlight: opts.inFlight } : {}),
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
