import type { NodeId, NodeState } from '@browserglass/protocol';
import type { BrowserRouter, LiveViewerPort, NodeActionExecutor } from '@browserglass/router';
import type { TokenApi } from '../auth/types.js';
import type { Logger } from '../config/logger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { PreflightDetectors } from './preflight.js';
import { runPreflight } from './preflight.js';
import { PreflightError, type StartReport, StoreError } from './types.js';
import { type RouterWiring, buildRouterWiring } from './wiring.js';

/**
 * Drives the fixed eight step `start()` order. Config resolution (step 1) has
 * already happened by the time this runs, inside `createBrowserGlass`
 * itself, with no I/O: every field this function reads is already frozen
 * on `config`. Steps 2 through 8 run here, in order:
 *
 * 2. preflight
 * 3. open the store, run or check migrations
 * 4. register the local node (embedded/supervised) or connect the remote
 *    control plane (gateway, not built yet)
 * 5. reconcile pools from `router.pools`
 * 6. start the router's reaper and reconcile loops
 * 7. reconcile the `instances` table against what is actually running on
 *    this node. Two halves, deliberately split:
 *
 *    The ADOPTIVE half runs inside `buildRouterWiring`, synchronously,
 *    before `router.start()` below. `reattachSurvivors` hands `LocalNode`
 *    a handle for every browser that outlived the previous process, and it
 *    cannot wait: until it has run, this gateway is serving instances it
 *    has no way to terminate.
 *
 *    The DESTRUCTIVE half is only ARMED here, and runs roughly a minute
 *    later (`scheduleOrphanSweep`). It is not part of `start()` at all, and
 *    `StartReport` therefore carries no result for it. That is not an
 *    omission. A process can complete `start()` and then die before it ever
 *    serves anything, and the first version of this step did exactly that
 *    damage: a duplicate `node server.mjs` ran `runStart`, retired the
 *    already running gateway instances, then failed to bind its port and
 *    exited. This SDK cannot see the application own `server.listen`, which
 *    happens after `start()` resolves in code the SDK does not own, so the
 *    only commitment it can honestly require of itself is that it is still
 *    alive when the timer fires.
 *
 *    This comment used to say step 7 was "delegated to `router.start()`,
 *    which reconciles against `requested|placing|launching` on its own
 *    node at startup". That was never true. `BrowserRouter.start()` is
 *    `markReady()` plus three `setInterval` registrations; it never reads
 *    the store and never adopts anything. Step 7 was simply absent, which
 *    is why instance rows from a killed process stayed `'live'` forever,
 *    consumed quota, and were handed back by sticky reuse as though a
 *    browser were behind them. The comment asserting a guarantee nothing
 *    provided is a large part of why the gap went unnoticed for as long as
 *    it did, so it is corrected here rather than left as decoration.
 * 8. flip `state` to `'running'` and start answering `readyz` 200
 *
 * Throws `PreflightError` (when `preflight.mode` is `'fail'` and a check
 * failed) or `StoreError`. Never opens a port itself: this package never
 * owns the HTTP server.
 */
export async function runStart(
  config: ResolvedConfig,
  logger: Logger,
  detectors: PreflightDetectors,
  /** Forwarded to `buildRouterWiring`'s own `actions` parameter; see that function's doc for why this cannot be wired after the fact. `src/index.ts` builds this from its own `SessionRegistry` before `start()` is ever called. */
  actions?: NodeActionExecutor,
  /**
   * Forwarded to `buildRouterWiring`'s own `deps` parameter. `viewers` is
   * the live viewer counter `BrowserRouter`'s viewer aware `release()`
   * reads, built by `src/index.ts` over the same `SessionRegistry`
   * `actions` comes from. `tokens` is `src/index.ts`'s own `tokenApi`
   * (built before `start()` is ever called): `buildRouterWiring` wraps it
   * into the real `AttachCredentialIssuer` `BrowserRouter.attachCredentials`
   * needs to mint a real, redeemable `attach()`/`acquire()` credential;
   * see `wiring.ts`'s `attachCredentialIssuerFor` for why this cannot be
   * built inside `@browserglass/router` itself.
   */
  deps?: { readonly viewers?: LiveViewerPort; readonly tokens?: TokenApi },
): Promise<{ readonly report: StartReport; readonly wiring: RouterWiring | undefined }> {
  const startedAt = Date.now();
  const t0 = performance.now();
  const warnings: { code: string; message: string }[] = [...config.configWarnings];

  // Step 2: preflight, before the store opens and before any port a caller
  // might bind based on this call having succeeded.
  const preflight = await runPreflight(config, detectors, logger);
  const failed = preflight.filter((r) => r.verdict === 'fail');
  if (failed.length > 0 && config.preflight.mode === 'fail') {
    throw new PreflightError(preflight);
  }
  for (const r of failed) {
    warnings.push({ code: `preflight.${r.name}`, message: r.detail });
  }

  // Step 3: open the store, run or check migrations.
  let migrationsApplied = 0;
  let schemaVersion = 0;
  let storeDriver = 'none';
  if (config.store !== undefined) {
    storeDriver = config.store.capabilities().transactions ? 'transactional' : 'unknown';
    try {
      await config.store.init();
      if (config.migrate === 'auto') {
        const report = await config.store.migrate();
        migrationsApplied = report.applied.length;
        schemaVersion = report.toVersion;
      } else if (config.migrate === 'check') {
        schemaVersion = await config.store.schemaVersion();
      } else {
        schemaVersion = await config.store.schemaVersion();
      }
    } catch (err) {
      throw new StoreError(
        'E_STORE_OPEN_FAILED',
        `Failed to open or migrate the store: ${err instanceof Error ? err.message : String(err)}`,
        {
          cause: err,
        },
      );
    }
  }

  // Steps 4 through 7: register the local node, reconcile pools, start
  // the router's own reaper/reconcile/warm-pool loops, and adopt orphaned
  // instances. `gateway` mode has no local node to build; a remote
  // control-plane connection is not implemented yet.
  let wiring: RouterWiring | undefined;
  const nodes: { nodeId: NodeId; state: NodeState }[] = [];
  const pools: { name: string; poolId: string; created: boolean }[] = [];

  if (config.mode === 'embedded' || config.mode === 'supervised') {
    wiring = await buildRouterWiring(config, actions, {
      logger,
      ...(deps?.viewers !== undefined ? { viewers: deps.viewers } : {}),
      ...(deps?.tokens !== undefined ? { tokens: deps.tokens } : {}),
    });
    try {
      await wiring.router.start();
    } catch (err) {
      // `buildRouterWiring` has already armed the deferred orphan sweep by
      // this point. A start that fails here leaves `createBrowserGlass`
      // holding no `wiring` reference (`index.ts` assigns it only on
      // success), so nothing would be able to cancel that timer later. Do
      // it here, while the handle is still in scope: a process whose start
      // failed has no business retiring anybody instance rows a minute
      // from now, least of all another live process ones.
      wiring.orphanSweep?.cancel();
      throw err;
    }
    nodes.push({ nodeId: wiring.nodeId, state: 'ready' });
    for (const pool of config.router.pools) {
      pools.push({ name: pool.name, poolId: pool.name, created: true });
    }
  } else {
    warnings.push({
      code: 'gateway.not_implemented',
      message:
        'mode "gateway" has no remote control plane connection in this build; router.* calls will be unavailable.',
    });
  }

  const durationMs = performance.now() - t0;
  const report: StartReport = {
    startedAt,
    durationMs,
    mode: config.mode,
    preflight,
    store: { driver: storeDriver, migrationsApplied, schemaVersion },
    runtimes: config.runtimes.map((r) => ({
      name: r.kind,
      ready: true,
      detail: `${r.kind} runtime configured`,
    })),
    nodes,
    pools,
    warnings,
  };

  return { report, wiring };
}

/** Type only re-export so callers of `runStart` don't need a second import for the router handle. */
export type { BrowserRouter };
