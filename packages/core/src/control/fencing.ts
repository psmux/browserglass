/**
 * Fencing by `leaseId`: input naming a non-current `leaseId` is dropped,
 * except `mouse.up`, `key.up`, `touch.end`, `touch.cancel`, `drag.drop`, and
 * `drag.leave`, which are dispatched anyway at the last known position and
 * attributed to the previous holder in the audit log, without extending or
 * restoring any lease (the asymmetry: NEVER drop releases). `drag.drop`
 * and `drag.leave` (CDP `drop`/`dragCancel`) close a drag exactly the way
 * `mouse.up` closes a click-drag, so a departing driver cannot leave a drag
 * stuck open any more than they can leave a button stuck down.
 *
 * "Current" means "matches one of the lease's CURRENT HOLDERS", plural.
 * A `mode: 'shared'` lease has N holders at once, each with their own
 * `leaseId`, and this function matches an inbound message against all of
 * them. That plurality is the whole reason each holder gets its own id: one
 * driver releasing, expiring, or being revoked invalidates their in-flight
 * input and nobody else's. With one shared id there would be no way to
 * fence off one driver without fencing off everybody.
 *
 * The release asymmetry matters MORE with several drivers, not less. A
 * departing driver's `mouse.up` still dispatches after their lease is gone,
 * so they cannot leave a button or a modifier stuck down for the people
 * still driving.
 *
 * This module is a pure decision function. `@browserglass/core`'s input
 * dispatcher (`../input/dispatcher.ts`) calls it once per inbound input
 * message before touching CDP.
 */

import type { Lease } from './types.js';

/**
 * The input kinds the fencing decision distinguishes. Every value not in
 * {@link ALWAYS_DISPATCHED_KINDS} is subject to ordinary leaseId fencing.
 */
export type InputFenceKind =
  | 'mouse.down'
  | 'mouse.move'
  | 'mouse.up'
  | 'mouse.wheel'
  | 'key.down'
  | 'key.up'
  | 'key.char'
  | 'touch.start'
  | 'touch.move'
  | 'touch.end'
  | 'touch.cancel'
  | 'drag.enter'
  | 'drag.over'
  | 'drag.drop'
  | 'drag.leave'
  | 'other';

/** The one class of input never dropped for a stale (or absent) leaseId: releases. */
export const ALWAYS_DISPATCHED_KINDS: ReadonlySet<InputFenceKind> = new Set([
  'mouse.up',
  'key.up',
  'touch.end',
  'touch.cancel',
  // A drag closes exactly like a button releases: `drop` completes it,
  // `leave` (CDP `dragCancel`) aborts it. Neither may be stuck open by a
  // stale lease, or the departing driver leaves the page mid-drag forever.
  'drag.drop',
  'drag.leave',
]);

/** One inbound input message's fencing-relevant fields. */
export interface FenceCheckInput {
  readonly viewerId: string;
  readonly leaseId: string;
  readonly kind: InputFenceKind;
}

/** The outcome of a fencing check. */
export interface FenceDecision {
  /** Whether the input should be dispatched to CDP. */
  readonly dispatch: boolean;
  /**
   * The viewerId the audit log should attribute this input to. Set whenever
   * `dispatch` is true; for the current holder this is the sender itself,
   * for a stale-lease release it is the previous holder when known.
   */
  readonly attributedTo: string | null;
  readonly reason?: 'current' | 'stale_lease' | 'no_lease';
}

/** The per holder fields a fencing decision reads. Structurally satisfied by `LeaseHolder`. */
export interface FenceHolder {
  readonly leaseId: string;
  readonly viewerId: string;
  /** A holder inside their own disconnect grace is not dispatchable; see {@link resolveInputFencing}. */
  readonly connected: boolean;
}

/**
 * Decides whether one inbound input message should reach CDP, per the
 * fencing rule and its release exception. `lastHolderViewerId`, when
 * supplied, is used to attribute a stale-lease release to the viewer who
 * actually held the lease at the time the corresponding press happened,
 * rather than to whoever's socket the stale message arrived on.
 */
export function resolveInputFencing(
  lease: Pick<Lease, 'phase'> & { readonly holders: readonly FenceHolder[] },
  input: FenceCheckInput,
  options?: { readonly lastHolderViewerId?: string | null },
): FenceDecision {
  // Input only dispatches for a *current* holder while the lease is
  // actually held: `held` (ordinary tenure) and `preempt-pending` (the
  // holder KEEPS driving during the preemption grace). Every other phase, including
  // `handing-over` with the same leaseId still on the lease record for one
  // more tick, must reject non-exception input the same as a stale leaseId.
  const dispatchablePhase = lease.phase === 'held' || lease.phase === 'preempt-pending';
  // `connected` is required as well as a matching leaseId. In exclusive
  // mode this changes nothing: a disconnected holder's lease is in
  // `held-grace`, which is not a dispatchable phase anyway, so the extra
  // condition can never be the deciding one. In shared mode it is the only
  // thing standing in for that phase, because a shared lease stays `held`
  // while one of its holders sits out their own disconnect grace, and that
  // holder must be fenced off exactly as `held-grace` fences off the single
  // holder in exclusive mode.
  const match = dispatchablePhase
    ? lease.holders.find((h) => h.connected && h.leaseId === input.leaseId)
    : undefined;
  if (match) {
    return { dispatch: true, attributedTo: match.viewerId, reason: 'current' };
  }
  // `no_lease` versus `stale_lease` is "nobody holds this target at all"
  // versus "somebody does, but not under the id you sent", unchanged in
  // meaning now that "somebody" can be several people.
  const reason = lease.holders.length === 0 ? 'no_lease' : 'stale_lease';
  if (ALWAYS_DISPATCHED_KINDS.has(input.kind)) {
    const attributedTo = options?.lastHolderViewerId ?? input.viewerId;
    return { dispatch: true, attributedTo, reason };
  }
  return { dispatch: false, attributedTo: null, reason };
}
