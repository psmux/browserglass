/**
 * `ControlPolicy`, the pluggable arbitration strategy. Only `'exclusive'`
 * is implemented; the other four names are typed and throw
 * {@link ControlPolicyNotImplementedError} the moment any of their methods
 * is actually called, i.e. "on selection". The `ControlPolicy` interface
 * and the `control.policy` key exist so the other four are additive.
 */

import type { ControlTiming } from './constants.js';
import type { Lease, QueueEntry, ViewerRef } from './types.js';

/** The five policy names. Only `'exclusive'` ships. */
export type ControlPolicyName =
  | 'exclusive'
  | 'firstComeFirstServed'
  | 'ownerPriority'
  | 'freeForAll'
  | 'observerOnly';

/** The per-request facts a `ControlPolicy` decision needs beyond the lease and requester identity. */
export interface PolicyRequest {
  /** `control.request.force`; requires `admin`, checked by the caller before this is set true. */
  readonly force: boolean;
  /** The requester's effective priority for this request. */
  readonly priority: number;
}

/** Everything a `ControlPolicy` method needs to decide. */
export interface PolicyContext {
  readonly lease: Lease;
  readonly requester: ViewerRef;
  readonly request: PolicyRequest;
  /**
   * MONOTONIC now, on the same clock as {@link Lease}'s own timestamps
   * (`LeaseHolder.grantedAt`, `QueueEntry.requestedAt`), so a duration
   * computed against one of them is a real duration.
   *
   * It used to be a wall reading, which made `minHoldMs` below compute
   * `Date.now() - performance.now()` in production: a difference of roughly
   * the Unix epoch, so `minHoldElapsed` was unconditionally true and
   * `minHoldMs` protected nobody outside a test running on `ManualClock`
   * (where the two readings are equal, which is precisely why no test caught
   * it). Wall clock never belonged here: nothing a policy decides goes on
   * the wire, and `Lease`'s anchors are monotonic by the discipline at the
   * top of `lease-engine.ts`.
   */
  readonly now: number;
  /** Pool or instance owners; `ownerPriority` consults this, `exclusive` does not. */
  readonly ownerViewerIds: ReadonlySet<string>;
  readonly capabilities: ReadonlySet<string>;
  readonly timing: ControlTiming;
}

/**
 * The narrower context {@link ControlPolicy.selectNext} needs: unlike every
 * other policy method, choosing a winner from an already-populated queue is
 * not evaluating any particular viewer's request, so it has no `requester`
 * or `request` to offer.
 */
export type SelectNextContext = Pick<PolicyContext, 'now' | 'ownerViewerIds' | 'timing'>;

/**
 * The pluggable arbitration strategy interface. Every
 * method is checked, in this order, at the point it names.
 */
export interface ControlPolicy {
  readonly name: ControlPolicyName;
  /** Checked before anything else; `observerOnly` always returns false. */
  canRequest(ctx: PolicyContext): boolean;
  /** Called when the target has no current holder. */
  onRequestUnheld(ctx: PolicyContext): 'grant' | 'deny';
  /** Called when the target has a current holder. */
  onRequestHeld(ctx: PolicyContext): 'queue' | 'deny' | 'preempt';
  /** Who gets the lease next when it frees, or `null` if nobody should. */
  selectNext(queue: readonly QueueEntry[], ctx: SelectNextContext): QueueEntry | null;
  /** Called per input message: may this viewer inject right now? */
  mayInject(ctx: PolicyContext): boolean;
}

/** Thrown by every method of a not-yet-implemented `ControlPolicy` the moment it is called. */
export class ControlPolicyNotImplementedError extends Error {
  constructor(readonly policyName: ControlPolicyName) {
    super(
      `Control policy '${policyName}' is not implemented in this build: only 'exclusive' ships. The interface exists so the other four policies are additive.`,
    );
    this.name = 'ControlPolicyNotImplementedError';
  }
}

function notImplementedPolicy(name: ControlPolicyName): ControlPolicy {
  const fail = (): never => {
    throw new ControlPolicyNotImplementedError(name);
  };
  return {
    name,
    canRequest: fail,
    onRequestUnheld: fail,
    onRequestHeld: fail,
    selectNext: fail,
    mayInject: fail,
  };
}

/**
 * `minHoldMs`, the floor on a fresh tenure, and the ONE pairing it does not
 * apply to.
 *
 * The rule exists so a person mid drag is not yanked out from under
 * themselves a moment after they got control. That is a claim on those three
 * seconds a HUMAN holder has and an AGENT holder does not: an agent is not
 * halfway through a gesture it can feel being interrupted, it already has a
 * dedicated and shorter yield window in `agentPreemptGraceMs` (2000) for the
 * actual handover, and stacking the two made a person wait up to five
 * seconds to take a browser back off automation.
 *
 * So the floor is lifted for exactly one combination: a `'human'` REQUESTER
 * against an `'agent'` HOLDER. Every other pairing keeps it in full,
 * deliberately and including the ones that look adjacent:
 *
 * | requester | holder | `minHoldMs` gate |
 * | --- | --- | --- |
 * | human | agent | LIFTED |
 * | human | human | kept (a person mid drag, the case the rule is for) |
 * | agent | human | kept |
 * | agent | agent | kept |
 *
 * Lifting the floor grants no new preemption RIGHT. The `forceClaim ||
 * priorityWins` test below still has to pass on its own, so a deployment
 * that has configured an agent above a human on `priority` still sees that
 * agent keep the lease. Only the wait is removed, never the arbitration.
 */
function minHoldSatisfied(ctx: PolicyContext, holder: NonNullable<Lease['holder']>): boolean {
  if (ctx.requester.kind === 'human' && holder.kind === 'agent') return true;
  return ctx.now - holder.grantedAt >= ctx.timing.minHoldMs;
}

/**
 * The only shipped policy: one holder, FIFO queue, preemption only by
 * priority or a `force:true` admin claim, and never inside `minHoldMs` of a
 * grant except for the one pairing {@link minHoldSatisfied} names.
 * `mayInject` requires both the
 * matching `viewerId` and (checked by the engine, which is the only caller
 * with the inbound leaseId) the matching `leaseId`. `selectNext` is plain
 * FIFO because `queue.ts`'s `insertIntoQueue` already maintains
 * highest-priority-first, FIFO-within-priority ordering on insert.
 */
export const EXCLUSIVE_POLICY: ControlPolicy = {
  name: 'exclusive',
  canRequest: () => true,
  onRequestUnheld: () => 'grant',
  onRequestHeld: (ctx) => {
    const holder = ctx.lease.holder;
    if (!holder) return 'queue';
    const forceClaim = ctx.request.force && ctx.capabilities.has('admin');
    const priorityWins = ctx.request.priority > holder.priority;
    if (!minHoldSatisfied(ctx, holder)) return 'queue';
    if (forceClaim || priorityWins) return 'preempt';
    return 'queue';
  },
  selectNext: (queue) => queue[0] ?? null,
  mayInject: (ctx) => ctx.lease.holder?.viewerId === ctx.requester.viewerId,
};

/** `firstComeFirstServed`: NOT IMPLEMENTED. Throws on any method call. */
export const FIRST_COME_FIRST_SERVED_POLICY: ControlPolicy =
  notImplementedPolicy('firstComeFirstServed');
/** `ownerPriority`: NOT IMPLEMENTED. Throws on any method call. */
export const OWNER_PRIORITY_POLICY: ControlPolicy = notImplementedPolicy('ownerPriority');
/** `freeForAll`: NOT IMPLEMENTED. Throws on any method call. */
export const FREE_FOR_ALL_POLICY: ControlPolicy = notImplementedPolicy('freeForAll');
/** `observerOnly`: NOT IMPLEMENTED. Throws on any method call. */
export const OBSERVER_ONLY_POLICY: ControlPolicy = notImplementedPolicy('observerOnly');

const POLICIES: Readonly<Record<ControlPolicyName, ControlPolicy>> = Object.freeze({
  exclusive: EXCLUSIVE_POLICY,
  firstComeFirstServed: FIRST_COME_FIRST_SERVED_POLICY,
  ownerPriority: OWNER_PRIORITY_POLICY,
  freeForAll: FREE_FOR_ALL_POLICY,
  observerOnly: OBSERVER_ONLY_POLICY,
});

/**
 * Resolves a policy name to its (possibly not-implemented) `ControlPolicy`.
 * Resolving a name never throws by itself; using the returned policy's
 * methods is what throws for the four unshipped names.
 */
export function getControlPolicy(name: ControlPolicyName): ControlPolicy {
  return POLICIES[name];
}
