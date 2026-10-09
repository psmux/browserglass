import { randomUUID } from 'node:crypto';
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import type { AuthResolver, Principal, Scope } from '@browserglass/protocol';
import type { BrowserRouter, LiveViewerPort } from '@browserglass/router';
import { systemClock } from '@browserglass/router';
import {
  InProcessJtiCache,
  TicketRegistry,
  TokenApiImpl,
  principalFromClaims as buildPrincipalFromClaims,
  jwtAuthResolver,
  principalFor as resolvePrincipalFor,
} from './auth/index.js';
import type { TokenApi } from './auth/types.js';
import { loggerFor, resolveConfig } from './config/resolve.js';
import type { BrowserGlassConfig, ResolvedConfig } from './config/types.js';
import { createDownloadStore } from './downloads/download-store.js';
import { createUploadStore } from './files/upload-store.js';
import { HookRegistry } from './hooks/dispatch.js';
import type { HookName, Hooks } from './hooks/types.js';
import type { PreflightDetectors } from './lifecycle/preflight.js';
import { runStart } from './lifecycle/start.js';
import { runStop } from './lifecycle/stop.js';
import {
  LifecycleError,
  type StartReport,
  type StopOptions,
  type StopReport,
} from './lifecycle/types.js';
import type { RouterWiring } from './lifecycle/wiring.js';
import { dispatchRest } from './rest/router.js';
import { handleCdpDiscovery } from './rest/routes/cdp-discovery.js';
import type { RestContext } from './rest/types.js';
import {
  type SessionApi,
  SessionRegistry,
  createLocalNodeActionExecutor,
  createManagedSessionFactory,
  createRestCdpSender,
  createRestSessionDriver,
  createSessionApi,
} from './session/index.js';
import { compact } from './util/compact.js';
import { ResumeStore, buildGoodbye } from './wire/index.js';
import {
  type CdpProxyDeps,
  type ConnectionDeps,
  type PeerUpgradeDeps,
  checkUpgradeOrigin,
  completeHandshakeAndServe,
  handleCdpUpgrade,
  handlePeerUpgrade,
  shouldHandleCdpUpgrade,
  shouldHandlePeerUpgrade,
} from './ws/index.js';

export * from './adapters/index.js';
export * from './auth/index.js';
export * from './config/index.js';
export * from './downloads/index.js';
export * from './files/index.js';
export * from './hooks/index.js';
export * from './lifecycle/index.js';
export * from './rest/index.js';
export * from './session/index.js';
export * from './wire/index.js';
export * from './ws/index.js';

/** Options accepted by {@link BrowserGlass.attachUpgrade}. */
export interface UpgradeOptions {
  readonly path?: string;
  readonly aliases?: readonly string[];
  readonly checkOrigin?: boolean;
}

/**
 * The object `createBrowserGlass` returns. `attachUpgrade`/`upgrade`/
 * `shouldHandleUpgrade`/`handleUpgrade`/`attach` are the WebSocket extension point:
 * this build claims the socket, negotiates the `bgls.v1` subprotocol,
 * checks Origin and the four-carrier credential precedence, and runs the
 * full `bgls.v1` message loop (`src/{ws,session,wire}/**`).
 */
export interface BrowserGlass {
  readonly config: ResolvedConfig;
  readonly state: 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';

  start(): Promise<StartReport>;
  stop(opts?: StopOptions): Promise<StopReport>;

  attachUpgrade(server: HttpServer | HttpsServer, opts?: UpgradeOptions): () => void;
  shouldHandleUpgrade(req: IncomingMessage): boolean;
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  upgrade(opts?: UpgradeOptions): (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  attach(server: HttpServer | HttpsServer, opts?: UpgradeOptions): () => void;

  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  rest(): (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void;
  fetch(request: Request, ctx?: { readonly remoteAddress?: string }): Promise<Response>;

  principalFor(req: IncomingMessage): Promise<Principal>;
  principalFromClaims(
    claims: Partial<Principal> & {
      readonly tenantId: string;
      readonly appId: string;
      readonly sub: string;
    },
  ): Principal;

  readonly router: BrowserRouter | undefined;
  readonly tokens: TokenApi;
  /** `bg.sessions`: live, in-process session inspection and moderation. */
  readonly sessions: SessionApi;

  on<K extends HookName>(name: K, fn: NonNullable<Hooks[K]>): () => void;
}

const activeUpgradePaths = new WeakMap<HttpServer | HttpsServer, Map<string, () => void>>();

/**
 * Assembles the real `@browserglass/server` gateway: config resolution,
 * the fixed lifecycle order, the live REST subset, auth (EdDSA tokens,
 * tickets, capability enforcement), and hook dispatch. Reads the
 * environment exactly once, here, and performs no I/O until `start()`.
 */
export function createBrowserGlass(config: BrowserGlassConfig): BrowserGlass {
  const resolved = resolveConfig(config);
  const logger = loggerFor(resolved);

  const jtiCache = new InProcessJtiCache(resolved.auth.jtiCacheSize);
  const ticketRegistry = new TicketRegistry();

  const defaultResolver: AuthResolver | undefined =
    resolved.auth.resolver ??
    (resolved.auth.keys.length > 0
      ? jwtAuthResolver(
          compact({
            keys: resolved.auth.keys,
            tenantId: resolved.tenantId,
            appId: resolved.appId,
            issuer: resolved.auth.issuer,
            clockSkewSeconds: resolved.auth.clockSkewSeconds,
            jtiCache,
            store: resolved.store,
          }),
        )
      : undefined);

  const tokenApi = new TokenApiImpl({
    keys: resolved.auth.keys,
    defaultTtlSeconds: resolved.auth.defaultTtlSeconds,
    maxTtlSeconds: resolved.auth.maxTtlSeconds,
    maxCaps: resolved.auth.maxCaps,
    tenantAllowedCaps: resolved.auth.maxCaps,
    ...compact({ store: resolved.store }),
    clock: { now: () => Date.now() },
    tenantId: resolved.tenantId,
    appId: resolved.appId,
    issuer: resolved.auth.issuer,
    clockSkewSeconds: resolved.auth.clockSkewSeconds,
    jtiCache,
  });

  const hookRegistry = new HookRegistry(resolved.hooks, {
    globalTimeoutMs: resolved.hooks.timeoutMs,
    logger,
  });

  let state: BrowserGlass['state'] = 'created';
  let accepting = true;
  let ready = false;
  let wiring: RouterWiring | undefined;
  let startPromise: Promise<StartReport> | undefined;
  let stopped = false;

  // Built before `restContext` (unlike the rest of that object's fields,
  // which are simple values or closures over `wiring`) because `restContext.driver`/`.cdp`
  // are built directly over it: `RestSessionDriver`/`RestCdpSender`
  // (`session/rest-driver.ts`) resolve a request's `sessionId` against
  // `SessionRegistry.all()`, the same live pool `ws/connection.ts`'s own
  // `getOrCreate` populates.
  const resumeStore = new ResumeStore();

  // Built before `sessionRegistry`, unlike `uploadStore` below (which
  // nothing upstream of it needs): `createManagedSessionFactory` hands
  // this straight to every `ManagedSession` it builds, so
  // `dispatchEffect`'s `download.completed` case
  // (`session/managed-session.ts`) has somewhere to hash, contain, and
  // mint a signed URL for a finished download the moment one arrives, not
  // only once REST wiring further down happens to exist. See
  // `downloads/download-store.ts`'s module doc for the full design.
  const downloadStore = createDownloadStore({
    root: resolved.downloads.dir,
    logger,
    maxBytes: resolved.limits.downloadMaxBytes,
    urlTtlMs: resolved.limits.downloadUrlTtlMs,
    publicUrl: resolved.publicUrl,
    basePath: resolved.basePath,
  });

  // `resolved.session.control` is threaded in here, at the one place that
  // holds both the resolved config and the factory. It was resolved and
  // then read by nothing at all before this, which is why
  // `session.control.mode` could be set, accepted, and silently ignored,
  // leaving shared control inert end to end. Only `mode` is currently
  // carried across; see `config/resolve.ts` for the four sibling keys that
  // are still resolved and unused, and why threading them is a behaviour
  // decision rather than plumbing.
  const sessionRegistry = new SessionRegistry(
    createManagedSessionFactory(
      () => wiring,
      logger,
      { mode: resolved.session.control.mode },
      hookRegistry,
      { store: downloadStore, dir: resolved.downloads.dir },
      // `RuntimeConfig.stealthProfiles`, resolved once and handed to the
      // one place that builds a `TargetRegistry`. Until this was threaded,
      // `session/factory.ts` passed three arguments to a four argument
      // constructor and a registered profile's `initScripts`/
      // `onTargetAttached` were resolved by `runtime-host` and then never
      // applied to anything. Empty for every deployment that runs at
      // `stealth: 'off'`, which is the only level enabled by default.
      resolved.stealthProfiles,
      // `resolved.recordings.dir`: where `ManagedSession.startRecording()`'s
      // `DiskRecordingSink` (`recording/disk-recording-sink.ts`) writes.
      // No separate store object the way `downloadStore` is: a recording
      // has no signed-URL retrieval path yet, only start/stop/
      // list, so there is nothing beyond the directory for this factory
      // to hand `ManagedSession`.
      { dir: resolved.recordings.dir },
    ),
    // `resolved.sessionLimits.noViewerTimeoutMs`: how long a session with
    // no connections is kept alive before `SessionRegistry.evict()` runs
    // (its own doc comment explains why a resuming viewer needs the
    // window). Resolved since `config/resolve.ts` already existed (default
    // 120s, matching `resumeWindowMs`'s own default) but was never read by
    // anything until this fix wired `onIdle` up at all.
    resolved.sessionLimits.noViewerTimeoutMs,
  );
  const sessionApi = createSessionApi(sessionRegistry);
  // The real `NodeActionExecutor` `lifecycle/wiring.ts`'s `LocalNode` needs
  // to answer a peer's `dispatch` request for real (`session/node-action-executor.ts`'s
  // own doc: before this, `LocalNode` was always built with `actions`
  // unset). Built here, over `sessionRegistry` above, and threaded into
  // `start()`'s `runStart` call below: `buildRouterWiring` cannot reach
  // this process's `SessionRegistry` on its own (it is built by this
  // function, one layer up from `lifecycle/**`), and `LocalNode` has no
  // way to receive it after construction.
  const nodeActionExecutor = createLocalNodeActionExecutor(sessionRegistry);

  // The real `LiveViewerPort` `BrowserRouter`'s viewer aware `release()`
  // reads, threaded down the same path as `nodeActionExecutor` above and
  // for the same reason: the router package holds no viewer sockets, so it
  // cannot count them and must not pretend to. Left uninjected it uses a
  // constant zero, which means a release always terminates and a second
  // tab watching the same browser loses it out from under itself.
  //
  // `ManagedSession.viewerCount` is `connections.size`, and `connections`
  // is written in exactly three places: `attachViewer` and `resumeViewer`
  // set an entry when a viewer socket completes its hello, and
  // `detachViewer` deletes it, called from `ws/connection.ts`'s
  // `onSocketClosed`. It moves with real sockets, unlike the several
  // viewer signals in this codebase that are permanently zero.
  //
  // Zero for an instance with no `ManagedSession` is a deliberate choice,
  // not an accident of `?? 0`. Two reasons. First, a session exists in
  // this process exactly when a viewer socket is attached to that
  // instance through this gateway, so no session genuinely means no
  // viewer here. Second, and decisive: `SessionRegistry` evicts a session
  // once it reports `onIdle`, which fires the moment its last connection
  // closes. That is precisely the instant a closing tab's release request
  // arrives, so any non zero fallback would make an ordinary release
  // report `detached` forever and nothing would ever be torn down. The
  // honest limitation is that this count covers THIS process only: a
  // multi gateway deployment where another gateway holds viewers for the
  // same instance would read zero here, and the port's shape (a number,
  // with no way to say "unknown") gives no way to express that.
  const liveViewers: LiveViewerPort = {
    countFor: (instanceId) => sessionRegistry.get(instanceId)?.viewerCount ?? 0,
  };

  // The upload staging area, built here and shared by BOTH on-ramps: the
  // `/v1/upload/*` REST routes and the socket's `upload.*` messages write
  // into the same store, so a file staged over HTTP can be attached over
  // the socket and the other way round. One store per gateway process,
  // because it owns a directory and removes it on `stop()`.
  const uploadStore = createUploadStore({
    root: resolved.uploads.dir,
    logger,
    maxUploadBytes: resolved.limits.uploadMaxBytes,
    stagingTtlMs: resolved.uploads.stagingTtlMs,
    retentionMs: resolved.uploads.retentionMs,
    maxConcurrent: resolved.uploads.maxConcurrent,
    maxTotalBytes: resolved.uploads.maxTotalBytes,
  });

  const restContext: RestContext = {
    config: resolved,
    getRouter: () => wiring?.router,
    store: resolved.store,
    tokens: tokenApi,
    resolver: defaultResolver,
    hooks: hookRegistry,
    logger,
    isAccepting: () => accepting,
    isReady: () => ready,
    // Both driving surfaces need the same `getRouter` closure `getRouter`
    // below reads from `wiring`: a non local `DrivingContext` forwards
    // through `BrowserRouter.dispatchAction`, which is unreachable until
    // `start()` resolves `wiring`, exactly the reason `restContext.getRouter`
    // itself is a closure and not a plain field.
    driver: createRestSessionDriver(sessionRegistry, () => wiring?.router, uploadStore),
    cdp: createRestCdpSender(sessionRegistry, () => wiring?.router),
    uploads: uploadStore,
    downloads: downloadStore,
    // `routes/presence.ts`'s `GET /v1/instances/:instanceId/viewers`: the
    // same live registry `driver`/`cdp`/`sessionApi` are already built
    // over, threaded onto `RestContext` directly (see that field's own
    // doc comment on `rest/types.ts`).
    sessionRegistry,
  };

  // `defaultResolver` is merged into `restContext.resolver` above, but the
  // raw `resolved` object itself carries whatever `config.auth.resolver`
  // was explicitly given (often nothing). `ws/connection.ts` reads its
  // resolver from `deps.resolved.auth.resolver`, not from a separate
  // field, so without this same merge every WS bearer token connection
  // closes immediately with "No AuthResolver is configured." unless a
  // caller supplies `auth.resolver` explicitly.
  const resolvedForConnections: ResolvedConfig = {
    ...resolved,
    auth: { ...resolved.auth, resolver: defaultResolver },
  };

  const connectionDeps: ConnectionDeps = {
    resolved: resolvedForConnections,
    sessionRegistry,
    resumeStore,
    ticketRegistry,
    tokenApi,
    hooks: hookRegistry,
    logger,
    uploads: uploadStore,
  };

  // The raw CDP attach proxy's own deps, built once and reused for every
  // upgrade. `resolver: defaultResolver`, not `resolved.auth.resolver`,
  // for the same reason `resolvedForConnections` above exists: an
  // explicit `config.auth.resolver` is rare, so without the merge this
  // path would read `undefined` and refuse every connection with
  // "no AuthResolver configured" whenever a caller supplied `auth.keys`
  // alone (`createBrowserGlass`'s own default resolver construction,
  // above). `getRouter` mirrors `restContext.getRouter` exactly: a
  // closure over `wiring`, since `wiring` is not populated until `start()`
  // resolves.
  const cdpProxyDeps: CdpProxyDeps = {
    enabled: resolved.security.cdpProxyEnabled,
    resolver: defaultResolver,
    allowQueryToken: resolved.auth.allowQueryToken,
    getRouter: () => wiring?.router,
    // The SAME `SessionRegistry` `ws/connection.ts`'s own `processHello`
    // resolves through (`connectionDeps.sessionRegistry`, built from this
    // same `sessionRegistry` above), so a raw CDP client attaching through
    // `handleCdpUpgrade` joins the identical `ManagedSession`, presence
    // roster, and `ControlLeaseEngine` pool any `bgls.v1` viewer of the
    // same instance already shares, rather than a side channel that
    // cannot see them. See `ws/cdp-upgrade.ts`'s own module doc for the
    // full argument.
    getManagedSession: (instanceId, ctx) => sessionRegistry.getOrCreate(instanceId, ctx),
    logger,
  };

  function normalizeWsPath(configuredPath: string | undefined): string {
    const raw = configuredPath ?? resolved.wsPath;
    if (!raw.startsWith('/')) {
      throw new LifecycleError(
        'E_UPGRADE_PATH_OUTSIDE_BASE',
        `Upgrade path "${raw}" must start with "/".`,
      );
    }
    if (resolved.basePath !== '/' && !raw.startsWith(resolved.basePath)) {
      throw new LifecycleError(
        'E_UPGRADE_PATH_OUTSIDE_BASE',
        `Upgrade path "${raw}" is not under basePath "${resolved.basePath}".`,
      );
    }
    return raw;
  }

  // Whether this process runs a peer listener at all: gated on
  // `peer.sharedSecret` alone (not `peer.dataPlaneUrl`), matching
  // `config/types.ts`'s `PeerConfig.dataPlaneUrl` doc: a node can accept
  // peer connections without ever advertising its own address (useful for
  // a node that only ever gets DIALED, never resolved by id elsewhere), so
  // the listener's own existence must not depend on whether this node
  // publishes a reachable URL.
  const peerEnabled = resolved.peer.sharedSecret !== null;

  /** Whether `req`'s URL targets this node's peer upgrade path. Folded into `shouldHandleUpgrade`/`handleUpgrade` below rather than exposed as a separate `bg.*` method pair: see `ws/peer-upgrade.ts`'s own top comment for why one claimed dispatch surface, recognising a second internal path, is the right shape here (an operator's `createUpgradeDispatcher`-style fallback chain keeps working unmodified). */
  function isPeerUpgrade(req: IncomingMessage): boolean {
    return peerEnabled && shouldHandlePeerUpgrade(req, resolved.peer.path);
  }

  /**
   * Whether `req`'s URL targets the CDP proxy path (`resolved.cdpProxyPath`),
   * checked by SHAPE alone, not by `security.cdpProxyEnabled`: this path is
   * claimed unconditionally (see `ResolvedConfig.cdpProxyPath`'s own doc
   * comment) so a disabled gateway still answers a matching upgrade with an
   * explicit 404 (`handleCdpUpgrade`'s own first check) instead of falling
   * through to whatever else an operator's `createUpgradeDispatcher`-style
   * chain claims next, which would make "disabled" indistinguishable from
   * "this gateway never had this feature at all".
   */
  function isCdpUpgrade(req: IncomingMessage): boolean {
    return shouldHandleCdpUpgrade(req, resolved.cdpProxyPath);
  }

  function shouldHandleUpgrade(req: IncomingMessage, wsPath?: string): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const target = wsPath ?? resolved.wsPath;
    return url.pathname === target || isPeerUpgrade(req) || isCdpUpgrade(req);
  }

  function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    opts?: UpgradeOptions,
  ): void {
    if (isPeerUpgrade(req)) {
      // Distinct concern from the viewer socket below: a peer connection
      // is server to server, not a browser tab, so none of the viewer
      // path's Origin check, subprotocol negotiation, or "always complete
      // the handshake, fail inside the message loop" policy (meant for a
      // bad VIEWER credential specifically) apply here. This
      // node's own readiness (`wiring` populated) and the operator having
      // configured a shared secret are both hard prerequisites for a peer
      // link to mean anything, so an upgrade that arrives before `start()`
      // has resolved `wiring`, or with no shared secret configured despite
      // `isPeerUpgrade` matching (unreachable today: `isPeerUpgrade` itself
      // is gated on `peerEnabled`, kept as a second, independent guard
      // rather than trusting that gate alone), fails the HTTP upgrade
      // outright rather than opening a socket only to immediately refuse
      // whatever arrives on it.
      const sharedSecret = resolved.peer.sharedSecret;
      if (sharedSecret === null || wiring === undefined) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }
      handlePeerUpgrade(req, socket, head, {
        selfNodeId: wiring.nodeId,
        nodeTransport: wiring.nodeTransport,
        sharedSecret,
        clock: systemClock,
        logger,
      });
      return;
    }

    if (isCdpUpgrade(req)) {
      // A third distinct concern, alongside the peer path above and the
      // viewer path below: a raw CDP client speaks Chrome's own wire
      // format, not `bgls.v1`, and authenticates via a capability-gated
      // `?token=` rather than a `hello.auth` frame, so it shares none of
      // either sibling's handshake. `handleCdpUpgrade` owns every check
      // (the `enabled` gate, auth, the `cdp` capability, `driveInstance`,
      // and the outbound connect to the real browser) and every refusal
      // shape; nothing here duplicates them.
      handleCdpUpgrade(req, socket, head, resolved.cdpProxyPath, cdpProxyDeps);
      return;
    }

    const checkOrigin = opts?.checkOrigin ?? true;
    if (checkOrigin) {
      const originResult = checkUpgradeOrigin(req, resolved.security.allowedOrigins);
      if (!originResult.allowed) {
        const body = originResult.message ?? 'Origin not allowed.';
        socket.write(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        socket.destroy();
        return;
      }
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

    // From here on the WS handshake always completes: a bad credential, a dead session, or any other
    // problem discovered afterward is answered inside the `bgls.v1` message
    // loop with `error` plus a close, never an HTTP failure.
    completeHandshakeAndServe(req, socket, head, offered, connectionDeps);
  }

  const bg: BrowserGlass = {
    config: resolved,
    get state() {
      return state;
    },

    async start(): Promise<StartReport> {
      if (startPromise !== undefined) return startPromise;
      if (stopped)
        throw new LifecycleError(
          'E_ALREADY_STOPPED',
          'This BrowserGlass instance already stopped; construct a new one.',
        );
      state = 'starting';
      startPromise = (async () => {
        const detectors: PreflightDetectors = {};
        try {
          const { report, wiring: builtWiring } = await runStart(
            resolved,
            logger,
            detectors,
            nodeActionExecutor,
            { viewers: liveViewers, tokens: tokenApi },
          );
          wiring = builtWiring;
          state = 'running';
          ready = true;
          return report;
        } catch (err) {
          state = 'failed';
          throw err;
        }
      })();
      return startPromise;
    },

    async stop(opts?: StopOptions): Promise<StopReport> {
      state = 'stopping';
      accepting = false;
      ready = false;
      const report = await runStop(resolved, logger, wiring, opts ?? {}, {
        notifyViewers: async (notice) => {
          let count = 0;
          for (const managed of sessionRegistry.all()) {
            managed.broadcast({
              t: 'error',
              code: 'bgls.error.internal',
              category: 'internal',
              message: notice.text,
              fatal: false,
              retryable: true,
              retryAfterMs: notice.reconnectAfterMs,
            });
            count += managed.viewerCount;
          }
          return count;
        },
        closeViewerSockets: async (closeCode) => {
          let count = 0;
          for (const managed of sessionRegistry.all()) {
            for (const conn of managed.allConnections()) {
              conn.sendEnvelope(buildGoodbye(closeCode, 'The server is restarting.'));
              conn.close(closeCode, 'server_shutdown');
              count += 1;
            }
          }
          sessionRegistry.disposeAll();
          return count;
        },
      });
      // After the sockets are closed, so no connection can open a new
      // upload between the sweep and the root removal, and unconditionally
      // rather than inside `runStop`'s hook set: staged bytes are this
      // process's own temp files, and leaving them behind on every restart
      // is how a machine fills up quietly.
      await uploadStore.dispose();
      // Same reasoning as `uploadStore.dispose()` immediately above,
      // mirrored for the download direction: a completed download's file
      // is this process's own temp file too, and `DownloadStore.dispose()`
      // only clears its in-memory token map (it does not remove `downloads.dir`
      // itself, unlike `UploadStore`, since Chrome, not this store, owns
      // writing into that directory and may still be mid-write to it at
      // the moment `stop()` runs).
      await downloadStore.dispose();
      state = 'stopped';
      stopped = true;
      return report;
    },

    attachUpgrade(server, opts): () => void {
      const path = normalizeWsPath(opts?.path);
      let byPath = activeUpgradePaths.get(server);
      if (byPath === undefined) {
        byPath = new Map();
        activeUpgradePaths.set(server, byPath);
      }
      const existing = byPath.get(path);
      if (existing !== undefined) {
        logger.warn(
          { component: 'server', path },
          'attachUpgrade called twice for the same server and path; reusing the first listener',
        );
        return existing;
      }
      const listener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
        const paths = [path, ...(opts?.aliases ?? [])];
        if (!paths.some((p) => shouldHandleUpgrade(req, p))) return;
        handleUpgrade(req, socket, head, opts);
      };
      server.on('upgrade', listener);
      const detach = (): void => {
        server.off('upgrade', listener);
        byPath?.delete(path);
      };
      byPath.set(path, detach);
      return detach;
    },

    shouldHandleUpgrade(req): boolean {
      return shouldHandleUpgrade(req);
    },

    handleUpgrade(req, socket, head): void {
      handleUpgrade(req, socket, head);
    },

    upgrade(opts): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
      return (req, socket, head) => handleUpgrade(req, socket, head, opts);
    },

    attach(server, opts): () => void {
      const detachUpgrade = bg.attachUpgrade(server, opts);
      return detachUpgrade;
    },

    async handleRequest(req, res): Promise<boolean> {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const base = resolved.basePath === '/' ? '' : resolved.basePath;
      const isHealth = url.pathname === '/healthz' || url.pathname === '/readyz';
      // `/json/version` and `/json/list`: the two paths a real CDP client
      // library probes before it ever opens a socket
      // (`rest/routes/cdp-discovery.ts`'s own module doc). Handled outside
      // `basePath` for the same reason `isHealth` is: neither path carries
      // this gateway's own prefix, because a bare CDP client has no reason
      // to know it exists.
      const cdpDiscoveryKind =
        url.pathname === '/json/version'
          ? 'version'
          : url.pathname === '/json/list'
            ? 'list'
            : null;
      if (
        !isHealth &&
        cdpDiscoveryKind === null &&
        !url.pathname.startsWith(`${base}/`) &&
        url.pathname !== base
      ) {
        return false;
      }
      if (cdpDiscoveryKind !== null) {
        await handleCdpDiscovery(
          restContext,
          req,
          res,
          cdpDiscoveryKind,
          resolved.cdpProxyPath,
          `req_${randomUUID()}`,
        );
        return true;
      }
      const subPath = isHealth ? url.pathname : url.pathname.slice(base.length) || '/';
      await dispatchRest(restContext, req, res, subPath);
      return true;
    },

    rest() {
      return (req, res, next) => {
        bg.handleRequest(req, res)
          .then((handled) => {
            if (!handled) next();
          })
          .catch(next);
      };
    },

    async fetch(request, ctx): Promise<Response> {
      const { nodeRequestFromFetch, fetchResponseFromNode } = await import(
        './rest/fetch-bridge.js'
      );
      const { req, res, done } = nodeRequestFromFetch(request, ctx);
      const handled = await bg.handleRequest(req, res);
      if (!handled) {
        return new Response('{"error":{"code":"E_NOT_FOUND","message":"not found"}}', {
          status: 404,
          headers: { 'content-type': 'application/json' },
        });
      }
      return fetchResponseFromNode(await done);
    },

    async principalFor(req): Promise<Principal> {
      if (defaultResolver === undefined) {
        throw new LifecycleError(
          'E_NO_AUTH_RESOLVER',
          'No AuthResolver is configured (set auth.resolver or auth.keys).',
        );
      }
      return resolvePrincipalFor(req, defaultResolver, {
        allowQueryToken: resolved.auth.allowQueryToken,
      });
    },

    principalFromClaims(claims): Principal {
      return buildPrincipalFromClaims(claims);
    },

    get router() {
      return wiring?.router;
    },

    tokens: tokenApi,
    sessions: sessionApi,

    on(name, fn) {
      return hookRegistry.on(name, fn);
    },
  };

  return bg;
}

/** Re-exported so app code can build a `Scope` literal without a second `@browserglass/protocol` import. */
export type { Scope };
