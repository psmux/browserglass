/**
 * `SessionRegistry`: the process-wide `instanceId` to {@link ManagedSession}
 * map, with join-in-flight construction (two viewers attaching to the same
 * Instance in the same tick share one `CdpBridge`/`TargetRegistry`/`Session`
 * triple, never race to build two) and eviction once a session has no
 * viewers left. The actual construction (reaching the router for
 * `Instance.runtime.cdpWsUrl`, connecting a `CdpBridge`, starting a
 * `TargetRegistry`) is supplied by the caller as a factory, so this module
 * has no dependency on `@browserglass/router` itself.
 */

import type { ManagedSession } from './managed-session.js';

/** The context a first-time build needs; ignored by every caller that joins an already-live session. `sessionId` is not included: the factory derives it from the Instance itself (`Instance.sessionId`), which is authoritative, rather than trusting a caller-supplied guess. */
export interface ManagedSessionContext {
  readonly tenantId: string;
  readonly appId: string;
}

/**
 * What `getOrCreate` actually hands the factory: the caller's own
 * {@link ManagedSessionContext}, plus `onIdle`, which this registry adds
 * itself rather than asking every caller of `getOrCreate` to remember to
 * supply it. `onIdle` is `ManagedSession`'s own construction time option
 * (`managed-session.ts`'s `ManagedSessionOptions.onIdle`, fired once
 * `connections.size === 0`); until this type existed, `createManagedSessionFactory`
 * (`./factory.ts`) had nothing to pass into it, so the option was always
 * `undefined` and `evict` below was reachable only from `disposeAll()`.
 */
export interface ManagedSessionFactoryContext extends ManagedSessionContext {
  /** Schedules this `instanceId`'s session for eviction, `noViewerGraceMs` after its `ManagedSession` reports no connections left; cancelled if a viewer reattaches first. See {@link SessionRegistry.evict}'s own doc for why an immediate, ungraced version of this broke resume. */
  readonly onIdle: () => void;
}

/** Builds a fresh {@link ManagedSession} for `instanceId`. Supplied by `ws/connection.ts`'s wiring (`packages/server/src/index.ts`), which is the one place with router access. */
export type ManagedSessionFactory = (
  instanceId: string,
  ctx: ManagedSessionFactoryContext,
) => Promise<ManagedSession>;

/**
 * One process's live `ManagedSession` pool. A `BrowserGlass` instance owns
 * exactly one.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly inflight = new Map<string, Promise<ManagedSession>>();
  private readonly factory: ManagedSessionFactory;
  private readonly noViewerGraceMs: number;
  /**
   * One pending eviction timer per idle `instanceId`, armed by `onIdle`
   * and cancelled the moment a viewer reattaches (`getOrCreate`'s
   * `existing` branch, below). A first version of this fix evicted
   * immediately on `onIdle`, with no grace window at all; that broke WS
   * resume outright (`ws/connection.ts`'s `resumeInto`,
   * `ManagedSession.resumeViewer`'s "retained bookkeeping" the resume
   * token itself carries none of), because a resuming viewer's
   * `getOrCreate` call landed on an already-disposed session and rebuilt
   * a fresh one with no memory of that viewer's prior target
   * subscriptions or restored lease. `session.limits.resumeWindowMs`
   * (`config/resolve.ts`, default 120s) is exactly how long a resume
   * token stays valid, so a session must outlive at least that long after
   * its last viewer leaves for resume to ever have a session left to
   * resume into; `noViewerGraceMs` defaults to match.
   */
  private readonly pendingEvictions = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * `noViewerGraceMs` (default 120,000, matching `resumeWindowMs`'s own
   * default, `config/resolve.ts`) is how long an idle session (no
   * connections) is kept alive before `evict()` actually runs, so a
   * viewer that reconnects within the resume window still has a live
   * session, and the same `ManagedSession`'s retained per-viewer
   * bookkeeping, to resume into.
   */
  constructor(factory: ManagedSessionFactory, noViewerGraceMs = 120_000) {
    this.factory = factory;
    this.noViewerGraceMs = noViewerGraceMs;
  }

  /** Returns the live `ManagedSession` for `instanceId`, building one if none exists yet. Concurrent callers for the same `instanceId` share one in-flight build; `ctx` is consulted only by the caller that actually triggers the build. */
  async getOrCreate(instanceId: string, ctx: ManagedSessionContext): Promise<ManagedSession> {
    const existing = this.sessions.get(instanceId);
    if (existing) {
      // A viewer (fresh or resuming) reattached before this idle session's
      // grace window ran out: it is still wanted, so the pending eviction
      // this same session's own last `onIdle` armed must not fire under it.
      this.cancelPendingEviction(instanceId);
      return existing;
    }
    const inflight = this.inflight.get(instanceId);
    if (inflight) return inflight;

    const building = this.factory(instanceId, {
      ...ctx,
      onIdle: () => this.scheduleEviction(instanceId),
    })
      .then((managed) => {
        this.sessions.set(instanceId, managed);
        this.inflight.delete(instanceId);
        return managed;
      })
      .catch((err) => {
        this.inflight.delete(instanceId);
        throw err;
      });
    this.inflight.set(instanceId, building);
    return building;
  }

  get(instanceId: string): ManagedSession | undefined {
    return this.sessions.get(instanceId);
  }

  all(): readonly ManagedSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Arms `instanceId`'s eviction, `noViewerGraceMs` from now, replacing
   * any timer already pending for it (a session can go idle, gain a
   * viewer, and go idle again within one grace window). `noViewerGraceMs
   * <= 0` evicts synchronously instead of scheduling a zero delay timer,
   * which is what this registry's own tests use for a fast, deterministic
   * "evicted immediately" assertion.
   */
  private scheduleEviction(instanceId: string): void {
    this.cancelPendingEviction(instanceId);
    if (this.noViewerGraceMs <= 0) {
      this.evict(instanceId);
      return;
    }
    const timer = setTimeout(() => {
      this.pendingEvictions.delete(instanceId);
      this.evict(instanceId);
    }, this.noViewerGraceMs);
    // A grace timer is bookkeeping, not real work: it must never be the
    // reason a process with nothing else to do stays alive.
    timer.unref?.();
    this.pendingEvictions.set(instanceId, timer);
  }

  private cancelPendingEviction(instanceId: string): void {
    const timer = this.pendingEvictions.get(instanceId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingEvictions.delete(instanceId);
  }

  /**
   * Evicts and disposes `instanceId`'s session immediately, if any.
   * Called from three places: `disposeAll()` on shutdown, `scheduleEviction`'s
   * own timer once the grace window actually elapses, and (`noViewerGraceMs
   * <= 0` only) `scheduleEviction` directly. Before this fix's `onIdle`
   * wiring existed at all, this method was reachable only from
   * `disposeAll()`: `ManagedSession` was always built without an `onIdle`
   * option (`factory.ts`), so a session (its `CdpBridge` socket and
   * `TargetRegistry` included) leaked for the life of the process once its
   * last viewer left, on every gateway this build could run.
   */
  evict(instanceId: string): void {
    this.cancelPendingEviction(instanceId);
    const managed = this.sessions.get(instanceId);
    if (!managed) return;
    this.sessions.delete(instanceId);
    managed.dispose();
  }

  /** Disposes every live session, and cancels every pending grace timer so none fires after this registry is gone. Called from `stop()`. */
  disposeAll(): void {
    for (const instanceId of [...this.sessions.keys()]) this.evict(instanceId);
  }
}
