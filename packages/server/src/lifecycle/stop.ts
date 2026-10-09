import {
  CloseCode,
  type InstanceLifecycleState,
  type Principal,
  type TerminateMode,
} from '@browserglass/protocol';
import type { InstanceView } from '@browserglass/router';
import type { Logger } from '../config/logger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { StopOptions, StopReport } from './types.js';
import type { RouterWiring } from './wiring.js';

/** Live-ish instance states worth draining. Matches the router's `requested|placing|launching` startup-reconcile set, widened with the post-launch states. */
const LIVE_STATES: readonly InstanceLifecycleState[] = [
  'requested',
  'placing',
  'launching',
  'ready',
  'degraded',
  'recovering',
];

/**
 * `store.listInstances`'s (`store-sqlite/src/store.ts`) default `LIMIT` is
 * 200 when no `limit` is given. Phase 5 below needs every live instance
 * for the tenant, not the 200 most recently created rows regardless of
 * state: past that default, a tenant with real history could miss
 * genuinely live instances outside the window entirely. This package has no pagination story yet, so "explicitly
 * unbounded" is the fix rather than a cursor loop; a tenant with more live
 * instances than this at shutdown time has bigger problems than this
 * constant.
 */
const STOP_LIST_LIMIT = 100_000;

/**
 * Margin phase 5 grants on top of `terminateBrowser`'s own step 5 budget
 * (`runtime-host/src/terminate.ts`'s `PROFILE_CLEAR_BUDGET_MS`), for the
 * ladder work that budget does NOT cover: step 2's (and, if the process
 * is still alive after it, step 4's) `killProcessTree` call, plus
 * `router.stop()`/`closeNodeTransport` below, which run inside this same
 * `withBudget` call after `Promise.allSettled` resolves. Not itself
 * derived from anything smaller; 3s is generous for two `taskkill /T /F`
 * invocations and the router's own bookkeeping, both of which are
 * genuinely fast operations even under the load this module's own
 * `PROFILE_CLEAR_BUDGET_MS` doc measured (unlike step 5's re-scan, they
 * do not poll a process table).
 */
const TERMINATE_LADDER_STEP_MARGIN_MS = 3_000;

/**
 * A MIRROR of `runtime-host/src/terminate.ts`'s `PROFILE_CLEAR_BUDGET_MS`,
 * deliberately duplicated as a literal rather than imported.
 *
 * `@browserglass/server` has NO dependency edge on
 * `@browserglass/runtime-host` (`config/types.ts` says so four times, and
 * that is why `ProfileFs` and the host runtime are injected by the
 * composition root rather than imported here). `runtime-host` is a
 * devDependency of this package, used by tests and adapters only, so a
 * VALUE import of it from `src` is bundled straight into
 * `packages/server/dist/index.mjs` by tsup, which externalises
 * `better-sqlite3` (`tsup.config.ts`) but cannot externalise the
 * workspace package that pulls it in. The result was a published `dist`
 * carrying a bare `import Database from "better-sqlite3"` that this
 * package does not declare and Node therefore cannot resolve:
 * `ERR_MODULE_NOT_FOUND ... imported from packages/server/dist/index.mjs`,
 * which broke every importer of `@browserglass/server`, the demo gateway
 * included.
 *
 * The drift this mirror could introduce is guarded where it costs
 * nothing: `test/lifecycle/terminate-budget.test.ts` imports the real
 * constant from `runtime-host` (legitimate in a test, which is never
 * bundled) and asserts both that this mirror still matches it and that
 * the derived budget still exceeds it. So a future change to
 * `PROFILE_CLEAR_BUDGET_MS` fails a test rather than silently
 * reintroducing the shutdown race documented below.
 */
const MIRRORED_PROFILE_CLEAR_BUDGET_MS = 15_000;

/**
 * Worst case duration of one instance's terminate ladder
 * (`terminateBrowser`, `runtime-host/src/terminate.ts`), derived from that
 * module's own `PROFILE_CLEAR_BUDGET_MS` rather than a second, independent
 * number here. Termination below runs every instance in parallel
 * (`Promise.allSettled`), so the phase's real worst case is one ladder's
 * length, not N of them (the previous
 * `deadlineMs * 0.4` flat-fraction budget terminated serially and was
 * smaller than even one instance's own ladder).
 *
 * MUST stay derived, not a second hardcoded literal: this budget wraps
 * `nodeTransport.terminate()`, whose own step 5 (`confirmProfileClear`)
 * cannot report success before `PROFILE_CLEAR_BUDGET_MS` elapses when a
 * straggler survives the first kill attempt. A hardcoded number here
 * previously drifted to 12000ms while `PROFILE_CLEAR_BUDGET_MS` was
 * independently raised from 5000ms to 15000ms (the confirm-dead scan
 * alone can cost up to ~4.4s under load, see that constant's own doc),
 * which meant this phase gave up and returned `deadlineExceeded: true`
 * before `terminateBrowser` could ever legitimately finish a slow
 * confirm, even though the underlying kill itself was working: the
 * `withBudget` race abandons the losing branch's RESULT, not the browser
 * process, so Chrome could still end up dead a few seconds after `stop()`
 * had already returned reporting failure.
 *
 * `test/lifecycle/terminate-budget.test.ts` exists so that drift is a
 * failing test, not a silent, hard-to-reproduce shutdown race the next
 * person has to rediscover from scratch. It cannot be an import-time
 * assertion here, because reading the real constant would mean a value
 * import of `@browserglass/runtime-host`; see
 * {@link MIRRORED_PROFILE_CLEAR_BUDGET_MS} for why that breaks the built
 * package outright.
 */
const TERMINATE_LADDER_BUDGET_MS =
  MIRRORED_PROFILE_CLEAR_BUDGET_MS + TERMINATE_LADDER_STEP_MARGIN_MS;

/**
 * Test-only re-exports. `test/lifecycle/terminate-budget.test.ts` asserts
 * the mirror above still matches `runtime-host`'s real constant; it cannot
 * do that without seeing both numbers, and neither is otherwise part of
 * this module's public surface.
 */
export const MIRRORED_PROFILE_CLEAR_BUDGET_MS_FOR_TEST = MIRRORED_PROFILE_CLEAR_BUDGET_MS;
export const TERMINATE_LADDER_BUDGET_MS_FOR_TEST = TERMINATE_LADDER_BUDGET_MS;

/** A synthetic, tenant-wide, fully privileged `Principal` used only for `stop()`'s own internal orchestration, never signed, never sent anywhere. */
function systemPrincipal(config: ResolvedConfig): Principal {
  return {
    tenantId: config.tenantId,
    appId: config.appId,
    sub: 'system:shutdown',
    subKind: 'service',
    caps: ['view', 'admin', 'instance.create', 'instance.destroy', 'profile.write'],
    scope: { kind: 'tenant' },
    jti: 'system:shutdown',
    exp: Math.floor(Date.now() / 1000) + 60,
  };
}

async function withBudget<T>(
  fn: () => Promise<T>,
  budgetMs: number,
  onExceeded: () => void,
): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<undefined>((resolve) => {
    timer = setTimeout(
      () => {
        onExceeded();
        resolve(undefined);
      },
      Math.max(0, budgetMs),
    );
    timer.unref?.();
  });
  try {
    return await Promise.race([fn(), budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Drives the `stop()` sequence.
 *
 * THE ORDERING, which is three way rather than two way, and the reason is
 * worth stating because getting it to two was a real defect:
 *
 * 1. Phase 4 releases every live instance's profile lease ROW, and only
 *    the row. No directory is touched.
 * 2. Phase 5 kills every browser process group.
 * 3. Phase 6 reclaims the profile DIRECTORIES, now that nothing holds
 *    them open.
 *
 * The rule "release profile leases before killing browsers" is satisfied
 * by step 1, and it is worth
 * being precise about what that requirement is FOR, because the imprecision
 * is what caused the defect. The requirement is about the LEASE ROW, not
 * about the bytes: releasing the row before killing anything means that if
 * this process dies part way through shutdown, the profile is not left
 * claimed by a holder that no longer exists, so another gateway can take
 * it. That argument says nothing about when the directory is reclaimed,
 * and it never needed to.
 *
 * Phases 4 and 6 used to be one call. `ProfileService.release()` does both
 * jobs, and does them in the order `fs.trash()` first, `releaseProfileLease()`
 * second. Once `ProfileFs.trash()` learned to refuse a directory a live
 * Chrome still holds, that first step began throwing during phase 4, which
 * meant the second step never ran: the lease row stayed claimed by a
 * process that was about to exit, which is precisely the failure C-SRV
 * item 3 exists to prevent. The directory was left in `profiles/` too,
 * never reaching `trash/`, so the profile trash sweep
 * (`wiring.ts`'s `scheduleProfileMaintenance`) could not collect it either:
 * that sweep empties the trash, it cannot gather what never got there.
 *
 * Splitting the two is better than choosing between the two orderings,
 * because both orderings are right about different things. The row must go
 * before the kill; the bytes can only go after it.
 *
 * `BrowserRouter.release()` sequences the whole thing the
 * other way internally, terminate then lease release, one instance at a
 * time, because there is no separate "release just the lease" entry point
 * on its public surface. This function therefore drives the steps directly
 * against the same `ProfileService`, `Store`, and `NodeTransport` the
 * router itself uses (all constructed by `buildRouterWiring` and held
 * here), and only then calls `router.stop()` so the router's own per
 * instance bookkeeping (store state transitions, timers) still runs, now
 * against already released, already terminated instances, where its own
 * release/terminate calls are idempotent no-ops.
 *
 * Never throws: every failure is recorded in `StopReport.forced` and
 * logged: `stop()` never throws.
 */
/**
 * Closes the peer sockets a `WebSocketNodeTransport` holds, if this
 * gateway is running as part of a cluster.
 *
 * `NodeTransport` does not declare `close()`, because a
 * `LocalNodeTransport` has nothing to close: it dispatches in process and
 * holds no handles. Only the WebSocket implementation does, and its own
 * doc comment already asked for exactly this ("a production wiring should
 * call this during its own shutdown sequence"). Nothing called it, which
 * did not matter while `buildRouterWiring` never constructed one, and
 * starts mattering the moment it does: an unclosed peer socket keeps the
 * event loop alive and leaves the peer holding a connection to a gateway
 * that has already stopped answering.
 *
 * Duck typed rather than `instanceof`, deliberately. `stop.ts` should not
 * grow a dependency on a concrete router class just to shut a socket, and
 * a hand assembled `RouterWiring` (the conformance suite builds these) can
 * supply any `NodeTransport` it likes. A transport with no `close` is not
 * an error, it is the ordinary single node case.
 */
function closeNodeTransport(wiring: RouterWiring, logger: Logger): void {
  const closable = wiring.nodeTransport as { close?: () => void };
  if (typeof closable.close !== 'function') return;
  try {
    closable.close();
  } catch (err) {
    logger.warn(
      { component: 'server', error: err instanceof Error ? err.message : String(err) },
      'stop: closing the node transport failed',
    );
  }
}

export async function runStop(
  config: ResolvedConfig,
  logger: Logger,
  wiring: RouterWiring | undefined,
  opts: StopOptions,
  hooks: {
    readonly notifyViewers?: (notice: {
      readonly level: 'warn';
      readonly text: string;
      readonly reconnectAfterMs: number;
    }) => Promise<number>;
    readonly closeViewerSockets?: (closeCode: number) => Promise<number>;
  } = {},
): Promise<StopReport> {
  const t0 = performance.now();
  const deadlineMs = opts.deadlineMs ?? 30_000;
  const closeCode = opts.closeCode ?? CloseCode.ServerShutdown;
  const instancesPolicy = opts.instances ?? (config.mode === 'embedded' ? 'release' : 'leave');
  const forced: { what: string; id: string }[] = [];
  let deadlineExceeded = false;
  const markExceeded = () => {
    deadlineExceeded = true;
  };

  // Phase 1: stop accepting. Synchronous by design; the caller (index.ts)
  // is responsible for flipping `readyz` to 503 and REST/router admission
  // to E_ROUTER_UNAVAILABLE before or immediately after calling this.
  logger.info({ component: 'server', phase: 1 }, 'stop: no longer accepting new work');

  // Before anything else, cancel the pending startup orphan sweep
  // (`lifecycle/wiring.ts`'s `scheduleOrphanSweep`). It is armed at boot
  // and fires roughly a minute later, so a gateway that starts and stops
  // inside that window would otherwise have a timer waiting to retire
  // instance rows on behalf of a process that no longer exists. Cancelling
  // first, ahead of the phases below, also keeps it from racing this
  // function own release and terminate work over the same rows.
  wiring?.orphanSweep?.cancel();
  // And the profile trash sweep, for the same reason: it is an interval,
  // so unlike the orphan sweep it would otherwise keep firing for the rest
  // of the process lifetime against a gateway that has stopped. Cancelled
  // here rather than in a later phase so it cannot run concurrently with
  // this function own profile lease releases below.
  wiring?.profileMaintenance?.cancel();

  let viewersClosed = 0;
  if (!(opts.immediate ?? false)) {
    // Phase 2: notify viewers.
    await withBudget(
      async () => {
        if (hooks.notifyViewers !== undefined) {
          await hooks.notifyViewers({
            level: 'warn',
            text: 'Server is shutting down',
            reconnectAfterMs: 2000,
          });
        }
      },
      Math.min(2000, deadlineMs * 0.1),
      markExceeded,
    );

    // Phase 3: close sockets.
    await withBudget(
      async () => {
        if (hooks.closeViewerSockets !== undefined) {
          viewersClosed = await hooks.closeViewerSockets(closeCode);
        }
      },
      deadlineMs * 0.15,
      markExceeded,
    );
  }

  let instancesReleased = 0;
  let instancesLeft = 0;

  if (wiring !== undefined) {
    // Nothing should still be renewing a lease once the gateway is coming
    // down; the loop stands itself down when the last lease goes anyway,
    // but a shutdown that releases every lease should not have to wait a
    // whole renew interval for that to be noticed.
    wiring.profileService.stopLeaseRenewal();
  }

  if (wiring !== undefined && instancesPolicy === 'release') {
    const principal = systemPrincipal(config);
    // Phase 4 releases the lease row through the store directly; see its
    // own comment for why it cannot go through `ProfileService.release()`.
    // `wiring` only exists for `mode: 'embedded' | 'supervised'`, and
    // `buildRouterWiring` refuses to build without a store, so this is
    // always present here. Left as `| undefined` and checked below rather
    // than asserted, so a future mode that breaks that invariant reports a
    // named failure per instance instead of throwing out of `stop()`,
    // which is not allowed to throw at all.
    const store = config.store;
    let live: readonly InstanceView[] = [];
    try {
      live = await wiring.router.list({ state: LIVE_STATES, limit: STOP_LIST_LIMIT }, principal);
    } catch (err) {
      logger.error(
        { component: 'server', error: err instanceof Error ? err.message : String(err) },
        'stop: failed to list live instances',
      );
    }

    // Phase 4: release every profile lease ROW, before any browser is
    // killed, and nothing else. See this function's own ordering comment
    // for why the row and the directory are now two separate phases.
    //
    // Goes straight to the store rather than through
    // `ProfileService.release()`, because that method reclaims the
    // directory first and would throw on a browser that is still running,
    // taking the row release down with it. `Store.releaseProfileLease` is
    // `UPDATE ... WHERE id = ? AND released_at IS NULL`, so phase 6's own
    // release of the same lease is a silent no-op rather than a
    // double release.
    //
    // The tracked in memory lease record is deliberately NOT cleared here:
    // `ProfileService.release()` is what clears it, and phase 6 still needs
    // it to resolve the profile this lease belonged to.
    const reclaim: { instanceId: string; leaseId: string; profileId: string | null }[] = [];
    await withBudget(
      async () => {
        for (const row of live) {
          const leaseId = wiring.profileService.leaseIdForInstance(row.instance.id);
          if (leaseId === null) continue;
          try {
            if (store === undefined)
              throw new Error(
                'no store is configured, so the profile lease row cannot be released',
              );
            await store.releaseProfileLease(leaseId, 'drain');
            instancesReleased += 1;
            reclaim.push({
              instanceId: row.instance.id,
              leaseId,
              profileId: row.instance.profileId,
            });
          } catch (err) {
            forced.push({ what: 'profile_lease_release_failed', id: row.instance.id });
            logger.warn(
              {
                component: 'server',
                instanceId: row.instance.id,
                error: err instanceof Error ? err.message : String(err),
              },
              'stop: profile lease release failed',
            );
          }
        }
      },
      deadlineMs * 0.1,
      markExceeded,
    );

    // Phase 5: terminate every browser process group, in parallel.
    // `Promise.allSettled` rather than a `for` loop awaiting each
    // terminate in turn: with N instances, serial termination needs
    // roughly N times one ladder's length, which is exactly what made the
    // old flat-fraction budget (`deadlineMs * 0.4`) too small to ever
    // finish for more than one or two instances.
    // In parallel, the whole phase costs about one ladder's length
    // regardless of N. `router.stop()` below (`drainNode`) walks every
    // tenant's own store rows independently and, since this loop does not
    // itself transition any instance's DB state, will very likely try to
    // terminate the same instances again; `LocalNode.terminate` (see its
    // own comment) is what makes that second call an idempotent no-op
    // rather than a "no launched handle" failure that would otherwise
    // wrongly look like a genuine terminate failure.
    const mode: TerminateMode =
      deadlineExceeded || (opts.immediate ?? false) ? 'force' : 'graceful';
    await withBudget(
      async () => {
        const results = await Promise.allSettled(
          live.map((row) => wiring.nodeTransport.terminate(wiring.nodeId, row.instance.id, mode)),
        );
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') return;
          const instanceId = live[i]?.instance.id;
          if (instanceId === undefined) return;
          forced.push({ what: 'terminate_failed', id: instanceId });
          logger.warn(
            {
              component: 'server',
              instanceId,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            },
            'stop: browser terminate failed',
          );
        });
        // Let the router's own bookkeeping (store state transitions, timer
        // teardown) catch up now that every instance is already
        // terminated; its own release()/terminate() calls become
        // idempotent no-ops. `drainNode` (inside `router.stop()`) will
        // very likely hit the same instances again (see `LocalNode.terminate`'s
        // own comment for why); it is a safe no-op, not a double kill.
        try {
          await wiring.router.stop({ drainMs: Math.max(0, deadlineMs * 0.4) });
        } catch (err) {
          logger.warn(
            { component: 'server', error: err instanceof Error ? err.message : String(err) },
            'stop: router.stop() failed',
          );
        }
        closeNodeTransport(wiring, logger);
      },
      TERMINATE_LADDER_BUDGET_MS,
      markExceeded,
    );

    // Phase 6: reclaim the profile directories, now that phase 5 has killed
    // every browser that was holding one open.
    //
    // This is a deliberate step with its own budget, not a retry loop and
    // not something left to a later timer to notice. `ProfileFs.trash()`
    // refuses to reclaim a directory a live Chrome still holds, so before
    // phase 5 this work simply could not succeed; after it, it can. Doing
    // it here is what puts the directory into `tenants/<t>/trash/`, which
    // is the only place the profile trash sweep
    // (`wiring.ts`'s `scheduleProfileMaintenance`) can ever collect it
    // from.
    //
    // `ProfileService.release()` is the right call now: its `fs.trash()`
    // step succeeds, its `releaseProfileLease` step is the idempotent
    // no-op phase 4 already made it, and it still performs the profile
    // state transition and clears the tracked lease record. The budget is
    // the other half of what phase 4 used to hold on its own: a directory
    // rename is orders of magnitude slower than the single indexed UPDATE
    // phase 4 now does, so the split is 0.1 to the row and 0.15 to the
    // bytes, leaving the total shutdown budget exactly where it was.
    await withBudget(
      async () => {
        for (const entry of reclaim) {
          try {
            const result = await wiring.profileService.release({
              leaseId: entry.leaseId,
              fence: -1,
              reason: 'drain',
            });
            for (const warning of result.warnings) {
              logger.warn(
                {
                  component: 'server',
                  instanceId: entry.instanceId,
                  profileId: entry.profileId,
                  warning,
                },
                'stop: profile reclaim warning',
              );
            }
          } catch (err) {
            // Loudly, per instance, with the path. Every filesystem
            // failure in this build names the directory in its own message
            // (`trash()`'s refusal quotes it, and an EPERM/EBUSY rename
            // carries both sides), and `profileId` is logged alongside so
            // the directory is findable even when the message is not
            // specific. A directory left behind and reported is
            // acceptable; a silent one is the defect this whole session
            // has been digging out.
            forced.push({ what: 'profile_dir_reclaim_failed', id: entry.instanceId });
            logger.warn(
              {
                component: 'server',
                instanceId: entry.instanceId,
                profileId: entry.profileId,
                error: err instanceof Error ? err.message : String(err),
              },
              'stop: profile directory reclaim failed; the directory is still on disk and will not be swept, since it never reached trash',
            );
          }
        }
      },
      deadlineMs * 0.15,
      markExceeded,
    );
  } else if (wiring !== undefined) {
    instancesLeft = 0;
    try {
      await wiring.router.stop({ drainMs: Math.max(0, deadlineMs * 0.4) });
    } catch (err) {
      logger.warn(
        { component: 'server', error: err instanceof Error ? err.message : String(err) },
        'stop: router.stop() failed',
      );
    }
  }

  // Backstop: release every configured `BrowserRuntime`'s own runtime-wide
  // resources. `HostRuntime.dispose()` (`runtime-host/src/runtime.ts`) is
  // the only reader of `killOnShutdown`, and before this line nothing in
  // `@browserglass/server` ever called `dispose()` (only
  // `cli/src/gateway.ts`'s `close()` did), so a config with
  // `killOnShutdown: true` was dead code: a non-graceful exit, or any
  // instance this phase's terminate calls above genuinely could not reach,
  // stranded every Chrome regardless of that setting. `dispose()` only kills browsers it still tracks as live when the
  // runtime itself was constructed with `killOnShutdown: true` (see that
  // method's own doc comment on `BrowserRuntime`); everything else, this
  // call is a no-op cleanup of internal state. Placed after the terminate
  // phase, not instead of it, so a normal graceful shutdown still goes
  // through the terminate ladder first and only falls back to this blunter
  // tool for whatever it missed.
  await withBudget(
    async () => {
      for (const runtime of config.runtimes) {
        try {
          await runtime.dispose();
        } catch (err) {
          forced.push({ what: 'runtime_dispose_failed', id: runtime.kind });
          logger.warn(
            {
              component: 'server',
              runtimeKind: runtime.kind,
              error: err instanceof Error ? err.message : String(err),
            },
            'stop: runtime dispose failed',
          );
        }
      }
    },
    Math.max(1000, deadlineMs * 0.05),
    markExceeded,
  );

  // Phase 6: flush.
  let storeFlushed = false;
  let auditFlushed = false;
  await withBudget(
    async () => {
      if (config.observability.auditSink !== undefined) {
        await config.observability.auditSink.flush();
        auditFlushed = true;
      }
      if (config.store !== undefined) {
        await config.store.close();
        storeFlushed = true;
      }
    },
    Math.max(1000, deadlineMs * 0.1),
    markExceeded,
  );

  return {
    durationMs: performance.now() - t0,
    viewersClosed,
    sessionsEnded: 0,
    instancesReleased,
    instancesLeft,
    storeFlushed,
    auditFlushed,
    deadlineExceeded,
    forced,
  };
}
