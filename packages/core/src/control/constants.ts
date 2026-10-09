/**
 * The lease timing constants, all under `control.*`. Every key here
 * corresponds 1:1 to a `control.<key>` configuration key.
 *
 * `disconnectGraceMs` is 30000, not 10000: holding control hostage is
 * worse than losing a subscription, so the longer value wins, while the key name stays in the `control.*`
 * namespace rather than becoming `leaseGraceMs`.
 */
export interface ControlTiming {
  /** TTL from grant. */
  readonly leaseTtlMs: number;
  /** No input from the holder for this long releases the lease, regardless of queue state. */
  readonly idleExpiryMs: number;
  /** No input from the holder for this long, AND someone is queued, revokes to the queue head. */
  readonly idleReleaseMs: number;
  /** Client renews once `expiresAt - now` drops below this. */
  readonly renewWithinMs: number;
  /** Lead time before an idle/TTL lapse at which `control.expiring` is sent to the holder. */
  readonly expiryWarningMs: number;
  /** Two missed renewals plus slack; catches a client alive on the socket but with wedged lease logic. */
  readonly renewGraceMs: number;
  /** A disconnected holder's lease survives this long; a reconnect inside the window keeps control. */
  readonly disconnectGraceMs: number;
  /**
   * How long after a holder's socket closes their POINTER AND KEY HYGIENE
   * sweep runs, when other drivers are still on the target.
   *
   * Deliberately split from {@link ControlTiming.disconnectGraceMs}, which
   * stays 30000. The two were one deadline only because nothing ever needed
   * them apart. They want opposite things:
   *
   *  - The TENURE should survive the full grace, so a driver whose laptop
   *    lid closed for twenty seconds comes back to the SAME `leaseId`
   *    rather than re-requesting and possibly re-queuing.
   *  - The HELD STATE should not. A departed driver's held mouse button,
   *    held modifiers, active touches, and active drag are visible to
   *    everybody else driving that page, and 30 seconds of a jammed pointer
   *    in a room with two people in it reads as a broken page. Measured on
   *    a real hard close (`ws.terminate()`, no close frame): the button came
   *    up 30514ms later.
   *
   * 1500ms is derived from this repo's own client rather than from taste.
   * `DEFAULT_RECONNECT_OPTIONS` (`packages/client/src/transport/types.ts`)
   * gives two silent attempts at 200ms and then an exponential ladder from
   * 250ms, so a genuine network blip reconnects on its first, second, or
   * third attempt: roughly 650ms of backoff plus the handshake and the
   * `hello{reauth:true}` round trip. 1500ms clears that with headroom, so a
   * blip never visibly interrupts that driver's own drag, and it is 20x
   * shorter than the grace it used to be welded to.
   *
   * Only ever scheduled when somebody ELSE is still driving the target
   * (`ControlLeaseEngine`'s `othersStillDriving`), which in
   * `mode: 'exclusive'` is never true. Exclusive mode is therefore unchanged
   * by construction rather than by a mode check.
   */
  readonly disconnectHygieneMs: number;
  /** Bounded wait for the previous holder's dispatch queue to drain during handoff. */
  readonly handoverDrainMs: number;
  /**
   * A freshly granted lease cannot be preempted for this long, with ONE
   * exception: a `'human'` requester against an `'agent'` holder, which is
   * not made to wait at all.
   *
   * The rule protects a person mid drag from being yanked out from under
   * themselves. An agent has no equivalent claim on these three seconds, and
   * it already has a shorter dedicated window for the actual handover in
   * {@link ControlTiming.agentPreemptGraceMs}, so stacking the two made a
   * person wait up to five seconds to take a browser back off automation.
   * Every other pairing keeps the floor in full: see `minHoldSatisfied` in
   * `policies.ts` for the table and for why lifting it grants no new
   * preemption right.
   */
  readonly minHoldMs: number;
  /** `preempt-pending` grace when the holder is a human being force-claimed by an admin. */
  readonly forceClaimNoticeMs: number;
  /**
   * How long an automation holder gets to stand down of its own accord, in
   * both of the ways it can be asked.
   *
   * In `mode: 'exclusive'` it is the `preempt-pending` grace when the holder
   * is an automation viewer. In `mode: 'shared'` it is the `control.yield`
   * grace, the window between a person asking the agents on a target to stop
   * and the engine ending the tenure of any that did not.
   *
   * One constant rather than two on purpose: the question both windows ask is
   * the same one, namely how long an automation client reasonably needs to
   * finish an action already in flight and release cleanly, and that does not
   * depend on which mode the target happens to be in. A deployment that tunes
   * it tunes both, which is what it would want.
   */
  readonly agentPreemptGraceMs: number;
  /** Floor on `requeueAfterMs` for a preempted automation viewer. */
  readonly agentRequeueBackoffMs: number;
  /** A queued request expires after this long unclaimed. */
  readonly queueTtlMs: number;
  /** How long a queued viewer waits before force-claim is offered. */
  readonly forceClaimAfterMs: number;
  /** Bound on draining the input dispatch chain at handoff. */
  readonly inputDrainTimeoutMs: number;
  /** Whether dispatched input resets `lastInputAt` (it always does in this build). */
  readonly renewOnInput: boolean;
  /**
   * The deployment-level veto on `mode: 'shared'`, matching the
   * `bgls.error.control.shared_not_allowed` hint ("Enable control.allowShared
   * server side"). An engine constructed with `mode: 'shared'` while this is
   * false runs exclusive instead and records a `control.sharedNotAllowed`
   * audit note, so the downgrade is visible rather than silent.
   *
   * Now `true`. It was `false` for as long as `'shared'` was a named but
   * unimplemented branch, and it is emphatically NOT the flag that keeps
   * existing integrations on exclusive control: that is
   * `ControlLeaseEngineOptions.mode`, which still defaults to `'exclusive'`.
   * A deployment that wants shared control forbidden outright, rather than
   * merely not selected, sets this back to false.
   */
  readonly allowShared: boolean;
  /** The default {@link import('./policy.js').ControlPolicyName}. */
  readonly policy: 'exclusive';
}

/** The default {@link ControlTiming}. */
export const CONTROL_TIMING: ControlTiming = Object.freeze({
  leaseTtlMs: 60_000,
  idleExpiryMs: 30_000,
  idleReleaseMs: 20_000,
  renewWithinMs: 15_000,
  expiryWarningMs: 10_000,
  renewGraceMs: 12_000,
  disconnectGraceMs: 30_000,
  disconnectHygieneMs: 1_500,
  handoverDrainMs: 2_000,
  minHoldMs: 3_000,
  forceClaimNoticeMs: 3_000,
  agentPreemptGraceMs: 2_000,
  agentRequeueBackoffMs: 30_000,
  queueTtlMs: 120_000,
  forceClaimAfterMs: 20_000,
  inputDrainTimeoutMs: 250,
  renewOnInput: true,
  allowShared: true,
  policy: 'exclusive',
});

/**
 * Per-holder-kind clamps on a requested lease duration, applied on
 * top of {@link CONTROL_TIMING.leaseTtlMs}. `AcquireControlOptions.durationMs`
 * is the automation client's request; the server clamps it to
 * `CONTROL_HOLD_MAX_MS.agent`, so this is not a conflict with `leaseTtlMs`.
 */
export const CONTROL_HOLD_MAX_MS: Readonly<Record<'human' | 'agent', number>> = Object.freeze({
  human: 300_000,
  agent: 120_000,
});
