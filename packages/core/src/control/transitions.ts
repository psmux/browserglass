/**
 * `LeasePhase`, the server-internal ControlLease state machine, expressed
 * as data and driven through `transition()` from `@browserglass/protocol`'s
 * domain layer rather than reimplementing the state-machine plumbing.
 *
 * `LeasePhase` is distinct from, and never conflated with, two other lease
 * state types:
 *  - `ControlLeaseState` (`@browserglass/protocol` domain layer): the audit
 *    and history event vocabulary (`unheld|requested|granted|renewing|...`),
 *    with its own `CONTROL_LEASE_TRANSITIONS` table. That table answers "how
 *    did this get logged"; this one answers "what may the server do next".
 *  - `LeaseState` (`@browserglass/protocol` wire layer): the client-visible
 *    projection. `LeasePhase` never appears on the wire.
 *
 * This table is called with the entity name `'ControlLeasePhase'`, which is
 * deliberately not `'ControlLease'` (the name `TERMINAL` already uses for
 * the audit-vocabulary machine in `state.ts`, whose terminal set
 * (`revoked`/`forceClaimed`) describes different state strings than this
 * machine's six phases). None of `LeasePhase`'s six states is a `TERMINAL`
 * entry: a lease cycles through them for as long as the target exists, so
 * an event with no matching row for a live phase is a real bug and MUST
 * throw rather than be silently ignored as "this lease is done".
 */

import { type TransitionOutcome, type TransitionTable, transition } from '@browserglass/protocol';

/**
 * The six server-internal ControlLease phases. Never
 * on the wire; the wire type is `LeaseState` (`@browserglass/protocol`).
 */
export type LeasePhase =
  | 'unheld'
  | 'held'
  | 'held-grace'
  | 'preempt-pending'
  | 'handing-over'
  | 'revoking';

/** The entity name this module passes to `transition()`; see the module doc for why it is not `'ControlLease'`. */
export const LEASE_PHASE_ENTITY = 'ControlLeasePhase';

/** The events the `LeasePhase` machine accepts. */
export type LeaseEvent =
  | 'request'
  | 'release'
  | 'expiryWarning'
  | 'idleExpired'
  | 'renewGraceExpired'
  | 'socketClosed'
  | 'reconnected'
  | 'disconnectGraceExpired'
  | 'preempted'
  | 'yielded'
  | 'kindChanged'
  | 'revoke'
  | 'preemptResolved'
  | 'preemptWithdrawn'
  | 'queueDrained'
  | 'drainSettled';

/**
 * The guard flags `LEASE_PHASE_TRANSITIONS`'s rules read. Callers pass a
 * plain object with exactly the flags relevant to the event being applied;
 * unset flags are `undefined`, which every guard here treats as falsy.
 */
export interface LeasePhaseContext {
  /** `unheld`+`request`: the configured `ControlPolicy.onRequestUnheld` returned `'grant'`. */
  readonly policyPermits?: boolean;
  /** `unheld`+`request`: the configured policy is `observerOnly` (or otherwise refuses). */
  readonly policyObserverOnly?: boolean;
  /** `held`+`idleExpired`: the FIFO queue is non-empty. */
  readonly queueNonEmpty?: boolean;
  /** `held-grace`+`reconnected`: the reconnecting socket presented a valid resume token for this lease. */
  readonly validResumeToken?: boolean;
  /** `held-grace`+`preempted`: a higher-priority request arrived while the holder is disconnected. */
  readonly higherPriorityWaiting?: boolean;
  /** `held`+`preempted`: the requester's priority exceeds the current holder's. */
  readonly priorityExceedsHolder?: boolean;
  /** `held`+`preempted`: `control.request{force:true}` from an `admin` viewer. */
  readonly forceClaimByAdmin?: boolean;
  /** `held`+`revoke`: the caller holds the `admin` capability. */
  readonly isAdmin?: boolean;
  /** `preempt-pending`+`preemptResolved`: the holder sent `control.release` before the deadline. */
  readonly holderReleased?: boolean;
  /** `preempt-pending`+`preemptResolved`: the grace deadline passed before a release. */
  readonly deadlinePassed?: boolean;
  /** `handing-over`+`drainSettled`: the FIFO queue has a next entry to grant to. */
  readonly hasQueueHead?: boolean;
  /**
   * `held`+`request`: the lease is `mode: 'shared'`, so a second (third,
   * Nth) concurrent holder may be admitted without the lease leaving
   * `held`. Never set in exclusive mode, where a request against a held
   * lease queues or preempts instead and this row is never reached.
   */
  readonly sharedAdmitsHolder?: boolean;
  /**
   * `held`+`socketClosed`: the lease is `mode: 'shared'`. A shared lease
   * never enters `held-grace`: the disconnect grace is per holder there (it
   * has to be, or one driver closing their laptop would suspend everyone
   * else's input), so the lease stays `held` and only that holder's own
   * timer runs.
   */
  readonly sharedMode?: boolean;
  /**
   * `held`+(`release`|`renewGraceExpired`|`revoke`|`disconnectGraceExpired`|`yielded`|`kindChanged`):
   * this event removes ONE holder from a `mode: 'shared'` lease and at
   * least one other holder remains, so the lease stays `held` instead of
   * handing over. Never set in exclusive mode, where losing the holder
   * always means losing the lease.
   */
  readonly sharedHoldersRemain?: boolean;
}

function has(ctx: unknown, key: keyof LeasePhaseContext): boolean {
  return typeof ctx === 'object' && ctx !== null && Boolean((ctx as LeasePhaseContext)[key]);
}

/**
 * The full 18-row exclusive transition table, plus the nine
 * shared-mode rows (S1 to S9) that admit and remove one holder of several
 * without the lease leaving `held`.
 *
 * A `mode: 'shared'` lease only ever visits four of the six phases:
 * `unheld`, `held`, `handing-over` (the last holder leaving), and
 * `revoking`. `held-grace` and `preempt-pending` are exclusive-mode
 * concepts. Nobody waits on a shared target, so nobody preempts; and the
 * disconnect grace has to be per holder rather than per lease, so there is
 * no lease-wide grace phase to be in.
 *
 * Rows that share
 * a `(from, event)` pair with more than one outcome (the `held`+`preempted`
 * split for priority versus force-claim, `preempt-pending`+`preemptResolved`
 * split for release versus deadline, and `handing-over`+`drainSettled`
 * split for a non-empty versus empty queue) are represented as ordered
 * guarded candidates on one table entry, matching how `INSTANCE_TRANSITIONS`
 * and friends already express a branching row in `@browserglass/protocol`.
 */
export const LEASE_PHASE_TRANSITIONS: TransitionTable<LeasePhase, LeaseEvent> = {
  unheld: {
    // Row 1: unheld, control.request, policy permits -> held.
    // Row 2: unheld, control.request, policy is observerOnly -> unheld (denied).
    request: [
      { to: 'held', guard: (ctx) => has(ctx, 'policyPermits'), guardName: 'policy_permits' },
      { to: 'unheld', guard: (ctx) => has(ctx, 'policyObserverOnly'), guardName: 'observer_only' },
    ],
  },
  held: {
    // Row S1 (shared): held, control.request from a viewer who is not yet a
    // holder, lease is shared -> held, one more concurrent holder. Nothing
    // reaches this row in exclusive mode, where a request against a held
    // lease is a queue or a preempt; if something ever does, the unguarded
    // fall-through is deliberately absent so it is `ignored`, not a silent
    // second holder on an exclusive target.
    request: [
      {
        to: 'held',
        guard: (ctx) => has(ctx, 'sharedAdmitsHolder'),
        guardName: 'shared_admits_holder',
      },
    ],
    // Row 3: held, control.release from holder -> handing-over.
    // Row S2 (shared): one of several holders releases -> held (the rest keep driving).
    release: [
      {
        to: 'held',
        guard: (ctx) => has(ctx, 'sharedHoldersRemain'),
        guardName: 'shared_holders_remain',
      },
      { to: 'handing-over' },
    ],
    // Row 4: held, expiresAt - now <= expiryWarningMs -> held (no phase change; control.expiring is a side effect).
    expiryWarning: [{ to: 'held' }],
    // Row 5: held, no input for idleExpiryMs, queue non-empty -> handing-over.
    idleExpired: [
      {
        to: 'handing-over',
        guard: (ctx) => has(ctx, 'queueNonEmpty'),
        guardName: 'queue_non_empty',
      },
    ],
    // Row 6: held, no renewal for renewGraceMs -> handing-over.
    // Row S3 (shared): one of several holders stops renewing -> held (only that holder is dropped).
    renewGraceExpired: [
      {
        to: 'held',
        guard: (ctx) => has(ctx, 'sharedHoldersRemain'),
        guardName: 'shared_holders_remain',
      },
      { to: 'handing-over' },
    ],
    // Row 7: held, holder socket closes -> held-grace.
    // Row S4 (shared): a holder's socket closes -> held. A shared lease never
    // enters `held-grace`; see `sharedMode`'s note on `LeasePhaseContext`.
    socketClosed: [
      { to: 'held', guard: (ctx) => has(ctx, 'sharedMode'), guardName: 'shared_mode' },
      { to: 'held-grace' },
    ],
    // Row S5 (shared): a disconnected holder's own grace runs out while the
    // lease is still `held` (exclusive mode reaches the same event from
    // `held-grace` instead, row 9). Falls through to `handing-over` when the
    // holder who ran out was the last one.
    disconnectGraceExpired: [
      {
        to: 'held',
        guard: (ctx) => has(ctx, 'sharedHoldersRemain'),
        guardName: 'shared_holders_remain',
      },
      { to: 'handing-over' },
    ],
    // Row S6 (shared): a holder reconnects inside their own grace while the
    // lease is still `held`. The mirror of row 8, which does the same thing
    // from `held-grace` for the single holder of an exclusive lease, and it
    // guards on the same resume token so an invalid one is `ignored` rather
    // than restoring a driver who cannot prove continuity.
    reconnected: [
      { to: 'held', guard: (ctx) => has(ctx, 'validResumeToken'), guardName: 'valid_resume_token' },
    ],
    // Row 11: held, control.request priority > holder.priority -> preempt-pending.
    // Row 12: held, control.request{force:true} from admin -> preempt-pending.
    preempted: [
      {
        to: 'preempt-pending',
        guard: (ctx) => has(ctx, 'forceClaimByAdmin'),
        guardName: 'force_claim_by_admin',
      },
      {
        to: 'preempt-pending',
        guard: (ctx) => has(ctx, 'priorityExceedsHolder'),
        guardName: 'priority_exceeds_holder',
      },
    ],
    // Row S9 (shared): a holder's viewer kind changed under them, so the
    // tenure granted to the old kind ends. Shaped like `release` and
    // `yielded`, and for the third time for the same reason: removing one
    // driver of several leaves the lease `held`, and removing the last one is
    // a genuine handover. Reaches `handing-over` in exclusive mode, where the
    // queue head is then promoted exactly as it is on any other exit.
    kindChanged: [
      {
        to: 'held',
        guard: (ctx) => has(ctx, 'sharedHoldersRemain'),
        guardName: 'shared_holders_remain',
      },
      { to: 'handing-over' },
    ],
    // Row S8 (shared): an agent holder's yield grace ran out after a human
    // sent `control.yield`, so its tenure is ended for it. Shaped exactly
    // like `release` above, and for the same reason: removing one driver of
    // several leaves the lease `held`, and removing the last one is a
    // genuine handover. There is no `isAdmin` guard, because a yield is not
    // an administrative act: any human with control on a shared target may
    // ask the automation there to stop.
    yielded: [
      {
        to: 'held',
        guard: (ctx) => has(ctx, 'sharedHoldersRemain'),
        guardName: 'shared_holders_remain',
      },
      { to: 'handing-over' },
    ],
    // Row S7 (shared): admin revokes ONE of several holders -> held. The
    // `revoking` phase exists to drain the whole lease before it changes
    // hands, which is the wrong thing to do to the drivers who were not
    // named. Ordered first so the exclusive row below stays the last
    // candidate, and therefore stays the `reason` a guard failure reports
    // (`transition()` names the last rule): a non-admin caller still gets
    // `ignored: is_admin`, exactly as before.
    // Row 13: held, control.revoke from admin -> revoking.
    revoke: [
      {
        to: 'held',
        guard: (ctx) => has(ctx, 'isAdmin') && has(ctx, 'sharedHoldersRemain'),
        guardName: 'shared_holders_remain',
      },
      { to: 'revoking', guard: (ctx) => has(ctx, 'isAdmin'), guardName: 'is_admin' },
    ],
  },
  'held-grace': {
    // Row 8: held-grace, holder reconnects with a valid resume token -> held.
    reconnected: [
      { to: 'held', guard: (ctx) => has(ctx, 'validResumeToken'), guardName: 'valid_resume_token' },
    ],
    // Row 9: held-grace, graceUntil passes -> handing-over.
    disconnectGraceExpired: [{ to: 'handing-over' }],
    // Row 10: held-grace, higher-priority control.request arrives -> handing-over (grace cut short).
    preempted: [
      {
        to: 'handing-over',
        guard: (ctx) => has(ctx, 'higherPriorityWaiting'),
        guardName: 'higher_priority_waiting',
      },
    ],
  },
  'preempt-pending': {
    // Row 14: preempt-pending, holder sends control.release -> handing-over (released:true).
    // Row 15: preempt-pending, preemptDeadline passes -> handing-over (released:false).
    preemptResolved: [
      {
        to: 'handing-over',
        guard: (ctx) => has(ctx, 'holderReleased'),
        guardName: 'holder_released',
      },
      {
        to: 'handing-over',
        guard: (ctx) => has(ctx, 'deadlinePassed'),
        guardName: 'deadline_passed',
      },
    ],
    // Row 16: preempt-pending, requester withdraws or disconnects -> held (grace cancelled).
    preemptWithdrawn: [{ to: 'held' }],
  },
  revoking: {
    // Row 17: revoking, queue drained -> handing-over.
    queueDrained: [{ to: 'handing-over' }],
  },
  'handing-over': {
    // Row 18: handing-over, drain complete or handoverDrainMs elapsed -> held (queue head) or unheld (empty queue).
    drainSettled: [
      { to: 'held', guard: (ctx) => has(ctx, 'hasQueueHead'), guardName: 'grant_queue_head' },
      { to: 'unheld', guard: () => true, guardName: 'queue_empty' },
    ],
  },
};

/** Applies one `LeaseEvent` to a `LeasePhase` through the shared `transition()` helper, scoped to this table. */
export function applyLeasePhaseTransition(
  leaseId: string,
  from: LeasePhase,
  event: LeaseEvent,
  ctx: LeasePhaseContext,
): TransitionOutcome<LeasePhase> {
  return transition(LEASE_PHASE_TRANSITIONS, LEASE_PHASE_ENTITY, leaseId, from, event, ctx);
}
