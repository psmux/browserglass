/**
 * The real `ManagedSessionFactory`: reaches `@browserglass/router`'s
 * `BrowserRouter.describe()` for `Instance.runtime.cdpWsUrl` (router's own
 * `attach()` never populates this, since router has no CDP access),
 * connects a `CdpBridge`, starts a `TargetRegistry` on top of
 * it, and constructs the `ManagedSession`. This is the one file in the
 * session layer that imports `@browserglass/router`.
 */

import {
  type CdpBridge,
  type ProxyAuthCredentials,
  type SessionControlOptions,
  type StealthProfileHooks,
  type TargetRegistry,
  createCdpBridge,
  createTargetRegistry,
} from '@browserglass/core';
import {
  type AppId,
  BglsError,
  type BrowserSpec,
  type Capability,
  type Principal,
  type Scope,
  type StealthProfile,
  type TenantId,
  newId,
} from '@browserglass/protocol';
import type { Logger } from '../config/logger.js';
import type { DownloadStore } from '../downloads/download-store.js';
import type { HookRegistry } from '../hooks/dispatch.js';
import type { SessionStartedEvent } from '../hooks/types.js';
import type { RouterWiring } from '../lifecycle/wiring.js';
import { ManagedSession } from './managed-session.js';
import type { ManagedSessionFactory, ManagedSessionFactoryContext } from './registry.js';

/**
 * Turns the `{name, level, version}` metadata that DID cross the process
 * boundary (`Instance.runtime.stealthProfile`) back into the live
 * `initScripts`/`onTargetAttached` functions the launching runtime
 * resolved, by matching it against the same `StealthProfile` objects this
 * gateway was handed in `RuntimeConfig.stealthProfiles`.
 *
 * WHY THIS IS A LOOKUP AND NOT A HANDOFF. `StealthProfile` carries
 * functions. Functions do not serialise, and the runtime that launched an
 * instance may not be this process at all
 * (`packages/protocol/src/domain/runtime.ts`; `packages/server` has no
 * dependency edge on `@browserglass/runtime-host`, said twice in
 * `config/types.ts` for `ProfileFs` and `BrowserRuntime`). So the gateway
 * is given its own copies of the profile objects and looks up the one the
 * launch recorded. That was the missing piece: before this, both
 * `createTargetRegistry` call sites in this file passed three arguments to
 * a four argument constructor, so `StealthProfile.initScripts(spec)` and
 * `onTargetAttached` were resolved by `runtime-host` and then never
 * applied to anything. Only `launchArgs` ever reached Chrome, while
 * `LaunchedBrowser.stealthProfile` reported the profile as having run.
 *
 * REFUSAL, NOT DOWNGRADE. `name`, `level` and `version` must all match
 * exactly. `StealthProfile.version` is semver for the profile's own
 * CONTENT (see `runtime-host`'s `basic.ts`, which says to bump it whenever
 * a patch changes), so two processes holding different revisions of the
 * same name are two different sets of patches. Running the gateway's
 * revision against a browser launched under the runtime's would produce an
 * environment neither side described, and it would do it silently. A
 * mismatch throws, and the WS attach fails with it, which is the loud
 * outcome.
 *
 * `null` in, `null` out: `spec.stealth: 'off'` never records a profile
 * (`runtime-host`'s `resolveRequiredStealthProfile` returns null for
 * `'off'`), so an apply-shaped instance reaches this function with nothing
 * to look up and gets no hooks. That is how `'off'` stays off after this
 * fix, and there is a test asserting it.
 */
export function resolveStealthHooks(
  ref:
    | { readonly name: string; readonly level: 'basic' | 'full'; readonly version: string }
    | null
    | undefined,
  spec: BrowserSpec,
  profiles: readonly StealthProfile[],
): StealthProfileHooks | null {
  if (!ref) return null;
  const byName = profiles.filter((p) => p.name === ref.name);
  if (byName.length === 0) {
    throw new BglsError(
      'E_STEALTH_PROFILE_MISSING',
      `instance was launched under stealth profile '${ref.name}' (level ${ref.level}, version ${ref.version}) but this gateway has no profile registered under that name; pass it in RuntimeConfig.stealthProfiles`,
      { context: { name: ref.name, level: ref.level, version: ref.version } },
    );
  }
  const exact = byName.find((p) => p.version === ref.version && p.level === ref.level);
  if (!exact) {
    throw new BglsError(
      'E_STEALTH_PROFILE_MISSING',
      `stealth profile '${ref.name}' is registered on this gateway at ${byName.map((p) => `${p.level}/${p.version}`).join(', ')}, but the instance was launched under ${ref.level}/${ref.version}; refusing to apply a different revision of the same name`,
      {
        context: {
          name: ref.name,
          wanted: `${ref.level}/${ref.version}`,
          have: byName.map((p) => `${p.level}/${p.version}`),
        },
      },
    );
  }
  return {
    initScripts: exact.initScripts(spec),
    onTargetAttached: (ctx) => exact.onTargetAttached(ctx),
  };
}

/**
 * Maps `BrowserSpec.clientHints` to CDP `Emulation.setUserAgentOverride`'s
 * `userAgentMetadata` shape. Mirrors `runtime-remote`'s own
 * `toUserAgentMetadata` (`packages/runtime-remote/src/spec-apply.ts:109-122`)
 * exactly, duplicated rather than imported: `packages/server` has no
 * dependency edge on `@browserglass/runtime-remote` (same package boundary
 * `resolveStealthHooks`'s own comment above names for `runtime-host`), and
 * the mapping is a handful of fields with no shared state to drift.
 */
function toUserAgentMetadata(
  hints: BrowserSpec['clientHints'],
): Record<string, unknown> | undefined {
  if (!hints) {
    return undefined;
  }
  return {
    brands: hints.brands.map((b) => ({ brand: b.brand, version: b.version })),
    platform: hints.platform ?? '',
    platformVersion: hints.platformVersion ?? '',
    architecture: hints.architecture ?? '',
    model: hints.model ?? '',
    mobile: hints.mobile ?? false,
    fullVersion: hints.fullVersion ?? '',
  };
}

/**
 * Closes the gap `runtime-host/src/flags.ts` (around line 344-349) names in
 * its own comment: `--user-agent=<spec.userAgent>` changes the UA STRING at
 * launch, but `navigator.userAgentData` is built from Chrome's own brand
 * list, not parsed back out of that flag, so a host-launched instance whose
 * spec carries `clientHints` reported a spoofed `navigator.userAgent` next
 * to an UNMODIFIED `navigator.userAgentData`. That mismatch is itself a
 * strong automation signal, so it silently undermined the stealth feature.
 *
 * `runtime-remote`'s `applyResolvedSpec` (`spec-apply.ts:175-184`) already
 * sends `Emulation.setUserAgentOverride` with `userAgentMetadata` once, at
 * attach time, for a browser it did not launch. This is the same CDP call
 * for an instance this gateway drives regardless of which runtime launched
 * it, sent once per attached page/iframe target rather than once per
 * browser: `Emulation` is a CDP-session-scoped domain, so a target that
 * attaches with a fresh session (a tab opened after this factory's first
 * attach, or any target's cross origin navigation, `target-registry.ts`'s
 * `handleAttachedToTarget`) would otherwise keep whatever Chrome's own
 * default `userAgentData` reported. Wired through the same
 * `StealthProfileHooks.onTargetAttached` slot `resolveStealthHooks` already
 * fills, via `composeTargetAttachedHooks` below, since `TargetRegistry`
 * already re-runs that hook on every fresh target session and this needed
 * nothing new from `target-registry.ts` to do the same.
 *
 * `null` when `spec.userAgent` is `null`: `Emulation.setUserAgentOverride`
 * requires `userAgent` as a mandatory CDP parameter, so there is nothing
 * honest to send when the spec never asked for a UA override at all,
 * matching `spec-apply.ts`'s own `if (spec.userAgent !== null)` gate.
 * Applying this for a remote-launched instance too (not just host) is
 * intentional and harmless: `runtime-remote` already sent the same call
 * once at launch, so this repeats it, idempotently, on every subsequent
 * target that browser-level, one-shot call could never have reached.
 */
function resolveClientHintsHook(spec: BrowserSpec): StealthProfileHooks | null {
  if (spec.userAgent === null) {
    return null;
  }
  const userAgent = spec.userAgent;
  return {
    initScripts: [],
    onTargetAttached: async (ctx) => {
      await ctx.send('Emulation.setUserAgentOverride', {
        userAgent,
        userAgentMetadata: toUserAgentMetadata(spec.clientHints),
      });
    },
  };
}

/**
 * Closes the gap `packages/runtime-host/src/runtime.ts`'s
 * `proxyAuthPerInstance: false` note names precisely: `BrowserSpec.proxy.username`/
 * `.password` (`@browserglass/protocol`'s `entities.ts`) reach this
 * process (via `router.describe()`'s `view.instance.spec`, same source
 * `spec.initScripts` and `spec.stealth` already come from a few lines
 * below) but nothing ever turned them into `createTargetRegistry`'s fifth
 * argument, so `ProxyAuthHandler` (`core/src/cdp/proxy-auth.ts`) never got
 * armed for ANY instance, host-launched or otherwise, regardless of what
 * an operator configured. This is that missing conversion, done exactly
 * where `createTargetRegistry` is actually called (both call sites in
 * this file), the same seam `runtime.ts`'s own note names.
 *
 * `null` unless BOTH `username` and `password` are non-null, non-empty
 * strings. `ProxySpec` allows either half to be `null` independently
 * (`entities.ts`: "supplied per acquire"), and CDP's
 * `Fetch.continueWithAuth` has no honest partial answer to a proxy
 * challenge armed with only one half of a credential pair -- arming it
 * anyway would either send an empty string as the other half (Chrome
 * would then fail the challenge exactly as if no credentials were
 * configured at all, just less legibly) or throw, neither of which is
 * better than the plain "no credentials" this function already returns
 * for a spec with no proxy at all. Treating a half-configured spec as "no
 * credentials" keeps this function's contract simple and matches
 * `installProxyAuth`'s own no-op default (`target-registry.ts`: `null`
 * arms nothing).
 *
 * NEVER LOGGED. This function's return value carries `password` in plain
 * text (as `ProxyAuthCredentials` itself documents it must, for
 * `Fetch.continueWithAuth`'s own sake); it is passed straight into
 * `createTargetRegistry` below and nowhere else in this file, never
 * spread into a log line, an error, or a hook payload. See
 * `test/session/factory-proxy-auth.test.ts`'s dedicated "never leaks"
 * assertion.
 */
function resolveProxyAuthCredentials(spec: BrowserSpec): ProxyAuthCredentials | null {
  const proxy = spec.proxy;
  if (!proxy || !proxy.username || !proxy.password) {
    return null;
  }
  return { username: proxy.username, password: proxy.password };
}

/**
 * Composes two `StealthProfileHooks` into one, since `createTargetRegistry`'s
 * fourth argument accepts exactly one and this factory now has two
 * independent sources for it: {@link resolveClientHintsHook} (spec-derived,
 * always eligible) and {@link resolveStealthHooks} (profile-derived, only
 * when `spec.stealth` is not `'off'`). Client hints run FIRST, before any
 * stealth patch, the same "environmental before functional" ordering
 * `target-registry.ts`'s constructor comment already gives for
 * `initScripts` (stealth scripts ahead of `spec.initScripts`): a stealth
 * profile probing `navigator.userAgentData` itself should see the corrected
 * value, not race it. Either side may be `null` (no clientHints override
 * needed, or no stealth profile for this instance); a `null` side degrades
 * to the other side untouched, and both `null` degrades to `null` so a spec
 * asking for neither keeps `createTargetRegistry`'s existing no-op default.
 */
function composeTargetAttachedHooks(
  clientHints: StealthProfileHooks | null,
  stealth: StealthProfileHooks | null,
): StealthProfileHooks | null {
  if (!clientHints) return stealth;
  if (!stealth) return clientHints;
  return {
    initScripts: [...clientHints.initScripts, ...stealth.initScripts],
    onTargetAttached: async (ctx) => {
      await clientHints.onTargetAttached(ctx);
      await stealth.onTargetAttached(ctx);
    },
  };
}

/** Builds a synthetic, tenant-scoped, all-capability `Principal` for this process's own internal `router.describe()` reads. Never sent anywhere, never logged as a real credential: it exists only to satisfy `BrowserRouter`'s method signature for a purely internal call the gateway itself makes on a viewer's behalf. */
function internalPrincipal(tenantId: string, appId: string): Principal {
  const scope: Scope = { kind: 'tenant' };
  return {
    tenantId: tenantId as TenantId,
    appId: appId as AppId,
    sub: 'bgls:internal',
    subKind: 'service',
    caps: ['view', 'admin'] as Capability[],
    scope,
    jti: 'internal',
    exp: Number.MAX_SAFE_INTEGER,
  };
}

/**
 * Builds {@link ManagedSessionFactory} bound to a `RouterWiring` getter.
 * `getWiring` is a closure, not a direct reference, because
 * `createBrowserGlass()` constructs this factory (and the `SessionRegistry`
 * it feeds) before `start()` has resolved the router wiring (`router` and
 * `nodeId` are both only known once `start()` completes); matches
 * `restContext.getRouter`'s identical pattern in `packages/server/src/index.ts`.
 */
export function createManagedSessionFactory(
  getWiring: () => RouterWiring | undefined,
  logger?: Logger,
  control?: SessionControlOptions,
  /**
   * Threaded through for two reasons: this factory is the one and only
   * place `onSessionStarted` can honestly fire (`SessionRegistry.getOrCreate`'s
   * own doc, `registry.ts`, says this function runs exactly once per fresh
   * `ManagedSession`, never on a join to an already-live one, which is
   * what makes "session started" true here and nowhere else reachable from
   * `packages/server`), and it is also handed straight into `ManagedSession`
   * itself (below) so `dispatchEffect`'s recovery cases can fire
   * `onRecovery`.
   */
  hooks?: HookRegistry,
  /**
   * The gateway's one `DownloadStore` and the directory
   * `Session.startDownloadCapture` must arm `Page.setDownloadBehavior`
   * with, threaded through for the same reason `hooks` is: this factory is
   * the one place building every `ManagedSession`, and downloads (like
   * `hooks`) are a cross cutting dependency `ManagedSession` needs handed
   * in rather than looked up itself (`ManagedSession` has no reach into
   * `packages/server/src/index.ts`'s composition root, same boundary
   * `defaultNewWindow`'s own doc comment names). Optional so
   * every existing caller and test harness that builds this factory
   * without the download feature keeps working with `download` capability
   * viewers simply never triggering CDP capture (`ManagedSession.ensureDownloadCapture`'s
   * own null check).
   */
  downloads?: { readonly store: DownloadStore; readonly dir: string },
  /**
   * `ResolvedConfig.stealthProfiles`, the live `StealthProfile` objects an
   * operator handed both this gateway and its `runtime-host`. Threaded in
   * for the same reason `hooks` and `downloads` are: this factory is the
   * one place that builds a `TargetRegistry`, and the registry's fourth
   * constructor argument is where a profile's per target CDP work has to
   * land. See {@link resolveStealthHooks}.
   *
   * Empty (the default) is the right value for every deployment whose
   * specs say `stealth: 'off'`, which is the only level enabled unless an
   * operator opts in.
   */
  stealthProfiles: readonly StealthProfile[] = [],
  /**
   * The directory `ManagedSession.startRecording()`'s `DiskRecordingSink`
   * (`../recording/disk-recording-sink.ts`) writes each recording's frames
   * and sidecar index under, threaded through for the same reason
   * `downloads` above is: this factory is the one place building every
   * `ManagedSession`, and it has no reach into `packages/server/src/index.ts`'s
   * composition root (see `defaultNewWindow`'s own doc comment).
   * Optional so every existing caller and test harness that builds this
   * factory without it keeps working, with `recording.start` simply
   * refusing (`ManagedSession.startRecording`'s own check).
   */
  recordings?: { readonly dir: string },
): ManagedSessionFactory {
  return async (instanceId: string, ctx: ManagedSessionFactoryContext): Promise<ManagedSession> => {
    const wiring = getWiring();
    if (!wiring) {
      throw new Error(
        'The router is not ready yet (call start() before accepting WS connections).',
      );
    }
    const { router, nodeId } = wiring;
    const principal = internalPrincipal(ctx.tenantId, ctx.appId);
    // The same authority gate `rest/routes/targets.ts`'s `resolveDrive`
    // calls for REST: honest `E_INSTANCE_NOT_FOUND`/`E_INSTANCE_GONE`/
    // `E_INSTANCE_NOT_READY` instead of this file's own former bespoke
    // "no live CDP endpoint" `Error`, plus the one activity/audit touch a
    // fresh WS attach counts as (`driveInstance`'s own doc: unconditional,
    // already throttled). Does not replace the `describe()` call below:
    // `driveInstance` only resolves node/session/liveness, never
    // `runtime.cdpWsUrl` or `spec.isolation`, which this factory still
    // needs to actually connect a `CdpBridge`.
    //
    // `local: false` used to fall through to `describe()` and then the
    // generic "no live CDP endpoint" error below, which told a viewer
    // nothing beyond "not ready" even though the router had already worked
    // out exactly why: the instance is real and running, just not on this
    // process. Streaming a viewer's frames through the router as a proxy
    // is deliberately out (`docs/scaling.md`'s control/data path split;
    // frames run at ~100/sec/stream, so the WS attach path stays
    // direct-only), so this
    // gateway genuinely cannot serve the viewer itself. What it CAN do
    // honestly is say which node can: `resolution.nodeId`. It cannot say
    // WHERE that node is reachable. `Node.dataPlaneUrl`
    // (`packages/protocol/src/domain/entities.ts`) is where a reachable
    // address for a node would live, but nothing in this build populates
    // it outside router's own test fixtures (no node registration flow
    // exists yet), and `BrowserRouter` exposes no method to read a `Node`
    // record by id even if it were populated. Inventing an endpoint here
    // would be lying to the caller; naming the node and stopping is not.
    // `ws/connection.ts`'s `processHello` turns this into
    // `bgls.error.instance.wrong_node` with `context.nodeId` instead of
    // the misleading `bgls.error.instance.not_found` every WS attach
    // failure used to share.
    const resolution = await router.driveInstance(instanceId as never, principal);
    if (!resolution.local) {
      throw new BglsError(
        'E_INSTANCE_WRONG_NODE',
        `instance ${instanceId} is driven by node ${resolution.nodeId}, not this gateway`,
        { context: { nodeId: resolution.nodeId } },
      );
    }
    const view = await router.describe(instanceId as never, principal);
    const cdpWsUrl = view.instance.runtime?.cdpWsUrl;
    if (!cdpWsUrl) {
      throw new Error(`instance ${instanceId} has no live CDP endpoint (runtime not ready)`);
    }
    const bridge = createCdpBridge(instanceId as never);
    await bridge.connect({ url: cdpWsUrl });
    // `view.instance.spec.initScripts` (`BrowserSpec.initScripts`,
    // `@browserglass/protocol`): plain data (`{name, source}[]`), already
    // in scope from the `describe()` call above, and `createTargetRegistry`'s
    // own third argument is exactly where its doc comment
    // (`core/src/cdp/target-registry.ts`) says the caller assembling a
    // fresh `CdpBridge`/registry pair is responsible for passing it.
    // Omitted before this fix (this call site was one of the "two call
    // sites outside this package" that comment names as still owing it),
    // so an operator's `spec.initScripts` silently never ran through the
    // server path, however it launched.
    //
    // The fourth argument, `StealthProfileHooks`, is now resolved rather
    // than omitted. What reaches this process is
    // `Instance.runtime.stealthProfile`, metadata only
    // (`{name, level, version}`); `resolveStealthHooks` matches it against
    // the profile objects this gateway was configured with and hands back
    // the live `initScripts(spec)`/`onTargetAttached` pair, or `null` when
    // the launch recorded no profile at all (which is every
    // `stealth: 'off'` instance). It throws rather than degrading when the
    // two processes disagree about a name or a version.
    //
    // Composed with `resolveClientHintsHook`, unconditionally: unlike
    // stealth, `clientHints` is not gated behind an opt in level, so this
    // runs for every instance whose spec carries a `userAgent` regardless
    // of `spec.stealth`. See both functions' own doc comments above.
    const registry = createTargetRegistry(
      instanceId as never,
      bridge,
      view.instance.spec.initScripts,
      composeTargetAttachedHooks(
        resolveClientHintsHook(view.instance.spec),
        resolveStealthHooks(
          view.instance.runtime?.stealthProfile,
          view.instance.spec,
          stealthProfiles,
        ),
      ),
      // `view.instance.spec.proxy.username`/`.password`, when both set:
      // arms `ProxyAuthHandler` on every page/iframe target this registry
      // attaches. See `resolveProxyAuthCredentials`'s own doc for why this
      // was previously never threaded through, and for the "never logged"
      // guarantee this value carries.
      resolveProxyAuthCredentials(view.instance.spec),
    );
    await registry.start();

    // `Instance.sessionId` is authoritative when the router already created
    // one at launch; a fresh `sess_` id is minted only for the degenerate
    // case of an instance whose session row does not exist yet.
    const sessionId = view.instance.sessionId ?? newId('sess');

    // `ManagedSession` has no reach of its own into router state (the
    // same reason `cdpWsUrl` above comes from `router.describe()` rather
    // than a lookup `ManagedSession` performs itself); this is the one
    // place that already holds `Instance.spec`, so the isolation mode a
    // bare `target.new` should default to is resolved here and passed in
    // already-decided rather than handed a `BrowserSpec` to interpret.
    const defaultNewWindow = view.instance.spec.isolation === 'window';

    // Non-vetoing (`HOOK_TIMEOUTS.onSessionStarted`, `hooks/types.ts`), so
    // this is fired and awaited here rather than left fire-and-forget: a
    // handler that throws or times out is already swallowed and logged by
    // `HookRegistry.dispatch` itself (`hooks/dispatch.ts`), never surfaced
    // to this factory, so awaiting it costs nothing beyond
    // `HOOK_TIMEOUTS.onSessionStarted.timeoutMs` (2000ms) added to a WS
    // attach that is already doing a CDP connect and a `TargetRegistry`
    // start, both slower than that budget in the common case.
    if (hooks) {
      const startedEvent: SessionStartedEvent = {
        at: Date.now(),
        tenantId: ctx.tenantId,
        appId: ctx.appId,
        requestId: newId('evt'),
        sessionId,
        instanceId,
      };
      await hooks.dispatch('onSessionStarted', startedEvent);
    }

    return new ManagedSession({
      instanceId,
      sessionId,
      tenantId: ctx.tenantId,
      appId: ctx.appId,
      nodeId,
      // `view.instance.spec.stealth` is this factory's one guaranteed source
      // of the operator's stealth intent (`resolveStealthHooks` above reads
      // the SAME `view.instance.spec`, a few lines up): `ManagedSession`
      // otherwise never sees a `BrowserSpec` at all (see its own module doc
      // on why: `Session` deliberately has no opinion on it either). Reduced
      // to a plain boolean, not the `'basic'`/`'full'` level itself, because
      // the diagnostics stealth-conflict gate this feeds
      // (`ManagedSession.subscribeDiagnostics`) does not vary by level: any
      // non-`'off'` level is an operator asking this browser not to carry
      // the `Runtime.enable` fingerprint, and `console`/`errors` diagnostics
      // reintroduce that fingerprint identically regardless of which level
      // was requested.
      stealthActive: view.instance.spec.stealth !== 'off',
      // Wires `SessionRegistry.evict(instanceId)` (`ctx.onIdle`, set by
      // `getOrCreate`, `registry.ts`) to fire the moment this session's
      // last viewer disconnects (`ManagedSession`'s own `onIdle` option,
      // fired once `connections.size === 0`, `managed-session.ts`).
      // Previously omitted entirely, which is why `evict` was dead code
      // outside `disposeAll()`: nothing ever told a `ManagedSession` its
      // own registry wanted to know when it went idle, so its `CdpBridge`
      // and `TargetRegistry` lived until process shutdown regardless of
      // how long ago the last viewer left.
      onIdle: ctx.onIdle,
      bridge,
      registry,
      restartInstanceExecutor: buildRestartInstanceExecutor(
        router,
        instanceId,
        principal,
        stealthProfiles,
        logger,
      ),
      defaultNewWindow,
      ...(hooks ? { hooks } : {}),
      ...(downloads ? { downloadStore: downloads.store, downloadDir: downloads.dir } : {}),
      ...(recordings ? { recordingsDir: recordings.dir } : {}),
      // Keeps `Instance.lastActivityAt` current so the router's idle sweep
      // can tell a browser somebody is driving from one nobody has touched.
      // Calls `driveInstance` itself, not `recordActivity` directly, so
      // the WS input path goes through the same gate every other driving
      // surface does (the gate is uniform across surfaces): on the hot path this is a `driveCache` hit, an
      // in-memory map lookup, plus the same throttled `recordActivity`
      // call `driveInstance` already makes unconditionally, so calling it
      // once per input event costs nothing beyond what a bare
      // `recordActivity` call already cost here. Deliberately fire and
      // forget: a failed activity touch (or, now, a resolution that
      // throws because the instance was released mid session) must never
      // break the input path.
      onActivity: () => {
        void router.driveInstance(instanceId as never, principal).catch(() => undefined);
      },
      // `ResolvedConfig.session.control`, resolved once by
      // `createBrowserGlass()` and handed to this factory rather than read
      // here: this file already holds a router dependency and must not grow
      // a config one too. Omitted when the caller passed nothing, so core's
      // exclusive defaults stand.
      ...(control ? { control } : {}),
      // So `withRestControl` can announce a REST input that may have been
      // discarded. That path is otherwise completely silent: the caller gets
      // a success, the page does not move, and `InputDispatcher`'s drop
      // signal goes to a `core` callback wired to an empty function.
      ...(logger ? { logger } : {}),
    });
  };
}

/**
 * The real `R4` mechanism: calls
 * `BrowserRouter.restart()` (terminate, preserve-or-destroy the profile,
 * relaunch, all under the SAME `instanceId`), then connects a brand new
 * `CdpBridge`/`TargetRegistry` pair to the fresh `cdpWsUrl`, exactly the
 * same two calls this file's own factory function above makes for a first
 * attach. Returns `{ ok: false }` on any failure (the router call itself,
 * the bridge connect, or the registry start), never throws, matching
 * `core.Session.restartInstanceExecutor`'s contract.
 */
function buildRestartInstanceExecutor(
  router: RouterWiring['router'],
  instanceId: string,
  principal: Principal,
  stealthProfiles: readonly StealthProfile[],
  logger?: Logger,
): (
  lastUrl: string | null,
  preserveProfile: boolean,
) => Promise<
  | { readonly ok: false }
  | { readonly ok: true; readonly bridge: CdpBridge; readonly registry: TargetRegistry }
> {
  return async (_lastUrl, preserveProfile) => {
    // Which of the three steps failed matters a great deal when a restart
    // does not come back, and the wire error a viewer receives
    // ('the browser could not be relaunched') deliberately says nothing
    // about internals. Swallowing the cause entirely left an operator with
    // no way at all to tell a Chrome launch failure from a profile lease
    // problem from a CDP connect timeout, so each step names itself here.
    let step: 'router.restart' | 'bridge.connect' | 'registry.start' = 'router.restart';
    try {
      const restarted = await router.restart(instanceId as never, principal, { preserveProfile });
      step = 'bridge.connect';
      const bridge = createCdpBridge(instanceId as never);
      await bridge.connect({ url: restarted.cdpWsUrl });
      step = 'registry.start';
      // `RestartResult` (`router/types.ts`) carries no `spec`, only
      // reconnection details (`cdpWsUrl`, `profileId`, `fence`); a restart
      // never changes `BrowserSpec.initScripts` for the same instance
      // (same instanceId, same spec row), so this extra `describe()` read
      // is the only way to hand `createTargetRegistry` the same
      // `initScripts` the fresh-attach path above passes, rather than
      // silently reverting to none on every restart.
      const view = await router.describe(instanceId as never, principal);
      // Same fourth argument as the fresh attach path above, and for the
      // same reason: a restart builds a brand new registry against a brand
      // new Chrome, so a profile that was applied on first attach must be
      // applied again or the relaunched browser silently loses its
      // patches. `router.restart()` keeps the same instanceId and the same
      // spec row, so the profile reference is the same one. Composed with
      // `resolveClientHintsHook` for the same reason as the fresh attach
      // path: a restart relaunches Chrome, and a host relaunch reapplies
      // `--user-agent` (`runtime-host/src/flags.ts`) but not
      // `userAgentMetadata`, which still needs this hook on the new
      // registry's targets.
      const registry = createTargetRegistry(
        instanceId as never,
        bridge,
        view.instance.spec.initScripts,
        composeTargetAttachedHooks(
          resolveClientHintsHook(view.instance.spec),
          resolveStealthHooks(
            view.instance.runtime?.stealthProfile,
            view.instance.spec,
            stealthProfiles,
          ),
        ),
        // Same reasoning as the fresh-attach path above: a restart builds
        // a brand new registry against a brand new Chrome, so proxy
        // credentials must be re-armed on it or the relaunched browser
        // silently loses them.
        resolveProxyAuthCredentials(view.instance.spec),
      );
      await registry.start();
      return { ok: true, bridge, registry };
    } catch (err) {
      logger?.error(
        {
          component: 'server',
          instanceId,
          step,
          preserveProfile,
          code:
            typeof (err as { code?: unknown })?.code === 'string'
              ? (err as { code: string }).code
              : null,
          error: err instanceof Error ? err.message : String(err),
        },
        'instance restart failed',
      );
      return { ok: false };
    }
  };
}
