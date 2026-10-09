/**
 * Test harness for `packages/server/src/ws/**`'s conformance suite: a real
 * `node:http` server with `attachUpgrade` wired to the real
 * `completeHandshakeAndServe`, a real `TicketRegistry`/`TokenApiImpl`/
 * `SessionRegistry`, a real `@browserglass/store-sqlite` in-memory `Store`
 * (for real ticket redemption), and a real `ws` client helper.
 *
 * The one deliberate substitution: `SessionRegistry`'s factory does not go
 * through a real `BrowserRouter` (building router's own full test harness,
 * store/node-transport/profile-service fakes and all, belongs to router's
 * own suite and is out of proportion to this suite). Instead it
 * connects a real `CdpBridge` straight to a `FakeChromeServer` (a real,
 * listening WebSocket server speaking just enough CDP), exactly mirroring
 * `@browserglass/core`'s own test pattern
 * (`test/session/session.test.ts`'s `startFakeRegistry`) but over a genuine
 * socket. Everything downstream of "which Instance does this ticket/token
 * point at" (the WS upgrade, the `bgls.v1` message loop, `ManagedSession`,
 * `core.Session`, the real CDP socket) is real and exercised by a real
 * `ws` client.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { type Server as HttpServer, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type SessionControlOptions,
  createCdpBridge,
  createTargetRegistry,
} from '@browserglass/core';
import { type AppId, type Capability, type TenantId, newId } from '@browserglass/protocol';
import { createSqliteStore } from '@browserglass/store-sqlite';
import WebSocket from 'ws';
import {
  type AppSigningKey,
  InProcessJtiCache,
  TicketRegistry,
  TokenApiImpl,
  jwtAuthResolver,
} from '../../../src/auth/index.js';
import { generateEd25519KeyMaterial } from '../../../src/auth/jwt.js';
import { resolveConfig } from '../../../src/config/resolve.js';
import { type DownloadStore, createDownloadStore } from '../../../src/downloads/download-store.js';
import { type UploadStore, createUploadStore } from '../../../src/files/upload-store.js';
import { HookRegistry } from '../../../src/hooks/dispatch.js';
import { ManagedSession } from '../../../src/session/managed-session.js';
import { SessionRegistry } from '../../../src/session/registry.js';
import { ResumeStore } from '../../../src/wire/resume-store.js';
import type { ConnectionDeps } from '../../../src/ws/connection.js';
import { completeHandshakeAndServe } from '../../../src/ws/upgrade.js';
import {
  type FakeChromeServer,
  type FakeTargetInfo,
  startFakeChromeServer,
} from './fake-chrome-server.js';

/** One fully wired test gateway. */
export interface TestGateway {
  readonly httpServer: HttpServer;
  readonly url: string;
  readonly wsUrl: string;
  readonly connectionDeps: ConnectionDeps;
  /** The upload staging area this gateway's `upload.*` handlers write into, backed by a temp directory that `close()` removes. */
  readonly uploads: UploadStore;
  /** The completed-download staging area `ManagedSession.finalizeDownload` writes into, backed by a temp directory that `close()` removes. */
  readonly downloads: DownloadStore;
  /** The root `ManagedSession.startRecording()`'s `DiskRecordingSink` writes each recording's `<recordingId>/` subdirectory under, backed by a temp directory that `close()` removes. A test asserting on real on-disk recording output reads under here. */
  readonly recordingsDir: string;
  readonly sessionRegistry: SessionRegistry;
  readonly resumeStore: ResumeStore;
  readonly ticketRegistry: TicketRegistry;
  readonly tokenApi: TokenApiImpl;
  readonly signingKey: AppSigningKey;
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly chrome: FakeChromeServer;
  /**
   * Every line the session logger wrote, in order.
   *
   * The instrument for the drops that deliberately never reach the wire
   * (`queue_shed`, `rate_limited`, `dispatch_error`). Asserting on the log
   * is the only way to tell "reported at debug, as designed" from "still
   * silently discarded", which is exactly the distinction this whole change
   * is about.
   */
  readonly logLines: Array<{ level: string; message: string }>;
  readonly instanceId: string;
  /** Adds a target the fake Chrome endpoint will report. */
  addTarget(info: FakeTargetInfo): void;
  /** Mints a real, valid instance-scoped token for `viewerId`. */
  issueToken(opts?: { readonly caps?: string[]; readonly viewerId?: string }): Promise<string>;
  /** Opens a real `ws` client to this gateway's WS path. Offers `bgls.v1` by default. */
  connect(opts?: {
    readonly protocols?: string[];
    readonly headers?: Record<string, string>;
  }): WebSocket;
  close(): Promise<void>;
}

/** Builds and starts a {@link TestGateway} on an ephemeral loopback port. */
export async function startTestGateway(opts?: {
  /**
   * Threaded straight through to `ManagedSessionOptions.defaultNewWindow`.
   * The real `session/factory.ts` resolves this from `Instance.spec.isolation`
   * via `router.describe()`, which this harness's `SessionRegistry` factory
   * deliberately bypasses (see the module doc); a test exercising the
   * default (rather than an explicit per-call `newWindow`) sets this
   * directly instead.
   */
  readonly defaultNewWindow?: boolean;
  /**
   * When set, the session factory throws this instead of building a real
   * `ManagedSession`. Stands in for `session/factory.ts`'s own
   * `BglsError('E_INSTANCE_WRONG_NODE')` throw when `router.driveInstance()`
   * resolves a foreign node: this harness's factory bypasses the real
   * router entirely (see the module doc above), so there is no other way
   * to reach `ws/connection.ts`'s `processHello` catch block with that
   * specific shape of failure.
   */
  readonly factoryError?: () => Error;
  /**
   * Threaded straight through to `ManagedSessionOptions.control`, and from
   * there to `core.Session`'s `SessionOptions.control`. The real path is
   * `ResolvedConfig.session.control` -> `packages/server/src/index.ts` ->
   * `createManagedSessionFactory`, which this harness deliberately bypasses
   * (see the module doc: the factory reaches a real `BrowserRouter`), so a
   * test that needs shared control sets it here instead.
   */
  readonly control?: SessionControlOptions;
  /** Threaded straight through to `DownloadStoreOptions.maxBytes`. A test exercising `E_DOWNLOAD_TOO_LARGE` sets this small rather than staging a genuinely huge file. */
  readonly downloadMaxBytes?: number;
  /** Threaded straight through to `DownloadStoreOptions.urlTtlMs`. A test exercising `bgls.error.download.expired` sets this small rather than waiting out the real 60s default. */
  readonly downloadUrlTtlMs?: number;
  /** Maps the harness's own temp directory to the root the download store is given. A test uses it to point the store at a directory that does not exist yet, or at a path that cannot be created, without the harness creating it first. The temp directory itself is still the thing `close()` removes. */
  readonly downloadRoot?: (tempDir: string) => string;
  /**
   * Threaded straight through to `HookRegistry`'s own `globalTimeoutMs`.
   * Default 5000ms, matching every existing hook test in this suite. A
   * test exercising a hook's FAIL-CLOSED timeout behaviour (`onDownload`,
   * `onRequest`, `hooks/types.ts`'s `HOOK_TIMEOUTS`) sets this small
   * instead of a handler actually sleeping out the real per-hook default:
   * `HookRegistry.dispatch` uses `globalTimeoutMs` in place of the per-hook
   * value whenever it is greater than zero, so this shortens the wait
   * without touching which hooks fail open versus closed, which is
   * `HOOK_TIMEOUTS` alone, untouched by this option.
   */
  readonly hookTimeoutMs?: number;
  /**
   * Threaded straight through to `SessionRegistry`'s own constructor
   * (`session/registry.ts`). Default (omit this) is that constructor's
   * own default, 120,000ms, matching production and keeping every
   * existing resume test in this suite realistic (a session must outlive
   * a resume attempt). A test exercising eviction ITSELF
   * (`test/session/registry-onidle-eviction.test.ts`) sets this small
   * instead of a real test waiting out two full minutes.
   */
  readonly noViewerGraceMs?: number;
  /**
   * Threaded straight through to `ManagedSessionOptions.stealthActive`. The
   * real path is `session/factory.ts` resolving `view.instance.spec.stealth
   * !== 'off'` from a real `BrowserRouter.describe()`, which this harness's
   * factory closure deliberately bypasses (see the module doc: no real
   * router here), so a test exercising the diagnostics stealth-conflict
   * gate (`ManagedSession.subscribeDiagnostics`) sets this directly instead.
   * Default `false`, matching `ManagedSessionOptions.stealthActive`'s own
   * default.
   */
  readonly stealthActive?: boolean;
}): Promise<TestGateway> {
  const tenantId = newId('ten') as TenantId;
  const appId = newId('app') as AppId;
  const instanceId = newId('inst');
  const keyMaterial = generateEd25519KeyMaterial();
  const signingKey: AppSigningKey = {
    kid: 'test-key',
    alg: 'EdDSA',
    publicKey: keyMaterial.publicKey,
    privateKey: keyMaterial.privateKey,
    status: 'active',
  };

  const store = await createSqliteStore(':memory:', { memory: true });
  await store.createTenant({ id: tenantId, name: 'Test Tenant' });
  await store.createApp({ id: appId, tenantId, name: 'Test App' });

  const resolved = resolveConfig({
    // 'embedded' (not 'gateway'): this harness needs `store` for real ticket
    // redemption, and 'gateway' mode forbids a locally owned store. This
    // suite never calls `start()`/`router.acquire()` (see the module doc:
    // `SessionRegistry`'s factory bypasses the router entirely), so the
    // `runtimes`/`profiles.fs` values below are never actually invoked;
    // they exist only to satisfy `resolveConfig`'s embedded-mode presence
    // check.
    mode: 'embedded',
    tenantId,
    appId,
    store,
    runtime: {} as unknown as import('@browserglass/protocol').BrowserRuntime,
    profiles: { fs: {} as unknown as import('@browserglass/protocol').ProfileFs },
    auth: { keys: [signingKey], issuer: appId },
  });

  const jtiCache = new InProcessJtiCache(resolved.auth.jtiCacheSize);
  const resolver = jwtAuthResolver({
    keys: resolved.auth.keys,
    tenantId: resolved.tenantId,
    appId: resolved.appId,
    issuer: resolved.auth.issuer,
    clockSkewSeconds: resolved.auth.clockSkewSeconds,
    jtiCache,
    store: resolved.store,
  });
  const resolvedWithAuth = { ...resolved, auth: { ...resolved.auth, resolver } };

  const tokenApi = new TokenApiImpl({
    keys: resolved.auth.keys,
    defaultTtlSeconds: resolved.auth.defaultTtlSeconds,
    maxTtlSeconds: resolved.auth.maxTtlSeconds,
    maxCaps: resolved.auth.maxCaps,
    tenantAllowedCaps: resolved.auth.maxCaps,
    store: resolved.store,
    clock: { now: () => Date.now() },
    tenantId: resolved.tenantId,
    appId: resolved.appId,
    issuer: resolved.auth.issuer,
    clockSkewSeconds: resolved.auth.clockSkewSeconds,
    jtiCache,
  });

  const ticketRegistry = new TicketRegistry();
  const resumeStore = new ResumeStore();
  const hooks = new HookRegistry(undefined, {
    globalTimeoutMs: opts?.hookTimeoutMs ?? 5000,
    logger: resolvedWithAuth.logger.sink ?? noopLogger(),
  });

  const chrome = await startFakeChromeServer();

  const logLines: Array<{ level: string; message: string }> = [];
  /** Records instead of printing, so a test can assert on what was reported and a noisy `warn` does not drown the run's output. */
  const captureLogger = {
    trace: (_f: unknown, m: string) => logLines.push({ level: 'trace', message: m }),
    debug: (_f: unknown, m: string) => logLines.push({ level: 'debug', message: m }),
    info: (_f: unknown, m: string) => logLines.push({ level: 'info', message: m }),
    warn: (_f: unknown, m: string) => logLines.push({ level: 'warn', message: m }),
    error: (_f: unknown, m: string) => logLines.push({ level: 'error', message: m }),
  } as never;

  // A real `DownloadStore` on a temp directory, mirroring `uploadRoot`
  // below exactly (built before `sessionRegistry`, since the factory
  // closure needs it, matching `packages/server/src/index.ts`'s own
  // ordering for the real gateway). No sweep timer, so a suite using fake
  // timers never has one firing underneath it.
  const downloadRoot = mkdtempSync(join(tmpdir(), 'bgls-ws-download-'));
  const downloads = createDownloadStore({
    root: opts?.downloadRoot !== undefined ? opts.downloadRoot(downloadRoot) : downloadRoot,
    logger: resolvedWithAuth.logger.sink ?? noopLogger(),
    sweepIntervalMs: 0,
    ...(opts?.downloadMaxBytes !== undefined ? { maxBytes: opts.downloadMaxBytes } : {}),
    ...(opts?.downloadUrlTtlMs !== undefined ? { urlTtlMs: opts.downloadUrlTtlMs } : {}),
  });

  // Recordings root, same shape as `downloadRoot` immediately above: a
  // real temp directory `DiskRecordingSink` writes into, not a stub,
  // since the recording suite asserts on real on-disk output. No store
  // object the way `downloads` gets one, because `startRecording` needs
  // only the directory; see `session/factory.ts`'s own comment for why.
  const recordingsDir = mkdtempSync(join(tmpdir(), 'bgls-ws-recording-'));

  const sessionRegistry = new SessionRegistry(async (reqInstanceId, ctx) => {
    if (opts?.factoryError) throw opts.factoryError();
    const bridge = createCdpBridge(reqInstanceId as never);
    await bridge.connect({ url: chrome.url });
    const registry = createTargetRegistry(reqInstanceId as never, bridge);
    await registry.start();
    // `hooks` is the same `HookRegistry` `connectionDeps.hooks` uses (built
    // below, before this closure runs; a plain `const` a few lines down,
    // captured here the same way `chrome`/`captureLogger` already are), so
    // a test that registers `onRecovery` (or any other hook) against
    // `gw.connectionDeps.hooks` sees BOTH the WS-level dispatches
    // (`ws/connection.ts` reads `deps.hooks`) and `ManagedSession`'s own
    // (`dispatchEffect`'s `fireRecovery`, `session/managed-session.ts`)
    // through one registry, exactly as `src/index.ts` wires the real
    // gateway. Omitted before this, `ManagedSession` had no `hooks` at all
    // here, so `onRecovery` could never fire in this harness regardless of
    // what a test registered.
    // `onIdle: ctx.onIdle`, matching the real factory (`session/factory.ts`):
    // without it this harness's `SessionRegistry` could never actually
    // evict a session, the same gap `registry.ts`'s `onIdle` wiring fixes
    // for the real gateway, and no WS level test could observe eviction.
    return new ManagedSession({
      instanceId: reqInstanceId,
      sessionId: newId('sess'),
      tenantId: ctx.tenantId,
      appId: ctx.appId,
      nodeId: 'nod_test',
      bridge,
      registry,
      defaultNewWindow: opts?.defaultNewWindow,
      stealthActive: opts?.stealthActive ?? false,
      logger: captureLogger,
      hooks,
      downloadStore: downloads,
      downloadDir: downloads.root,
      recordingsDir,
      onIdle: ctx.onIdle,
      ...(opts?.control ? { control: opts.control } : {}),
    });
  }, opts?.noViewerGraceMs);

  // A real `UploadStore` on a temp directory, not a stub: the `upload.*`
  // handlers are being tested for what they do to disk, and `close()`
  // takes the whole root away again. No sweep timer, so a suite using fake
  // timers never has one firing underneath it.
  const uploadRoot = mkdtempSync(join(tmpdir(), 'bgls-ws-upload-'));
  const uploads = createUploadStore({
    root: uploadRoot,
    logger: resolvedWithAuth.logger.sink ?? noopLogger(),
    sweepIntervalMs: 0,
  });

  const connectionDeps: ConnectionDeps = {
    resolved: resolvedWithAuth,
    sessionRegistry,
    resumeStore,
    ticketRegistry,
    tokenApi,
    hooks,
    logger: resolvedWithAuth.logger.sink ?? noopLogger(),
    uploads,
  };

  /** Every client socket `connect()` handed out, so `close()` can terminate the ones a failing test never closed. */
  const opened: WebSocket[] = [];

  const httpServer = createServer((req, res) => {
    res.writeHead(404).end();
  });

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== resolved.wsPath) {
      socket.destroy();
      return;
    }
    const offered = (req.headers['sec-websocket-protocol'] ?? '')
      .toString()
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (!offered.includes('bgls.v1')) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }
    completeHandshakeAndServe(req, socket, head, offered, connectionDeps);
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const url = `http://127.0.0.1:${port}`;
  const wsUrl = `ws://127.0.0.1:${port}${resolved.wsPath}`;

  return {
    httpServer,
    url,
    wsUrl,
    connectionDeps,
    uploads,
    downloads,
    recordingsDir,
    sessionRegistry,
    resumeStore,
    ticketRegistry,
    tokenApi,
    signingKey,
    tenantId,
    appId,
    chrome,
    logLines,
    instanceId,
    addTarget(info) {
      chrome.targetInfos.push(info);
    },
    async issueToken(opts) {
      const caps = (opts?.caps ?? [
        'view',
        'control',
        'navigate',
        'tabs.manage',
        'capture',
        'probe',
        'admin',
      ]) as Capability[];
      return tokenApi.issue({
        sub: opts?.viewerId ?? newId('vwr'),
        caps,
        scope: { kind: 'instance', instanceId, targets: '*' },
        tenantId,
        appId,
        ttlSeconds: 300,
        ...(caps.includes('admin' as Capability) ? { iUnderstandAdmin: true } : {}),
      });
    },
    connect(opts) {
      const protocols = opts?.protocols ?? ['bgls.v1'];
      const ws = new WebSocket(
        wsUrl,
        protocols,
        opts?.headers ? { headers: opts.headers } : undefined,
      );
      // Attach the message queue immediately, before any message could
      // possibly arrive, so `nextMessage`/`nextBinary` never race a fast
      // server reply against a not-yet-registered listener.
      queueFor(ws);
      // Remembered so `close()` can tear down a socket the test never got
      // to close itself; see `close()`'s own comment.
      opened.push(ws);
      return ws;
    },
    async close() {
      await uploads.dispose();
      try {
        rmSync(uploadRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best effort; a leftover temp directory is untidy, never wrong.
      }
      await downloads.dispose();
      try {
        rmSync(downloadRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Same reasoning as `uploadRoot`'s own cleanup immediately above.
      }
      try {
        rmSync(recordingsDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Same reasoning as `uploadRoot`'s own cleanup immediately above.
      }
      // Dispose every live `ManagedSession` (closing its `CdpBridge`
      // connection to the fake Chrome server) before tearing the servers
      // down: `WebSocketServer.close()`'s callback (and, via it,
      // `http.Server.close()`'s) does not fire until every open connection
      // has ended, so a still-open `CdpBridge` socket would hang this
      // teardown forever.
      sessionRegistry.disposeAll();
      // Force every client socket this gateway handed out to close, whether
      // the test closed it or not.
      //
      // This is what made a FAILING test look like a HANGING one. `close()`
      // runs from an `afterEach` or a `finally`, so it runs after an
      // assertion has thrown, and an assertion that throws skips the
      // `ws.close()` at the end of the test body. `http.Server.close()` does
      // not invoke its callback until every open connection has ended, so
      // the teardown then waited forever and vitest reported a timeout for
      // the whole test. The real assertion error was never printed, and the
      // failure read as "this test hangs" rather than "this expectation was
      // wrong", which cost real debugging time.
      for (const ws of opened) {
        try {
          ws.terminate();
        } catch {
          // Already closed, or never opened. Teardown must not itself throw.
        }
      }
      opened.length = 0;
      await chrome.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

function noopLogger() {
  const fn = () => undefined;
  const err = (meta: unknown, msg: string) => {
    // eslint-disable-next-line no-console
    console.error('[test-gateway]', msg, meta);
  };
  return { trace: fn, debug: fn, info: fn, warn: err, error: err } as never;
}

/** Waits for `ws` to reach the `open` state, or rejects on `error`/`close`. */
export function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === ws.OPEN) {
      resolve();
      return;
    }
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`unexpected response: ${res.statusCode}`)),
    );
  });
}

/**
 * A persistent, in-order queue of every message `ws` has received since
 * this queue was created, split into two independent streams (control
 * messages and binary frames): a real server interleaves them freely (a
 * forced keyframe can arrive before or after the `stream.subscribed` that
 * triggered it), and a naive single shared queue whose `nextMessage()`
 * skips past a not-yet-wanted binary frame would permanently discard it
 * rather than leave it for a later `nextBinary()` call. Attaching a fresh
 * one-shot listener per call (the other naive approach) loses messages
 * that arrive in the gap between two `await`s, since `ws`'s `message`
 * event has no replay buffer of its own; this queue is created once,
 * immediately, so nothing is ever missed regardless of how quickly the
 * server replies.
 */
export class MessageQueue {
  private readonly bufferedText: Record<string, unknown>[] = [];
  private readonly bufferedBinary: Buffer[] = [];
  private readonly textWaiters: Array<(v: Record<string, unknown>) => void> = [];
  private readonly binaryWaiters: Array<(v: Buffer) => void> = [];

  constructor(ws: WebSocket) {
    ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
      if (isBinary) {
        const buf = data as Buffer;
        const waiter = this.binaryWaiters.shift();
        if (waiter) waiter(buf);
        else this.bufferedBinary.push(buf);
      } else {
        const value = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
        const waiter = this.textWaiters.shift();
        if (waiter) waiter(value);
        else this.bufferedText.push(value);
      }
    });
  }

  /** Waits for the next queued JSON control message. */
  async nextMessage(): Promise<Record<string, unknown>> {
    const queued = this.bufferedText.shift();
    if (queued) return queued;
    return new Promise((resolve) => this.textWaiters.push(resolve));
  }

  /** Waits for the next queued binary frame. */
  async nextBinary(): Promise<Buffer> {
    const queued = this.bufferedBinary.shift();
    if (queued) return queued;
    return new Promise((resolve) => this.binaryWaiters.push(resolve));
  }
}

const queues = new WeakMap<WebSocket, MessageQueue>();

function queueFor(ws: WebSocket): MessageQueue {
  let q = queues.get(ws);
  if (!q) {
    q = new MessageQueue(ws);
    queues.set(ws, q);
  }
  return q;
}

/** Waits for the next parsed JSON control message from `ws`. Backed by a persistent per-socket {@link MessageQueue}, created (and start listening) on first use, so call this at least once before any message you care about could arrive, or use `queueFor(ws)` directly right after `connect()`. */
export function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return queueFor(ws).nextMessage();
}

/**
 * Like {@link nextMessage}, but discards any leading message whose `t` is
 * in `skip` before returning. `ManagedSession.broadcastPresence()` sends an
 * unprompted `presence.state` immediately after every fresh or resumed
 * `welcome`/`resumed`, which
 * lands in the same queue as whatever a test is actually asserting on next;
 * tests that care about exact adjacency (the next reply to a specific
 * request, a specific `sq`) should read through this rather than assume
 * `welcome` is the last thing a connection sends unprompted.
 */
export async function nextMessageSkipping(
  ws: WebSocket,
  skip: readonly string[],
): Promise<Record<string, unknown>> {
  for (;;) {
    const msg = await nextMessage(ws);
    if (!skip.includes(msg['t'] as string)) return msg;
  }
}

/** Waits for the next binary frame from `ws`. See {@link nextMessage}'s queueing note. */
export function nextBinary(ws: WebSocket): Promise<Buffer> {
  return queueFor(ws).nextBinary();
}

/** Waits for `ws` to close, resolving with `{code, reason}`. */
export function waitClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
  });
}
