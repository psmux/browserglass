/**
 * `ControlLeaseEngine`: the orchestrator that drives one target's `Lease`
 * through `LeasePhase` (`transitions.ts`), applies the configured
 * `ControlPolicy` (`policies.ts`), maintains the FIFO queue (`queue.ts`),
 * schedules every lease timer against an injected `Clock`
 * (`clock.ts`), and produces the wire effects (`types.ts`'s `LeaseEffect`)
 * a transport layer sends out.
 *
 * One instance per `(sessionId, targetId)`: a `ControlLease` is scoped to a
 * Target, not a Session, so a Session with several
 * targets owns several engines.
 *
 * TWO MODES, one engine (`ControlLeaseEngineOptions.mode`, default
 * `'exclusive'`, fixed for the life of the engine):
 *
 *  - `'exclusive'` is everything below: one holder, a FIFO queue, and the
 *    two-step preemption machine. Unchanged.
 *  - `'shared'` admits N concurrent holders on one target. A viewer with the
 *    `control` capability who asks is granted control IMMEDIATELY, with
 *    their OWN `leaseId`. Nobody waits, so nobody preempts: the queue and
 *    the whole preemption machine are exclusive-mode concepts, and
 *    `control.queued`, `control.preempt.request`,
 *    `control.preempt.cancelled` and `control.preempted` are never emitted
 *    for a shared target. `force: true` is a no-op there (there is nothing
 *    to displace); `control.revoke`, which names one holder, is the way an
 *    admin removes a specific driver.
 *
 * What shared mode has instead of preemption, and only for the human over
 * agent case, is `control.yield` (`requestAgentYield`): a person asks the
 * AGENT holders of a target to stand down and every HUMAN holder keeps
 * driving. It is deliberately not modelled as preemption. Nobody is losing a
 * lease to a queue, the requester wins nothing they could not already have
 * for the asking, and a yielded agent is granted control again the instant it
 * asks, so the whole `mayRequeue`/`requeueAfterMs` vocabulary would be
 * describing a wait that cannot occur here.
 *
 * PER HOLDER TIMERS. Idle release, renewal grace, expiry warning, and
 * disconnect grace all hang off a holder, not off the lease, and are
 * scheduled and cancelled per holder. One driver going idle, losing their
 * socket, or letting their lease lapse must take down that driver and
 * nobody else. In exclusive mode there is exactly one holder, so every one
 * of those timers behaves precisely as it did when it hung off the lease.
 *
 * A shared lease never enters `held-grace` or `preempt-pending`: a
 * disconnected holder sits out their own grace while the lease stays
 * `held`, so the drivers who are still connected keep driving.
 *
 * TENURE AND HYGIENE ARE TWO DEADLINES, not one. A holder whose socket dies
 * keeps their tenure for the full `disconnectGraceMs` (30s), so a reconnect
 * inside the window resumes the SAME `leaseId`; but their held buttons,
 * modifiers, touches and drag are swept after `disconnectHygieneMs` (1.5s)
 * whenever somebody else is still driving that page, because a stuck pointer
 * belongs to everyone looking at it and their seat belongs only to them.
 * Measured before the split: a hard socket close left a button down for
 * 30514ms.
 *
 * Two pieces of real mechanism this engine does not own are taken by
 * injection: `drainInput` (the input dispatcher's per-target tail promise,
 * `core/src/input/**`) and `releaseHeld` (the pointer/key hygiene sweep,
 * same module). Both default to an immediate no-op so this module is fully
 * testable on its own; `Session` wires the real implementations in.
 *
 * Monotonic-versus-wall-clock discipline: every stored timestamp used for scheduling or duration
 * arithmetic (`LeaseHolder.grantedAt/lastInputAt/lastRenewAt`, `QueueEntry`
 * timestamps) is a `clock.monotonicNow()` reading. The only exception is
 * `Lease.preemptDeadline`, which is genuinely wire-facing
 * (`ControlPreemptRequest.deadline` is specified as "wall clock, Unix ms,
 * authoritative") and is computed once, directly
 * from `clock.wallNow() + graceMs`, at the same instant the matching
 * monotonic delay is handed to `clock.setTimer`, so no monotonic value is
 * ever read back and reinterpreted as a wall value, or vice versa.
 * `computeExpiresAt()` and `monoToWall()` are the two places a monotonic
 * *duration* (never an absolute monotonic reading) is projected onto the
 * current wall reading to produce a wire timestamp.
 */

import type {
  ContentionHolder,
  ControlContention,
  ControlDenied,
  ControlExpiring,
  ControlGranted,
  ControlPreemptCancelled,
  ControlPreemptRequest,
  ControlPreempted,
  ControlQueued,
  ControlRevoked,
  ControlStateMsg,
  ControlYieldRequest,
  LeaseHolderState,
  LeaseMode,
  LeaseState,
  LeaseSummary,
} from '@browserglass/protocol';
import type { Clock, TimerHandle } from './clock.js';
import { CONTROL_TIMING, type ControlTiming } from './constants.js';
import { type FenceCheckInput, type FenceDecision, resolveInputFencing } from './fencing.js';
import {
  type ControlPolicy,
  type ControlPolicyName,
  type PolicyContext,
  getControlPolicy,
} from './policies.js';
import {
  HoldDurationTracker,
  expireQueue,
  insertIntoQueue,
  queuePositionFor,
  removeFromQueue,
} from './queue.js';
import { applyLeasePhaseTransition } from './transitions.js';
import {
  DEFAULT_PRIORITY,
  type HolderKind,
  type Lease,
  type LeaseAuditNote,
  type LeaseDirectEffect,
  type LeaseEffect,
  type LeaseHolder,
  type PreemptReason,
  type QueueEntry,
  type ViewerRef,
  createLease,
} from './types.js';

const BASE_CAPABILITIES: ReadonlySet<string> = Object.freeze(new Set(['control']));
const ADMIN_CAPABILITIES: ReadonlySet<string> = Object.freeze(new Set(['control', 'admin']));

function mintLeaseId(): string {
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  // Every production runtime this build targets (Node 22) provides
  // `crypto.randomUUID`; this path exists only so the module never throws
  // on an unusual host, and is not itself cryptographically strong.
  return `lse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Options accepted by {@link ControlLeaseEngine.requestControl}, mirroring wire `ControlRequest`. */
export interface RequestControlOptions {
  readonly reason?: string;
  /** Server clamps a supplied priority; omit to use the viewer kind's default. */
  readonly priority?: number;
  /** Requires `viewer.isAdmin`; ignored otherwise. */
  readonly force?: boolean;
  /** Default true: queue if busy instead of failing. */
  readonly queue?: boolean;
  /** The wire `control.request`'s own `id`, if it carried one. Echoed as `re` on whichever direct effect this call produces (immediate grant, deny, or queued; and, for a queued request, the eventual grant once it reaches the head of the queue). Never echoed onto an unrelated viewer's message (the current holder's `control.preempt.request`, a broadcast `control.state`, and so on). */
  readonly requestId?: string;
}

/** Constructor options for {@link ControlLeaseEngine}. */
export interface ControlLeaseEngineOptions {
  readonly sessionId: string;
  readonly targetId: string;
  readonly clock: Clock;
  /** Called synchronously for every wire effect the engine produces. */
  readonly emit: (effect: LeaseEffect) => void;
  /**
   * How many people may drive this target at once. Default `'exclusive'`,
   * which is what every existing integration gets and what every existing
   * integration already relies on: `'shared'` removes exclusivity, and some
   * automation treats exclusivity as a safety property.
   *
   * Chosen HERE, server side and per target, rather than on
   * `control.request`. Arbitration has to be single valued for a contended
   * resource: with a per request mode, "Alice holds exclusively, Bob asks
   * for shared" has no honest answer, and the fencing, timer, and queue
   * paths would each need one anyway. What a viewer genuinely chooses is
   * whether to ask for control at all (view, or view and control), which is
   * a decision they already make by sending `control.request` or not.
   *
   * Downgraded to `'exclusive'` when `timing.allowShared` is false (the
   * deployment veto), with a `control.sharedNotAllowed` audit note so the
   * downgrade is never silent.
   */
  readonly mode?: LeaseMode;
  /** Default `'exclusive'`. */
  readonly policyName?: ControlPolicyName;
  readonly timing?: Partial<ControlTiming>;
  readonly ownerViewerIds?: ReadonlySet<string>;
  /** Maximum queue depth before a new request is denied `queue_full`. Default 32. */
  readonly maxQueueDepth?: number;
  /** Step 2 of the handoff drain: the input dispatcher's tail promise for this target. Defaults to an immediate no-op. */
  readonly drainInput?: (targetId: string) => Promise<void>;
  /** Step 4 of the handoff drain: pointer/key hygiene. Defaults to an immediate no-op. */
  readonly releaseHeld?: (targetId: string, viewerId: string) => Promise<void> | void;
  /** Optional sink for structured notes (for example `handoverDrainTimeout`) that are not themselves wire messages. */
  readonly onAudit?: (note: LeaseAuditNote) => void;
}

/**
 * The timers that belong to ONE holder. The first four used to hang off the
 * lease, which was correct while a lease had one holder and is wrong the
 * moment it has several: one driver's idle clock, renewal lapse, expiry
 * warning, or disconnect grace must never touch another driver's tenure.
 *
 * `disconnectHygiene` is the fifth: the prompt pointer and key sweep that
 * runs well before `disconnectGrace`, so a driver whose socket died hard does
 * not leave a button held down inside a page other people are still driving.
 * See `ControlTiming.disconnectHygieneMs` for why the two deadlines are split
 * and where 1500ms comes from.
 *
 * `yieldGrace` is the sixth and belongs to a holder rather than to the lease
 * for the same reason all the others do: a `control.yield` can name several
 * agent holders of one shared target at once, each of them has its own
 * deadline to stand down by, and one running out must end that agent's tenure
 * and nobody else's. It is the only holder timer that is never scheduled in
 * exclusive mode (see {@link ControlLeaseEngine.requestAgentYield}).
 */
type HolderTimerName =
  | 'idleRelease'
  | 'renewGrace'
  | 'expiryWarning'
  | 'disconnectGrace'
  | 'disconnectHygiene'
  | 'yieldGrace';

/**
 * The timers that belong to the LEASE rather than to any one holder.
 * `preemptDeadline` is the preemption grace, which is exclusive-mode only
 * (nobody preempts on a shared target, because nobody waits).
 */
type TimerName = 'preemptDeadline';

/**
 * Drives one Target's `ControlLease` end to end: requests, renewal,
 * release, admin revoke, disconnect/reconnect, preemption, and the FIFO
 * queue. See the module doc for the injection points and the clock
 * discipline.
 */
export class ControlLeaseEngine {
  private readonly sessionId: string;
  private readonly targetId: string;
  private readonly clock: Clock;
  private readonly emit: (effect: LeaseEffect) => void;
  private readonly policy: ControlPolicy;
  private readonly timing: ControlTiming;
  private readonly ownerViewerIds: ReadonlySet<string>;
  private readonly maxQueueDepth: number;
  private readonly drainInput: (targetId: string) => Promise<void>;
  private readonly releaseHeldHook: (targetId: string, viewerId: string) => Promise<void> | void;
  private readonly onAudit: ((note: LeaseAuditNote) => void) | undefined;
  private readonly holdTracker = new HoldDurationTracker();
  private readonly timers: Partial<Record<TimerName, TimerHandle>> = {};
  /** One entry per current holder, keyed by `viewerId`; see {@link HolderTimerName}. Entries are created on grant and deleted the moment a holder stops holding. */
  private readonly holderTimers = new Map<string, Partial<Record<HolderTimerName, TimerHandle>>>();
  /** In-flight handoff-drain timeouts. Not in {@link timers}: a shared lease can be draining one departing holder while another departs, so there is no single slot to put them in. */
  private readonly drainTimers = new Set<TimerHandle>();

  private lease: Lease;

  constructor(options: ControlLeaseEngineOptions) {
    this.sessionId = options.sessionId;
    this.targetId = options.targetId;
    this.clock = options.clock;
    this.emit = options.emit;
    this.policy = getControlPolicy(options.policyName ?? 'exclusive');
    this.timing = Object.freeze({ ...CONTROL_TIMING, ...options.timing });
    this.ownerViewerIds = options.ownerViewerIds ?? new Set();
    this.maxQueueDepth = options.maxQueueDepth ?? 32;
    this.drainInput = options.drainInput ?? (() => Promise.resolve());
    this.releaseHeldHook = options.releaseHeld ?? (() => {});
    this.onAudit = options.onAudit;
    const requestedMode = options.mode ?? 'exclusive';
    const mode: LeaseMode =
      requestedMode === 'shared' && !this.timing.allowShared ? 'exclusive' : requestedMode;
    if (mode !== requestedMode) {
      // Refusing to start at all would take down a whole session over a
      // configuration mismatch; running shared anyway would ignore an
      // operator's explicit veto. Downgrading loudly is the only option that
      // does neither, and the note is what makes it loud.
      this.onAudit?.({
        type: 'control.sharedNotAllowed',
        targetId: this.targetId,
        sessionId: this.sessionId,
        requestedMode,
        effectiveMode: mode,
      });
    }
    this.lease = createLease(this.sessionId, this.targetId, mode);
  }

  /** A shallow, readonly snapshot of the current lease, for inspection and tests. `holder`, `leaseId` and `graceUntil` are the derived primary-holder values (`types.ts`), flattened by the spread. */
  getSnapshot(): Readonly<Lease> {
    return {
      ...this.lease,
      holders: this.lease.holders.map((holder) => ({ ...holder })),
      queue: [...this.lease.queue],
    };
  }

  /** This target's lease mode, fixed at construction. */
  getMode(): LeaseMode {
    return this.lease.mode;
  }

  /**
   * Whether `viewerId` is one of the CURRENT holders. The right question to
   * ask in both modes: `getSnapshot().holder?.viewerId === viewerId` answers
   * it only for the longest tenured driver of a shared lease, and is wrong
   * (silently, and only under shared control) for every other driver.
   */
  isHolder(viewerId: string): boolean {
    return this.holderFor(viewerId) !== null;
  }

  /** `viewerId`'s own holder record, or `null` if they are not driving this target. */
  holderFor(viewerId: string): Readonly<LeaseHolder> | null {
    return this.lease.holders.find((holder) => holder.viewerId === viewerId) ?? null;
  }

  /** Pure fencing decision for one inbound input message; see `fencing.ts`. Matches the inbound `leaseId` against every current holder, which is what makes N concurrent drivers possible. */
  checkFencing(
    input: FenceCheckInput,
    options?: { readonly lastHolderViewerId?: string | null },
  ): FenceDecision {
    return resolveInputFencing(this.lease, input, options);
  }

  /** Cancels every pending timer, lease-wide and per holder. Call when the target (and therefore this engine) is going away. */
  dispose(): void {
    this.clearAllTimers();
    for (const handle of this.drainTimers) this.clock.clearTimer(handle);
    this.drainTimers.clear();
  }

  // ── control.request ──────────────────────────────────────────────────

  /** Handles `control.request`. */
  requestControl(viewer: ViewerRef, opts: RequestControlOptions = {}): void {
    const priority = opts.priority ?? DEFAULT_PRIORITY[viewer.kind];
    const force = Boolean(opts.force) && viewer.isAdmin;
    const wantsQueue = opts.queue ?? true;
    // MONOTONIC, not wall. `PolicyContext.now` is compared against
    // `LeaseHolder.grantedAt` (`EXCLUSIVE_POLICY`'s `minHoldMs` floor), and
    // every anchor on a `Lease` is a monotonic reading by the discipline at
    // the top of this file. Handing a wall reading in made that comparison
    // `Date.now() - performance.now()` in production, which is always
    // enormous, so `minHoldMs` never once held a preemption back outside a
    // `ManualClock` test (where the two readings are equal, which is exactly
    // why the tests were green). Nothing a policy decides reaches the wire,
    // so nothing here wants a wall reading.
    const now = this.clock.monotonicNow();
    const requestId = opts.requestId;

    const ctx = this.policyContextFor(viewer, { force, priority }, now);
    if (!this.policy.canRequest(ctx)) {
      this.emitDenied(
        viewer.viewerId,
        'session_readonly',
        'Control is not available under the current policy.',
        undefined,
        requestId,
      );
      return;
    }

    // A viewer that already holds this lease asking for it again is
    // idempotent: re-emit the grant it already has, without minting a new
    // leaseId and without touching the queue.
    //
    // Without this the request fell through to `requestWhileHeld`, which
    // does not special case the holder, so the holder queued BEHIND ITSELF:
    // `{granted: false, queued: true, position: 1}` with its own viewerId as
    // both the holder and the sole queue entry. Reproduced against the
    // running demo. It is easy to hit by accident, because nothing about it
    // looks like an error: a double click on "Take control", React
    // StrictMode running an effect twice in development, or any component
    // that re-requests on remount is enough, and
    // `RequestControlButton` then renders a permanent "Waiting, 1 in queue"
    // on a pane the viewer is already driving.
    //
    // `buildGranted()` reads the CURRENT lease, so re-emitting it hands back
    // the same `leaseId` the viewer is already stamping onto its input.
    // Minting a fresh one (by calling `grant()` again) would invalidate
    // every input message already in flight under the old id, which is a
    // real cost for what should be a no-op.
    const ownHolder = this.holderFor(viewer.viewerId);
    if ((this.lease.phase === 'held' || this.lease.phase === 'held-grace') && ownHolder) {
      this.emitDirect(viewer.viewerId, this.buildGranted(ownHolder), requestId);
      return;
    }

    // Shared mode diverges here, after the policy veto and after the
    // already-a-holder shortcut, and never reaches the queue or the
    // preemption machine below.
    if (this.isShared) {
      this.requestShared(viewer, priority, ctx, requestId);
      return;
    }

    if (this.lease.phase === 'unheld') {
      this.requestWhileUnheld(viewer, priority, ctx, requestId);
      return;
    }
    if (this.lease.phase === 'held') {
      this.requestWhileHeld(viewer, priority, force, wantsQueue, opts.reason, ctx, requestId);
      return;
    }
    if (this.lease.phase === 'held-grace') {
      this.requestWhileHeldGrace(viewer, priority, force, wantsQueue, opts.reason, requestId);
      return;
    }
    // preempt-pending, handing-over, revoking: queue behind whatever resolves it.
    this.enqueueOrDeny(viewer, priority, opts.reason, wantsQueue, requestId);
  }

  /**
   * `control.request` on a `mode: 'shared'` target. The whole point of the
   * mode: a viewer who is allowed to control gets control now, alongside
   * whoever else is already driving.
   *
   * `force` and `queue` are both ignored here, and neither is quietly
   * dropped on the floor:
   *
   *  - `force: true` asks to displace a holder or jump a queue. A shared
   *    target has neither, and the requester's actual goal (drive now) is
   *    met in full by the ordinary grant. The part force cannot deliver
   *    (and nobody else drives) is not something shared mode offers at all,
   *    so denying the request to protect it would fail the primary goal in
   *    order to defend a secondary one. An admin who needs one specific
   *    driver off uses `control.revoke`, which names a holder and removes
   *    only that holder.
   *  - `queue: false` means "fail rather than make me wait". Nobody waits
   *    here, so there is nothing for it to prevent.
   *
   * The one case that is not an immediate grant is a request that lands
   * while the lease is settling (`handing-over` after the last holder left,
   * or `revoking`). Granting into a phase whose settlement is about to
   * clear the holder list would hand out a lease that is discarded
   * microseconds later. Denying would make the button fail at random for a
   * window the viewer cannot see. So the request is parked on the queue
   * WITHOUT a `control.queued` (nothing was queued in any sense the viewer
   * would recognise: this is an admission backlog, bounded by
   * `handoverDrainMs`), and `settleHandingOver` grants every parked entry,
   * echoing `re` back to the original request through `entry.requestId`.
   */
  private requestShared(
    viewer: ViewerRef,
    priority: number,
    ctx: PolicyContext,
    requestId: string | undefined,
  ): void {
    if (this.lease.phase === 'unheld') {
      const decision = this.policy.onRequestUnheld(ctx);
      const outcome = applyLeasePhaseTransition(this.leaseTag(), 'unheld', 'request', {
        policyPermits: decision === 'grant',
        policyObserverOnly: decision !== 'grant',
      });
      if (outcome.kind !== 'ok' || outcome.to !== 'held') {
        this.emitDenied(
          viewer.viewerId,
          'policy',
          'Control request denied by policy.',
          undefined,
          requestId,
        );
        return;
      }
      this.grant(viewer, priority, requestId);
      return;
    }

    if (this.lease.phase === 'held') {
      // `ControlPolicy.onRequestHeld` is deliberately NOT consulted. Its
      // whole return vocabulary (`queue`, `deny`, `preempt`) is about
      // arbitrating between people who cannot all drive at once, and on a
      // shared target they can. `canRequest`, which is the policy's veto on
      // this viewer controlling anything at all, has already run above.
      const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'request', {
        sharedAdmitsHolder: true,
      });
      if (outcome.kind !== 'ok' || outcome.to !== 'held') {
        this.emitDenied(
          viewer.viewerId,
          'policy',
          'Control request denied by policy.',
          undefined,
          requestId,
        );
        return;
      }
      this.grant(viewer, priority, requestId);
      return;
    }

    // `handing-over` or `revoking`: the admission backlog described above.
    // `held-grace` and `preempt-pending` are unreachable on a shared lease.
    const nowMono = this.clock.monotonicNow();
    this.lease.queue = insertIntoQueue(this.lease.queue, {
      viewerId: viewer.viewerId,
      identity: viewer.identity,
      label: viewer.label,
      kind: viewer.kind,
      priority,
      requestedAt: nowMono,
      expiresAt: nowMono + this.timing.queueTtlMs,
      ...(requestId !== undefined ? { requestId } : {}),
    });
  }

  private requestWhileUnheld(
    viewer: ViewerRef,
    priority: number,
    ctx: PolicyContext,
    requestId: string | undefined,
  ): void {
    const decision = this.policy.onRequestUnheld(ctx);
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'unheld', 'request', {
      policyPermits: decision === 'grant',
      policyObserverOnly: decision !== 'grant',
    });
    if (outcome.kind !== 'ok' || outcome.to !== 'held') {
      this.emitDenied(
        viewer.viewerId,
        'policy',
        'Control request denied by policy.',
        undefined,
        requestId,
      );
      return;
    }
    this.grant(viewer, priority, requestId);
  }

  private requestWhileHeld(
    viewer: ViewerRef,
    priority: number,
    force: boolean,
    wantsQueue: boolean,
    reason: string | undefined,
    ctx: PolicyContext,
    requestId: string | undefined,
  ): void {
    const decision = this.policy.onRequestHeld(ctx);
    if (decision === 'preempt') {
      this.beginPreempt(viewer, priority, force, requestId);
      return;
    }
    if (decision === 'deny' || !wantsQueue) {
      const holder = this.lease.holder;
      this.emitDenied(
        viewer.viewerId,
        'holder_pinned',
        `${holder?.label ?? 'Someone'} is currently in control.`,
        {
          ...(holder?.label !== undefined ? { holderLabel: holder.label } : {}),
          retryAfterMs: this.retryAfterEstimate(),
        },
        requestId,
      );
      return;
    }
    this.enqueueOrDeny(viewer, priority, reason, true, requestId);
  }

  private requestWhileHeldGrace(
    viewer: ViewerRef,
    priority: number,
    force: boolean,
    wantsQueue: boolean,
    reason: string | undefined,
    requestId: string | undefined,
  ): void {
    // Row 10: a present, higher-priority (or admin force) requester cuts a
    // disconnected holder's grace short rather than waiting behind it.
    const holder = this.lease.holder;
    const cutsGraceShort = force || (holder ? priority > holder.priority : true);
    if (!cutsGraceShort) {
      this.enqueueOrDeny(viewer, priority, reason, wantsQueue, requestId);
      return;
    }
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held-grace', 'preempted', {
      higherPriorityWaiting: true,
    });
    if (outcome.kind !== 'ok') {
      this.enqueueOrDeny(viewer, priority, reason, wantsQueue, requestId);
      return;
    }
    this.lease.phase = outcome.to;
    if (holder) {
      this.clearHolderTimer(holder.viewerId, 'disconnectGrace');
      holder.graceUntil = null;
    }
    const nowMono = this.clock.monotonicNow();
    this.lease.queue = insertIntoQueue(this.lease.queue, {
      viewerId: viewer.viewerId,
      identity: viewer.identity,
      label: viewer.label,
      kind: viewer.kind,
      priority,
      requestedAt: nowMono,
      expiresAt: nowMono + this.timing.queueTtlMs,
      ...(reason !== undefined ? { reason } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    });
    if (holder) this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'expired'));
    void this.settleHandingOver({ preempted: false });
  }

  private enqueueOrDeny(
    viewer: ViewerRef,
    priority: number,
    reason: string | undefined,
    wantsQueue: boolean,
    requestId: string | undefined,
  ): void {
    if (!wantsQueue) {
      this.emitDenied(
        viewer.viewerId,
        'holder_pinned',
        'The current holder is not being displaced by a queued request.',
        { retryAfterMs: this.retryAfterEstimate() },
        requestId,
      );
      return;
    }
    if (this.lease.queue.length >= this.maxQueueDepth) {
      this.emitDenied(
        viewer.viewerId,
        'queue_full',
        'The control queue is full.',
        undefined,
        requestId,
      );
      return;
    }
    const nowMono = this.clock.monotonicNow();
    const entry: QueueEntry = {
      viewerId: viewer.viewerId,
      identity: viewer.identity,
      label: viewer.label,
      kind: viewer.kind,
      priority,
      requestedAt: nowMono,
      expiresAt: nowMono + this.timing.queueTtlMs,
      ...(reason !== undefined ? { reason } : {}),
      ...(requestId !== undefined ? { requestId } : {}),
    };
    this.lease.queue = insertIntoQueue(this.lease.queue, entry);
    const position = queuePositionFor(this.lease.queue, viewer.viewerId) ?? this.lease.queue.length;
    this.emitDirect(viewer.viewerId, this.buildQueued(position), requestId);
    this.emitBroadcast();
  }

  private grant(viewer: ViewerRef, priority: number, requestId: string | undefined): void {
    // Captured BEFORE `admitHolder` mutates `lease.holders`, so
    // `emitContentionIfCrossed` below can tell whether THIS grant is the
    // one that crossed the co-driving threshold.
    const previousHolderCount = this.lease.holders.length;
    const holder = this.admitHolder({
      viewerId: viewer.viewerId,
      identity: viewer.identity,
      label: viewer.label,
      kind: viewer.kind,
      priority,
    });
    // Direct reply FIRST, always: `control.granted` is the reply to this
    // viewer's own `control.request`, and every client that sends a
    // request is entitled to see its own reply before any broadcast the
    // same action causes (`shared-control.test.ts`'s "lease broadcasts
    // never precede the reply that caused them", checked there via `sq`
    // ordering, not merely the order two `nextMessage()` calls happened to
    // observe). `control.contention` is a broadcast like `control.state`,
    // never a reply, and is never a legitimate answer to `control.request`,
    // so it must not arrive first even though this same call can trigger
    // it.
    this.emitDirect(viewer.viewerId, this.buildGranted(holder), requestId);
    // Contention next, `control.state` last (`emitBroadcast()` below):
    // `control.state` stays the final broadcast of any call that also
    // crosses the threshold, matching `latestState()` in
    // `shared-lease.test.ts` and `human-takeover.test.ts`, which read the
    // most recent broadcast and assume it is `control.state`.
    this.emitContentionIfCrossed(previousHolderCount);
    this.emitBroadcast();
  }

  /** Grants from a queue entry once it reaches the head (`settleHandingOver`'s step 5): always asynchronous relative to whichever `requestControl()` call originally enqueued it, so `entry.requestId` (not a parameter) is what lets this echo `re` back to that original request. */
  private grantFromQueueEntry(entry: QueueEntry): void {
    // Same ordering rule `grant()` follows: direct reply first, contention
    // second. The caller emits the final `control.state` afterward, either
    // once per entry (exclusive mode, one entry) or once after the whole
    // backlog loop (shared mode's `settleHandingOver`), so this method
    // never emits its own broadcast.
    const previousHolderCount = this.lease.holders.length;
    const holder = this.admitHolder(entry);
    this.emitDirect(entry.viewerId, this.buildGranted(holder), entry.requestId);
    this.emitContentionIfCrossed(previousHolderCount);
  }

  /**
   * Adds one holder to the lease and starts its own timers. Appends rather
   * than replaces: in exclusive mode the list was empty (a grant only ever
   * happens from `unheld`, or from the settlement that just cleared it), so
   * this is the same single-holder lease it always was; in shared mode the
   * existing drivers stay exactly where they are, and the new holder joins
   * them at the end. Grant order is what makes `Lease.holder` the longest
   * tenured driver rather than an arbitrary one.
   */
  private admitHolder(who: {
    readonly viewerId: string;
    readonly identity: string;
    readonly label: string;
    readonly kind: LeaseHolder['kind'];
    readonly priority: number;
  }): LeaseHolder {
    const nowMono = this.clock.monotonicNow();
    const holder: LeaseHolder = {
      leaseId: mintLeaseId(),
      viewerId: who.viewerId,
      identity: who.identity,
      label: who.label,
      kind: who.kind,
      priority: who.priority,
      grantedAt: nowMono,
      lastInputAt: nowMono,
      lastRenewAt: nowMono,
      connected: true,
      graceUntil: null,
    };
    this.lease.holders = [...this.lease.holders, holder];
    this.lease.phase = 'held';
    this.scheduleHolderTimers(holder);
    // No contention check here on purpose. Both call sites (`grant()`,
    // `grantFromQueueEntry()`) need `emitContentionIfCrossed` to run AFTER
    // their own direct `control.granted`, never before: a client's own
    // reply to its own request must never be preceded by an unrelated
    // broadcast (see `grant()`'s own doc). So each caller captures
    // `previousHolderCount` itself, before calling this method, and fires
    // the check once its grant is on the wire.
    return holder;
  }

  // ── control.renew ─────────────────────────────────────────────────────

  /** Handles `control.renew`. Renews THIS viewer's own tenure: on a shared target the other drivers' deadlines are untouched. */
  renew(
    viewerId: string,
    leaseId: string,
  ): { ok: true } | { ok: false; error: 'not_held' | 'lease_stale' } {
    const holder = this.mutableHolderFor(viewerId);
    if ((this.lease.phase !== 'held' && this.lease.phase !== 'preempt-pending') || !holder) {
      return { ok: false, error: 'not_held' };
    }
    if (holder.leaseId !== leaseId) return { ok: false, error: 'lease_stale' };
    const nowMono = this.clock.monotonicNow();
    holder.lastRenewAt = nowMono;
    holder.lastInputAt = nowMono;
    if (this.lease.phase === 'held') this.scheduleHolderTimers(holder);
    this.emitDirect(viewerId, this.buildGranted(holder));
    return { ok: true };
  }

  /**
   * Records dispatched input from the current holder, resetting the idle
   * clock (`control.renewOnInput`). No-op if `viewerId`/`leaseId` do not
   * match the current tenure. Intended to be called by the input
   * dispatcher (`core/src/input/**`) after a successful
   * dispatch.
   */
  recordInput(viewerId: string, leaseId: string): void {
    const holder = this.mutableHolderFor(viewerId);
    if (!holder || holder.leaseId !== leaseId) return;
    if (!this.timing.renewOnInput) return;
    holder.lastInputAt = this.clock.monotonicNow();
    if (this.lease.phase === 'held') this.scheduleHolderTimers(holder);
  }

  // ── control.release ──────────────────────────────────────────────────

  /** Handles `control.release`. Resolves once the handoff has fully settled. On a shared target with other drivers still on it, only this holder's tenure ends. */
  async release(
    viewerId: string,
    leaseId: string,
  ): Promise<{ ok: true } | { ok: false; error: 'not_held' }> {
    const holder = this.mutableHolderFor(viewerId);
    if (!holder || holder.leaseId !== leaseId) {
      return { ok: false, error: 'not_held' };
    }
    if (this.lease.phase === 'preempt-pending') {
      await this.resolvePreempt(true);
      return { ok: true };
    }
    if (this.lease.phase !== 'held') return { ok: false, error: 'not_held' };
    const holdersRemain = this.othersRemainAfter(holder);
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'release', {
      ...(holdersRemain ? { sharedHoldersRemain: true } : {}),
    });
    if (outcome.kind !== 'ok') return { ok: false, error: 'not_held' };
    if (outcome.to === 'held') {
      await this.settleHolderExit(holder);
      return { ok: true };
    }
    this.lease.phase = outcome.to;
    await this.settleHandingOver({ preempted: false });
    return { ok: true };
  }

  // ── control.revoke (admin; NOT preemption) ──────────────────────────

  /** Handles `control.revoke`. A stale `holderViewerId` leaves the current lease untouched and returns `not_held`. */
  async revoke(
    admin: ViewerRef,
    holderViewerId: string,
    reason?: string,
  ): Promise<{ ok: true } | { ok: false; error: 'not_held' | 'cap_missing' }> {
    if (!admin.isAdmin) return { ok: false, error: 'cap_missing' };
    const holder = this.mutableHolderFor(holderViewerId);
    if (this.lease.phase !== 'held' || !holder) {
      return { ok: false, error: 'not_held' };
    }
    void reason; // capped/sanitised/audit-logged by the transport layer; not otherwise used here
    const holdersRemain = this.othersRemainAfter(holder);
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'revoke', {
      isAdmin: true,
      ...(holdersRemain ? { sharedHoldersRemain: true } : {}),
    });
    if (outcome.kind !== 'ok') return { ok: false, error: 'not_held' };
    if (outcome.to === 'held') {
      // One named driver of several, on a shared target. The `revoking`
      // phase below drains the whole lease before it changes hands, which
      // is precisely the wrong thing to do to the drivers nobody named:
      // fencing them off mid-drag to remove somebody else would make an
      // admin action against one person visible as a stutter to everyone.
      this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'admin', admin.label));
      await this.settleHolderExit(holder);
      return { ok: true };
    }
    this.lease.phase = outcome.to;
    this.clearAllTimers();
    const toHandingOver = applyLeasePhaseTransition(
      this.leaseTag(),
      'revoking',
      'queueDrained',
      {},
    );
    this.lease.phase = toHandingOver.kind === 'ok' ? toHandingOver.to : 'handing-over';
    this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'admin', admin.label));
    await this.settleHandingOver({ preempted: false });
    return { ok: true };
  }

  // ── withdrawal, disconnect, reconnect ───────────────────────────────

  /** A queued (or preempt-in-flight) viewer withdraws their own request. */
  withdrawRequest(viewerId: string): void {
    if (this.lease.phase === 'preempt-pending' && this.lease.preemptedBy === viewerId) {
      void this.withdrawPreempt('withdrawn');
      return;
    }
    if (queuePositionFor(this.lease.queue, viewerId) !== null) {
      this.lease.queue = removeFromQueue(this.lease.queue, viewerId);
      this.emitBroadcast();
    }
  }

  /**
   * The viewer's socket closed. An exclusive holder takes the lease to
   * `held-grace`; a shared holder starts their OWN grace while the lease
   * stays `held` and the other drivers carry on. A preempt requester's
   * withdrawal is `requester_gone`; a queued viewer is dropped.
   */
  handleSocketClosed(viewerId: string): void {
    const holder = this.mutableHolderFor(viewerId);
    if (holder && this.lease.phase === 'held') {
      const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'socketClosed', {
        ...(this.isShared ? { sharedMode: true } : {}),
      });
      if (outcome.kind === 'ok') {
        this.lease.phase = outcome.to;
        holder.connected = false;
        this.clearHolderTimer(viewerId, 'idleRelease');
        this.clearHolderTimer(viewerId, 'renewGrace');
        this.clearHolderTimer(viewerId, 'expiryWarning');
        holder.graceUntil = this.clock.monotonicNow() + this.timing.disconnectGraceMs;
        this.setHolderTimer(
          viewerId,
          'disconnectGrace',
          () => {
            void this.onDisconnectGraceExpired(viewerId, holder.leaseId);
          },
          this.timing.disconnectGraceMs,
        );
        // The tenure is on the long clock above; the HELD STATE is on a short
        // one. Only when somebody else is still driving this page, which is
        // the only case in which a jammed pointer is visible to anyone.
        if (this.othersStillDriving(holder)) {
          this.setHolderTimer(
            viewerId,
            'disconnectHygiene',
            () => {
              void this.onDisconnectHygieneDue(viewerId, holder.leaseId);
            },
            this.timing.disconnectHygieneMs,
          );
        }
        this.emitBroadcast();
      }
      return;
    }
    if (this.lease.phase === 'preempt-pending' && this.lease.preemptedBy === viewerId) {
      void this.withdrawPreempt('requester_gone');
      return;
    }
    if (queuePositionFor(this.lease.queue, viewerId) !== null) {
      this.lease.queue = removeFromQueue(this.lease.queue, viewerId);
      this.emitBroadcast();
    }
  }

  /**
   * The holder's socket reconnected. Restores the tenure with the SAME
   * `leaseId` when `hasValidResumeToken`, from `held-grace` in exclusive
   * mode and from within the holder's own grace (the lease never left
   * `held`) in shared mode.
   */
  handleReconnect(viewerId: string, hasValidResumeToken: boolean): { restored: boolean } {
    const holder = this.mutableHolderFor(viewerId);
    if (!holder) return { restored: false };
    const from = this.lease.phase;
    // The two phases a disconnected holder can be sitting in, one per mode.
    // A shared holder in grace is inside a lease that is still `held`,
    // because the other drivers never stopped driving.
    if (from === 'held-grace') {
      if (!this.isReconnectable(holder)) return { restored: false };
    } else if (from === 'held' && this.isShared) {
      if (!this.isReconnectable(holder)) return { restored: false };
    } else {
      return { restored: false };
    }
    const outcome = applyLeasePhaseTransition(this.leaseTag(), from, 'reconnected', {
      validResumeToken: hasValidResumeToken,
    });
    if (outcome.kind !== 'ok') return { restored: false };
    this.lease.phase = outcome.to;
    holder.connected = true;
    holder.graceUntil = null;
    this.clearHolderTimer(viewerId, 'disconnectGrace');
    // What this driver gets back depends on whether they beat the hygiene
    // sweep, and that is deliberate rather than incidental.
    //
    // Inside `disconnectHygieneMs`: the timer is cancelled here, the sweep
    // never runs, and their held state is exactly as they left it, so a drag
    // interrupted by a blip continues.
    //
    // After it: the sweep has already run and their held state is gone. No
    // attempt is made to restore it, and none should be. The server knows
    // which buttons and keys it last saw pressed; it cannot know which are
    // still PHYSICALLY down on a machine it was not talking to. Re-pressing
    // them on the driver's behalf would be inventing input. Releasing and
    // letting the client's next real `down` re-establish the truth is the
    // only safe direction, and the client is the side that can actually see
    // the hardware.
    this.clearHolderTimer(viewerId, 'disconnectHygiene');
    this.scheduleHolderTimers(holder);
    this.emitBroadcast();
    return { restored: true };
  }

  /** A holder is reconnectable only while their own disconnect grace is actually running: `held-grace` alone is not enough evidence once a lease can hold several people. */
  private isReconnectable(holder: LeaseHolder): boolean {
    return !holder.connected && holder.graceUntil !== null;
  }

  /**
   * The prompt hygiene sweep for a holder whose socket died, run long before
   * their tenure lapses.
   *
   * This releases their held mouse buttons, held modifier keys, active
   * touches, and any active drag, and NOTHING ELSE. The holder stays in
   * `lease.holders` with `connected: false`, their `graceUntil` stands, and
   * `handleReconnect` still restores them with the same `leaseId`. Fixing a
   * stuck pointer by evicting the driver would trade a 30 second annoyance
   * for losing their seat, which is the worse of the two.
   *
   * `HeldState` is keyed per `(target, viewer)`, which is what makes a sweep
   * scoped to one driver possible at all: this lifts exactly what the
   * departed driver was holding and touches nothing the people still driving
   * hold.
   */
  private async onDisconnectHygieneDue(viewerId: string, leaseId: string): Promise<void> {
    const holder = this.mutableHolderFor(viewerId);
    // Same identity check the grace timer makes: a viewer who dropped,
    // reconnected, and was granted a fresh tenure must not have the dead
    // tenure's sweep run against their live one.
    if (!holder || holder.leaseId !== leaseId) return;
    // Reconnected inside the window, so there is nothing to clean up and
    // their drag is still theirs to finish.
    if (holder.connected) return;
    await this.releaseHeldHook(this.targetId, viewerId);
    this.onAudit?.({
      type: 'control.disconnectHygiene',
      targetId: this.targetId,
      sessionId: this.sessionId,
      viewerId,
      afterMs: this.timing.disconnectHygieneMs,
    });
  }

  private async onDisconnectGraceExpired(viewerId: string, leaseId: string): Promise<void> {
    const holder = this.mutableHolderFor(viewerId);
    // Identity is checked by `leaseId`, not by viewerId alone: a viewer who
    // dropped, reconnected, and was granted a fresh tenure must not be
    // evicted by the dead tenure's timer.
    if (!holder || holder.leaseId !== leaseId) return;
    if (this.lease.phase === 'held-grace') {
      const outcome = applyLeasePhaseTransition(
        this.leaseTag(),
        'held-grace',
        'disconnectGraceExpired',
        {},
      );
      if (outcome.kind !== 'ok') return;
      this.lease.phase = outcome.to;
      holder.graceUntil = null;
      this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'expired'));
      await this.settleHandingOver({ preempted: false });
      return;
    }
    if (this.lease.phase !== 'held') return;
    const holdersRemain = this.othersRemainAfter(holder);
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'disconnectGraceExpired', {
      ...(holdersRemain ? { sharedHoldersRemain: true } : {}),
    });
    if (outcome.kind !== 'ok') return;
    holder.graceUntil = null;
    this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'expired'));
    if (outcome.to === 'held') {
      await this.settleHolderExit(holder);
      return;
    }
    this.lease.phase = outcome.to;
    await this.settleHandingOver({ preempted: false });
  }

  // ── preemption (two-step) ────────────────────────────────────────────

  // Everything from here to the end of the preemption section is
  // exclusive-mode only. A shared target never reaches it: `requestShared`
  // returns before the contended paths, and nothing else calls in.
  private beginPreempt(
    viewer: ViewerRef,
    priority: number,
    force: boolean,
    requestId: string | undefined,
  ): void {
    const holder = this.lease.holder;
    if (!holder) return;
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'preempted', {
      forceClaimByAdmin: force,
      priorityExceedsHolder: !force && priority > holder.priority,
    });
    if (outcome.kind !== 'ok') return;
    // The requester's kind is on the `ViewerRef` the transport built from
    // their authenticated token, and the holder's was recorded from the same
    // field when they were granted, so this is two declared facts compared
    // against each other rather than "human" inferred from the absence of
    // anything. `force` is checked first: an admin forcing an agent off is an
    // administrative act, not an ordinary person taking over, and the two
    // carry different `graceMs` and different client obligations.
    const reason: PreemptReason = force
      ? 'force_claim'
      : viewer.kind === 'human' && holder.kind === 'agent'
        ? 'human_takeover'
        : 'priority';
    const graceMs =
      holder.kind === 'agent' ? this.timing.agentPreemptGraceMs : this.timing.forceClaimNoticeMs;
    const nowMono = this.clock.monotonicNow();

    this.lease.phase = outcome.to;
    this.lease.preemptedBy = viewer.viewerId;
    this.lease.preemptReason = reason;
    this.lease.preemptRequesterLabel = viewer.label;
    this.lease.preemptDeadline = this.clock.wallNow() + graceMs;
    this.lease.preemptReleasedInsideGrace = null;
    this.clearHolderTimer(holder.viewerId, 'idleRelease');
    this.clearHolderTimer(holder.viewerId, 'renewGrace');
    this.clearHolderTimer(holder.viewerId, 'expiryWarning');
    this.timers.preemptDeadline = this.clock.setTimer(() => {
      void this.resolvePreempt(false);
    }, graceMs);

    // The requester also joins the queue as part of the preemption handshake.
    this.lease.queue = insertIntoQueue(this.lease.queue, {
      viewerId: viewer.viewerId,
      identity: viewer.identity,
      label: viewer.label,
      kind: viewer.kind,
      priority,
      requestedAt: nowMono,
      expiresAt: nowMono + this.timing.queueTtlMs,
      ...(requestId !== undefined ? { requestId } : {}),
    });

    // `re` echoes only onto the requester's own `control.queued` below,
    // never onto the current holder's unrelated `control.preempt.request`.
    this.emitDirect(holder.viewerId, this.buildPreemptRequest(reason, graceMs));
    const position = queuePositionFor(this.lease.queue, viewer.viewerId) ?? 1;
    this.emitDirect(viewer.viewerId, this.buildQueued(position), requestId);
    this.emitBroadcast();
  }

  private async resolvePreempt(holderReleased: boolean): Promise<void> {
    if (this.lease.phase !== 'preempt-pending') return; // release raced the deadline timer; already resolved
    this.clearTimer('preemptDeadline');
    const outcome = applyLeasePhaseTransition(
      this.leaseTag(),
      'preempt-pending',
      'preemptResolved',
      {
        holderReleased,
        deadlinePassed: !holderReleased,
      },
    );
    if (outcome.kind !== 'ok') return;
    this.lease.phase = outcome.to;
    this.lease.preemptReleasedInsideGrace = holderReleased;
    await this.settleHandingOver({ preempted: true });
  }

  private async withdrawPreempt(reason: 'withdrawn' | 'requester_gone' | 'admin'): Promise<void> {
    if (this.lease.phase !== 'preempt-pending') return;
    const outcome = applyLeasePhaseTransition(
      this.leaseTag(),
      'preempt-pending',
      'preemptWithdrawn',
      {},
    );
    if (outcome.kind !== 'ok') return;
    this.clearTimer('preemptDeadline');
    const holder = this.lease.holder;
    const leaseIdUnchanged = this.lease.leaseId;
    this.lease.phase = outcome.to;
    if (this.lease.preemptedBy)
      this.lease.queue = removeFromQueue(this.lease.queue, this.lease.preemptedBy);
    this.lease.preemptedBy = null;
    this.lease.preemptDeadline = null;
    this.lease.preemptReason = null;
    this.lease.preemptRequesterLabel = null;
    this.lease.preemptReleasedInsideGrace = null;
    if (holder) this.scheduleHolderTimers(holder);
    if (holder && leaseIdUnchanged)
      this.emitDirect(holder.viewerId, this.buildPreemptCancelled(leaseIdUnchanged, reason));
    this.emitBroadcast();
  }

  // ── a viewer's kind changing under a live tenure ────────────────────

  /**
   * The viewer's KIND has been re-derived after their capability set changed
   * (a `hello{reauth:true}` that added or removed `automation`). Ends the
   * tenure this viewer holds on this target, if that tenure was granted under
   * the other kind, and corrects any queue entry of theirs in place.
   *
   * WHY A TENURE ENDS RATHER THAN BEING AMENDED. `LeaseHolder.kind` was one
   * of three copies of this fact taken at grant time and never refreshed. The
   * other two were fixed where they live: `connection.ts` reads it live on
   * every `viewerIdentity()`, and `ManagedSession.presenceEntries` recomputes
   * it on reauth. Neither fix was available here, because this copy is not a
   * label. It is the identity class a `leaseId` was ISSUED to, and a
   * `leaseId` is precisely the capability that holder's input is fenced by.
   *
   * Amending the field in place was the other candidate and it is the wrong
   * shape for three reasons. Every identity field on `LeaseHolder` is
   * `readonly` (`viewerId`, `identity`, `label`, `kind`, `leaseId`,
   * `grantedAt`); only the timing and liveness fields are mutable, and that
   * split is a statement rather than an accident. An amendment is also
   * completely unobservable: the holder's own client would carry on driving
   * with no idea the server had reclassified it, and an automation author
   * later asking "why was I stood down by a `control.yield`" would find no
   * event explaining it. And there is direct precedent for ending it:
   * `ManagedSession.applyCapabilityShrink` already ends a lease outright when
   * a reauth removes `control`, on exactly the reasoning that the lease was
   * granted under a capability set that no longer holds. `automation` is a
   * capability in the same set.
   *
   * The cost is real and small: the viewer must ask again. On a shared target
   * that is granted synchronously with no queue. On an exclusive target they
   * rejoin the queue, which is the same cost the `control` shrink path
   * already imposes, and the trigger (an operator minting a differently
   * capped token for a live viewer mid session) is rare and deliberate.
   *
   * The revoke reason is `'kind_changed'`, deliberately NOT the `'admin'` a
   * `control` shrink arrives as. Same trigger, two different facts: "you may
   * no longer control anything" against "you are now a different kind of
   * actor, ask again". Only one of them is worth retrying immediately.
   *
   * QUEUE ENTRIES ARE CORRECTED IN PLACE, and the asymmetry with holders is
   * the point rather than an inconsistency. A waiter has been granted
   * nothing: no `leaseId` was issued under the old kind, no input was ever
   * authorised by it, and nothing downstream has acted on it. The single
   * thing the entry's `kind` still does is get copied onto the holder record
   * by `admitHolder` when the entry reaches the head, so correcting it there
   * IS the whole fix. Dropping a waiter out of a line they can see
   * (`queuePosition` is on the wire) over an operator action they cannot
   * would be a worse answer than the bug.
   *
   * `priority` is deliberately left alone on that entry. It is
   * `opts.priority ?? DEFAULT_PRIORITY[kind]` at request time, so an explicit
   * priority is already a first class input independent of kind; re-deriving
   * it here would silently discard an explicit choice and re-order a queue
   * other viewers are watching.
   *
   * Only acts while the lease is `held`. In every other phase the tenure is
   * already on its way out within seconds and nothing reads the kind again
   * before it goes: `preempt-pending` chose its `reason` and `graceMs` when
   * the episode began, `handing-over` and `revoking` are settling, and
   * `held-grace` means a disconnected holder, which a viewer that just
   * reauthed is not. So a stale kind cannot outlive any of them.
   *
   * Called per target, the way `ManagedSession.applyCapabilityShrink` already
   * walks `knownTargetIds`.
   */
  async applyViewerKind(viewerId: string, kind: HolderKind): Promise<{ ended: boolean }> {
    // The queue first, and unconditionally: an entry can be stale whether or
    // not this viewer also holds anything anywhere.
    let queueCorrected = false;
    this.lease.queue = this.lease.queue.map((entry) => {
      if (entry.viewerId !== viewerId || entry.kind === kind) return entry;
      queueCorrected = true;
      return { ...entry, kind };
    });

    const holder = this.mutableHolderFor(viewerId);
    if (!holder || holder.kind === kind) {
      if (queueCorrected) this.auditKindChanged(viewerId, kind, false);
      return { ended: false };
    }
    if (this.lease.phase !== 'held') return { ended: false };

    const holdersRemain = this.othersRemainAfter(holder);
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'kindChanged', {
      ...(holdersRemain ? { sharedHoldersRemain: true } : {}),
    });
    if (outcome.kind !== 'ok') return { ended: false };

    this.auditKindChanged(viewerId, kind, true);
    // No `byLabel`: nobody did this to them. A token changed shape.
    this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'kind_changed'));
    if (outcome.to === 'held') {
      await this.settleHolderExit(holder);
      return { ended: true };
    }
    this.lease.phase = outcome.to;
    await this.settleHandingOver({ preempted: false });
    return { ended: true };
  }

  private auditKindChanged(viewerId: string, kind: HolderKind, endedTenure: boolean): void {
    this.onAudit?.({
      type: 'control.viewerKindChanged',
      targetId: this.targetId,
      sessionId: this.sessionId,
      viewerId,
      kind,
      endedTenure,
    });
  }

  // ── control.yield (shared mode; NOT preemption) ───────────────────

  /**
   * Handles `control.yield`: a person asks the AGENT holders of a shared
   * target to stand down, and leaves every HUMAN holder driving.
   *
   * This is the shared-mode counterpart to preemption, and it is a separate
   * mechanism rather than a reuse of that one because the two are different
   * events. Preemption moves a lease from a holder to a waiter: there is a
   * queue, a winner, and a `requeueAfterMs` backoff for the loser. None of
   * that exists here. Nobody waits on a shared target, the requester gains
   * nothing they did not already have (they need not be a holder at all, and
   * if they want to drive they simply ask and are granted instantly), and a
   * yielded agent that wants back in is likewise granted instantly, so a
   * backoff would be describing a wait that cannot happen. The preemption
   * messages therefore stay exclusive-mode only.
   *
   * EXPLICIT, never implied by a `control.request`. On a shared target a
   * request is granted immediately, so "a human started driving" is the
   * ordinary case and the whole point of the mode: a person and an agent
   * driving one page is the feature, not a conflict to resolve. An implicit
   * yield would fire on every tab click in a UI whose posture is "click a tab
   * to start driving" and would make shared mode unusable for the swarm case
   * it exists for. Standing the automation down is a second, rarer intention
   * and it gets its own message.
   *
   * TWO STEPS, like preemption, and for the same reason. The agent is told
   * first and keeps its lease and its input for `agentPreemptGraceMs`, so an
   * action already in flight can finish and the client can release itself
   * cleanly. Only if it has not released by then is its tenure ended for it,
   * through the same one-holder exit an admin `control.revoke` uses, with
   * `control.revoked{reason:'human_takeover'}`. A yield with no notice would
   * fence an agent off mid gesture and leave the page in whatever state that
   * gesture had reached.
   *
   * A YIELDED AGENT LOSES ITS LEASE rather than keeping one in a stood-down
   * state. The alternative was considered: it would let an agent resume
   * without re-acquiring, but it means a holder that is in `holders[]` and
   * must not inject, which fencing, `holderCount`, and every driver rail in
   * the UI would each have to learn about, and it is the "half yielded agent"
   * the plan calls out as worse than no yield. Losing the lease costs one
   * `control.request` to come back, and on a shared target that request is
   * granted synchronously with no queue, which is precisely why the cheap
   * option is available here and would not have been under exclusive control.
   *
   * NOT AN ADMIN ACT. Any human with control on this target may send it;
   * `control.revoke` remains the admin instrument, and it stays narrower
   * still (it names one holder, of any kind).
   *
   * Refused on an exclusive target rather than silently doing nothing:
   * exclusive control already lets a person take a target off an agent
   * through `control.request`, which gives that agent the same
   * `agentPreemptGraceMs` window, so a `control.yield` there is a client that
   * has sent the wrong message for the mode.
   *
   * Returns the viewerIds actually asked to stand down. An empty list is a
   * success, not a failure: "no agent is driving this target" is the state
   * the caller wanted.
   */
  requestAgentYield(
    requester: ViewerRef,
    opts: { readonly reason?: string } = {},
  ): { ok: true; notified: readonly string[] } | { ok: false; error: 'not_shared' | 'not_human' } {
    if (!this.isShared) return { ok: false, error: 'not_shared' };
    // The requester's kind is the declared field on their `ViewerRef`, the
    // same one the holder's kind was recorded from. An agent asking other
    // agents to stand down is not what this message is for, and the priority
    // ladder already ranks agents against each other.
    if (requester.kind !== 'human') return { ok: false, error: 'not_human' };
    if (this.lease.phase !== 'held') return { ok: true, notified: [] };

    const graceMs = this.timing.agentPreemptGraceMs;
    const notified: string[] = [];
    for (const holder of [...this.lease.holders]) {
      if (holder.kind !== 'agent') continue;
      // Already standing down. A second yield neither re-notices nor moves
      // the deadline: extending it would let a client keep an agent alive by
      // asking repeatedly, and shortening it would take back grace the agent
      // was already promised and is spending on an in-flight action.
      if (this.holderTimers.get(holder.viewerId)?.yieldGrace) continue;
      const viewerId = holder.viewerId;
      const leaseId = holder.leaseId;
      // Wall clock for the wire `deadline`, monotonic for the timer delay,
      // both computed at one instant from `graceMs` so neither reading is
      // ever reinterpreted as the other. Same shape as `beginPreempt`.
      const deadline = this.clock.wallNow() + graceMs;
      this.setHolderTimer(
        viewerId,
        'yieldGrace',
        () => {
          void this.onYieldGraceExpired(viewerId, leaseId, requester.label);
        },
        graceMs,
      );
      this.emitDirect(
        viewerId,
        this.buildYieldRequest(holder, requester, graceMs, deadline, opts.reason),
      );
      notified.push(viewerId);
    }

    if (notified.length > 0) {
      this.onAudit?.({
        type: 'control.yieldRequested',
        targetId: this.targetId,
        sessionId: this.sessionId,
        byViewerId: requester.viewerId,
        viewerIds: notified,
        graceMs,
      });
    }
    return { ok: true, notified };
  }

  /**
   * An agent did not stand down inside its yield grace, so its tenure ends
   * here.
   *
   * The identity check is `leaseId`, not `viewerId`, for the same reason
   * every other holder timer checks it: an agent that released, re-requested,
   * and was granted a fresh tenure (which on a shared target it can do inside
   * these two seconds) must not have the dead tenure's deadline evict its
   * live one. An agent that released honestly has no holder record at all by
   * now, and `clearHolderTimers` in its exit path already cancelled this.
   */
  private async onYieldGraceExpired(
    viewerId: string,
    leaseId: string,
    byLabel: string,
  ): Promise<void> {
    const holder = this.mutableHolderFor(viewerId);
    if (!holder || holder.leaseId !== leaseId) return;
    if (this.lease.phase !== 'held') return;
    const holdersRemain = this.othersRemainAfter(holder);
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'yielded', {
      ...(holdersRemain ? { sharedHoldersRemain: true } : {}),
    });
    if (outcome.kind !== 'ok') return;
    this.onAudit?.({
      type: 'control.yieldEnforced',
      targetId: this.targetId,
      sessionId: this.sessionId,
      viewerId,
      byLabel,
      afterMs: this.timing.agentPreemptGraceMs,
    });
    this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'human_takeover', byLabel));
    if (outcome.to === 'held') {
      // One agent among several drivers: the people driving alongside it are
      // untouched, and their input is never fenced off in order to remove it.
      // Shared stays shared between people.
      await this.settleHolderExit(holder);
      return;
    }
    // The agent was the last driver, so this is a genuine whole-lease
    // handover and the target ends up unheld (nobody is queued on a shared
    // target) until somebody asks for it.
    this.lease.phase = outcome.to;
    await this.settleHandingOver({ preempted: false });
  }

  // ── the five-step handoff drain ──────────────────────────────────────

  /**
   * The five-step handoff drain, bounded at
   * `control.handoverDrainMs`. Step 4 (pointer/key hygiene) runs even when
   * step 3 timed out, because hygiene must not stay queued behind a wedged
   * input; the
   * timeout is recorded via `onAudit` as `handoverDrainTimeout: true`.
   */
  private async settleHandingOver(opts: { readonly preempted: boolean }): Promise<void> {
    // Every remaining holder is departing: this settlement is the whole
    // lease changing hands, which a shared lease only ever reaches once its
    // LAST holder has gone (a shared holder who leaves with others still
    // driving goes through `settleHolderExit` instead). So this list has 0
    // or 1 entries in practice, exactly as it did when it was one nullable
    // field, and the loops below run at most once.
    const departing = [...this.lease.holders];
    const holder = departing[0] ?? null;
    const previousLeaseId = holder?.leaseId ?? null;
    const targetId = this.targetId;

    // Step 1: `handing-over` is already the current phase by the time this
    // runs; the previous holder's input now fences off via `checkFencing`
    // (only `held`/`preempt-pending` dispatch). Broadcast so viewers see it.
    this.clearAllTimers();
    this.emitBroadcast();

    // Steps 2 and 3: capture the input dispatcher's tail promise and race it
    // against handoverDrainMs.
    const timedOut = await this.drainBounded();

    // Step 4: pointer/key hygiene, even when step 3 timed out.
    for (const departingHolder of departing) {
      await this.releaseHeldHook(targetId, departingHolder.viewerId);
    }
    if (timedOut) {
      this.onAudit?.({
        type: 'control.handoverDrainTimeout',
        targetId,
        sessionId: this.sessionId,
        handoverDrainTimeout: true,
      });
    }

    for (const departingHolder of departing) {
      this.holdTracker.record(this.clock.monotonicNow() - departingHolder.grantedAt);
    }

    const releasedInsideGrace = this.lease.preemptReleasedInsideGrace;
    const preemptedBy = this.lease.preemptedBy;
    const preemptRequesterLabel = this.lease.preemptRequesterLabel;
    const preemptReason = this.lease.preemptReason ?? 'priority';

    this.lease.holders = [];
    this.lease.preemptedBy = null;
    this.lease.preemptDeadline = null;
    this.lease.preemptReason = null;
    this.lease.preemptRequesterLabel = null;
    this.lease.preemptReleasedInsideGrace = null;

    // Step 5: mint a fresh leaseId (via `grantFromQueueEntry`) or go unheld; notify the loser if this settlement began in `preempt-pending`.
    this.lease.queue = expireQueue(this.lease.queue, this.clock.monotonicNow());
    if (this.isShared) {
      // A shared lease grants the WHOLE backlog, not a head: these entries
      // are the requests that arrived during this settlement
      // (`requestShared`'s admission window), and shared mode's promise is
      // that nobody waits behind anybody.
      const backlog = this.lease.queue;
      const outcome = applyLeasePhaseTransition(this.leaseTag(), 'handing-over', 'drainSettled', {
        hasQueueHead: backlog.length > 0,
      });
      this.lease.queue = [];
      if (outcome.kind === 'ok' && outcome.to === 'held' && backlog.length > 0) {
        for (const entry of backlog) this.grantFromQueueEntry(entry);
      } else {
        this.lease.phase = 'unheld';
      }
      this.emitBroadcast();
      return;
    }
    const next = this.policy.selectNext(this.lease.queue, {
      // Monotonic, for the same reason `requestControl` above uses it: a
      // policy comparing this against a `QueueEntry.requestedAt` is
      // comparing two readings of one clock.
      now: this.clock.monotonicNow(),
      ownerViewerIds: this.ownerViewerIds,
      timing: this.timing,
    });
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'handing-over', 'drainSettled', {
      hasQueueHead: next !== null,
    });
    const to = outcome.kind === 'ok' ? outcome.to : 'unheld';

    if (to === 'held' && next) {
      this.lease.queue = removeFromQueue(this.lease.queue, next.viewerId);
      this.grantFromQueueEntry(next);
    } else {
      this.lease.phase = 'unheld';
    }

    if (opts.preempted && holder && preemptedBy && previousLeaseId) {
      this.emitDirect(
        holder.viewerId,
        this.buildPreempted(
          previousLeaseId,
          preemptedBy,
          preemptRequesterLabel ?? '',
          preemptReason,
          releasedInsideGrace ?? false,
        ),
      );
    }
    this.emitBroadcast();
  }

  /**
   * One holder of several leaving a shared lease: the same drain, scoped to
   * one driver.
   *
   * Steps 2 to 4 of the five-step handoff are exactly as valuable here as
   * they are for a whole-lease handover, and step 4 more so. The departing
   * driver's `releaseHeld` sweep is what stops them leaving a mouse button
   * or a modifier key held down inside a page other people are still
   * driving. Steps 1 and 5 are the ones that do not carry over: the lease
   * does not enter `handing-over` (that would fence off every remaining
   * driver mid-drag to remove one person), and there is no queue head to
   * promote, because on a shared target nobody was waiting.
   */
  private async settleHolderExit(holder: LeaseHolder): Promise<void> {
    // Remove the holder BEFORE the drain, which is what step 1 achieves for
    // the whole-lease case: their `leaseId` now matches no current holder,
    // so `resolveInputFencing` drops their ordinary input from this instant
    // (and still dispatches their releases, which is the point).
    this.clearHolderTimers(holder.viewerId);
    const previousHolderCount = this.lease.holders.length;
    this.lease.holders = this.lease.holders.filter((candidate) => candidate !== holder);
    // Before `emitBroadcast()`, for the same reason `admitHolder` emits
    // before its caller's own broadcast: `control.state` stays the last
    // broadcast this call produces (there is a second one below, after the
    // drain, so this one is never last regardless, but the ordering is kept
    // consistent with `admitHolder` rather than accidental).
    this.emitContentionIfCrossed(previousHolderCount);
    this.emitBroadcast();

    const timedOut = await this.drainBounded();
    await this.releaseHeldHook(this.targetId, holder.viewerId);
    if (timedOut) {
      this.onAudit?.({
        type: 'control.handoverDrainTimeout',
        targetId: this.targetId,
        sessionId: this.sessionId,
        handoverDrainTimeout: true,
        viewerId: holder.viewerId,
      });
    }
    this.holdTracker.record(this.clock.monotonicNow() - holder.grantedAt);
    this.emitBroadcast();
  }

  /** Steps 2 and 3: the input dispatcher's tail promise raced against `handoverDrainMs`. Returns whether the bound was hit. */
  private async drainBounded(): Promise<boolean> {
    const drainPromise = this.drainInput(this.targetId).catch(() => {});
    let timedOut = false;
    let handle: TimerHandle | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      handle = this.clock.setTimer(() => {
        timedOut = true;
        resolve();
      }, this.timing.handoverDrainMs);
      this.drainTimers.add(handle);
    });
    await Promise.race([drainPromise, timeoutPromise]);
    if (handle) {
      this.clock.clearTimer(handle);
      this.drainTimers.delete(handle);
    }
    return timedOut;
  }

  // ── timers ────────────────────────────────────────────────────────────

  /**
   * (Re)schedules ONE holder's three live timers. Called on grant, on
   * renewal, on recorded input, and on reconnect, always for the holder
   * whose tenure moved: on a shared target the other drivers' deadlines are
   * left exactly where they were.
   */
  private scheduleHolderTimers(holder: LeaseHolder): void {
    this.clearHolderTimer(holder.viewerId, 'idleRelease');
    this.clearHolderTimer(holder.viewerId, 'renewGrace');
    this.clearHolderTimer(holder.viewerId, 'expiryWarning');
    const nowMono = this.clock.monotonicNow();

    // `control.idleReleaseMs`: the queue-conditioned idle release from the
    // transition table ("no input for idleExpiryMs, queue non-empty"). An
    // empty queue means an idle holder keeps the lease until TTL, so idle
    // release only ever fires when somebody is waiting. This engine wires
    // the queue-conditioned `idleReleaseMs` value through the transition
    // table's guarded row and leaves the empty-queue case to
    // `renewGraceMs`/`leaseTtlMs` alone.
    const holderId = holder.viewerId;
    const leaseId = holder.leaseId;
    this.setHolderTimer(
      holderId,
      'idleRelease',
      () => this.onIdleReleaseDue(holderId, leaseId),
      Math.max(0, holder.lastInputAt + this.timing.idleReleaseMs - nowMono),
    );

    const ttlDeadlineMono = holder.lastRenewAt + this.timing.leaseTtlMs;
    const idleDeadlineMono = holder.lastInputAt + this.timing.idleExpiryMs;

    this.setHolderTimer(
      holderId,
      'renewGrace',
      () => {
        void this.onRenewGraceExpired(holderId, leaseId);
      },
      Math.max(0, ttlDeadlineMono + this.timing.renewGraceMs - nowMono),
    );

    const warnAt = Math.min(ttlDeadlineMono, idleDeadlineMono) - this.timing.expiryWarningMs;
    this.setHolderTimer(
      holderId,
      'expiryWarning',
      () => this.onExpiryWarningDue(holderId, leaseId),
      Math.max(0, warnAt - nowMono),
    );
  }

  private onIdleReleaseDue(viewerId: string, leaseId: string): void {
    if (this.lease.phase !== 'held') return;
    const holder = this.mutableHolderFor(viewerId);
    if (!holder || holder.leaseId !== leaseId) return;
    // Idle release exists to hand a target to somebody who is WAITING for
    // it (the transition table row is guarded on a non-empty queue, and an
    // empty queue means an idle holder keeps the lease until TTL). Nobody ever waits on a shared target, so
    // the rule fires for nobody's benefit and would only take control away
    // from someone who is about to use it again. A driver who has genuinely
    // gone away still loses their tenure, through their own renewal grace.
    if (this.isShared) return;
    if (this.lease.queue.length === 0) return;
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'idleExpired', {
      queueNonEmpty: true,
    });
    if (outcome.kind !== 'ok') return;
    this.lease.phase = outcome.to;
    this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'idle'));
    void this.settleHandingOver({ preempted: false });
  }

  private async onRenewGraceExpired(viewerId: string, leaseId: string): Promise<void> {
    if (this.lease.phase !== 'held') return;
    const holder = this.mutableHolderFor(viewerId);
    if (!holder || holder.leaseId !== leaseId) return;
    const holdersRemain = this.othersRemainAfter(holder);
    const outcome = applyLeasePhaseTransition(this.leaseTag(), 'held', 'renewGraceExpired', {
      ...(holdersRemain ? { sharedHoldersRemain: true } : {}),
    });
    if (outcome.kind !== 'ok') return;
    this.emitDirect(holder.viewerId, this.buildRevoked(holder.leaseId, 'expired'));
    if (outcome.to === 'held') {
      await this.settleHolderExit(holder);
      return;
    }
    this.lease.phase = outcome.to;
    await this.settleHandingOver({ preempted: false });
  }

  private onExpiryWarningDue(viewerId: string, leaseId: string): void {
    if (this.lease.phase !== 'held') return;
    const holder = this.mutableHolderFor(viewerId);
    if (!holder || holder.leaseId !== leaseId) return;
    applyLeasePhaseTransition(this.leaseTag(), 'held', 'expiryWarning', {}); // self-loop; the side effect below is what matters
    const nowMono = this.clock.monotonicNow();
    const ttlDeadlineMono = holder.lastRenewAt + this.timing.leaseTtlMs;
    const idleDeadlineMono = holder.lastInputAt + this.timing.idleExpiryMs;
    const reason: ControlExpiring['reason'] = idleDeadlineMono <= ttlDeadlineMono ? 'idle' : 'ttl';
    this.emitDirect(holder.viewerId, {
      v: 1,
      t: 'control.expiring',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      leaseId: holder.leaseId,
      expiresAt: this.computeExpiresAt(holder),
      inMs: Math.max(0, Math.min(ttlDeadlineMono, idleDeadlineMono) - nowMono),
      reason,
    });
  }

  private clearTimer(name: TimerName): void {
    const handle = this.timers[name];
    if (!handle) return;
    this.clock.clearTimer(handle);
    delete this.timers[name];
  }

  private setHolderTimer(
    viewerId: string,
    name: HolderTimerName,
    fn: () => void,
    ms: number,
  ): void {
    this.clearHolderTimer(viewerId, name);
    let slot = this.holderTimers.get(viewerId);
    if (!slot) {
      slot = {};
      this.holderTimers.set(viewerId, slot);
    }
    slot[name] = this.clock.setTimer(fn, ms);
  }

  private clearHolderTimer(viewerId: string, name: HolderTimerName): void {
    const slot = this.holderTimers.get(viewerId);
    const handle = slot?.[name];
    if (!slot || !handle) return;
    this.clock.clearTimer(handle);
    delete slot[name];
    if (Object.keys(slot).length === 0) this.holderTimers.delete(viewerId);
  }

  /** Cancels every timer belonging to one holder. Called the moment they stop holding, so a dead tenure's timer can never fire against a live lease. */
  private clearHolderTimers(viewerId: string): void {
    const slot = this.holderTimers.get(viewerId);
    if (!slot) return;
    for (const name of Object.keys(slot) as HolderTimerName[])
      this.clearHolderTimer(viewerId, name);
    this.holderTimers.delete(viewerId);
  }

  /** Cancels the lease's own timers and every holder's. The whole-lease paths (`revoke` to `revoking`, `settleHandingOver`, `dispose`) use this; nothing per holder does. */
  private clearAllTimers(): void {
    for (const name of Object.keys(this.timers) as TimerName[]) this.clearTimer(name);
    for (const viewerId of [...this.holderTimers.keys()]) this.clearHolderTimers(viewerId);
  }

  // ── message builders ────────────────────────────────────────────────

  private emitDenied(
    viewerId: string,
    reason: ControlDenied['reason'],
    message: string,
    extra: { readonly holderLabel?: string; readonly retryAfterMs?: number } | undefined,
    requestId: string | undefined,
  ): void {
    this.emitDirect(viewerId, this.buildDenied(reason, message, extra), requestId);
  }

  private buildGranted(holder: LeaseHolder): ControlGranted {
    return {
      v: 1,
      t: 'control.granted',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      leaseId: holder.leaseId,
      expiresAt: this.computeExpiresAt(holder),
      renewWithinMs: this.timing.renewWithinMs,
      idleReleaseMs: this.timing.idleReleaseMs,
      mode: this.lease.mode,
    };
  }

  private buildDenied(
    reason: ControlDenied['reason'],
    message: string,
    extra?: { readonly holderLabel?: string; readonly retryAfterMs?: number },
  ): ControlDenied {
    return {
      v: 1,
      t: 'control.denied',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      reason,
      message,
      ...(extra?.holderLabel !== undefined ? { holderLabel: extra.holderLabel } : {}),
      ...(extra?.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}),
    };
  }

  private buildQueued(position: number): ControlQueued {
    return {
      v: 1,
      t: 'control.queued',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      position,
      estimatedWaitMs: this.holdTracker.estimateWaitMs(position, this.timing.idleExpiryMs),
      holderLabel: this.lease.holder?.label ?? '',
    };
  }

  /** `leaseId` is the revoked holder's own, not the lease's: on a shared target the message names the tenure that ended and nobody else's. */
  private buildRevoked(
    leaseId: string,
    reason: ControlRevoked['reason'],
    byLabel?: string,
  ): ControlRevoked {
    return {
      v: 1,
      t: 'control.revoked',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      leaseId,
      reason,
      ...(byLabel !== undefined ? { byLabel } : {}),
    };
  }

  private buildPreemptRequest(reason: PreemptReason, graceMs: number): ControlPreemptRequest {
    return {
      v: 1,
      t: 'control.preempt.request',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      leaseId: this.lease.leaseId ?? '',
      byViewerId: this.lease.preemptedBy ?? '',
      byLabel: this.lease.preemptRequesterLabel ?? '',
      reason,
      graceMs,
      deadline: this.lease.preemptDeadline ?? this.clock.wallNow() + graceMs,
    };
  }

  /**
   * `leaseId` is the RECIPIENT'S own, taken from their holder record rather
   * than from `Lease.leaseId`. On a shared target the latter is the primary
   * (longest tenured) holder's id, which is somebody else's capability and
   * not the one this agent is being asked to release.
   */
  private buildYieldRequest(
    holder: LeaseHolder,
    requester: ViewerRef,
    graceMs: number,
    deadline: number,
    reason: string | undefined,
  ): ControlYieldRequest {
    return {
      v: 1,
      t: 'control.yield.request',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      leaseId: holder.leaseId,
      byViewerId: requester.viewerId,
      byLabel: requester.label,
      graceMs,
      deadline,
      ...(reason !== undefined ? { reason } : {}),
    };
  }

  private buildPreemptCancelled(
    leaseId: string,
    reason: ControlPreemptCancelled['reason'],
  ): ControlPreemptCancelled {
    return {
      v: 1,
      t: 'control.preempt.cancelled',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      leaseId,
      reason,
    };
  }

  private buildPreempted(
    loserLeaseId: string,
    byViewerId: string,
    byLabel: string,
    reason: PreemptReason,
    released: boolean,
  ): ControlPreempted {
    return {
      v: 1,
      t: 'control.preempted',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      leaseId: loserLeaseId,
      byViewerId,
      byLabel,
      reason,
      released,
      // The engine has no handle on the input dispatcher here, so it cannot
      // report the real sequence number yet; it always reports 0.
      lastDispatchedInputSeq: 0,
      mayRequeue: true,
      requeueAfterMs: this.timing.agentRequeueBackoffMs,
    };
  }

  /**
   * This target's `LeaseState`, from `viewerId`'s point of view, and the ONE
   * place a client-visible lease projection is built.
   *
   * `control.state` (through {@link buildStateMsg}), `welcome.lease.byTarget`
   * and `resumed.lease` are all the same question asked in three places, and
   * the server cannot answer it on its own: `grantedAt` needs
   * {@link monoToWall} and `expiresAt` needs {@link computeExpiresAt}, both of
   * which project a monotonic reading onto the wall clock and both of which
   * must stay inside the engine that anchored it. Converting a monotonic
   * reading to wall clock anywhere else drifts by however long the process
   * has been up. Building all three from here also means a field the wire
   * grows arrives in all three at once, rather than in whichever the caller
   * remembered to update.
   *
   * `viewerId` is the RECIPIENT, not a subject: `queuePosition` has always
   * been per recipient, and `holderViewerId` is per
   * recipient too under shared mode (see below). `null` means "no particular
   * recipient", which yields `queuePosition: null` and, in shared mode, a
   * null `holderViewerId`.
   */
  projectState(viewerId: string | null): LeaseState {
    // Which holder this projection is ABOUT. In exclusive mode: the one
    // holder, the same for every recipient, unchanged. In shared mode:
    // the recipient's own holding, or nothing.
    //
    // The alternatives were both worse. Reporting one arbitrary holder of
    // several makes `holderViewerId === myViewerId` ("am I driving?") false
    // for every driver but one, which is the exact question every existing
    // consumer of this field asks. Reporting `null` for everybody makes it
    // false for all of them, including people who are genuinely driving.
    // Per recipient is not a new idea here either: `queuePosition` has
    // always been computed per recipient, which is why
    // this message is emitted as a `forViewer` factory rather than a value.
    // `holders`, below, is the complete and recipient-independent answer to
    // "who is driving", and it is what a dashboard reads.
    const projected = this.isShared
      ? viewerId === null
        ? null
        : this.holderFor(viewerId)
      : this.lease.holder;
    const holders: LeaseHolderState[] = this.lease.holders.map((holder) => ({
      viewerId: holder.viewerId,
      label: holder.label,
      grantedAt: this.monoToWall(holder.grantedAt),
      expiresAt: this.computeExpiresAt(holder),
      connected: holder.connected,
    }));
    return {
      targetId: this.targetId,
      holderViewerId: projected?.viewerId ?? null,
      holderLabel: projected?.label ?? null,
      grantedAt: projected ? this.monoToWall(projected.grantedAt) : null,
      expiresAt: projected ? this.computeExpiresAt(projected) : null,
      mode: this.lease.mode,
      holders,
      holderCount: holders.length,
      queue: this.lease.queue.map((entry) => ({
        viewerId: entry.viewerId,
        label: entry.label,
        requestedAt: this.monoToWall(entry.requestedAt),
        priority: entry.priority,
      })),
      queueLength: this.lease.queue.length,
      queuePosition: queuePositionFor(this.lease.queue, viewerId),
    };
  }

  /**
   * The `welcome.lease.byTarget[targetId]` entry for `viewerId`: the same
   * projection as {@link projectState}, narrowed to `LeaseSummary`.
   *
   * `LeaseSummary` and `LeaseState` stay deliberately separate types (three
   * types, three scopes), and this narrows one to the
   * other rather than unifying them, so `welcome` cannot disagree with the
   * first `control.state` that follows it. `expiresAt` is non-nullable on
   * the summary and nullable on the state, so an unheld lease reports the
   * current wall reading, which is what {@link computeExpiresAt} already
   * returns for a null holder.
   */
  projectSummary(viewerId: string | null): LeaseSummary {
    const state = this.projectState(viewerId);
    return {
      holderViewerId: state.holderViewerId,
      holderLabel: state.holderLabel,
      mode: state.mode,
      holderCount: state.holderCount,
      queueLength: state.queueLength,
      queuePosition: state.queuePosition,
      expiresAt: state.expiresAt ?? this.clock.wallNow(),
    };
  }

  /** The broadcast `control.state` wrapper around {@link projectState}. One lease per engine, so one element. */
  private buildStateMsg(viewerId: string | null): ControlStateMsg {
    return {
      v: 1,
      t: 'control.state',
      ts: this.clock.wallNow(),
      leases: [this.projectState(viewerId)],
    };
  }

  /**
   * Emits `control.contention` iff `this.lease.holders.length` just crossed
   * the co-driving threshold (two) relative to `previousHolderCount`.
   * Called once from each of the three places that can observe a crossing:
   * `grant()` and `grantFromQueueEntry()` (each captures
   * `previousHolderCount` itself, right before calling {@link admitHolder},
   * and calls this AFTER its own direct `control.granted` is on the wire,
   * never before: see `grant()`'s own doc for why that order is not
   * optional), and {@link settleHolderExit} (remove one of several, checked
   * before its own broadcast).
   *
   * `settleHandingOver`'s own `this.lease.holders = []` needs no call of
   * its own: that assignment is reached only when the lease had AT MOST one
   * holder beforehand (its own doc: "a shared lease only ever reaches once
   * its LAST holder has gone... a shared holder who leaves with others
   * still driving goes through `settleHolderExit` instead"), so it can
   * never itself cross the two-holder threshold. Its shared-mode backlog
   * grants, immediately afterward, go through `grantFromQueueEntry` ->
   * `admitHolder` in a loop, one call per entry, so a backlog of two or
   * more requests admitted at once is still caught correctly: the second
   * `grantFromQueueEntry` call sees `previousHolderCount === 1` and fires,
   * after ITS OWN grant has already gone out to the second entry's viewer.
   *
   * A no-op in `mode: 'exclusive'` by construction, never by a mode check:
   * an exclusive lease has 0 or 1 holders always, so `previousHolderCount`
   * and the count after can never straddle two there.
   */
  private emitContentionIfCrossed(previousHolderCount: number): void {
    const currentHolderCount = this.lease.holders.length;
    const wasContended = previousHolderCount >= 2;
    const isContended = currentHolderCount >= 2;
    if (wasContended === isContended) return;
    const message = this.buildContention(isContended);
    this.emit({ to: 'broadcast', forViewer: () => message });
  }

  /** Builds one `control.contention`. See that type's own doc for why its `holders` carry `kind`/`priority` that `LeaseState.holders` deliberately does not. */
  private buildContention(contended: boolean): ControlContention {
    const holders: ContentionHolder[] = this.lease.holders.map((holder) => ({
      viewerId: holder.viewerId,
      label: holder.label,
      kind: holder.kind,
      priority: holder.priority,
      grantedAt: this.monoToWall(holder.grantedAt),
      connected: holder.connected,
    }));
    return {
      v: 1,
      t: 'control.contention',
      ts: this.clock.wallNow(),
      targetId: this.targetId,
      contended,
      holders,
      holderCount: holders.length,
      mostRecentViewerId:
        holders.length > 0 ? (holders[holders.length - 1]?.viewerId ?? null) : null,
    };
  }

  // ── small helpers ────────────────────────────────────────────────────

  private get isShared(): boolean {
    return this.lease.mode === 'shared';
  }

  /**
   * The internal, mutable holder record for `viewerId`. {@link holderFor} is
   * the same lookup for callers outside the engine, handing back a
   * `Readonly` view so nobody can move a tenure's timing anchors without
   * going through the methods that reschedule the matching timers.
   */
  private mutableHolderFor(viewerId: string): LeaseHolder | null {
    return this.lease.holders.find((holder) => holder.viewerId === viewerId) ?? null;
  }

  /**
   * Whether removing `holder` would leave the lease still held by somebody
   * else, which is only ever true in shared mode. This is the single fact
   * every shared-mode transition guard turns on: it decides whether one
   * driver leaving is a lease-wide handover or just one driver leaving.
   */
  private othersRemainAfter(holder: LeaseHolder): boolean {
    return this.isShared && this.lease.holders.some((candidate) => candidate !== holder);
  }

  /**
   * Whether anybody OTHER than `holder` is currently driving this target with
   * a live socket. The one condition under which a jammed pointer is visible
   * to a human being, and therefore the condition the prompt hygiene sweep
   * hangs off.
   *
   * Stated this way rather than as `if (this.isShared)` on purpose. It is the
   * real reason, not a proxy for it, and it makes the exclusive path unchanged
   * BY CONSTRUCTION: an exclusive lease has at most one holder, so this can
   * never be true there, and no exclusive integration can observe a timing
   * difference. It is also correctly false for the last driver leaving a
   * shared target, where nobody is left to be inconvenienced and the ordinary
   * grace expiry sweep is soon enough.
   */
  private othersStillDriving(holder: LeaseHolder): boolean {
    return this.lease.holders.some((candidate) => candidate !== holder && candidate.connected);
  }

  private policyContextFor(
    viewer: ViewerRef,
    request: { readonly force: boolean; readonly priority: number },
    now: number,
  ): PolicyContext {
    return {
      lease: this.lease,
      requester: viewer,
      request,
      now,
      ownerViewerIds: this.ownerViewerIds,
      capabilities: viewer.isAdmin ? ADMIN_CAPABILITIES : BASE_CAPABILITIES,
      timing: this.timing,
    };
  }

  private retryAfterEstimate(): number {
    const position = this.lease.queue.length + 1;
    return (
      this.holdTracker.estimateWaitMs(position, this.timing.idleExpiryMs) ?? this.timing.minHoldMs
    );
  }

  /** Projects a monotonic anchor reading onto the current wall clock via a monotonic-only duration. */
  private monoToWall(monoTimestamp: number): number {
    return this.clock.wallNow() - (this.clock.monotonicNow() - monoTimestamp);
  }

  /** `expiresAt` is the sooner of the TTL deadline and the idle deadline, projected onto the wall clock. Per holder: two drivers of one shared target expire at their own times. */
  private computeExpiresAt(holder: LeaseHolder | null): number {
    if (!holder) return this.clock.wallNow();
    const nowMono = this.clock.monotonicNow();
    const ttlDeadlineMono = holder.lastRenewAt + this.timing.leaseTtlMs;
    const idleDeadlineMono = holder.lastInputAt + this.timing.idleExpiryMs;
    const remainingMs = Math.min(ttlDeadlineMono, idleDeadlineMono) - nowMono;
    return this.clock.wallNow() + remainingMs;
  }

  private leaseTag(): string {
    return `${this.sessionId}:${this.targetId}`;
  }

  /**
   * `requestId`, when given, is echoed onto `message.re`: every call site above passes it only for the direct
   * effect that is genuinely the reply to that exact `control.request`
   * (immediate grant/deny/queued, or a queued request's eventual grant via
   * `grantFromQueueEntry`'s own `entry.requestId`), and omits it for every
   * other direct effect (a preempt notice to the current holder, a revoke,
   * an expiry warning, and so on), which are unprompted pushes.
   */
  private emitDirect(to: string, message: LeaseDirectEffect['message'], requestId?: string): void {
    this.emit({ to, message: requestId !== undefined ? { ...message, re: requestId } : message });
  }

  private emitBroadcast(): void {
    this.emit({ to: 'broadcast', forViewer: (viewerId) => this.buildStateMsg(viewerId) });
  }
}
