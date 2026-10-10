/**
 * Shared embedded-gateway assembly: turns a data directory plus a handful
 * of knobs into a fully wired, running `createBrowserGlass` instance with
 * a real `node:http` listener. Used by `commands/serve.ts` (the long-lived
 * process) and `commands/doctor.ts`'s `--deep` check (a throwaway instance
 * torn down within the same command). The wiring here follows
 * `packages/server/test/ws/support/test-gateway.ts`'s pattern and
 * `examples/nextjs-demo`'s `server.mjs`.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import {
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import { type Server as HttpsServer, createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { dirname, isAbsolute, join } from 'node:path';
import {
  type BrowserRuntime,
  type BrowserSpecInput,
  type LaunchRequest,
  newId,
} from '@browserglass/protocol';
import {
  MEASURED_STEALTH_PROFILE,
  createHostRuntime,
  createProfileFs,
} from '@browserglass/runtime-host';
import { RemoteRuntime } from '@browserglass/runtime-remote';
import {
  type BrowserGlass,
  InProcessJtiCache,
  type StartReport,
  createBrowserGlass,
  jwtAuthResolver,
} from '@browserglass/server';
import {
  type PostgresPoolSizeOptions,
  type PostgresTlsOptions,
  createPostgresStore,
} from '@browserglass/store-postgres';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { generateDevSigningKey } from './dev-key.js';
import { type BglsDevSession, readDevSession, writeDevSession } from './session-file.js';

/** The default tenant/app ids every `bgls`-started gateway uses, matching `@browserglass/server`'s own config-resolution fallback. */
export const DEFAULT_TENANT_ID = 'ten_00000000000000000000000000';
/** See {@link DEFAULT_TENANT_ID}. */
export const DEFAULT_APP_ID = 'app_00000000000000000000000000';

/** The pool name `@browserglass/router`'s `acquire()` falls back to when a request names none, matching `@browserglass/server`'s own `router.defaultPool` default. */
const DEFAULT_POOL_NAME = 'default';

/** A minimal, stored `BrowserSpec` for {@link DEFAULT_POOL_NAME}: Chrome, headless, a common desktop viewport. Individual `acquire()` calls override this per request via `AcquireRequest.browser`. */
const DEFAULT_STORED_BROWSER_SPEC: BrowserSpecInput = {
  engine: 'chromium',
  channel: 'chrome',
  headless: 'new',
  // Every target of the default pool gets its own OS window, so several
  // panes acquired from it can stream concurrently (measured):
  // Chromium composites only a window's visible tab, so 'tab' isolation
  // would cap this pool at one live stream per instance.
  isolation: 'window',
  viewportW: 1440,
  viewportH: 900,
  dpr: 1,
  locale: null,
  timezone: null,
  userAgent: null,
  proxy: null,
  // Give headful-under-Xvfb Chrome a working WebGL renderer (Mesa llvmpipe via
  // ANGLE/Vulkan) instead of none; without it the runtime's sticky --disable-gpu leaves WebGL null.
  args: ['--use-angle=vulkan', '--enable-features=Vulkan', '--ignore-gpu-blocklist'],
  extensions: [],
  stealth: 'off', // MEASURED_STEALTH_PROFILE is registered (createHostRuntime below) but 'full' stalls the WS session on Chrome 153 (profile validated on 152), measured 2026-09-09; headful alone clears Cloudflare
  limits: {},
};

/**
 * Runs `fn()` with the global `Object.freeze` replaced by a no-op,
 * restoring the real one immediately afterward (`finally`, so a throw
 * still restores it). `@browserglass/server`'s own config resolution
 * (`packages/server/src/config/resolve.ts`'s `deepFreeze`) recursively
 * freezes the entire resolved config tree it is handed, including
 * whatever `store`/`runtime`/`profiles.fs` service objects a caller
 * injected: it walks every own enumerable key it can reach, which for a
 * class instance includes fields that are only private in name (`private
 * contents: T` has no runtime enforcement). Freezing an injected
 * service's internal mutable state breaks it the moment it next tries to
 * mutate that state (`this.contents = {...}`), surfacing as `TypeError:
 * Cannot assign to read only property` deep inside a request handler,
 * confirmed directly against `@browserglass/runtime-host`'s
 * `StateFileStore`. This is a `@browserglass/server` bug in how eagerly
 * `deepFreeze` recurses into caller-owned service objects rather than
 * only its own plain-data config fields, in another package. `createBrowserGlass` resolves and freezes its config
 * synchronously, before returning, so neutralising `Object.freeze` only
 * around that one call is enough, and nothing else in this process
 * observes the global function being swapped out.
 */
function withoutDeepFreeze<T>(fn: () => T): T {
  const realFreeze = Object.freeze;
  Object.freeze = ((obj: unknown) => obj) as typeof Object.freeze;
  try {
    return fn();
  } finally {
    Object.freeze = realFreeze;
  }
}

/**
 * Wraps a `BrowserRuntime` so every `launch()` call receives an absolute
 * `req.profile.path`. `packages/router/src/profiles/**`'s `storage_path`
 * column is relative to the profile root and stored as relative by
 * design; the translation into `MaterialisedProfile.path` for
 * a `LaunchRequest` (`packages/router/src/node/LocalNode.ts`) forwards
 * that relative value as-is instead of joining it onto the profile
 * filesystem root `runtime-host` itself knows. `spawnDetachedChrome` never
 * sets an explicit `cwd`, so Chrome resolves a relative `--user-data-dir`
 * against this Node process's own working directory, not the profile
 * root: the directory `ProfileFs` actually materialised into stays empty,
 * `DevToolsActivePort` is watched for in the wrong place, and every launch
 * times out at `spec.launchTimeoutMs` with `E_CDP_TIMEOUT`, confirmed by
 * direct inspection of the `LaunchRequest` `@browserglass/router` builds.
 * This is a `packages/router` bug, fixed here at the injection seam this
 * CLI already controls, without touching router or runtime-host source.
 */
function withAbsoluteProfilePaths(runtime: BrowserRuntime, profilesRoot: string): BrowserRuntime {
  // A `Proxy` (not object spread) is required: `runtime` is a class
  // instance whose methods live on its prototype, not as own enumerable
  // properties, so `{ ...runtime }` would silently drop every method but
  // whatever fields happen to be own properties.
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === 'launch') {
        return async (req: LaunchRequest) => {
          const path = isAbsolute(req.profile.path)
            ? req.profile.path
            : join(profilesRoot, req.profile.path);
          const containerPath =
            req.profile.containerPath === null || isAbsolute(req.profile.containerPath)
              ? req.profile.containerPath
              : join(profilesRoot, req.profile.containerPath);
          return runtime.launch({ ...req, profile: { ...req.profile, path, containerPath } });
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Options accepted by {@link buildEmbeddedGateway}. */
export interface EmbeddedGatewayOptions {
  /** Root directory: `<dataDir>/bgls.db`, `<dataDir>/profiles`, `<dataDir>/runtime-host`, `<dataDir>/dev-session.json`. */
  readonly dataDir: string;
  /** 'host' (default) launches Chrome locally; 'remote' attaches to CDP endpoints from `remoteEndpoints`. */
  readonly runtime?: 'host' | 'remote';
  /** name=url pairs for `runtime: 'remote'`; the first becomes the default pool's `remoteEndpointName`. */
  readonly remoteEndpoints?: readonly { name: string; url: string }[];
  readonly listenHost?: string;
  /** `0` binds an ephemeral port; the resolved port is read back from the listening socket. Default 7443. */
  readonly listenPort?: number;
  readonly maxInstances?: number;
  /** `--capture-rate`: screenshots/PDFs per second per target. Omitted means the server's own `BGLS_CAPTURE_RATE_PER_SEC`/default chain decides. */
  readonly captureRatePerSec?: number;
  /** `--capture-burst`: back to back screenshots allowed per target before the steady rate applies. */
  readonly captureBurst?: number;
  readonly basePath?: string;
  /** Passed to `runtime-host`'s `HostRuntimeConfig.killOnShutdown`. Default `false` (matches the `keepBrowsersAlive` default). `doctor --deep` sets `true` so its throwaway browser never survives the check. */
  readonly killOnShutdown?: boolean;
  readonly tenantId?: string;
  readonly appId?: string;
  /** Overrides `<dataDir>/bgls.db` (`--store sqlite:<path>`). Ignored when `store` is given. */
  readonly storePath?: string;
  /**
   * Selects Postgres instead of the default SQLite store (`--store
   * postgres://...`). `pool`/`tls` mirror `--store-pool-*`/`--store-tls-*`.
   */
  readonly store?: {
    readonly kind: 'postgres';
    readonly connectionString: string;
    readonly pool?: PostgresPoolSizeOptions;
    readonly tls?: PostgresTlsOptions;
  };
  /** Overrides `<dataDir>/profiles` (`--profiles-dir`). */
  readonly profilesDir?: string;
  /**
   * Overrides `@browserglass/server`'s own `recordings.dir` default (a
   * directory scoped to this process's pid under the system temp
   * directory, `config/resolve.ts`'s own deliberate choice so two
   * gateways on one machine never collide). Passed straight through to
   * `createBrowserGlass({ recordings: { dir } })` when given
   * (`--recordings-dir`); when omitted, that default is left alone, not
   * silently overridden to something under `dataDir`, since the choice of
   * whether recordings should outlive this one process's lifetime belongs
   * to the operator, not this CLI.
   */
  readonly recordingsDir?: string;
  /** Allowed CORS origins (`--cors`, repeatable). `'*'` when omitted, matching `@browserglass/server`'s own default. */
  readonly allowedOrigins?: readonly string[];
  /** `--tls-cert`/`--tls-key`: serves HTTPS/WSS instead of plain HTTP/WS when both are set. */
  readonly tls?: { readonly certPath: string; readonly keyPath: string };
}

/** A running embedded gateway plus everything a caller needs to talk to it and shut it down. */
export interface EmbeddedGateway {
  readonly bg: BrowserGlass;
  readonly httpServer: HttpServer | HttpsServer;
  readonly host: string;
  readonly port: number;
  readonly endpoint: string;
  readonly wsUrl: string;
  readonly session: BglsDevSession;
  readonly startReport: StartReport;
  /** Stops accepting connections, releases every live instance, terminates their browsers, and disposes the runtime. Never throws. */
  close(): Promise<void>;
}

/**
 * Builds and starts a complete embedded gateway: opens (creating if
 * needed) the SQLite store and its default tenant/app rows, constructs a
 * `HostRuntime` and `ProfileFs` rooted at `dataDir`, reuses (or generates)
 * a dev signing key, calls `createBrowserGlass` and `bg.start()`, and
 * binds a real `node:http` listener with `bg.attach()` wired to it.
 */
export async function buildEmbeddedGateway(opts: EmbeddedGatewayOptions): Promise<EmbeddedGateway> {
  // Keeps the event loop alive (a real, ref'd handle) for the whole
  // duration of this function. Every timer this call chain schedules
  // downstream (store busy-retry backoff, the router's heartbeat/reaper/
  // warm-pool timers, and so on) is correctly `.unref()`'d per the
  // project's own timer rule, since none of them should keep a *server*
  // process alive on their own once it is idle. Before the HTTP listener
  // itself starts holding the loop open (which only happens at the very
  // end of this function), that means nothing else refs the loop: if
  // every scheduled callback the setup path is waiting on happens to be
  // unref'd at the moment the loop would otherwise go idle, Node treats
  // the loop as drained and exits early with "Detected unsettled
  // top-level await" (exit code 13), abandoning this promise before it
  // ever resolves. Observed directly against this build: `bg.start()`
  // never returned without this. `clearInterval` in `finally` releases it
  // whether this call succeeds or throws.
  const keepAlive = setInterval(() => undefined, 2_147_483_647);
  try {
    return await buildEmbeddedGatewayInner(opts);
  } finally {
    clearInterval(keepAlive);
  }
}

async function buildEmbeddedGatewayInner(opts: EmbeddedGatewayOptions): Promise<EmbeddedGateway> {
  const remoteMode = opts.runtime === 'remote';
  const tenantId = opts.tenantId ?? DEFAULT_TENANT_ID;
  const appId = opts.appId ?? DEFAULT_APP_ID;
  const basePath = opts.basePath ?? '/browserglass';
  const host = opts.listenHost ?? '127.0.0.1';
  const requestedPort = opts.listenPort ?? 7443;

  const dbPath = opts.storePath ?? join(opts.dataDir, 'bgls.db');
  const profilesDir = opts.profilesDir ?? join(opts.dataDir, 'profiles');
  const stateDir = join(opts.dataDir, 'runtime-host');

  // better-sqlite3 (via `openSqlite`) refuses to create a database file
  // whose parent directory does not exist yet; `dataDir` and every
  // directory `--store`/`--profiles-dir` may point outside it need to
  // exist before anything below tries to open or write into them. Postgres
  // needs none of this (no local file, no parent directory), but the other
  // three still do regardless of which store backs this gateway.
  mkdirSync(opts.dataDir, { recursive: true });
  if (opts.store?.kind !== 'postgres') mkdirSync(dirname(dbPath), { recursive: true });
  mkdirSync(profilesDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  if (opts.recordingsDir !== undefined) mkdirSync(opts.recordingsDir, { recursive: true });

  const store =
    opts.store?.kind === 'postgres'
      ? await createPostgresStore(opts.store.connectionString, {
          ...(opts.store.pool !== undefined ? { pool: opts.store.pool } : {}),
          ...(opts.store.tls !== undefined ? { tls: opts.store.tls } : {}),
        })
      : await createSqliteStore(dbPath);
  if ((await store.getTenant(tenantId)) === null) {
    await store.createTenant({ id: tenantId, name: 'bgls dev tenant' });
  }
  if ((await store.getApp(tenantId, appId)) === null) {
    await store.createApp({ id: appId, tenantId, name: 'bgls dev app' });
  }

  // `@browserglass/server`'s own `runStart()` (`packages/server/src/
  // lifecycle/start.ts` step 5) only reconciles `config.router.pools`
  // into its `StartReport` for reporting purposes; it never writes a
  // `pools` row to the store. `BrowserRouter.acquire()` (called by every
  // `POST /v1/instances`) requires a real pool named `'default'` to
  // exist, via `store.getPoolByName`, or it throws `E_POOL_NOT_FOUND`.
  // Ensuring one here, backed by a stored default `BrowserSpec`, is what
  // makes a freshly started `bgls serve` actually able to acquire an
  // instance rather than failing the very first request.
  if ((await store.getPoolByName(tenantId, DEFAULT_POOL_NAME)) === null) {
    const spec = await store.upsertBrowserSpec(
      tenantId,

      remoteMode
        ? {
            ...DEFAULT_STORED_BROWSER_SPEC,
            headless: 'off',
            args: [],
            remoteEndpointName: (opts.remoteEndpoints ?? [])[0]?.name ?? null,
          }
        : DEFAULT_STORED_BROWSER_SPEC,
    );
    await store.createPool({ tenantId, name: DEFAULT_POOL_NAME, specId: spec.id });
  }

  // Reuse the existing session's signing key across a restart in the same
  // data directory (so a token minted before a restart, if still within
  // its TTL, keeps verifying); otherwise generate a fresh one.
  const existingSession = readDevSession(opts.dataDir);
  const key =
    existingSession !== null &&
    existingSession.tenantId === tenantId &&
    existingSession.appId === appId
      ? existingSession.key
      : generateDevSigningKey();

  let runtime: BrowserRuntime;
  if (remoteMode) {
    const eps = opts.remoteEndpoints ?? [];
    if (eps.length === 0)
      throw new Error(
        "runtime 'remote' needs at least one endpoint (BGLS_REMOTE_ENDPOINTS=name=http://host:port[,...])",
      );
    runtime = new RemoteRuntime({
      endpoints: eps.map((e) => ({ name: e.name, tenantId, url: e.url, auth: null })),
    });
  } else {
    const { runtime: hostRuntime } = await createHostRuntime({
      nodeId: newId('nod'),
      stateDir,
      profileRoot: profilesDir,
      killOnShutdown: opts.killOnShutdown ?? false,
      // Register the measured stealth profile so a caller may ask for
      // `browser.stealth: 'full'`; default spec stays 'off'.
      stealthProfiles: [MEASURED_STEALTH_PROFILE],
      enabledStealthLevels: ['off', 'basic', 'full'],
    });
    runtime = withAbsoluteProfilePaths(hostRuntime, profilesDir);
  }
  const profileFs = createProfileFs({ root: profilesDir });

  // `createBrowserGlass` only builds its own internal `AuthResolver` (used
  // for REST's `principalFor`/`bg.tokens`) when `auth.resolver` is unset;
  // that internally-built resolver is never written back onto
  // `ResolvedConfig.auth.resolver`, which is the field the WS upgrade path
  // (`ws/credentials.ts`'s `resolveJwt`) actually reads. Passing `keys`
  // alone leaves the WS path with no resolver at all (`bgls.error.auth.
  // no_credential`, confirmed directly against a real bearer token this
  // same key signed), even though REST auth works fine. Building and
  // passing the resolver explicitly here is a `@browserglass/server` gap,
  // worked around at the config
  // surface this CLI already controls.
  const authResolver = jwtAuthResolver({
    keys: [key],
    tenantId,
    appId,
    issuer: appId,
    clockSkewSeconds: 30,
    jtiCache: new InProcessJtiCache(10_000),
    store,
  });

  const bg = withoutDeepFreeze(() =>
    createBrowserGlass({
      mode: 'embedded',
      basePath,
      tenantId,
      appId,
      store,
      runtime,
      profiles: { dir: profilesDir, fs: profileFs },
      // Only pass `limits.maxInstances` when `--max-instances` was given
      // explicitly. This used to default to a hardcoded 20 here, which
      // silently overrode `@browserglass/server`'s own `BGLS_MAX_INSTANCES`
      // env var and its coherent fallback (`config/resolve.ts`) on every
      // `bgls serve` that did not pass the flag: `resolveConfig()` treats
      // an explicit `limits.maxInstances` as outranking the environment,
      // so this literal was the layer actually setting the ceiling for
      // ordinary use, two defaults out of step with the one an operator
      // reading the server's own docs would expect to control it. Omitting
      // the field when the flag is absent lets `resolveConfig()`'s own
      // env-var-then-fallback chain govern instead.
      // The same rule applies to the capture limits: only an explicit flag
      // is passed, so `BGLS_CAPTURE_RATE_PER_SEC`/`BGLS_CAPTURE_BURST` keep
      // working when the flags are absent.
      ...(opts.maxInstances !== undefined ||
      opts.captureRatePerSec !== undefined ||
      opts.captureBurst !== undefined
        ? {
            limits: {
              ...(opts.maxInstances !== undefined ? { maxInstances: opts.maxInstances } : {}),
              ...(opts.captureRatePerSec !== undefined
                ? { captureRatePerSec: opts.captureRatePerSec }
                : {}),
              ...(opts.captureBurst !== undefined ? { captureBurst: opts.captureBurst } : {}),
            },
          }
        : {}),
      ...(opts.recordingsDir !== undefined ? { recordings: { dir: opts.recordingsDir } } : {}),
      auth: { keys: [key], issuer: appId, resolver: authResolver },
      ...(opts.allowedOrigins !== undefined
        ? { security: { allowedOrigins: opts.allowedOrigins } }
        : {}),
    }),
  );

  const startReport = await bg.start();

  // `buildRouterWiring` (`packages/server/src/lifecycle/wiring.ts`)
  // generates its own local `nodeId` internally and never persists it;
  // `instances.node_id`/`profile_leases.node_id` both carry
  // `REFERENCES nodes(id)`, so the very first `acquire()` fails its
  // INSERT with `FOREIGN KEY constraint failed` unless a matching
  // `nodes` row exists. `StartReport.nodes` is the only place that id is
  // exposed; register it here, once, before this gateway accepts any
  // request that could reach the router.
  for (const node of startReport.nodes) {
    if ((await store.getNode(node.nodeId)) === null) {
      await store.registerNode({
        id: node.nodeId,
        name: 'bgls-embedded',
        runtime: remoteMode ? 'remote' : 'host',
        address: '127.0.0.1',
        registrationSecretEnc: 'embedded',
      });
    }
  }

  // `BrowserRouter.placeAndLaunch` (`packages/router/src/router/
  // BrowserRouter.ts`) receives a real `LaunchedBrowser` (carrying the
  // real `cdpWsUrl`) back from the runtime's own `launch()` and discards
  // it, so `instance.runtime` (which `describe()` already has a fallback
  // for, `this.liveRuntimeByInstance.get(instanceId) ?? null`, but never
  // populates) stays `null` forever; `@browserglass/server`'s
  // `createManagedSessionFactory` reads exactly that field to connect a
  // WS session's CDP bridge, so no session can ever go live without it.
  // Confirmed directly against a real launch. Patching the one live `describe()` this gateway's
  // own `bg.router` getter returns, backfilling from the runtime's real
  // `list()` inventory, is the same fix the router itself uses.
  if (bg.router !== undefined) {
    const router = bg.router;
    const realDescribe = router.describe.bind(router);
    router.describe = async (instanceId, principal) => {
      const view = await realDescribe(instanceId, principal);
      if (view.instance.runtime !== null) return view;
      const entry = (await runtime.list()).find(
        (e: { instanceId: string }) => e.instanceId === instanceId,
      );
      if (entry === undefined) return view;
      return {
        ...view,
        instance: {
          ...view.instance,
          runtime: {
            kind: entry.runtimeKind,
            pid: entry.pid,
            containerId: entry.containerId,
            podName: entry.podName,
            cdpWsUrl: `${entry.cdpUrl.replace(/^http/, 'ws')}/devtools/browser/${entry.browserGuid}`,
            cdpPort: null,
            chromeVersion: entry.engineVersion,
            profilePath: entry.profilePath,
            startedAt: entry.startedAt,
            // `null`, and it is a real limitation of this backfill rather
            // than a value. `RuntimeInventoryEntry` (inferred from the
            // state file entry shape, `@browserglass/protocol`'s
            // `runtime.ts`) records nothing about the stealth profile a
            // launch ran under, so this path cannot recover it, and a null
            // here means the gateway applies no stealth hooks to the
            // session it opens (`packages/server/src/session/factory.ts`'s
            // `resolveStealthHooks`).
            //
            // Correct today for every instance that reaches this branch.
            // The branch only runs when the router did NOT populate
            // `instance.runtime` itself, which since `stealthProfile` was
            // added to `InstanceRuntimeInfo` means only instances this
            // router process did not launch (adopted or reconciled ones),
            // and adoption carries no spec to have asked for stealth with.
            // If the inventory ever learns to carry the profile, read it
            // here rather than leaving this null.
            stealthProfile: null,
          },
        },
      };
    };
  }

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    bg.handleRequest(req, res)
      .then((handled) => {
        if (!handled) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end('{"error":{"code":"E_NOT_FOUND"}}');
        }
      })
      .catch(() => {
        if (!res.headersSent) res.writeHead(500).end();
      });
  };

  const httpServer: HttpServer | HttpsServer =
    opts.tls !== undefined
      ? createHttpsServer(
          { cert: readFileSync(opts.tls.certPath), key: readFileSync(opts.tls.keyPath) },
          requestHandler,
        )
      : createServer(requestHandler);
  bg.attach(httpServer);
  // Every socket the server accepted, so `close()` can end whatever is
  // still open once `bg.stop()` has had its chance to close it politely.
  const openSockets = new Set<Socket>();
  httpServer.on('connection', (socket: Socket) => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(requestedPort, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
  const scheme = opts.tls !== undefined ? 'https' : 'http';
  const endpoint = `${scheme}://${host}:${port}`;
  const wsUrl = `${scheme === 'https' ? 'wss' : 'ws'}://${host}:${port}${bg.config.wsPath}`;

  const session: BglsDevSession = {
    schema: 'bgls.dev-session/1',
    pid: process.pid,
    startedAt: Date.now(),
    endpoint,
    wsUrl,
    basePath: bg.config.basePath,
    tenantId,
    appId,
    issuer: bg.config.auth.issuer,
    key,
  };
  writeDevSession(opts.dataDir, session);

  return {
    bg,
    httpServer,
    host,
    port,
    endpoint,
    wsUrl,
    session,
    startReport,
    async close(): Promise<void> {
      // Stop accepting first, but do not wait for the server to finish
      // closing before stopping `bg`. `httpServer.close()` only calls back
      // once every connection has ended, and an upgraded socket (a viewer,
      // an MCP client's automation socket, a CDP proxy client) never ends
      // on its own. `bg.stop()` is the thing that closes those sockets, so
      // awaiting the server first meant a gateway with one client still
      // connected never reached `bg.stop()` at all. Whoever then killed
      // the hung process left every browser it had launched running.
      const serverClosed = new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      try {
        await bg.stop({ instances: 'release', deadlineMs: 10_000 });
      } catch {
        // bg.stop() itself never throws per its own contract; this catch
        // exists only so a caller's teardown never aborts partway through.
      }
      try {
        await runtime.dispose();
      } catch {
        // Best effort: dispose() releasing runtime-wide resources is not
        // worth failing an already-in-progress shutdown over.
      }
      // Anything `bg.stop()` did not close (a socket mid handshake, an idle
      // keep alive connection) is ended here, so the server's own close
      // callback can fire and the caller's `await close()` returns.
      for (const socket of openSockets) socket.destroy();
      await serverClosed;
    },
  };
}
