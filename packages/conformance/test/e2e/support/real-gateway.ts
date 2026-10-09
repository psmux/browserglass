import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
/**
 * Starts a real BrowserGlass gateway: the programmatic equivalent of
 * `bgls serve`, without depending on the CLI package. A real `@browserglass/store-sqlite` (temp file, never `:memory:`,
 * so the process boundary chaos scenarios can reopen it), a real
 * `@browserglass/runtime-host` launching real Chrome on this machine, a
 * real `@browserglass/router` (built internally by `createBrowserGlass`
 * from `store`/`runtime`/`profiles.fs`), and a real `node:http` server.
 *
 * Only this package's own `test/**` may import `@browserglass/server`,
 * `@browserglass/router`, and `@browserglass/runtime-host`: they are
 * devDependencies only, never part of `@browserglass/conformance`'s
 * published `src/**` (conformance itself depends on protocol and client
 * only).
 */
import { type Server as HttpServer, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserGlassClient, type BrowserGlassClientOptions } from '@browserglass/client';
import {
  type AppId,
  CAPABILITIES,
  type Capability,
  type InstanceId,
  type Principal,
  type Scope,
  type TenantId,
  newId,
} from '@browserglass/protocol';
import type { Store } from '@browserglass/protocol';
import type { AcquireResult } from '@browserglass/router';
import {
  type HostRuntime,
  chromeProcsForDataDir,
  createHostRuntime,
  createProfileFs,
  killProcessTree,
  listAllChromeFamilyProcesses,
} from '@browserglass/runtime-host';
import {
  type AppSigningKey,
  type BrowserGlass,
  createBrowserGlass,
  generateEd25519KeyMaterial,
} from '@browserglass/server';
import { createSqliteStore } from '@browserglass/store-sqlite';
import WebSocket from 'ws';

/** A `Principal` with every capability, used only to drive `bg.router.acquire()` from this test harness. Never sent over the wire. */
function launcherPrincipal(tenantId: TenantId, appId: AppId): Principal {
  const scope: Scope = { kind: 'tenant' };
  return {
    tenantId,
    appId,
    sub: 'conformance:launcher',
    subKind: 'service',
    caps: [...CAPABILITIES] as Capability[],
    scope,
    jti: 'conformance-launcher',
    exp: Number.MAX_SAFE_INTEGER,
  };
}

/** One fully wired, real, real-Chrome-launching gateway for this package's own e2e and chaos suites. */
export interface RealGateway {
  readonly bg: BrowserGlass;
  readonly httpServer: HttpServer;
  readonly wsUrl: string;
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly store: Store;
  readonly runtime: HostRuntime;
  readonly profileRoot: string;
  readonly stateDir: string;
  /**
   * Launches (or reuses) a real Chrome instance via the real router,
   * waiting for it to be ready.
   *
   * `subject` and `sticky` are the affinity pair. They are separate on
   * purpose: `subject` is what the router stamps onto the new instance row
   * (`BrowserRouter.doAcquire`'s `subject: req.subject ?? principal.sub`),
   * and `sticky.subject` is what `findReusable` later matches that column
   * against. A caller that passes only `sticky` gets an instance stamped
   * with the PRINCIPAL's sub, which for this harness is the single shared
   * `conformance:launcher`, so every "user" would collide on one row. Any
   * suite proving per subject affinity must pass both.
   *
   * No `requestId` is ever sent from here. `IdempotencyTable.withIdempotency`
   * returns early (`if (!req.requestId) return run()`), so nothing this
   * harness acquires can be satisfied by idempotent replay: a `reused`
   * result from this method always came from `findReusable`.
   */
  acquireInstance(opts?: {
    readonly ttlMs?: number;
    readonly idleMs?: number;
    readonly subject?: string;
    readonly sticky?: { readonly subject: string; readonly withinMs?: number };
    /** Omit the `profile` field entirely rather than sending `{ mode: 'ephemeral' }`. The pool's own `profileTemplate` defaults to `{ mode: 'ephemeral' }` (`store-sqlite/src/mappers.ts`), so the RESOLVED profile is identical either way; only `doAcquire`'s selector count differs. */
    readonly omitProfile?: boolean;
  }): Promise<AcquireResult>;
  /**
   * How many real Chrome BROWSER-MAIN processes (never a renderer, GPU or
   * utility child, all of which carry `--type=`) currently exist on this
   * machine under this gateway's own `profileRoot`.
   *
   * This is the ground truth signal for "did a second Chrome actually
   * launch". `AcquireResult.reused` is the router's own claim about what it
   * did; this is the operating system's answer, read from the process
   * table. `chromeProcsForDataDir` cannot be used for it: that helper
   * demands an EXACT `--user-data-dir=` match, and the real value is
   * `<profileRoot>/tenants/<tenantId>/profiles/<profileId>/udd`, several
   * levels below the root. This scans the same process table and matches
   * on the root as a path prefix instead.
   */
  chromeProcessCount(): number;
  /** Mints a real, viewer-scoped bearer token for `instanceId`. */
  mintToken(
    instanceId: InstanceId,
    opts?: { readonly caps?: readonly Capability[]; readonly sub?: string },
  ): Promise<string>;
  /**
   * Constructs (but does not connect) a real `BrowserGlassClient` pointed
   * at this gateway.
   *
   * `caps` is the token's capability set. Minting one WITHOUT `'control'`
   * is how a genuine view-only viewer is built: `requestControl()` refuses
   * locally, and the server's own gate refuses too, so there is no path by
   * which such a viewer acquires a lease.
   *
   * `sub` names the viewer. It defaults to a fresh `vwr_` id, which is
   * right for every suite that only needs the viewers to be distinct, and
   * is worth setting when a failure message has to say WHICH viewer
   * misbehaved.
   */
  makeClient(
    instanceId: InstanceId,
    opts?: Partial<BrowserGlassClientOptions> & {
      readonly caps?: readonly Capability[];
      readonly sub?: string;
    },
  ): Promise<BrowserGlassClient>;
  /** Reads the real router's own view of `instanceId`, including `runtime.pid`, the real host OS process id of the launched Chrome. */
  describeInstance(
    instanceId: InstanceId,
  ): Promise<{ readonly pid: number | null; readonly cdpWsUrl: string }>;
  /** Releases a real instance (profile lease released, browser terminated) via the real router. A test that acquires more than one instance should release each between cases, so this node's `maxConcurrentLaunches` never backs up across an already-finished test's still-live Chrome. */
  releaseInstance(instanceId: InstanceId): Promise<void>;
  /** Tears everything down: every client the caller handed back, the gateway, the HTTP server, the temp dirs, and asserts no Chrome process this run launched is left behind. */
  close(clients?: readonly BrowserGlassClient[]): Promise<void>;
}

/** Options accepted by {@link startRealGateway}. */
export interface StartRealGatewayOptions {
  /** Extra Chrome launch args, forwarded into the default pool's `BrowserSpec`. */
  readonly headless?: 'off' | 'new';
  /**
   * Whether each streamed target gets its own real OS window, forwarded
   * into the default pool's `BrowserSpec`.
   *
   * Defaults to `'tab'`, which is what every suite written before window
   * isolation existed assumes: one Chrome window, targets as tabs of it,
   * and therefore at most one target able to produce continuous screencast
   * frames. `parallel-live-streams.test.ts` is the one suite that needs
   * `'window'`, and it asks for it explicitly.
   */
  readonly isolation?: 'tab' | 'window';
  /**
   * The ControlLease mode every target of this gateway is created in,
   * sent as `session.control.mode`.
   *
   * `'exclusive'` (the default, and the SDK-wide default, which is a
   * compatibility promise rather than an accident) admits one holder per
   * target and queues everybody else. `'shared'` admits N concurrent
   * holders on one target, each with its own `leaseId`, and never queues
   * anybody.
   *
   * Server side and per deployment, deliberately, not a field on
   * `control.request`: arbitration has to be single valued for a
   * contended resource, since "Alice holds exclusively, Bob asks for
   * shared" has no honest answer. What a viewer chooses for themselves is
   * whether to ask for control at all.
   *
   * Passed through with NO cast. It used to be widened with `as never`,
   * back when the key did not exist, and that cast is exactly why nobody
   * noticed it was being accepted and silently dropped: `resolveConfig`
   * rejects no key it does not know, so an undeclared key fails at
   * nothing. The type checker is now the thing that keeps this honest.
   */
  readonly controlMode?: 'exclusive' | 'shared';
  /**
   * There is deliberately NO `controlGraceMs` option here, and this note
   * exists so nobody adds one back without checking first.
   *
   * An earlier version of this file offered one, sent as
   * `session.control.graceMs`, and documented it as shortening the
   * disconnect grace so a test would not have to sit through the 30 second
   * production default. It did nothing at all. All five `session.control.*`
   * keys are resolved, validated and frozen into `ResolvedConfig`, and only
   * `mode` is read by any consumer; `leaseMs`, `graceMs`, `queueMax` and
   * `allowForceClaim` reach nothing in `packages/server` or
   * `packages/cli`, so the engine keeps its own
   * `CONTROL_TIMING.disconnectGraceMs` of 30000 whatever the config says.
   *
   * A knob that silently does nothing is worse than no knob: a test written
   * against it passes for a reason its author does not know, and the moment
   * the knob starts working the test changes behaviour without anyone
   * touching it. The one case here that cares about the disconnect grace
   * waits out the real default instead, and says so.
   */
}

/**
 * A short-path temp root for the profile tree. `ProfileFs`'s canonical
 * layout is `<profileRoot>/tenants/<tenantId>/profiles/<profileId>/udd`,
 * which alone is roughly 82 characters once the two full `ten_`/`prf_`
 * ULIDs are in it; `runtime-host`'s own `ProfileRootTooLongError` refuses
 * anything whose full path exceeds 120 characters on Windows. The OS
 * default temp dir (`C:\Users\<user>\AppData\Local\Temp` on this
 * machine) is already 34+ characters on its own, leaving no room, so
 * this package uses its own short root instead.
 */
export function shortTempRoot(prefix: string): string {
  if (process.platform === 'win32') {
    const base = join(process.env['SystemDrive'] ?? 'C:', 'bglstmp');
    mkdirSync(base, { recursive: true });
    return mkdtempSync(join(base, prefix));
  }
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * Every real Chrome **browser-main** process on this machine whose command
 * line names a `--user-data-dir=` somewhere beneath `profileRoot`.
 *
 * The ground truth answer to "did Chrome actually launch again", read from
 * the operating system's own process table rather than from anything the
 * router says about itself. A test that asserts only on
 * `AcquireResult.reused` is asserting the router's own claim; this asserts
 * the consequence.
 *
 * `chromeProcsForDataDir(profileRoot)` cannot serve this purpose, despite
 * the name: its `containsDataDirArg` guard demands the `--user-data-dir=`
 * value equal the argument EXACTLY (deliberately, so `/path/ws-1` never
 * matches `/path/ws-12`), while the real value is
 * `<profileRoot>/tenants/<tenantId>/profiles/<profileId>/udd`, four levels
 * below the root. Passing the root there returns an empty array no matter
 * how many browsers are running, which is exactly the kind of fixture that
 * measures nothing and reports success. This scans the same table and
 * matches the root as a normalised path prefix instead.
 *
 * `--type=` excludes renderer/GPU/utility children, the same guard 3
 * `process-table.ts` applies, so the count is one per browser rather than
 * one per Chrome process.
 */
export function chromeMainProcessesUnder(
  profileRoot: string,
): readonly { pid: number; commandLine: string }[] {
  const needle = profileRoot.replace(/\\/g, '/').toLowerCase();
  return listAllChromeFamilyProcesses().filter((p) => {
    if (p.commandLine.includes('--type=')) return false;
    return p.commandLine.replace(/\\/g, '/').toLowerCase().includes(needle);
  });
}

/** {@link chromeMainProcessesUnder}'s count. */
export function countChromeMainProcessesUnder(profileRoot: string): number {
  return chromeMainProcessesUnder(profileRoot).length;
}

/** Builds and starts a real, real-Chrome-backed {@link RealGateway} on an ephemeral loopback port. */
export async function startRealGateway(opts: StartRealGatewayOptions = {}): Promise<RealGateway> {
  const tenantId = newId('ten') as TenantId;
  const appId = newId('app') as AppId;
  const workDir = shortTempRoot('g-');
  const dbPath = join(workDir, 'control.db');
  const profileRoot = join(workDir, 'p');
  const stateDir = join(workDir, 's');

  mkdirSync(profileRoot, { recursive: true });

  const store = await createSqliteStore(dbPath, { migrate: 'auto' });
  await store.createTenant({ id: tenantId, name: 'Conformance Tenant' });
  await store.createApp({ id: appId, tenantId, name: 'Conformance App' });

  const nodeId = `nod_conformance${Math.random().toString(36).slice(2, 10)}`;
  const { runtime } = await createHostRuntime({
    nodeId,
    stateDir,
    profileRoot,
    killOnShutdown: true,
  });
  const fs = createProfileFs({ root: profileRoot });

  const keyMaterial = generateEd25519KeyMaterial();
  const signingKey: AppSigningKey = {
    kid: 'conformance-key',
    alg: 'EdDSA',
    publicKey: keyMaterial.publicKey,
    privateKey: keyMaterial.privateKey,
    status: 'active',
  };

  // `createBrowserGlass()`'s own internal `defaultResolver` (built from
  // `auth.keys` when `auth.resolver` is not given) is now merged into both
  // the REST and the WS path, so `auth.keys` alone
  // is enough here; no separate `AuthResolver` needs to be built by hand.
  const bg = createBrowserGlass({
    mode: 'embedded',
    tenantId,
    appId,
    store,
    runtime,
    profiles: { dir: profileRoot, fs },
    auth: { keys: [signingKey], issuer: appId },
    // No cast. `session.control.mode` is a real, declared field now, so
    // the type checker is the thing that tells this harness it is sending a
    // key the server understands. An earlier version of this block widened
    // the whole `session` object with `as never` to get an undeclared key
    // past the compiler, which is precisely how it went on being accepted
    // and silently dropped by `resolveConfig` (which rejects no key it does
    // not know) for as long as it did. A cast that suppresses the one check
    // that would have caught the mistake is worse than no cast.
    ...(opts.controlMode !== undefined ? { session: { control: { mode: opts.controlMode } } } : {}),
  });

  await bg.start();

  // `packages/server/src/session/factory.ts`'s `createManagedSessionFactory`
  // reads `router.describe(instanceId, principal).instance.runtime?.cdpWsUrl`
  // to connect the real `CdpBridge` a WS session needs. `BrowserRouter`
  // now keeps its own in-memory `instanceId` -> live runtime detail map,
  // populated at successful launch and consulted by `describe()`
  // so no patching is needed here.

  // Seed the "default" pool `resolvePool()` requires: a real BrowserSpec
  // pointed at real Chrome on this machine, headless by default so the
  // suite runs unattended.
  const spec = await store.upsertBrowserSpec(tenantId, {
    engine: 'chromium',
    channel: 'chrome',
    headless: opts.headless ?? 'new',
    viewportW: 1280,
    viewportH: 720,
    dpr: 1,
    locale: null,
    timezone: null,
    userAgent: null,
    proxy: null,
    args: [],
    extensions: [],
    stealth: 'off',
    isolation: opts.isolation ?? 'tab',
    limits: {},
  });
  await store.createPool({ tenantId, name: 'default', specId: spec.id });

  const httpServer = createServer((req, res) => {
    bg.handleRequest(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  bg.attachUpgrade(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const wsUrl = `ws://127.0.0.1:${port}${bg.config.wsPath}`;

  const principal = launcherPrincipal(tenantId, appId);
  const launchedInstanceIds: InstanceId[] = [];

  /** Shared by both `mintToken` and `makeClient`; a plain function rather than an object method, since an object literal method's `this` cannot be relied on when called from a sibling method on the same literal. */
  async function mintTokenImpl(
    instanceId: InstanceId,
    tokenOpts?: { readonly caps?: readonly Capability[]; readonly sub?: string },
  ): Promise<string> {
    const caps = tokenOpts?.caps ?? ([...CAPABILITIES] as Capability[]);
    return bg.tokens.issue({
      sub: tokenOpts?.sub ?? newId('vwr'),
      caps: caps as Capability[],
      scope: { kind: 'instance', instanceId, targets: '*' },
      tenantId,
      appId,
      ttlSeconds: 300,
      ...(caps.includes('admin' as Capability) ? { iUnderstandAdmin: true } : {}),
    });
  }

  return {
    bg,
    httpServer,
    wsUrl,
    tenantId,
    appId,
    store,
    runtime,
    profileRoot,
    stateDir,

    async acquireInstance(acquireOpts) {
      const router = bg.router;
      if (!router)
        throw new Error(
          'bg.router is undefined; call after bg.start() (already awaited by startRealGateway)',
        );
      const handle = await router.acquire(
        {
          ...(acquireOpts?.omitProfile ? {} : { profile: { mode: 'ephemeral' as const } }),
          ...(acquireOpts?.ttlMs !== undefined ? { ttlMs: acquireOpts.ttlMs } : {}),
          ...(acquireOpts?.idleMs !== undefined ? { idleMs: acquireOpts.idleMs } : {}),
          ...(acquireOpts?.subject !== undefined ? { subject: acquireOpts.subject } : {}),
          ...(acquireOpts?.sticky !== undefined
            ? {
                sticky: {
                  subject: acquireOpts.sticky.subject,
                  ...(acquireOpts.sticky.withinMs !== undefined
                    ? { withinMs: acquireOpts.sticky.withinMs }
                    : {}),
                },
              }
            : {}),
        },
        principal,
      );
      const result = await handle.ready;
      launchedInstanceIds.push(result.instanceId);
      return result;
    },

    chromeProcessCount() {
      return countChromeMainProcessesUnder(profileRoot);
    },

    async mintToken(instanceId, tokenOpts) {
      return mintTokenImpl(instanceId, tokenOpts);
    },

    async makeClient(instanceId, clientOpts) {
      const token = await mintTokenImpl(instanceId, {
        ...(clientOpts?.caps ? { caps: clientOpts.caps } : {}),
        ...(clientOpts?.sub ? { sub: clientOpts.sub } : {}),
      });
      return new BrowserGlassClient({
        url: wsUrl,
        token,
        autoReconnect: false,
        transport: { WebSocketImpl: WebSocket as never, allowInsecureTransport: true },
        ...clientOpts,
      });
    },

    async describeInstance(instanceId) {
      const router = bg.router;
      if (!router) throw new Error('bg.router is undefined; call after bg.start()');
      const view = await router.describe(instanceId, principal);
      return {
        pid: view.instance.runtime?.pid ?? null,
        cdpWsUrl: view.instance.runtime?.cdpWsUrl ?? '',
      };
    },

    async releaseInstance(instanceId) {
      const router = bg.router;
      if (!router) throw new Error('bg.router is undefined; call after bg.start()');
      await router.release(instanceId, { reason: 'app_request' }, principal).catch(() => undefined);
    },

    async close(clients) {
      for (const client of clients ?? []) {
        try {
          client.destroy();
        } catch {
          // best effort: this method's job is teardown, not asserting client state.
        }
      }
      await bg.stop({ deadlineMs: 20_000 });
      // `bg.stop()` releases every live instance's profile lease and
      // terminates its browser via `NodeTransport`/`LocalNode`,
      // which removes it from `HostRuntime`'s own live map; this is the
      // real, primary cleanup path. `runtime.dispose()` is the safety net
      // for anything that slipped through (a launch that never made it
      // into a session, for example): with `killOnShutdown: true` it
      // SIGTERMs every process this runtime still tracks. `resolveConfig`'s
      // `deepFreeze` never walks into `config.runtime`'s own internals
      // so this same `runtime` reference, embedded
      // directly in `config`, is still safe to call `dispose()` on here.
      await runtime.dispose();
      // One further real Chrome process sweep as a last-resort backstop,
      // scoped to this run's own `profileRoot`, in case a launch died in
      // a way `dispose()`'s own bookkeeping never observed.
      //
      // Wrapped, because the probe itself can fail. It shells out to
      // `Get-CimInstance Win32_Process` through `execFileSync`, which on a
      // machine already running several real Chromes has been observed to
      // exceed its own timeout and throw `ETIMEDOUT`. Letting that escape
      // turns a best-effort sweep at the very end of teardown into a failed
      // `afterAll` hook, which reads like the suite broke when in fact
      // everything it was testing had already finished.
      try {
        const stragglers = chromeProcsForDataDir(profileRoot);
        for (const proc of stragglers) {
          try {
            killProcessTree(proc.pid, 'SIGKILL');
          } catch {
            // best effort
          }
        }
      } catch {
        // The primary cleanup paths above (`bg.stop()` and
        // `runtime.dispose()`) have already run; this sweep is the backstop
        // and is not worth failing teardown over.
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}
