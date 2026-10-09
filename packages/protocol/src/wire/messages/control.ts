import type { Envelope } from '../envelope.js';

/**
 * Whether a ControlLease admits one holder at a time or several.
 *
 * `'exclusive'`: at most one holder, everyone else waits in the FIFO queue,
 * and the two-step preemption machine decides who displaces whom. This is
 * the SDK default and nothing about it has changed.
 *
 * `'shared'`: N concurrent holders on one target, each with its own
 * `leaseId`. A viewer carrying the `control` capability who asks for
 * control on a shared target is granted it immediately. Nobody waits, so
 * nobody preempts: the queue and the whole preemption machine
 * (`control.queued`, `control.preempt.request`, `control.preempt.cancelled`,
 * `control.preempted`) are exclusive-mode concepts and are never emitted for
 * a shared target.
 *
 * What a shared target has instead, and only for the human-over-agent case,
 * is {@link ControlYield}: a person can ask the agent holders of a target to
 * stand down without disturbing the people driving alongside them. It is a
 * separate message precisely because it is not preemption (see
 * {@link ControlYield}).
 *
 * The mode is a property of the target's lease, configured server side. It
 * is deliberately NOT a field on {@link ControlRequest}: arbitration has to
 * be single valued for a contended resource, and a per request mode would
 * leave "Alice holds exclusively, Bob asks for shared" with no honest
 * answer.
 */
export type LeaseMode = 'exclusive' | 'shared';

/**
 * One current holder of a shared (or exclusive) ControlLease, as
 * {@link LeaseState.holders} reports it.
 *
 * Deliberately carries no `leaseId`. A holder's `leaseId` is the capability
 * their input is fenced by (`input.*` messages stamp it, and the server
 * dispatches only input whose `leaseId` matches a current holder), so
 * broadcasting every holder's id to every subscriber would hand any viewer
 * the means to inject input attributed to somebody else. `control.state`
 * has never carried a `leaseId` and still does not; a holder learns their
 * own from their own `control.granted`.
 */
export interface LeaseHolderState {
  viewerId: string;
  label: string;
  /** Wall clock, Unix ms, when this holder was granted control. */
  grantedAt: number;
  /** Wall clock, Unix ms: the sooner of this holder's own TTL and idle deadlines. Per holder, not per lease. */
  expiresAt: number;
  /** False while this holder's socket is closed and their own disconnect grace is still running. */
  connected: boolean;
}

/**
 * The client-visible mirror of a target's ControlLease. Canonical for
 * `resumed.lease` and `control.state.leases[]`. See {@link LeaseSummary}
 * for the summarised projection used inline on `welcome.lease.byTarget`:
 * both are exported, and they are deliberately not
 * unified.
 *
 * This is distinct from `LeasePhase` (the server-internal state machine,
 * never on the wire) and from `ControlLeaseState` (the audit/history event
 * vocabulary): three types, three scopes.
 *
 * PER RECIPIENT. `control.state` is one logical broadcast whose content
 * differs by recipient: `queuePosition` has always been "this recipient's
 * position", and in `mode: 'shared'`
 * `holderViewerId`/`holderLabel`/`grantedAt`/`expiresAt` join it (see
 * {@link LeaseState.holderViewerId}). {@link LeaseState.holders} and
 * {@link LeaseState.holderCount} are the same for every recipient.
 */
export interface LeaseState {
  targetId: string;
  /**
   * The holder THIS projection is about.
   *
   * In `mode: 'exclusive'` this is the single current holder, seen the same
   * way by every recipient. Unchanged.
   *
   * In `mode: 'shared'` there is no single holder, so this reports the
   * RECIPIENT'S OWN holding: their own `viewerId` when they are one of the
   * current drivers, and `null` when they are not. It is deliberately not
   * "one arbitrary holder of several", which would make the ordinary
   * `holderViewerId === myViewerId` test ("am I driving?") wrong for every
   * driver but one. Anyone who needs to know who else is driving reads
   * {@link LeaseState.holders}, which is complete and recipient independent.
   */
  holderViewerId: string | null;
  /** The label of whichever holder {@link LeaseState.holderViewerId} names, on the same per recipient terms. */
  holderLabel: string | null;
  /** Wall clock, Unix ms, for whichever holder {@link LeaseState.holderViewerId} names. */
  grantedAt: number | null;
  /** Wall clock, Unix ms, for whichever holder {@link LeaseState.holderViewerId} names. Per holder in shared mode: two drivers expire at their own times. */
  expiresAt: number | null;
  mode: LeaseMode;
  /**
   * Every current holder, in grant order (longest tenured first). Empty
   * when the lease is unheld. In `mode: 'exclusive'` this is 0 or 1 entries
   * and says the same thing `holderViewerId` does; in `mode: 'shared'` it is
   * the whole truth about who is driving, and it is identical for every
   * recipient.
   */
  holders: LeaseHolderState[];
  /** `holders.length`, carried separately so a summary can report it without the collection. */
  holderCount: number;
  /** Always empty in `mode: 'shared'`: a shared request is granted immediately, so nobody ever waits. */
  queue: Array<{ viewerId: string; label: string; requestedAt: number; priority: number }>;
  queueLength: number;
  /** This viewer's position, 1-based; `null` if not queued. Always `null` in `mode: 'shared'`. */
  queuePosition: number | null;
}

/**
 * The summarised projection of {@link LeaseState} used inline on
 * `welcome.lease.byTarget[targetId]`. Lacks `grantedAt` and `targetId`
 * (redundant with the map key) and carries `queuePosition` where
 * {@link LeaseState} carries the full `queue[]`.
 *
 * It takes `holderCount` but deliberately not `holders[]`: the point of the
 * summary is to stay small on a `welcome` that carries one entry per
 * target, and a viewer that needs the roster gets it from the first
 * `control.state`. The two types stay deliberately not unified.
 */
export type LeaseSummary = Pick<
  LeaseState,
  'holderViewerId' | 'holderLabel' | 'mode' | 'holderCount' | 'queueLength' | 'queuePosition'
> & { expiresAt: number };

/** C to S: request the ControlLease on a Target. */
export interface ControlRequest extends Envelope {
  t: 'control.request';
  targetId: string;
  /** Desired TTL; server clamps to policy. */
  ttlMs?: number;
  /** Shown to the current holder. */
  reason?: string;
  /**
   * Requires the `admin` capability. Enters the two-step preemption machine
   * with a different `graceMs`.
   *
   * A NO-OP on a `mode: 'shared'` target, where the request is granted
   * immediately anyway. `force` exists to displace a holder or jump a
   * queue, and a shared target has neither: the requester's actual goal
   * ("let me drive now") is already fully met, and the part force cannot
   * deliver ("and nobody else drives") is not something shared mode offers
   * at all. An admin who genuinely needs a specific driver off a shared
   * target uses `control.revoke`, which names one holder and removes only
   * that holder.
   */
  force?: boolean;
  /** Default true: queue if busy instead of failing. Ignored on a `mode: 'shared'` target, which is never busy. */
  queue?: boolean;
}

/**
 * S to C: the lease was granted.
 *
 * `leaseId` is per holder, not per target: on a `mode: 'shared'` target
 * every concurrent holder is granted their own, and every `input.*` message
 * stamps the sender's own id. That is what lets one driver's in-flight
 * input be invalidated (they released, expired, or were revoked) without
 * touching anybody else's.
 */
export interface ControlGranted extends Envelope {
  t: 'control.granted';
  targetId: string;
  leaseId: string;
  expiresAt: number;
  renewWithinMs: number;
  idleReleaseMs: number;
  /** The target's lease mode, so a client knows whether to expect a queue at all. */
  mode: LeaseMode;
}

/** S to C: the lease request was refused outright. */
export interface ControlDenied extends Envelope {
  t: 'control.denied';
  targetId: string;
  reason:
    | 'cap_missing'
    | 'queue_full'
    | 'policy'
    | 'holder_pinned'
    | 'target_gone'
    | 'session_readonly';
  message: string;
  holderLabel?: string;
  retryAfterMs?: number;
}

/** S to C: the request was queued behind the current holder. Never sent for a `mode: 'shared'` target, where a request ends in `control.granted` or `control.denied` and nothing else. */
export interface ControlQueued extends Envelope {
  t: 'control.queued';
  targetId: string;
  position: number;
  estimatedWaitMs: number | null;
  holderLabel: string;
}

/** C to S: extend the current holder's lease. */
export interface ControlRenew extends Envelope {
  t: 'control.renew';
  targetId: string;
  leaseId: string;
  ttlMs?: number;
}

/** C to S: voluntarily give up the lease. */
export interface ControlRelease extends Envelope {
  t: 'control.release';
  targetId: string;
  leaseId: string;
}

/**
 * S to C: the lease ended. Addressed to one holder and naming that holder's
 * own `leaseId`: on a shared target the other holders keep driving and are
 * not told anything beyond the next `control.state`.
 *
 * `'human_takeover'` is the {@link ControlYield} outcome: an agent holder on
 * a `mode: 'shared'` target that did not stand down inside the yield grace.
 * It is deliberately a separate value from `'admin'`, which is
 * {@link ControlRevoke}: an admin naming one driver and removing them is a
 * different fact from a person asking the automation on a page to stop, and
 * an automation client that logs or retries on one should not be forced to
 * guess which happened.
 *
 * `'kind_changed'` is a `hello{reauth:true}` that moved this viewer between
 * human and agent, in either direction, by adding or removing the
 * `automation` capability. The tenure ends because a lease is issued to an
 * identity CLASS, not merely to a viewer id: `leaseId` is the capability the
 * holder's input is fenced by, and half the arbitration downstream of a grant
 * (which preempt `reason` is sent, whether the `minHoldMs` floor applies,
 * whether a {@link ControlYield} addresses this holder, which grace they get)
 * reads the kind recorded at grant time. Re-requesting mints a fresh lease
 * under the class now in force, which is the only way every one of those
 * decisions stays consistent with every other.
 *
 * It is deliberately distinct from `'admin'`, which is what a capability
 * SHRINK that removes `control` arrives as (the server revokes the lease
 * through the ordinary admin path). Same trigger, a reauth, and two different
 * facts: "you may no longer control anything" against "you are now a
 * different kind of actor, ask again". An automation author will want to
 * retry immediately on one and not on the other.
 */
export interface ControlRevoked extends Envelope {
  t: 'control.revoked';
  targetId: string;
  leaseId: string;
  reason:
    | 'expired'
    | 'idle'
    | 'admin'
    | 'target_gone'
    | 'session_ended'
    | 'capability_lost'
    | 'human_takeover'
    | 'kind_changed';
  byLabel?: string;
}

/**
 * C to S: a person asks the AGENT holders of a `mode: 'shared'` target to
 * stand down, leaving every HUMAN holder driving. Requires the `control`
 * capability. The counterpart to preemption for a mode that has no queue.
 *
 * WHY THIS IS NOT A `control.request`. On a shared target `control.request`
 * is granted immediately, so it cannot express "and the automation should
 * stop": the requester already has control, alongside the agent. Making the
 * yield implicit in `control.request` was considered and rejected, because a
 * viewer that starts driving a shared tab is the ordinary case (the whole
 * point of the mode is that a person and an agent can both drive one page),
 * and an implicit yield would fire on every tab click and make shared mode
 * unusable for the swarm case it exists for. Standing the automation down is
 * a separate intention and gets a separate message.
 *
 * WHY THIS IS NOT A `control.preempt.request`. Nobody is losing a lease to a
 * queue here: there is no queue on a shared target, the requester gains
 * nothing they did not already have (they may not even be a holder), and no
 * `requeueAfterMs` backoff applies, since a yielded agent that wants back in
 * is granted control the instant it asks. The preemption machine
 * (`control.preempt.request`, `control.preempt.cancelled`,
 * `control.preempted`) remains exclusive-mode only and is still never
 * emitted for a shared target.
 *
 * REFUSED on a `mode: 'exclusive'` target rather than quietly doing nothing:
 * exclusive control already has a way for a person to take a target off an
 * agent, namely `control.request`, whose preemption notice gives that agent
 * the same `control.agentPreemptGraceMs` window. A client that sent the
 * wrong message for the mode should learn so.
 */
export interface ControlYield extends Envelope {
  t: 'control.yield';
  targetId: string;
  /** Shown to the agents being asked to stand down. Capped at 200 bytes, sanitised (see `packages/server/src/wire/sanitize.ts`). */
  reason?: string;
}

/**
 * S to C, to ONE agent holder of a shared target: stand down.
 *
 * The holder still owns its lease during the grace and its input still
 * dispatches, exactly as {@link ControlPreemptRequest} works in exclusive
 * mode, so an action already in flight can finish. The honest response is
 * `control.release` naming this `leaseId`. A holder that has not released by
 * `deadline` has its tenure ended for it and receives
 * `control.revoked{reason:'human_takeover'}`.
 *
 * `leaseId` is THIS recipient's own, never the lease's primary holder's: a
 * shared lease has several, and the one that matters to the recipient is the
 * one their own input is fenced by.
 *
 * Sent to agent holders only. A human driving the same target is not asked
 * to stand down and is not told that anybody else was: shared stays shared
 * between people, which is the point of the mode.
 */
export interface ControlYieldRequest extends Envelope {
  t: 'control.yield.request';
  targetId: string;
  /** The recipient's own lease id, the one to release. */
  leaseId: string;
  byViewerId: string;
  byLabel: string;
  /** `control.agentPreemptGraceMs`, the same window an agent gets to yield under exclusive preemption. */
  graceMs: number;
  /** Wall clock deadline, Unix ms, authoritative over `graceMs`. */
  deadline: number;
  /** The requester's `reason`, if they gave one. */
  reason?: string;
}

/**
 * C to S: admin revocation. No warning, no grace, no queue position for
 * the holder. Requires `admin`. NOT the same as preemption. Naming a
 * non-current `holderViewerId` yields `bgls.error.control.not_held` rather
 * than revoking whoever holds the lease now.
 *
 * On a `mode: 'shared'` target this is the ONLY way to take control away
 * from somebody, and it stays exactly as narrow as its name: it removes the
 * one holder it names and leaves every other driver untouched.
 */
export interface ControlRevoke extends Envelope {
  t: 'control.revoke';
  targetId: string;
  holderViewerId: string;
  /** Capped at 200 bytes, sanitised (see `packages/server/src/wire/sanitize.ts`). */
  reason?: string;
}

/** S to C, to the holder only, once per lapse: advisory that the lease is about to lapse. */
export interface ControlExpiring extends Envelope {
  t: 'control.expiring';
  targetId: string;
  leaseId: string;
  /** Authoritative. */
  expiresAt: number;
  /** Convenience; may be stale. */
  inMs: number;
  reason: 'idle' | 'ttl';
}

/**
 * S to C, to the current holder: preemption step 1. Nothing is taken yet;
 * the holder still owns the lease during the grace.
 *
 * `reason` is decided from the REQUESTER'S kind and the HOLDER'S kind
 * together, and the three values are genuinely distinct facts:
 *
 *  - `'human_takeover'`: a human requester displacing an AGENT holder. The
 *    one case where the holder is not competing with a peer, and the one an
 *    automation client should treat as "a person wants this page, stop".
 *  - `'priority'`: agent outranking agent, or human outranking human. A peer
 *    won on rank, and requeuing is reasonable.
 *  - `'force_claim'`: `control.request{force:true}` from an admin, whatever
 *    either party is.
 */
export interface ControlPreemptRequest extends Envelope {
  t: 'control.preempt.request';
  targetId: string;
  leaseId: string;
  byViewerId: string;
  byLabel: string;
  reason: 'priority' | 'force_claim' | 'human_takeover';
  graceMs: number;
  /** Wall-clock deadline, Unix ms, authoritative over `graceMs`. */
  deadline: number;
}

/** S to C, to the holder only: preemption called off. The lease never moved; the `leaseId` is unchanged (same tenure). */
export interface ControlPreemptCancelled extends Envelope {
  t: 'control.preempt.cancelled';
  targetId: string;
  leaseId: string;
  reason: 'withdrawn' | 'requester_gone' | 'admin';
}

/** S to C, to the party that lost control only: preemption step 2. */
export interface ControlPreempted extends Envelope {
  t: 'control.preempted';
  targetId: string;
  leaseId: string;
  byViewerId: string;
  byLabel: string;
  /** The same value the matching {@link ControlPreemptRequest} carried; see its `reason` note for how the three are chosen apart. */
  reason: 'priority' | 'force_claim' | 'human_takeover';
  /** True if the holder released inside the grace, false if the grace expired. */
  released: boolean;
  /** The last input `sq` the server actually dispatched. */
  lastDispatchedInputSeq: number;
  mayRequeue: boolean;
  /** Default 30000 for an automation viewer. */
  requeueAfterMs: number;
}

/** S to C: the full lease table for the session. */
export interface ControlStateMsg extends Envelope {
  t: 'control.state';
  leases: LeaseState[];
}

/**
 * One current holder as {@link ControlContention} reports it.
 *
 * Deliberately NOT {@link LeaseHolderState}. That type carries no `kind`
 * on purpose: it is a plain control record (`viewerId`, `label`, two
 * timestamps, `connected`), and every existing reader that needs a
 * holder's kind already joins `holders` against `presence.state`'s roster
 * to get it (see `BrowserGlassClient.countAgentHolders`'s own doc for that
 * join, and `@browserglass/react`'s `driversOf()`, which does the same
 * thing). {@link ControlContention} exists precisely so an autonomous
 * agent does NOT have to do that join under time pressure: "a human just
 * started driving my tab, I should stand down" has to be answerable from
 * ONE message, with no guarantee `presence.state` has even arrived yet (a
 * fresh `hello` can see `control.state` before its own first
 * `presence.state`). So this carries `kind` and `priority` itself, joined
 * once, here, for every recipient.
 */
export interface ContentionHolder {
  viewerId: string;
  label: string;
  /**
   * `'human' | 'agent'`, matching `LeaseHolder.kind` on the server
   * (`packages/core/src/control/types.ts`'s `HolderKind`), NOT
   * `presence.state`'s three-way `'human' | 'agent' | 'service'`. A
   * holder's kind is derived solely from whether its token carries the
   * `automation` capability (`ws/connection.ts`'s `viewerIdentity()`:
   * `granted.has('automation') ? 'agent' : 'human'`), never from
   * `hello.subKind`, so a `'service'` viewer is never actually
   * distinguishable as a holder kind in this build: it is admitted as
   * `'human'` unless its token also carries `automation`.
   */
  kind: 'human' | 'agent';
  /** The priority this holder was granted under (the lease engine's default, or an explicit `control.request.priority`). What ranks one holder above another when a policy or a human has to choose. */
  priority: number;
  /** Wall clock, Unix ms, when this holder was granted control. Same value {@link LeaseHolderState.grantedAt} carries. */
  grantedAt: number;
  /** False while this holder's socket is closed and their own disconnect grace is still running. Same meaning as {@link LeaseHolderState.connected}. */
  connected: boolean;
}

/**
 * S to C, broadcast: the explicit signal {@link LeaseState.holders} otherwise
 * leaves a client to notice only by diffing two `control.state` broadcasts
 * itself. Fires the instant a target's holder count crosses the co-driving
 * threshold in either direction: once when it goes from one holder to two
 * or more (`contended: true`), and once when it drops back to at most one
 * (`contended: false`). Never fires under `mode: 'exclusive'`, where
 * `holders` is 0 or 1 entries by construction (the threshold can never be
 * crossed there), so exclusive mode's wire behaviour is unchanged by this
 * message existing at all.
 *
 * WHY THIS EXISTS ALONGSIDE `control.state`. Every fact this message
 * reports was already reachable by a client willing to diff consecutive
 * `control.state.leases[].holders` arrays for a length that crosses two.
 * That diff is exactly the gap: an autonomous agent driving a target has no
 * event that SAYS "you are now co-driving with someone else", so it cannot
 * correct automatically without first writing that diff itself, for every
 * target, correctly, including the direction it un-fires. This message is
 * the announcement: sent once per threshold crossing, never once per
 * `control.state` broadcast (most of which do not cross the threshold at
 * all: a renewal, a disconnect, a reconnect, a third holder joining a
 * target that already had two, none of them cross it).
 *
 * NOT "conflict". Two or more holders of one shared target is the feature
 * `ControlLeaseEngine`'s own module doc describes ("two people driving one
 * page... is the feature, not a conflict to resolve"), not an error state,
 * so this reports CONTENTION for a resource in the ordinary sense of
 * several parties wanting it at once, and never implies anybody did
 * anything wrong or that the server refused anybody anything. Shared
 * mode's permissiveness is completely unchanged: this message is pure
 * observability, sent in addition to, never instead of, the ordinary grant
 * and the ordinary `control.state`.
 *
 * Broadcast, and recipient independent, on the same grounds
 * {@link LeaseState.holders} already is: who is driving a target is not a
 * secret between drivers, and every recipient needs the identical answer to
 * decide whether IT should stand down, not merely whether the target it
 * happens to be watching looks contended from its own point of view.
 */
export interface ControlContention extends Envelope {
  t: 'control.contention';
  targetId: string;
  /** True the instant `holders` crosses from one to two or more; false the instant it drops back to at most one. */
  contended: boolean;
  /** Every current holder, in grant order (longest tenured first): same order and same completeness as {@link LeaseState.holders}. */
  holders: ContentionHolder[];
  /** `holders.length`, carried separately per {@link LeaseState.holderCount}'s own convention. */
  holderCount: number;
  /**
   * The `viewerId` of whichever holder in `holders` was granted control
   * most recently (`holders[holders.length - 1]`), or `null` when
   * `holders` is empty. When `contended` just became `true` this IS the
   * arrival that caused it: the one new fact an agent needs in order to
   * decide who it is now co-driving with, without a second round trip
   * against `presence.state` or `control.state`. When `contended` just
   * became `false` this names whichever single holder, if any, remains.
   */
  mostRecentViewerId: string | null;
}
