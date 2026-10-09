/**
 * The server-internal `ControlLease` shape and its supporting types.
 * Distinct from `@browserglass/protocol`'s domain `ControlLease` (keyed by
 * `ControlLeaseState`, the audit vocabulary) and from its wire
 * `LeaseState`/`LeaseSummary` (the client-visible projection): there are
 * three types for three scopes, and this file owns the server scope.
 */

import type {
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
  LeaseMode,
} from '@browserglass/protocol';
import type { LeasePhase } from './transitions.js';

/** Whether the holder is a person or an automation client. */
export type HolderKind = 'human' | 'agent';

/** The default `priority` values by holder kind. */
export const DEFAULT_PRIORITY: Readonly<Record<HolderKind | 'owner' | 'admin', number>> =
  Object.freeze({
    human: 100,
    owner: 200,
    agent: 50,
    admin: 900,
  });

/** A viewer as the control-lease engine needs to know it: identity, not transport. */
export interface ViewerRef {
  readonly viewerId: string;
  /** Token `sub`. */
  readonly identity: string;
  /** Shown to other viewers (`holderLabel`, `byLabel`, ...). */
  readonly label: string;
  readonly kind: HolderKind;
  /** Whether this viewer's token carries the `admin` capability. */
  readonly isAdmin: boolean;
}

/**
 * One current holder's bookkeeping.
 *
 * Every holder carries their OWN `leaseId` and their OWN timing anchors,
 * because a shared lease has several of them at once and each must be able
 * to expire, disconnect, renew, or be revoked without disturbing the
 * others. In `mode: 'exclusive'` there is at most one of these, and its
 * `leaseId` is the lease's `leaseId`, so nothing about the exclusive path
 * changes.
 */
export interface LeaseHolder {
  /** Minted per holder, freshly on every grant; a dead `leaseId` is never reissued. This is what `resolveInputFencing` matches an inbound `input.*` message against. */
  readonly leaseId: string;
  readonly viewerId: string;
  readonly identity: string;
  readonly label: string;
  readonly kind: HolderKind;
  priority: number;
  readonly grantedAt: number;
  lastInputAt: number;
  lastRenewAt: number;
  connected: boolean;
  /**
   * Monotonic deadline of THIS holder's disconnect grace, or `null` while
   * they are connected. In exclusive mode the lease is in `held-grace` for
   * exactly as long as this is set on the single holder (which is why
   * `Lease.graceUntil` can be derived from it); in shared mode the lease
   * stays `held` and only this holder is on the clock.
   */
  graceUntil: number | null;
}

/** One waiter in a lease's FIFO queue. */
export interface QueueEntry {
  readonly viewerId: string;
  readonly identity: string;
  readonly label: string;
  readonly kind: HolderKind;
  priority: number;
  readonly requestedAt: number;
  /** `requestedAt + queueTtlMs`. */
  readonly expiresAt: number;
  readonly reason?: string;
  /** The `control.request`'s own `id`, if it carried one, so a grant made later from this entry (`grantFromQueueEntry`) can still echo `re` back to the original request. */
  readonly requestId?: string;
}

/**
 * Why a `preempt-pending` episode started; carried through to
 * `control.preempt.request.reason` and `control.preempted.reason`.
 *
 * Decided from the REQUESTER'S {@link HolderKind} and the HOLDER'S together,
 * in `ControlLeaseEngine.beginPreempt`, never inferred from the absence of
 * something: `ViewerRef.kind` is a first class field the transport fills in
 * from the authenticated token, and it is the same field
 * {@link LeaseHolder.kind} was recorded from when that holder was granted.
 *
 *  - `'human_takeover'`: a `'human'` requester displacing an `'agent'`
 *    holder. The distinction the value exists for, and the one an automation
 *    client needs in order to tell "a person wants this page" apart from
 *    "another bot outranked me".
 *  - `'priority'`: agent over agent, or human over human. Peers, decided on
 *    rank.
 *  - `'force_claim'`: an admin's `control.request{force:true}`, whatever
 *    either party is. Checked first, because an admin forcing an agent off
 *    is an administrative act rather than an ordinary person taking over.
 */
export type PreemptReason = 'priority' | 'force_claim' | 'human_takeover';

/**
 * The server-internal `ControlLease`. One instance per `(sessionId,
 * targetId)`: control leases are scoped per Target, not per Session, which
 * is what lets two people drive two tabs of one browser concurrently.
 */
export interface Lease {
  /**
   * The PRIMARY holder's `leaseId`, derived (see {@link Lease.holder}), or
   * `null` when nobody holds the lease. Kept for the exclusive-mode callers
   * that have always read it, where it is the one and only holder's id.
   *
   * NEVER fence input against this in shared mode: fencing matches an
   * inbound `leaseId` against EVERY holder's own id
   * (`resolveInputFencing`), and matching only the primary's would silently
   * drop every other driver's input.
   */
  readonly leaseId: string | null;
  readonly sessionId: string;
  readonly targetId: string;
  /**
   * Fixed for the life of this lease record, chosen server side (see
   * `ControlLeaseEngineOptions.mode`). Never negotiated per request:
   * arbitration has to be single valued for a contended resource.
   */
  readonly mode: LeaseMode;
  phase: LeasePhase;
  /**
   * The PRIMARY holder: the longest tenured of {@link Lease.holders}, or
   * `null` when the lease is unheld. Derived, not stored.
   *
   * In `mode: 'exclusive'` this is the single holder and means exactly what
   * it always meant. In `mode: 'shared'` it is one of several and is
   * therefore only ever the right thing to read when the question genuinely
   * is "is anyone driving at all". "Is THIS viewer driving" is
   * `holders.some(h => h.viewerId === v)`; the engine exposes `isHolder()`
   * and `holderFor()` for it.
   */
  readonly holder: LeaseHolder | null;
  /**
   * Every current holder, in grant order. Length 0 or 1 in
   * `mode: 'exclusive'`; 0 to N in `mode: 'shared'`.
   */
  holders: LeaseHolder[];
  /** FIFO within equal priority, highest priority first (see `queue.ts`). Always empty in shared mode outside the sub-second `handing-over` admission window. */
  queue: QueueEntry[];
  /** Set while `phase === 'held-grace'`. Derived from the disconnected holder's own {@link LeaseHolder.graceUntil}. */
  readonly graceUntil: number | null;
  /** Set while `phase === 'preempt-pending'`; wall-clock, authoritative over `graceMs`. */
  preemptDeadline: number | null;
  preemptedBy: string | null;
  preemptReason: PreemptReason | null;
  preemptRequesterLabel: string | null;
  /** Set when a `preempt-pending` episode resolves; consumed by the `handing-over` settlement to decide `control.preempted.released`. */
  preemptReleasedInsideGrace: boolean | null;
}

/**
 * Constructs a fresh, unheld `Lease` for a `(sessionId, targetId)` pair.
 *
 * `leaseId`, `holder`, and `graceUntil` are defined as getters over
 * `holders` rather than as fields kept in step with it. Two sources of
 * truth for "who holds this lease" is exactly the bug shared mode invites:
 * one place would inevitably be updated and the other forgotten, and the
 * forgotten one is what fencing or the wire projection reads.
 */
export function createLease(
  sessionId: string,
  targetId: string,
  mode: LeaseMode = 'exclusive',
): Lease {
  return {
    get leaseId(): string | null {
      return this.holders[0]?.leaseId ?? null;
    },
    sessionId,
    targetId,
    mode,
    phase: 'unheld',
    get holder(): LeaseHolder | null {
      return this.holders[0] ?? null;
    },
    holders: [],
    queue: [],
    get graceUntil(): number | null {
      return this.holders.find((h) => h.graceUntil !== null)?.graceUntil ?? null;
    },
    preemptDeadline: null,
    preemptedBy: null,
    preemptReason: null,
    preemptRequesterLabel: null,
    preemptReleasedInsideGrace: null,
  };
}

/** Who a direct (non-broadcast) {@link LeaseEffect} is addressed to. */
export type LeaseEffectTarget = string;

/** One wire message the engine has produced, addressed to exactly one viewer. */
export interface LeaseDirectEffect {
  readonly to: LeaseEffectTarget;
  readonly message:
    | ControlGranted
    | ControlDenied
    | ControlQueued
    | ControlRevoked
    | ControlExpiring
    | ControlPreemptRequest
    | ControlPreemptCancelled
    | ControlPreempted
    | ControlYieldRequest;
}

/**
 * `control.state` is broadcast to every viewer subscribed to the target,
 * but `LeaseState.queuePosition` is "this recipient's position, computed
 * per-recipient": the same logical broadcast carries
 * different content for different viewers. Rather than pretend it is one
 * static message, this effect carries a `forViewer` factory the transport
 * layer calls once per recipient (a `null` viewerId, or any viewerId not
 * holding and not queued, produces `queuePosition: null`).
 *
 * `forViewer` also returns `ControlContention` (see `buildContention` in
 * `lease-engine.ts`), the co-driving signal, which the engine emits through
 * this SAME effect shape rather than a bespoke one. It is genuinely
 * recipient independent (unlike `control.state`, nothing on it varies by
 * `viewerId`), but sharing the `LeaseBroadcastEffect` shape means the
 * transport layer (`ManagedSession.dispatchEffect`, which this package does
 * not own and does not need to change) needs no new case: it already sends
 * whatever `forViewer(viewerId)` returns to every connection, generically,
 * by `t`.
 */
export interface LeaseBroadcastEffect {
  readonly to: 'broadcast';
  readonly forViewer: (viewerId: string | null) => ControlStateMsg | ControlContention;
}

/** Everything a `ControlLeaseEngine` action can produce. */
export type LeaseEffect = LeaseDirectEffect | LeaseBroadcastEffect;

/** A structured note for an optional audit sink; not itself a wire message. */
export interface LeaseAuditNote {
  readonly type: string;
  readonly targetId: string;
  readonly sessionId: string;
  readonly [key: string]: unknown;
}
