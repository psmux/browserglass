/**
 * The pure lifecycle decision functions the reaper and idle detection use.
 * Kept separate
 * from `BrowserRouter`'s store touching orchestration (`reaperSweep()` on
 * the class itself) so the two-phase idle state machine and each sweep's
 * predicate can be unit tested without a store or a real timer.
 */

/** Two-phase idle detection: `ready --idleMs--> idle --idleGraceMs--> releasing`, any activity resets to `ready`. */
export type IdlePhase = 'active' | 'idle-grace' | 'release';

/** One idle decision, `evaluateIdle`'s result. */
export interface IdleDecision {
  phase: IdlePhase;
  /** Set only for `'idle-grace'`: how long until the grace period elapses and the instance releases. */
  closesInMs?: number;
}

/**
 * The two-phase idle state machine as a pure function of elapsed idle
 * time. `idleFor` is `now - lastActivityAt`. Grace shortens to
 * `idleGraceUnderPressureMs` when `queued` is true (a queued acquirer
 * outranks an empty idle browser someone might return to).
 */
export function evaluateIdle(
  idleFor: number,
  idleMs: number,
  idleGraceMs: number,
  idleGraceUnderPressureMs: number,
  queued: boolean,
): IdleDecision {
  if (idleFor < idleMs) return { phase: 'active' };
  const grace = queued ? idleGraceUnderPressureMs : idleGraceMs;
  if (idleFor < idleMs + grace)
    return { phase: 'idle-grace', closesInMs: idleMs + grace - idleFor };
  return { phase: 'release' };
}

/** The TTL sweep: `now > expiresAt`. */
export function isTtlExpired(now: number, expiresAt: number): boolean {
  return now > expiresAt;
}

/** The max duration sweep: `now > acquiredAt + maxDurationMs`, never reset by activity. */
export function isMaxDurationExceeded(
  now: number,
  acquiredAt: number,
  maxDurationMs: number,
): boolean {
  return now - acquiredAt > maxDurationMs;
}

/**
 * The orphan sweep: a `ready` (or `degraded`) instance whose node has not
 * heartbeated in `nodeStaleMs * 3`. Single node reduction of "the node is
 * lost": here it means the local heartbeat loop itself stalled (an event
 * loop stall), still worth a safety net sweep for.
 */
export function isOrphaned(now: number, nodeLastHeartbeatAt: number, nodeStaleMs: number): boolean {
  return now - nodeLastHeartbeatAt >= nodeStaleMs * 3;
}

/**
 * The stuck sweep (unified with startup reconcile): an instance
 * stuck in `requested`/`placing`/`launching` past `launchTimeoutMs * 2`.
 * Catches a lost message or a crash mid launch, which without this sweep
 * holds a profile lease and a quota slot forever.
 */
export function isStuckLaunching(
  now: number,
  stateChangedAt: number,
  launchTimeoutMs: number,
): boolean {
  return now - stateChangedAt > launchTimeoutMs * 2;
}

/** Every `InstanceLifecycleState` the stuck sweep and startup reconcile both cover (unified, not `placing|launching` for one and `requested|placing|launching` for the other). */
export const STUCK_LAUNCH_STATES = Object.freeze(['requested', 'placing', 'launching'] as const);
