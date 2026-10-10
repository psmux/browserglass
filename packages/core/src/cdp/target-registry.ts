/**
 * `TargetRegistry`: discovery, classification, tab ordering, and the
 * `cdpTargetId` to `tgt_...` mapping.
 *
 * The full per-target domain-enable lifecycle (steps 2 to 6 of attach:
 * `Page.enable`, `Runtime.enable`, `Emulation.*`, init scripts, file
 * chooser and download settings) depends on `BrowserSpec`-level
 * configuration (stealth level, init script content, clipboard capability)
 * that this registry is not handed; most of it is still not built here.
 * Step 7, `Runtime.runIfWaitingForDebugger` in a `finally` plus its 5000ms
 * watchdog, was the first piece this registry implemented, since it is a
 * mandatory safety net independent of whatever else an attach path does.
 *
 * Init scripts (`BrowserSpec.initScripts`, `entities.ts`) are the one piece
 * of that missing configuration this registry now does own, via
 * `installInitScripts`/`removeInitScripts` below. They are threaded in
 * through {@link createTargetRegistry}'s third argument rather than read
 * off a `BrowserSpec` directly, since this registry is constructed once per
 * `CdpBridge` (one per Instance) and never otherwise sees the spec that
 * launched its browser; the caller assembling that `CdpBridge`/registry
 * pair (today, `createTargetRegistry(instanceId, bridge)`'s two call sites
 * outside this package) is responsible for passing `spec.initScripts`
 * through as that third argument. The parameter defaults to empty so every
 * existing call site keeps compiling and behaving exactly as before until
 * its owner does.
 */

import {
  BglsError,
  type InstanceId,
  type StealthTargetContext,
  type TargetId,
  newId,
} from '@browserglass/protocol';
import type { CdpBridge } from './bridge.js';
import { CdpError } from './errors.js';
import { type TimerHandle, clearTimer, monotonicNow, scheduleTimer } from './platform.js';
import { type ProxyAuthCredentials, ProxyAuthHandler } from './proxy-auth.js';
import {
  type RawTargetInfo,
  type TargetClassification,
  type TargetRuntime,
  classifyTarget,
} from './target-types.js';
import type { CdpSessionHandle, CdpSessionId, Unsubscribe } from './types.js';

/** The sparse ordering step new, opener-less targets are inserted at. */
const ORDER_STEP = 1024;

/** Below this gap between two consecutive order keys, the whole list is renumbered rather than bisected further. */
const MIN_ORDER_GAP = 1e-6;

/** How long a destroyed target's `cdpTargetId` is remembered, so a late duplicate `targetDestroyed`/`detachedFromTarget` is dropped rather than logged as an error. */
const RECENTLY_DESTROYED_TTL_MS = 30000;

/** How often `resync()` runs on its own, in addition to once after connect and once after every reconnect. */
const RESYNC_INTERVAL_MS = 30000;

/** `Target.targetInfoChanged` debounce window, to absorb a navigating page's update burst. */
const TARGET_INFO_CHANGED_DEBOUNCE_MS = 100;

/** When to re-read `Target.getTargets` after a URL change, to pick up the title Chrome never announces. See `scheduleInfoCatchUp`. */
const TITLE_CATCH_UP_DELAYS_MS: readonly number[] = Object.freeze([800, 3000]);

/** How long a `Page.windowOpen` intent is remembered while waiting for the matching `Target.targetCreated`. */
const WINDOW_OPEN_INTENT_TTL_MS = 5000;

/**
 * Identity provider hosts a `Page.windowOpen` URL is matched against to
 * classify a popup as `role: 'auth_popup'`. Exported so a host application
 * can extend it. Matches the host itself or any subdomain.
 */
export const AUTH_POPUP_HOSTS: readonly string[] = Object.freeze([
  'accounts.google.com',
  'login.microsoftonline.com',
  'login.live.com',
  'appleid.apple.com',
  'auth0.com',
  'login.yahoo.com',
  'api.twitter.com',
  'twitter.com',
  'x.com',
  'www.facebook.com',
  'facebook.com',
]);

function extractHost(url: string): string | null {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/:?#]+)/.exec(url);
  return match ? (match[1] as string).toLowerCase() : null;
}

function isAuthPopupUrl(url: string): boolean {
  const host = extractHost(url);
  if (!host) {
    return false;
  }
  return AUTH_POPUP_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The event names `TargetRegistry.on` accepts (`'ready'` and `'attached'` are the same event). */
export type TargetRegistryEvent =
  | 'created'
  | 'updated'
  | 'closed'
  | 'crashed'
  | 'reordered'
  | 'attached'
  | 'detached';

/** The diff `resync()` reports. */
export interface ResyncResult {
  added: number;
  removed: number;
  changed: number;
}

/**
 * Asserts that `target` can be streamed, throwing the `E_NOT_STREAMABLE`
 * `BglsError` (mapped to `bgls.error.stream.not_streamable` on the wire)
 * otherwise. Called by whatever layer handles `stream.subscribe`.
 */
export function assertStreamable(target: Pick<TargetRuntime, 'streamable' | 'id'>): void {
  if (!target.streamable) {
    throw new BglsError('E_NOT_STREAMABLE', `target ${target.id} cannot be streamed`, {
      context: { targetId: target.id },
    });
  }
}

/** `TargetRegistry`'s public interface. */
export interface TargetRegistry {
  readonly instanceId: InstanceId;

  /** Ordered, filtered to streamable page targets. */
  tabs(): readonly TargetRuntime[];
  /** Everything, including workers and extension pages. */
  all(): readonly TargetRuntime[];
  get(id: TargetId): TargetRuntime | undefined;

  /** Delegates to `CdpBridge.sessionFor`. */
  attach(id: TargetId): Promise<CdpSessionHandle>;
  detach(id: TargetId): Promise<void>;

  /**
   * Turns off this target's configured init scripts on its CURRENT
   * session, without navigating or detaching it: every identifier
   * `installInitScripts` recorded in `TargetRuntime.scriptIdentifiers` is
   * removed via `Page.removeScriptToEvaluateOnNewDocument`, real removal
   * rather than merely forgetting the identifiers locally, and the array is
   * cleared. Same-origin navigations on this session then run no init
   * script at all. A LATER cross origin navigation still gets the gate
   * back: it forces a fresh CDP session, and `installInitScripts` treats
   * every fresh session as unconfigured, reinstalling from this registry's
   * own `initScripts` regardless of an earlier `removeInitScripts` call on
   * a now-dead session. That is deliberate: this method turns a gate off
   * for the page presently loaded, not for the Instance, so a caller
   * intentionally lifting a submit gate to let one real submission through
   * does not also disarm every page the Instance visits afterward. A
   * no-op, never throwing, when the target has no session or no
   * identifiers recorded.
   */
  removeInitScripts(id: TargetId): Promise<void>;

  create(opts: { url?: string; background?: boolean; newWindow?: boolean }): Promise<TargetRuntime>;
  close(id: TargetId): Promise<void>;
  /**
   * True while `id` is being closed by {@link close}: Chrome has accepted
   * `Target.closeTarget` but its `Target.targetDestroyed` has not arrived,
   * so the target is still listed by {@link tabs}. The wire reply to
   * `target.close` goes out as soon as Chrome accepts the close, so a
   * client can already consider such a tab gone.
   */
  isClosing(id: TargetId): boolean;
  activate(id: TargetId): Promise<void>;
  reorder(id: TargetId, beforeId: TargetId | null): void;

  /**
   * `Browser.getWindowForTarget`, cached onto `TargetRuntime.windowId` once
   * it succeeds. A cached value is returned without a further round trip;
   * a failed call (target gone, method unsupported) never throws and
   * leaves the cache empty, so a later call retries rather than sticking
   * with a wrong answer.
   */
  windowIdFor(id: TargetId): Promise<number | null>;

  /** Every live target currently in `windowId`, in the registry's existing tab order. */
  targetsInWindow(windowId: number): readonly TargetRuntime[];

  /**
   * `Browser.setWindowBounds`. Best effort: a failure (window already
   * closed, method unsupported) is swallowed, never thrown. Deliberately
   * has no `windowState` field: the spike that proved per-window isolation
   * (`spike-window-isolation.ts` arm C) never measured a minimized window,
   * and minimizing is the one case that could reintroduce the stall, so this method must never be able to request it.
   */
  setWindowBounds(
    windowId: number,
    bounds: { left?: number; top?: number; width?: number; height?: number },
  ): Promise<void>;

  on(e: TargetRegistryEvent, h: (t: TargetRuntime) => void): Unsubscribe;

  /**
   * Runs the fixed discovery setup and an initial
   * `resync()`. Call once, after `CdpBridge.connect()` resolves.
   */
  start(): Promise<void>;

  resync(): Promise<ResyncResult>;

  /** Stops the periodic resync timer and every session-scoped subscription this registry owns. */
  dispose(): void;
}

/**
 * The two `StealthProfile` (`@browserglass/protocol`, `runtime.ts`) methods
 * that need a live CDP session to act on, already resolved by whoever
 * constructs this registry against that profile's `BrowserSpec`
 * (`createTargetRegistry`'s own doc comment explains why this registry
 * never resolves a `StealthProfile` itself). `initScripts` here is
 * `StealthProfile.initScripts(spec)`'s return value, not the profile or
 * the spec; `onTargetAttached` is the profile method itself, unresolved,
 * since it takes a per-target `StealthTargetContext` this registry builds
 * fresh for every attach, not a `spec`.
 */
export interface StealthProfileHooks {
  /** Installed via the same `installInitScripts` machinery as `spec.initScripts`, BEFORE it in array order; see the constructor's own comment for why. */
  initScripts: readonly { name: string; source: string }[];
  /** Called once per newly attached page/iframe target, after this registry's own `installInitScripts` has run for that target's session. Errors are swallowed (see {@link TargetRegistryImpl.handleAttachedToTarget}), matching `installInitScripts`'s own best-effort precedent. */
  onTargetAttached: (ctx: StealthTargetContext) => Promise<void>;
}

/** The concrete `TargetRegistry` implementation. */
export class TargetRegistryImpl implements TargetRegistry {
  readonly instanceId: InstanceId;
  private readonly bridge: CdpBridge;

  private readonly byCdpId = new Map<string, TargetRuntime>();
  private readonly byTgtId = new Map<TargetId, string>();
  private readonly bySessionId = new Map<string, string>();
  private readonly recentlyDestroyed = new Map<string, number>();
  /**
   * CDP target ids this registry is deliberately closing or detaching.
   *
   * Chrome answers `Target.closeTarget` with `Target.detachedFromTarget`
   * before `Target.targetDestroyed`, and `handleDetachedFromTarget` emits
   * `'detached'`, which `Session` treats as the `cdp_detached` recovery
   * signal. So closing a tab, an ordinary thing a user does, drove the whole
   * Instance into `recovering`: every viewer got `instance.recovering`, and
   * a viewer that tried to connect during the window was refused outright
   * ("illegal recovering --viewerAttached-->"). `recentlyDestroyed` could
   * not prevent it, because it is only populated once the destroy event
   * arrives, which is after the detach. This is set before the CDP call
   * instead, so an intentional teardown is never mistaken for a failure.
   */
  private readonly intentionalTeardown = new Set<string>();
  /** CDP target ids whose `Target.closeTarget` Chrome has accepted and whose destroy event has not arrived yet. See {@link isClosing}. */
  private readonly closing = new Set<string>();
  private readonly pendingWindowOpens = new Map<string, { url: string; at: number }>();
  private readonly infoChangedDebounce = new Map<string, TimerHandle>();
  /** Pending title catch-up resyncs, keyed by their own delay so each one is scheduled at most once at a time. See `scheduleInfoCatchUp`. */
  private readonly infoCatchUpTimers = new Map<number, TimerHandle>();
  /** `Page` domain subscriptions per attached page target, keyed by CDP target id, with the session they belong to. See `wirePageDomain`. */
  private readonly pageDomainUnsubs = new Map<
    string,
    { sessionId: string; unsubs: Unsubscribe[] }
  >();
  /**
   * Which CDP session (by session id) currently has `initScripts` installed
   * on it, keyed by `cdpTargetId`. `installInitScripts` checks this before
   * doing any CDP work so a target that fires both `attach()` and
   * `handleAttachedToTarget` for the SAME session (the same double-path
   * `wirePageDomain`'s own comment describes) never registers the same
   * script twice on it, which would otherwise run the script twice on
   * every future navigation. A fresh session for the same target (a
   * reattach, most importantly the one a cross origin navigation forces)
   * never matches what is recorded here, so it always reinstalls.
   */
  private readonly initScriptSessions = new Map<string, string>();
  /** Which CDP session already ran `stealthOnTargetAttached`, keyed by `cdpTargetId`, mirroring {@link initScriptSessions}'s own idempotency reasoning. Tracked separately because a profile may set `onTargetAttached` with an empty `initScripts()`, in which case `initScriptSessions` never gets a row for that target to key off. */
  private readonly stealthAttachedSessions = new Map<string, string>();
  /**
   * Which CDP session a target's `ProxyAuthHandler` is currently armed on,
   * keyed by `cdpTargetId`, mirroring {@link initScriptSessions}'s own
   * idempotency reasoning: a target that reaches `installProxyAuth` twice
   * for the SAME session (the same double-path `wirePageDomain` already
   * guards against) must not re-arm, and a different (or first) session
   * always re-arms, which is what makes proxy auth survive a cross origin
   * navigation, an ordinary re-attach, and a transport reconnect. See
   * `./proxy-auth.ts`'s module doc, "Re-arming".
   */
  private readonly proxyAuthSessions = new Map<string, string>();
  /** The live `ProxyAuthHandler` instance per `cdpTargetId`, so a re-arm calls `rebind()` on the SAME handler rather than constructing a second `Fetch` consumer for the same target. */
  private readonly proxyAuthHandlers = new Map<string, ProxyAuthHandler>();
  private readonly listeners = new Map<TargetRegistryEvent, Set<(t: TargetRuntime) => void>>();
  private readonly bridgeUnsubs: Unsubscribe[] = [];
  private resyncTimer: TimerHandle | null = null;
  /** Set by `dispose()`; stops `scheduleResync()`'s own timer callback from rescheduling itself once this registry is torn down. */
  private disposed = false;
  /**
   * `BrowserSpec.initScripts` for this Instance, PLUS (at the front) any
   * `StealthProfile.initScripts(spec)` the constructor's `stealth` argument
   * carried, see {@link createTargetRegistry} and {@link StealthProfileHooks}.
   * Never mutated after construction: a spec is fixed for the life of an
   * Instance, so there is no "live update" case to support.
   */
  private readonly initScripts: readonly { name: string; source: string }[];
  /** `StealthProfile.onTargetAttached`, resolved by the constructor's `stealth` argument. `null` when `spec.stealth` was `'off'` for this Instance, or the caller passed none. See {@link handleAttachedToTarget}. */
  private readonly stealthOnTargetAttached: ((ctx: StealthTargetContext) => Promise<void>) | null;
  /** `BrowserSpec.proxy.username`/`password` for this Instance, threaded in through {@link createTargetRegistry}'s fifth argument the same way `initScripts` is threaded through the third; see that constructor comment and `./proxy-auth.ts`'s module doc. `null` when the spec carries no proxy, or a proxy with no credentials, or the caller passed none. */
  private readonly proxyAuthCredentials: ProxyAuthCredentials | null;

  constructor(
    instanceId: InstanceId,
    bridge: CdpBridge,
    initScripts: readonly { name: string; source: string }[] = [],
    stealth: StealthProfileHooks | null = null,
    proxyAuthCredentials: ProxyAuthCredentials | null = null,
  ) {
    this.instanceId = instanceId;
    this.bridge = bridge;
    this.proxyAuthCredentials = proxyAuthCredentials;
    // ORDERING, EXPLICIT: stealth patches run BEFORE this Instance's own
    // `BrowserSpec.initScripts`. Stealth scripts are foundational/
    // environmental (they exist to make the browser look like it always
    // does, before anything else runs), while `spec.initScripts` is
    // functional and operator authored for one particular automation; an
    // operator script that reads `navigator.webdriver` or otherwise probes
    // the page's own automation surface should see the patched
    // environment already in place, not race it. Reuses the exact same
    // `installInitScripts` loop below as `spec.initScripts` always has:
    // this is one array, installed once per session, in order, not two
    // separate install paths.
    this.initScripts = [...(stealth?.initScripts ?? []), ...initScripts];
    this.stealthOnTargetAttached = stealth?.onTargetAttached ?? null;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await this.bridge.send('Target.setDiscoverTargets', { discover: true });
    try {
      await this.bridge.send('Target.setAutoAttach', {
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
        filter: [
          // Real Chrome (confirmed against 151.0.7922.173) rejects a
          // filter naming `page` without also explicitly excluding `tab`:
          // "Filter should not simultaneously allow tab and page, page
          // targets are attached via tab targets."
          { type: 'tab', exclude: true },
          { type: 'page' },
          { type: 'iframe' },
          { type: 'worker', exclude: true },
          { type: 'service_worker', exclude: true },
          { type: 'shared_worker', exclude: true },
          {},
        ],
      });
    } catch (err) {
      if (err instanceof CdpError && err.code === 'E_CDP_METHOD_UNSUPPORTED') {
        // Chrome 105 to 119: no `filter` support. Fall back to attach on
        // targetCreated, accepting the one-round-trip-late manual attach race.
        await this.bridge.send('Target.setAutoAttach', {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        });
      } else {
        throw err;
      }
    }

    this.wireEvents();
    await this.resync();
    this.scheduleResync();
  }

  private wireEvents(): void {
    this.bridgeUnsubs.push(
      this.bridge.on('Target.targetCreated', (params) =>
        this.upsertFromRaw(params['targetInfo'] as unknown as RawTargetInfo),
      ),
      this.bridge.on('Target.targetInfoChanged', (params) =>
        this.handleTargetInfoChanged(params['targetInfo'] as unknown as RawTargetInfo),
      ),
      this.bridge.on(
        'Target.attachedToTarget',
        (params) => void this.handleAttachedToTarget(params),
      ),
      this.bridge.on('Target.detachedFromTarget', (params) =>
        this.handleDetachedFromTarget(params),
      ),
      this.bridge.on('Target.targetDestroyed', (params) =>
        this.handleTargetDestroyed(params['targetId'] as string),
      ),
      this.bridge.on('Target.targetCrashed', (params) =>
        this.handleTargetCrashed(params['targetId'] as string),
      ),
    );
  }

  private scheduleResync(): void {
    clearTimer(this.resyncTimer);
    this.resyncTimer = scheduleTimer(() => {
      // Best effort: a periodic resync racing a concurrent bridge close
      // (`E_CDP_CLOSED`) is expected, not exceptional, and must not
      // surface as an unhandled rejection; the bridge's own close/reconnect
      // handling, not this timer, owns reporting a real connection
      // problem. Never reschedules once `dispose()` has run.
      this.resync()
        .catch(() => undefined)
        .finally(() => {
          if (!this.disposed) this.scheduleResync();
        });
    }, RESYNC_INTERVAL_MS);
  }

  dispose(): void {
    this.disposed = true;
    clearTimer(this.resyncTimer);
    this.resyncTimer = null;
    for (const unsub of this.bridgeUnsubs) {
      unsub();
    }
    this.bridgeUnsubs.length = 0;
    for (const timer of this.infoChangedDebounce.values()) {
      clearTimer(timer);
    }
    this.infoChangedDebounce.clear();
    for (const timer of this.infoCatchUpTimers.values()) {
      clearTimer(timer);
    }
    this.infoCatchUpTimers.clear();
    for (const cdpTargetId of [...this.pageDomainUnsubs.keys()]) {
      this.teardownPageDomain(cdpTargetId);
    }
    this.initScriptSessions.clear();
    for (const handler of this.proxyAuthHandlers.values()) {
      void handler.stop().catch(() => {});
    }
    this.proxyAuthHandlers.clear();
    this.proxyAuthSessions.clear();
  }

  // ── reads ────────────────────────────────────────────────────────────

  tabs(): readonly TargetRuntime[] {
    return [...this.byCdpId.values()].filter((t) => t.type === 'page').sort(compareTargetOrder);
  }

  all(): readonly TargetRuntime[] {
    return [...this.byCdpId.values()].sort(compareTargetOrder);
  }

  get(id: TargetId): TargetRuntime | undefined {
    const cdpId = this.byTgtId.get(id);
    return cdpId ? this.byCdpId.get(cdpId) : undefined;
  }

  private require(id: TargetId): TargetRuntime {
    const target = this.get(id);
    if (!target) {
      throw new CdpError('E_CDP_TARGET_NOT_FOUND', {
        kind: 'protocol',
        retryable: false,
        message: `unknown target ${id}`,
      });
    }
    return target;
  }

  // ── attach / detach ──────────────────────────────────────────────────

  async attach(id: TargetId): Promise<CdpSessionHandle> {
    const target = this.require(id);
    const handle = await this.bridge.sessionFor(target.cdpTargetId, {
      flatten: true,
      type: target.type,
    });
    target.attached = true;
    target.cdpSessionId = handle.id;
    this.bySessionId.set(handle.id, target.cdpTargetId);
    // `attach()` builds its own session through `CdpBridge.sessionFor` and
    // never passes through `handleAttachedToTarget`, so this is the second
    // of the two places a page session comes into existence. Wiring only the
    // auto-attach path left every tab opened after startup with no `Page`
    // domain at all, and therefore no `loading` and no history.
    this.wirePageDomain(target, handle.id);
    // A target this registry discovers rather than creates (every tab
    // already open when `start()` runs, or one opened by a page's own
    // `window.open`) never passes through `create()`, so `windowId` is
    // populated here too. Fire and forget: `attach()`'s contract is the
    // session handle, not the window id, and `windowIdFor` never throws.
    void this.windowIdFor(target.id);
    // AWAITED, unlike `windowIdFor` above: a caller that gets `attach()`'s
    // handle back and immediately navigates must not be able to race this.
    // `Page.addScriptToEvaluateOnNewDocument` only affects documents
    // created after it registers, so if the navigation's own CDP command
    // reached Chrome first, the init script would silently miss that one
    // load. For a submit gate that is exactly the failure this feature
    // exists to prevent (see `entities.ts`'s `BrowserSpec.initScripts` doc
    // comment), so this resolves before `attach()` does rather than firing
    // and forgetting the way `windowIdFor` gets to.
    await this.installInitScripts(target, handle.id);
    // `StealthProfile.onTargetAttached`, same reasoning and same ordering
    // (after init scripts) as `handleAttachedToTarget`'s own call: `attach()`
    // is the second of the two places a page session comes into existence
    // (see this method's own comment above), and a stealth profile that
    // only ran on the auto-attach path would silently miss every target
    // this registry discovers rather than auto-attaches to.
    await this.runStealthOnTargetAttached(target, handle.id);
    // Same reasoning again, for proxy auth: `attach()` is the second of the
    // two places a page session comes into existence, and credentials
    // armed only on the auto-attach path would silently miss every target
    // this registry discovers rather than auto-attaches to. See
    // `./proxy-auth.ts`'s module doc, "Re-arming". Guarded here, not only
    // inside `installProxyAuth`, so a deployment with no proxy configured
    // (every existing caller of this registry, before this feature existed)
    // never even awaits a no-op async call: `installInitScripts`/
    // `runStealthOnTargetAttached` are awaited unconditionally because they
    // are the FIRST two such calls in this chain and the test suite's fixed
    // microtask-flush counts already account for both; a third always-awaited
    // no-op here would silently shift that count for every caller regardless
    // of whether this Instance uses proxy auth at all.
    if (this.proxyAuthCredentials) {
      await this.installProxyAuth(target, handle.id);
    }
    return handle;
  }

  async detach(id: TargetId): Promise<void> {
    const target = this.require(id);
    const sessionId = target.cdpSessionId;
    if (!sessionId) {
      return;
    }
    this.markIntentionalTeardown(target.cdpTargetId);
    await this.bridge.detach(sessionId);
    this.bySessionId.delete(sessionId);
    target.attached = false;
    target.cdpSessionId = null;
  }

  // ── create / close / activate / reorder ────────────────────────────

  async create(opts: {
    url?: string;
    background?: boolean;
    newWindow?: boolean;
  }): Promise<TargetRuntime> {
    const result = (await this.bridge.send('Target.createTarget', {
      url: opts.url ?? 'about:blank',
      background: opts.background ?? false,
      // Omitted rather than sent `false`: real Chrome (151.0.7922.173)
      // accepts `newWindow: false` fine, but omitting an unused optional
      // param matches every other call in this method and keeps the sent
      // params minimal for whatever fake CDP endpoint a test scripts
      // against.
      ...(opts.newWindow ? { newWindow: true } : {}),
    })) as { targetId: string };
    const existing = this.byCdpId.get(result.targetId);
    const target =
      existing ??
      this.upsertFromRaw(
        (
          (await this.bridge.send('Target.getTargetInfo', {
            targetId: result.targetId,
          })) as { targetInfo: RawTargetInfo }
        ).targetInfo,
      );
    // Best effort: a freshly created target's window is not yet known to
    // any caller, and `windowIdFor` never throws, so this populates
    // `TargetRuntime.windowId` without making `create()` itself fail on a
    // `Browser.getWindowForTarget` hiccup.
    await this.windowIdFor(target.id);
    return target;
  }

  async close(id: TargetId): Promise<void> {
    const target = this.require(id);
    this.markIntentionalTeardown(target.cdpTargetId);
    try {
      await this.bridge.send('Target.closeTarget', { targetId: target.cdpTargetId });
    } catch (err) {
      // The close never happened, so the target may well still be live and
      // a later detach on it would be a real failure again.
      this.intentionalTeardown.delete(target.cdpTargetId);
      throw err;
    }
    // Self expiring like `intentionalTeardown`, so a destroy event that
    // never arrives cannot hide a live tab for good.
    const cdpTargetId = target.cdpTargetId;
    this.closing.add(cdpTargetId);
    scheduleTimer(() => {
      this.closing.delete(cdpTargetId);
    }, RECENTLY_DESTROYED_TTL_MS);
  }

  isClosing(id: TargetId): boolean {
    const target = this.get(id);
    return target !== undefined && this.closing.has(target.cdpTargetId);
  }

  async activate(id: TargetId): Promise<void> {
    const target = this.require(id);
    await this.bridge.send('Target.activateTarget', { targetId: target.cdpTargetId });
  }

  async windowIdFor(id: TargetId): Promise<number | null> {
    // `get`, never `require`. This is documented as never throwing, and
    // callers lean on that: `TargetActivationPolicy` reaches it from
    // teardown paths that run precisely because a target was destroyed, so
    // the target really can be gone from this registry by the time the
    // question is asked. `require` answers that with a thrown
    // `E_CDP_TARGET_NOT_FOUND`, which surfaced as an unhandled rejection
    // out of `Session.teardownTarget` rather than as a null.
    const target = this.get(id);
    if (!target) {
      return null;
    }
    if (target.windowId !== null) {
      return target.windowId;
    }
    try {
      const result = (await this.bridge.send('Browser.getWindowForTarget', {
        targetId: target.cdpTargetId,
      })) as { windowId?: number };
      const windowId = typeof result.windowId === 'number' ? result.windowId : null;
      target.windowId = windowId;
      return windowId;
    } catch {
      // Chrome answers `Browser.getWindowForTarget` with an error for a
      // target that has no window (an out of process iframe, a worker) or
      // one that raced a close; neither is a fault in this registry, so
      // the target simply keeps an unknown window rather than the call
      // failing outward. See the interface doc for the retry behaviour.
      return null;
    }
  }

  targetsInWindow(windowId: number): readonly TargetRuntime[] {
    return this.tabs().filter((t) => t.windowId === windowId && !t.crashed);
  }

  async setWindowBounds(
    windowId: number,
    bounds: { left?: number; top?: number; width?: number; height?: number },
  ): Promise<void> {
    try {
      await this.bridge.send('Browser.setWindowBounds', { windowId, bounds });
    } catch {
      // Best effort placement: the window may already be gone by the time
      // this lands, and a caller (spreading N new windows across the
      // desktop rather than letting Chrome cascade them) must not fail its
      // own operation over a cosmetic placement miss.
    }
  }

  reorder(id: TargetId, beforeId: TargetId | null): void {
    const target = this.require(id);
    const before = beforeId ? this.get(beforeId) : undefined;
    const all = this.all();
    if (!before) {
      target.order = maxOrderOf(all, target) + ORDER_STEP;
    } else {
      const sorted = [...all].sort(compareTargetOrder);
      const beforeIdx = sorted.findIndex((t) => t.id === before.id);
      const prev = beforeIdx > 0 ? sorted[beforeIdx - 1] : undefined;
      const lowerBound = prev && prev.id !== target.id ? prev.order : before.order - ORDER_STEP;
      target.order = (lowerBound + before.order) / 2;
    }
    this.emit('reordered', target);
  }

  // ── events ───────────────────────────────────────────────────────────

  on(e: TargetRegistryEvent, h: (t: TargetRuntime) => void): Unsubscribe {
    let bucket = this.listeners.get(e);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(e, bucket);
    }
    bucket.add(h);
    return () => {
      this.listeners.get(e)?.delete(h);
    };
  }

  private emit(e: TargetRegistryEvent, t: TargetRuntime): void {
    const bucket = this.listeners.get(e);
    if (!bucket) {
      return;
    }
    for (const h of [...bucket]) {
      h(t);
    }
  }

  // ── resync ───────────────────────────────────────────────────────────

  async resync(): Promise<ResyncResult> {
    const result = (await this.bridge.send('Target.getTargets')) as {
      targetInfos: RawTargetInfo[];
    };
    const seen = new Set<string>();
    let added = 0;
    let removed = 0;
    let changed = 0;

    for (const info of result.targetInfos) {
      seen.add(info.targetId);
      const existing = this.byCdpId.get(info.targetId);
      if (!existing) {
        this.upsertFromRaw(info);
        added += 1;
      } else {
        const before = `${existing.url} ${existing.title} ${existing.attached}`;
        this.applyRawUpdate(existing, info);
        const after = `${existing.url} ${existing.title} ${existing.attached}`;
        if (before !== after) {
          changed += 1;
          // A resync that quietly mutated its own map and told nobody was
          // how a tab's title stayed wrong for the life of a session: the
          // only path that ever notices a title is this one (see
          // `scheduleInfoCatchUp`), so it has to emit like any other update.
          this.emit('updated', existing);
        }
      }
    }

    for (const cdpId of [...this.byCdpId.keys()]) {
      if (!seen.has(cdpId)) {
        this.removeTarget(cdpId);
        removed += 1;
      }
    }

    return { added, removed, changed };
  }

  // ── raw event handlers ───────────────────────────────────────────────

  private handleTargetInfoChanged(raw: RawTargetInfo): void {
    const existingTimer = this.infoChangedDebounce.get(raw.targetId);
    if (existingTimer) {
      clearTimer(existingTimer);
    }
    this.infoChangedDebounce.set(
      raw.targetId,
      scheduleTimer(() => {
        this.infoChangedDebounce.delete(raw.targetId);
        const target = this.byCdpId.get(raw.targetId);
        if (!target) {
          return;
        }
        const titleBefore = target.title;
        this.applyRawUpdate(target, raw);
        this.emit('updated', target);
        if (target.title !== titleBefore || target.title === '' || target.title === target.url) {
          this.scheduleInfoCatchUp();
        }
      }, TARGET_INFO_CHANGED_DEBOUNCE_MS),
    );
  }

  /**
   * Chrome sends `Target.targetInfoChanged` when a target's URL changes and
   * never when its title changes. Verified directly against real Chrome:
   * navigating fires the event carrying the host as the title, the document
   * then parses its own `<title>`, and no further event is ever sent;
   * `document.title = '...'` from script produces nothing at all. Only
   * `Target.getTargets` has the real value.
   *
   * So a tab's title was whatever Chrome happened to report at navigation
   * time, usually the bare host, for the rest of the session. `resync()`
   * would have picked it up, but it runs on a 30 second interval and, until
   * now, told nobody what it found.
   *
   * This schedules two short catch-up resyncs after a URL change, at the
   * points a real page has usually parsed its head and finished its own
   * scripted title updates. They are coalesced, so a burst of navigations
   * across several tabs costs one pair of `Target.getTargets` calls, not one
   * pair per tab.
   */
  private scheduleInfoCatchUp(): void {
    for (const delayMs of TITLE_CATCH_UP_DELAYS_MS) {
      if (this.infoCatchUpTimers.has(delayMs)) continue;
      this.infoCatchUpTimers.set(
        delayMs,
        scheduleTimer(() => {
          this.infoCatchUpTimers.delete(delayMs);
          if (this.disposed) return;
          this.resync().catch(() => undefined);
        }, delayMs),
      );
    }
  }

  /**
   * Enables the `Page` domain on one attached tab and keeps
   * `loading`, `canGoBack` and `canGoForward` true from then on.
   *
   * Those three fields are part of `TargetSummary`, the shape a tab strip
   * renders, and all three used to be permanently `false`: nothing in the
   * build ever wrote `loading`, and `toTargetSummary` hard coded the two
   * history flags because `TargetRuntime` carried no history at all. A
   * spinner driven by `loading` could never appear, and back and forward
   * controls driven off the tab list were always dead.
   *
   * Only page targets are wired. Workers and out of process iframes have no
   * navigation of their own to report, and enabling `Page` on them buys
   * nothing but event traffic.
   *
   * Deliberately synchronous up to the point every subscription is
   * registered, with the three CDP round trips deferred to
   * {@link initPageDomain}. A tab is commonly attached and navigated in the
   * same breath, and awaiting `Page.enable` before subscribing would let
   * that navigation's own `Page.frameStartedLoading` arrive while nothing
   * was listening for it.
   */
  private wirePageDomain(target: TargetRuntime, sessionId: string): void {
    if (target.type !== 'page' || this.disposed) return;

    // A page session comes into existence through two paths that can both
    // fire for the same target: `attach()` builds one on demand, and
    // `Target.attachedToTarget` reports it moments later. Re-wiring on the
    // second one would tear down live subscriptions and reset `loading` and
    // the main frame id mid navigation, losing whatever arrived in between.
    // Already wired to this same session means there is nothing to do.
    const existing = this.pageDomainUnsubs.get(target.cdpTargetId);
    if (existing?.sessionId === sessionId) return;

    this.teardownPageDomain(target.cdpTargetId);

    /** True when an event belongs to this tab's own top level frame, or while the frame tree read has not landed yet and there is nothing to compare against. */
    const isMainFrame = (frameId: unknown): boolean =>
      target.mainFrameId === null || frameId === target.mainFrameId;

    const setLoading = (loading: boolean): void => {
      if (target.loading === loading) return;
      target.loading = loading;
      this.emit('updated', target);
    };

    const unsubs: Unsubscribe[] = [
      this.bridge.on(
        'Page.frameStartedLoading',
        (params) => {
          if (isMainFrame(params['frameId'])) setLoading(true);
        },
        sessionId as never,
      ),
      this.bridge.on(
        'Page.frameStoppedLoading',
        (params) => {
          if (!isMainFrame(params['frameId'])) return;
          setLoading(false);
          void this.refreshNavigationHistory(target, sessionId);
        },
        sessionId as never,
      ),
      this.bridge.on(
        'Page.frameNavigated',
        (params) => {
          const frame = params['frame'] as { id?: string; parentId?: string } | undefined;
          // A cross process navigation can mint a new main frame id, so the
          // top level frame is identified by having no parent rather than by
          // matching what the frame tree said at attach time.
          if (frame?.parentId !== undefined) return;
          if (frame?.id) target.mainFrameId = frame.id;
          void this.refreshNavigationHistory(target, sessionId);
        },
        sessionId as never,
      ),
      this.bridge.on(
        'Page.navigatedWithinDocument',
        (params) => {
          // A pushState or a hash change moves history without ever starting
          // a load, so it has to be listened for separately.
          if (isMainFrame(params['frameId'])) void this.refreshNavigationHistory(target, sessionId);
        },
        sessionId as never,
      ),
    ];
    this.pageDomainUnsubs.set(target.cdpTargetId, { sessionId, unsubs });

    void this.initPageDomain(target, sessionId);
  }

  /** The three round trips {@link wirePageDomain} defers: enable the domain, learn the main frame id, and take the first history reading. */
  private async initPageDomain(target: TargetRuntime, sessionId: string): Promise<void> {
    try {
      await this.bridge.send('Page.enable', undefined, sessionId as never);
    } catch {
      // A target that died between attaching and enabling is ordinary, not
      // exceptional. Drop the listeners again and leave the honest defaults.
      this.teardownPageDomain(target.cdpTargetId);
      return;
    }
    if (this.disposed) return;

    try {
      const tree = (await this.bridge.send('Page.getFrameTree', undefined, sessionId as never)) as {
        frameTree?: { frame?: { id?: string } };
      };
      target.mainFrameId = tree.frameTree?.frame?.id ?? null;
    } catch {
      // Unknown main frame: `isMainFrame` then accepts every frame, a worse
      // approximation than filtering but a better one than reporting nothing.
      target.mainFrameId = null;
    }

    await this.refreshNavigationHistory(target, sessionId);
  }

  /** Reads `Page.getNavigationHistory` and updates `canGoBack`/`canGoForward`, emitting only when one of them actually changed. */
  private async refreshNavigationHistory(target: TargetRuntime, sessionId: string): Promise<void> {
    if (this.disposed) return;
    try {
      const history = (await this.bridge.send(
        'Page.getNavigationHistory',
        undefined,
        sessionId as never,
      )) as {
        currentIndex: number;
        entries: readonly { url?: unknown }[];
      };
      const canGoBack = history.currentIndex > 0;
      const canGoForward = history.currentIndex < history.entries.length - 1;
      // The URL comes along from the same reading. Otherwise it arrives
      // separately, through `Target.targetInfoChanged`, which is debounced
      // (`TARGET_INFO_CHANGED_DEBOUNCE_MS`), and for that long a tab strip
      // would read the new back and forward state next to the old URL:
      // forward available, still showing the page it just went back from.
      // Web and file URLs only: for Chrome's own pages the history entry
      // and the target info can spell the same page differently
      // (`chrome://newtab/` against `chrome://new-tab-page/`), and taking
      // both would flip the URL back and forth.
      const currentUrl = history.entries[history.currentIndex]?.url;
      const url =
        typeof currentUrl === 'string' && /^(https?|file):/.test(currentUrl)
          ? currentUrl
          : target.url;
      if (
        target.canGoBack === canGoBack &&
        target.canGoForward === canGoForward &&
        target.url === url
      ) {
        return;
      }
      target.canGoBack = canGoBack;
      target.canGoForward = canGoForward;
      target.url = url;
      this.emit('updated', target);
    } catch {
      // Best effort: a history read racing a closing target must not become
      // an unhandled rejection or a fabricated answer.
    }
  }

  /** Drops the `Page` subscriptions for one target and resets what they maintained, so a detached tab never reports stale navigation state. */
  private teardownPageDomain(cdpTargetId: string): void {
    const entry = this.pageDomainUnsubs.get(cdpTargetId);
    if (!entry) return;
    for (const off of entry.unsubs) off();
    this.pageDomainUnsubs.delete(cdpTargetId);
    const target = this.byCdpId.get(cdpTargetId);
    if (target) {
      target.loading = false;
      target.mainFrameId = null;
    }
  }

  // ── init scripts ────────────────────────────────────────────────────

  /**
   * Registers this registry's configured `initScripts`
   * (`BrowserSpec.initScripts`, see the constructor and the module doc
   * comment) on one target's session via
   * `Page.addScriptToEvaluateOnNewDocument`, one CDP call per script, in
   * array order (order is significant, per that field's own doc comment in
   * `entities.ts`). Called from both places a page session comes into
   * being, `attach()` and `handleAttachedToTarget`, exactly mirroring
   * `wirePageDomain`'s own two call sites and the reasoning in its comment.
   *
   * Only `'page'` and `'iframe'` targets are eligible. This is
   * deliberately WIDER than `wirePageDomain`'s `type !== 'page'` guard:
   * `wirePageDomain` exists to drive the tab strip's `loading`/history
   * fields, a top level tab concern, but an init script has to run in
   * whatever frame actually owns the document a page's own script would
   * otherwise run in first, and a cross origin subframe (an out of process
   * iframe, attached because `start()`'s `Target.setAutoAttach` filter
   * includes `{ type: 'iframe' }`) is exactly such a frame. A submit gate
   * that only ever installed on top level tabs would miss a form rendered
   * inside a cross origin payment or identity iframe, which is a realistic
   * shape for the exact application forms this feature exists for.
   *
   * Idempotent per session: `initScriptSessions` records which session a
   * target's scripts are currently installed on, so a target that reaches
   * this method twice for the SAME session (`attach()` racing an
   * auto-attach event for a target already wired, the same double-path
   * `wirePageDomain` itself guards against) does not register the same
   * script twice, which would otherwise run it twice on every future
   * navigation. A different (or first) session always reinstalls, which is
   * what makes a script survive a cross origin navigation: see
   * `handleAttachedToTarget`'s call site for why that path re-enters here
   * on every renderer swap.
   *
   * Best effort per script: a target that dies mid-install, or a Chrome
   * build that rejects the call for a target type it does not expect it
   * on, drops that one script rather than throwing `installInitScripts`
   * itself outward and failing the whole attach. `target.scriptIdentifiers`
   * ends up holding whichever identifiers Chrome actually handed back, in
   * the same order as `this.initScripts`, which is what
   * `removeInitScripts` later removes for real.
   */
  private async installInitScripts(target: TargetRuntime, sessionId: string): Promise<void> {
    if (this.initScripts.length === 0) return;
    if (target.type !== 'page' && target.type !== 'iframe') return;
    if (this.initScriptSessions.get(target.cdpTargetId) === sessionId) return;

    const identifiers: string[] = [];
    for (const script of this.initScripts) {
      try {
        const result = (await this.bridge.send(
          'Page.addScriptToEvaluateOnNewDocument',
          { source: script.source },
          sessionId as never,
        )) as { identifier: string };
        identifiers.push(result.identifier);
      } catch {
        // Best effort, see this method's own doc comment: one script that
        // Chrome refuses, or a target that dies mid-loop, must not stop the
        // rest of this target's attach from completing.
      }
    }
    target.scriptIdentifiers = identifiers;
    this.initScriptSessions.set(target.cdpTargetId, sessionId);
  }

  /**
   * Calls this registry's configured `StealthProfileHooks.onTargetAttached`
   * (see the constructor and {@link StealthProfileHooks}) once for one
   * target's session, building the `StealthTargetContext` the profile
   * receives from that session. Same eligibility and idempotency shape as
   * {@link installInitScripts}: `'page'`/`'iframe'` targets only, and a
   * session already handled for this target's `cdpTargetId` is skipped
   * rather than re-run. Best effort: a profile's own adjustment throwing
   * must not fail the target attach it was trying to adjust.
   */
  private async runStealthOnTargetAttached(
    target: TargetRuntime,
    sessionId: string,
  ): Promise<void> {
    if (!this.stealthOnTargetAttached) return;
    if (target.type !== 'page' && target.type !== 'iframe') return;
    if (this.stealthAttachedSessions.get(target.cdpTargetId) === sessionId) return;
    this.stealthAttachedSessions.set(target.cdpTargetId, sessionId);

    const ctx: StealthTargetContext = {
      cdpSessionId: sessionId,
      targetId: target.cdpTargetId,
      targetType: target.type,
      evaluate: (expression) => this.evaluateForStealth(sessionId, expression),
      send: (method, params) => this.bridge.send(method, params, sessionId as never),
    };
    try {
      await this.stealthOnTargetAttached(ctx);
    } catch {
      // Best effort, see this method's own doc comment: a `StealthProfile`
      // bug, or a Chrome build that rejects a CDP command the profile
      // called, must not stop the rest of this target's attach from
      // completing, the same reasoning `installInitScripts` already
      // applies to one script's own failure.
    }
  }

  /**
   * Arms (or re-arms) `./proxy-auth.ts`'s `ProxyAuthHandler` for one
   * target's session, using this registry's own configured
   * {@link proxyAuthCredentials} (see the constructor and
   * {@link createTargetRegistry}'s fifth argument). Same eligibility and
   * idempotency shape as {@link installInitScripts}/
   * {@link runStealthOnTargetAttached}: `'page'`/`'iframe'` targets only
   * (the only types `start()`'s `Target.setAutoAttach` filter ever attaches
   * in the first place), and a session already armed for this target's
   * `cdpTargetId` is skipped rather than re-armed. A DIFFERENT (or first)
   * session always re-arms through the SAME `ProxyAuthHandler` instance
   * (`rebind()`, not a fresh handler), which is what makes proxy auth
   * survive a cross origin navigation, an ordinary re-attach, and a
   * transport reconnect; see `./proxy-auth.ts`'s module doc, "Re-arming".
   * A no-op when this Instance has no proxy credentials configured, so a
   * deployment that never sets `spec.proxy.username`/`password` never pays
   * for `Fetch.enable` on this account, mirroring `RequestGate`'s own
   * "nothing enables `Fetch` unless one is registered" argument.
   *
   * Best effort, matching {@link installInitScripts}'s own doc comment: a
   * target that dies mid-arm, or a session `armProxyAuth` fails against,
   * must not stop the rest of this target's attach from completing.
   */
  private async installProxyAuth(target: TargetRuntime, sessionId: string): Promise<void> {
    if (!this.proxyAuthCredentials) return;
    if (target.type !== 'page' && target.type !== 'iframe') return;
    if (this.proxyAuthSessions.get(target.cdpTargetId) === sessionId) return;

    try {
      const existing = this.proxyAuthHandlers.get(target.cdpTargetId);
      if (existing) {
        await existing.rebind(sessionId as CdpSessionId);
      } else {
        const handler = new ProxyAuthHandler({
          bridge: this.bridge,
          sessionId: sessionId as CdpSessionId,
          credentials: this.proxyAuthCredentials,
        });
        this.proxyAuthHandlers.set(target.cdpTargetId, handler);
        await handler.start();
      }
      this.proxyAuthSessions.set(target.cdpTargetId, sessionId);
    } catch {
      // Best effort, see this method's own doc comment.
    }
  }

  /**
   * `StealthTargetContext.evaluate`'s real implementation: a plain
   * `Runtime.evaluate` on `sessionId`, resolving to the resulting value or
   * rejecting with the page's own thrown error. Deliberately simpler than
   * `evaluate.ts`'s `evaluateInSession` (isolated worlds, structured
   * `EvaluateOutcome`, timeout wiring for an app-triggered evaluate): a
   * `StealthProfile`'s own trusted code, not an app request, is calling
   * this, and the interface it is calling through
   * (`StealthTargetContext.evaluate`) is a bare `Promise<unknown>`.
   */
  private async evaluateForStealth(sessionId: string, expression: string): Promise<unknown> {
    const response = (await this.bridge.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId as never,
    )) as { result?: { value?: unknown }; exceptionDetails?: { text?: string } };
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate threw');
    }
    return response.result?.value;
  }

  /** `TargetRegistry.removeInitScripts`'s real implementation; see that interface method's doc comment for the full contract. */
  async removeInitScripts(id: TargetId): Promise<void> {
    const target = this.require(id);
    if (target.scriptIdentifiers.length === 0) return;
    const sessionId = target.cdpSessionId;
    if (sessionId) {
      for (const identifier of target.scriptIdentifiers) {
        await this.bridge
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, sessionId as never)
          .catch(() => {
            // Best effort: a script Chrome already forgot (the session
            // rebuilt underneath this call, or the identifier never
            // actually landed because `installInitScripts` swallowed that
            // one script's own failure) is not a fault worth surfacing;
            // the array is cleared below regardless, which is this
            // registry's half of "removed" either way.
          });
      }
    }
    target.scriptIdentifiers = [];
    this.initScriptSessions.delete(target.cdpTargetId);
  }

  private async handleAttachedToTarget(params: Record<string, unknown>): Promise<void> {
    const rawInfo = params['targetInfo'] as unknown as RawTargetInfo;
    const sessionId = params['sessionId'] as string;
    const waitingForDebugger = Boolean(params['waitingForDebugger']);
    const target = this.upsertFromRaw(rawInfo);

    target.attached = true;
    target.cdpSessionId = sessionId;
    this.bySessionId.set(sessionId, rawInfo.targetId);
    this.bridge.registerAutoAttachedSession(rawInfo.targetId, sessionId, target.type);

    let watchdog: TimerHandle | null = null;
    if (waitingForDebugger) {
      watchdog = scheduleTimer(() => {
        this.bridge.send('Runtime.runIfWaitingForDebugger', undefined, sessionId).catch(() => {});
      }, 5000);
    }
    try {
      // Of attach steps 2 to 6 (domain enables, emulation, init
      // scripts, file chooser and download settings), `Page` domain enable
      // (`wirePageDomain`, for what `TargetSummary` promises) and init
      // scripts (`installInitScripts`) are built. Emulation, downloads and
      // the file chooser still belong to a later pass.
      this.wirePageDomain(target, sessionId);
      // AWAITED, inside this `try`, BEFORE the `finally` below releases the
      // renderer via `Runtime.runIfWaitingForDebugger`. This is the whole
      // point of `waitForDebuggerOnStart: true` in `start()`'s
      // `Target.setAutoAttach` call: Chrome pauses a freshly attached
      // renderer before it runs anything, which is exactly the window in
      // which `Page.addScriptToEvaluateOnNewDocument` has to land for the
      // very first document on this session to be guaranteed to see it.
      // Miss this window and the renderer resumes, the init script is
      // registered a moment too late for whatever it was already loading,
      // and the whole point of an init script (running BEFORE any page
      // script, not merely before the NEXT navigation) is defeated on
      // exactly the session where it matters most.
      //
      // This same event fires again for the SAME target on a cross origin
      // navigation: Chrome tears down the old renderer's session and mints
      // a fresh one with `waitingForDebugger` true again
      // (`packages/core/src/session/session.ts`'s `rebuildCaptureAndDiagnostics`
      // doc comment describes the identical seam for diagnostics and the
      // request gate), so this one `await` is also what makes an init
      // script survive a cross origin navigation rather than silently
      // stopping, which for a submit gate is a security regression, not a
      // cosmetic one.
      await this.installInitScripts(target, sessionId);
      // `StealthProfile.onTargetAttached`, once per new target (and once
      // per reattach on a cross origin navigation, same reasoning as
      // `installInitScripts` above: a fresh session gets fresh CDP level
      // adjustments, not whatever the torn down session had). Same
      // eligibility as init scripts (`'page'`/`'iframe'` only): a worker
      // target has no page-level automation surface for a stealth profile
      // to adjust. AWAITED before the `finally` below for the same reason
      // as `installInitScripts`: an adjustment like
      // `Emulation.setAutomationOverride` has to land before the paused
      // renderer resumes and runs anything.
      await this.runStealthOnTargetAttached(target, sessionId);
      // Proxy auth, once per new target and once per reattach (cross origin
      // navigation, ordinary re-attach after a transport reconnect's
      // `Target.detachedFromTarget` synthesis: see `./proxy-auth.ts`'s
      // module doc, "Re-arming"). Not required to land before the paused
      // renderer resumes the way an init script is (it governs future
      // `Fetch` traffic on this session, not anything the renderer runs at
      // load), but awaited here anyway for the same ordering discipline as
      // its neighbours: `installInitScripts`/`runStealthOnTargetAttached`.
      // Guarded the same way `attach()`'s own call is; see that call site's
      // comment for why.
      if (this.proxyAuthCredentials) {
        await this.installProxyAuth(target, sessionId);
      }
    } finally {
      clearTimer(watchdog);
      await this.bridge
        .send('Runtime.runIfWaitingForDebugger', undefined, sessionId)
        .catch(() => {});
    }

    // See the matching call in `attach()`: this is the auto-attach path,
    // the other of the two places a target's window becomes knowable.
    void this.windowIdFor(target.id);

    this.emit('attached', target);
  }

  private handleDetachedFromTarget(params: Record<string, unknown>): void {
    const targetId = params['targetId'] as string | undefined;
    const sessionId = params['sessionId'] as string | undefined;
    const cdpTargetId = targetId ?? (sessionId ? this.bySessionId.get(sessionId) : undefined);
    if (!cdpTargetId) {
      return;
    }
    if (this.recentlyDestroyed.has(cdpTargetId)) {
      return;
    }
    const target = this.byCdpId.get(cdpTargetId);
    if (!target) {
      return;
    }
    target.attached = false;
    target.cdpSessionId = null;
    this.teardownPageDomain(cdpTargetId);
    if (sessionId) {
      this.bySessionId.delete(sessionId);
    }
    // A detach this registry asked for is bookkeeping, not a fault. Emitting
    // it reaches `Session.reportSignal` as `cdp_detached` and starts the
    // recovery ladder for the whole Instance; see `intentionalTeardown`. The
    // state above is still cleared either way, so the target is correctly
    // recorded as unattached.
    if (this.intentionalTeardown.has(cdpTargetId)) {
      return;
    }
    this.emit('detached', target);
  }

  private handleTargetCrashed(targetId: string): void {
    const target = this.byCdpId.get(targetId);
    if (!target) {
      return;
    }
    target.crashed = true;
    this.emit('crashed', target);
  }

  /** Marks one CDP target as being torn down on purpose, for {@link intentionalTeardown}. Self expiring, so a close whose events never arrive cannot mask a genuine detach later. */
  private markIntentionalTeardown(cdpTargetId: string): void {
    this.intentionalTeardown.add(cdpTargetId);
    scheduleTimer(() => {
      this.intentionalTeardown.delete(cdpTargetId);
    }, RECENTLY_DESTROYED_TTL_MS);
  }

  private handleTargetDestroyed(targetId: string): void {
    if (this.recentlyDestroyed.has(targetId)) {
      return;
    }
    this.recentlyDestroyed.set(targetId, monotonicNow());
    scheduleTimer(() => {
      this.recentlyDestroyed.delete(targetId);
    }, RECENTLY_DESTROYED_TTL_MS);
    this.removeTarget(targetId);
  }

  private handleWindowOpen(openerCdpTargetId: string, url: string): void {
    this.pendingWindowOpens.set(openerCdpTargetId, { url, at: monotonicNow() });
    scheduleTimer(() => {
      const pending = this.pendingWindowOpens.get(openerCdpTargetId);
      if (pending && monotonicNow() - pending.at >= WINDOW_OPEN_INTENT_TTL_MS) {
        this.pendingWindowOpens.delete(openerCdpTargetId);
      }
    }, WINDOW_OPEN_INTENT_TTL_MS);
  }

  // ── record construction ─────────────────────────────────────────────

  private upsertFromRaw(raw: RawTargetInfo): TargetRuntime {
    const existing = this.byCdpId.get(raw.targetId);
    if (existing) {
      this.applyRawUpdate(existing, raw);
      return existing;
    }

    const classification: TargetClassification = classifyTarget(raw.type, raw.url);
    const id = newId('tgt');
    const now = monotonicNow();
    const openerTargetId = raw.openerId ? (this.byCdpId.get(raw.openerId)?.id ?? null) : null;

    let role: TargetRuntime['role'] = null;
    if (raw.openerId) {
      const pending = this.pendingWindowOpens.get(raw.openerId);
      if (pending) {
        role = isAuthPopupUrl(pending.url) ? 'auth_popup' : 'popup';
        this.pendingWindowOpens.delete(raw.openerId);
      }
    }

    const order = this.computeOrderForNew(raw.openerId ?? null);

    const target: TargetRuntime = {
      id,
      cdpTargetId: raw.targetId,
      instanceId: this.instanceId,
      type: classification.type,
      url: raw.url,
      title: raw.title,
      faviconUrl: null,
      openerId: openerTargetId,
      browserContextId: raw.browserContextId ?? null,
      attached: raw.attached,
      cdpSessionId: null,
      streamable: classification.streamable,
      streamId: null,
      viewport: null,
      scroll: null,
      loading: false,
      crashed: false,
      discardedAt: null,
      createdAt: now,
      lastSeenAt: now,
      dialogOpen: null,
      degraded: false,
      loadTimedOut: false,
      role,
      pinned: false,
      scriptIdentifiers: [],
      order,
      canGoBack: false,
      canGoForward: false,
      mainFrameId: null,
      windowId: null,
    };

    this.byCdpId.set(raw.targetId, target);
    this.byTgtId.set(id, raw.targetId);
    this.emit('created', target);
    return target;
  }

  private applyRawUpdate(target: TargetRuntime, raw: RawTargetInfo): void {
    target.url = raw.url;
    target.title = raw.title;
    target.attached = raw.attached;
    target.browserContextId = raw.browserContextId ?? target.browserContextId;
    target.lastSeenAt = monotonicNow();
  }

  private removeTarget(cdpTargetId: string): void {
    this.closing.delete(cdpTargetId);
    const target = this.byCdpId.get(cdpTargetId);
    if (!target) {
      return;
    }
    this.teardownPageDomain(cdpTargetId);
    // No CDP call needed here: the target (and every session it ever had)
    // is gone, so there is nothing left for `Page.removeScriptToEvaluateOnNewDocument`
    // to reach. This only drops this registry's own bookkeeping, the same
    // as `bySessionId.delete` two lines down.
    this.initScriptSessions.delete(cdpTargetId);
    // A `ProxyAuthHandler` left running past its target's removal has
    // nothing left to ever call `stop()` on it again, which leaks the
    // `Fetch.enable` it (co-)owns onto a session nobody is managing any
    // more, the same reasoning `Session.teardownTarget` already applies to
    // `RequestGate`/`TargetDiagnostics`. Best effort: the target is already
    // gone, so a `Fetch.disable` this triggers may find no session left to
    // answer it either.
    const proxyAuth = this.proxyAuthHandlers.get(cdpTargetId);
    if (proxyAuth) {
      this.proxyAuthHandlers.delete(cdpTargetId);
      this.proxyAuthSessions.delete(cdpTargetId);
      void proxyAuth.stop().catch(() => {});
    }
    this.byCdpId.delete(cdpTargetId);
    this.byTgtId.delete(target.id);
    if (target.cdpSessionId) {
      this.bySessionId.delete(target.cdpSessionId);
    }
    this.emit('closed', target);
  }

  // ── ordering ─────────────────────────────────────────────────────────

  private computeOrderForNew(openerCdpId: string | null): number {
    const all = [...this.byCdpId.values()];
    if (!openerCdpId) {
      return maxOrderOf(all, null) + ORDER_STEP;
    }
    const opener = this.byCdpId.get(openerCdpId);
    if (!opener) {
      return maxOrderOf(all, null) + ORDER_STEP;
    }
    const nextAfterOpener = orderAfter(all, opener.order);
    if (nextAfterOpener !== null && nextAfterOpener - opener.order < MIN_ORDER_GAP) {
      this.renumber();
      const renumberedOpener = this.byCdpId.get(openerCdpId);
      const afterRenumber = renumberedOpener
        ? orderAfter([...this.byCdpId.values()], renumberedOpener.order)
        : null;
      const base = renumberedOpener ? renumberedOpener.order : maxOrderOf(all, null);
      return afterRenumber !== null ? (base + afterRenumber) / 2 : base + ORDER_STEP;
    }
    return nextAfterOpener !== null
      ? (opener.order + nextAfterOpener) / 2
      : opener.order + ORDER_STEP;
  }

  private renumber(): void {
    const sorted = [...this.byCdpId.values()].sort(compareTargetOrder);
    sorted.forEach((target, idx) => {
      target.order = (idx + 1) * ORDER_STEP;
    });
  }
}

function compareTargetOrder(a: TargetRuntime, b: TargetRuntime): number {
  if (a.pinned !== b.pinned) {
    return a.pinned ? -1 : 1;
  }
  return a.order - b.order;
}

function maxOrderOf(all: readonly TargetRuntime[], exclude: TargetRuntime | null): number {
  let max = 0;
  for (const t of all) {
    if (t === exclude) {
      continue;
    }
    if (t.order > max) {
      max = t.order;
    }
  }
  return max;
}

function orderAfter(all: readonly TargetRuntime[], order: number): number | null {
  let best: number | null = null;
  for (const t of all) {
    if (t.order > order && (best === null || t.order < best)) {
      best = t.order;
    }
  }
  return best;
}

/**
 * Constructs a {@link TargetRegistry} for one Instance's `CdpBridge`.
 * `initScripts`, when given, is that Instance's `BrowserSpec.initScripts`
 * (`entities.ts`): the module doc comment above explains why this
 * constructor is where it has to enter, rather than this registry reading
 * a `BrowserSpec` itself. Defaults to empty, so every call site that does
 * not yet pass it (there are two outside this package today) keeps
 * compiling and keeps its current behaviour, exactly as if init scripts
 * did not exist for that caller.
 *
 * `stealth`, when given, is a resolved `StealthProfile`'s
 * {@link StealthProfileHooks}: `profile.initScripts(spec)` merged ahead of
 * `initScripts` (see the constructor's own comment for the ordering
 * rationale) and `profile.onTargetAttached` called once per new page/
 * iframe target. This registry never resolves a `StealthProfile` itself
 * (which profile applies to a `BrowserSpec.stealth` level, and whether
 * that level is even permitted, is `HostRuntimeConfig`/`resolveRequiredStealthProfile`
 * territory, `@browserglass/runtime-host`, a package this one does not
 * depend on); the caller that already holds both the resolved profile and
 * the spec is the one that builds this argument, the same relationship
 * `initScripts` already has to `BrowserSpec.initScripts`. Defaults to
 * `null`, so every existing call site keeps compiling and behaving exactly
 * as before until its owner threads a resolved profile through.
 *
 * `proxyAuthCredentials`, when given, is `BrowserSpec.proxy.username`/
 * `password` (`@browserglass/protocol`'s `entities.ts`): every `'page'`/
 * `'iframe'` target this registry attaches gets a `./proxy-auth.ts`
 * `ProxyAuthHandler` armed on its session, re-armed on every path that
 * mints a fresh one (see that module's doc, "Re-arming"). Defaults to
 * `null`, same reasoning as `initScripts`/`stealth`: every existing call
 * site keeps compiling and keeps behaving exactly as before (no `Fetch`
 * enabled on this account at all) until its owner threads
 * `spec.proxy.username`/`password` through.
 */
export function createTargetRegistry(
  instanceId: InstanceId,
  bridge: CdpBridge,
  initScripts?: readonly { name: string; source: string }[],
  stealth?: StealthProfileHooks | null,
  proxyAuthCredentials?: ProxyAuthCredentials | null,
): TargetRegistry {
  return new TargetRegistryImpl(instanceId, bridge, initScripts, stealth, proxyAuthCredentials);
}
