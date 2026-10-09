import type { ControlGranted, ErrorMsg } from '@browserglass/protocol';
import { AutomationError } from '../errors.js';
import type { ControlLeaseHandle, PreemptionRequest, RevokeReason } from '../types.js';
import type { AutomationCore } from './core.js';

/** Every automation-held lease carries this fixed priority (the per-holder-kind default: human 100, agent 50). `control.granted` carries no priority field of its own. */
export const AUTOMATION_LEASE_PRIORITY = 50;

/**
 * Concrete {@link ControlLeaseHandle}. Owned by {@link AutomationCore}, which
 * fires `firePreemptionRequested()`/`markRevoked()` as the corresponding
 * wire messages arrive; nothing outside `client/` constructs or mutates one
 * directly.
 */
export class ControlLeaseHandleImpl implements ControlLeaseHandle {
  readonly leaseId: string;
  readonly grantedAt: number;
  readonly priority = AUTOMATION_LEASE_PRIORITY;
  private _expiresAt: number;
  private readonly renewWithinMs: number;

  private readonly preemptionCbs = new Set<(req: PreemptionRequest) => void>();
  private readonly revokedCbs = new Set<(reason: RevokeReason) => void>();
  private revoked = false;
  private autoRenewTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly autoRenewWanted: boolean;

  constructor(
    private readonly core: AutomationCore,
    readonly targetId: string,
    granted: ControlGranted,
    autoRenew: boolean,
  ) {
    this.leaseId = granted.leaseId;
    this.grantedAt = Date.now();
    this._expiresAt = granted.expiresAt;
    this.renewWithinMs = granted.renewWithinMs;
    this.autoRenewWanted = autoRenew;
    if (autoRenew) this.scheduleAutoRenew();
  }

  get expiresAt(): number {
    return this._expiresAt;
  }

  /** `false` once revoked or past `expiresAt`; consulted by every interaction method before dispatch. */
  get isValid(): boolean {
    return !this.revoked && Date.now() < this._expiresAt;
  }

  onPreemptionRequested(cb: (req: PreemptionRequest) => void): () => void {
    this.preemptionCbs.add(cb);
    return () => this.preemptionCbs.delete(cb);
  }

  onRevoked(cb: (reason: RevokeReason) => void): () => void {
    this.revokedCbs.add(cb);
    return () => this.revokedCbs.delete(cb);
  }

  /**
   * Asks the gateway to extend this lease and waits for the fresh
   * `control.granted`.
   *
   * The gateway answers `control.renew` with a `control.granted` for this
   * lease that carries no `re` (the lease engine's `renew()` emits it
   * directly to the viewer, the same message any other grant uses). An
   * earlier version waited only for a reply whose `re` matched the
   * request id, so against a real gateway every renew timed out, the
   * local `expiresAt` never moved, and every verb started failing with
   * `LEASE_NOT_HELD` 30 seconds after `acquireControl()` even though the
   * server had renewed the lease. The fake gateway in the tests did echo
   * `re`, which hid it. So this accepts either: a reply correlated by
   * `re`, or a `control.granted` naming this target and lease.
   */
  async renew(ms?: number): Promise<void> {
    if (this.revoked) return;
    const id = this.core.newId();
    let abandon: (() => void) | null = null;
    const reply = this.core.awaitMessage<ControlGranted | ErrorMsg>(
      (m) =>
        m.re === id ||
        (m.t === 'control.granted' &&
          (m as ControlGranted).targetId === this.targetId &&
          (m as ControlGranted).leaseId === this.leaseId),
      this.core.defaultTimeoutMs,
      (a) => {
        abandon = a;
      },
    );
    try {
      this.core.send('control.renew', {
        id,
        targetId: this.targetId,
        leaseId: this.leaseId,
        ...(ms !== undefined ? { ttlMs: ms } : {}),
      });
    } catch (err) {
      reply.catch(() => undefined);
      (abandon as (() => void) | null)?.();
      throw err;
    }
    const msg = await reply;
    if (msg.t === 'error') throw AutomationError.fromErrorMsg(msg as ErrorMsg);
    if (msg.t === 'control.granted') this._expiresAt = (msg as ControlGranted).expiresAt;
  }

  async release(): Promise<void> {
    this.releaseNow(null);
  }

  /**
   * Releases as part of a stand-down, firing `onRevoked` with `reason` on
   * the way out.
   *
   * A plain `release()` does not fire `onRevoked`, and should not: the
   * caller asked for it and already knows. Yielding is the opposite case.
   * The lease is ending because somebody took it, the caller did not ask,
   * and it is precisely the caller that has to hear about it. Without this
   * the well-behaved client (the one that hands over early rather than
   * sitting out the grace window) was the only one whose `onRevoked` never
   * fired at all, because by the time `control.preempted` arrived it had
   * already deleted its own handle. Yielding promptly must not cost an
   * agent the notification that it was yielded.
   */
  releaseYielding(reason: RevokeReason): void {
    this.releaseNow(reason);
  }

  /** `revokeReason` non-null fires `onRevoked`; `null` is a plain caller-initiated release. Idempotent either way. */
  private releaseNow(revokeReason: RevokeReason | null): void {
    if (this.revoked) return;
    this.stopAutoRenew();
    this.core.send('control.release', { targetId: this.targetId, leaseId: this.leaseId });
    this.core.leases.delete(this.targetId);
    this.revoked = true;
    if (revokeReason !== null) for (const cb of this.revokedCbs) cb(revokeReason);
  }

  /** Called by `AutomationCore` on `control.preempt.request` for this lease's target. */
  firePreemptionRequested(req: PreemptionRequest): void {
    for (const cb of this.preemptionCbs) cb(req);
  }

  /**
   * Called by `AutomationCore` when this client stands down on this
   * lease's target. Auto-renew has to stop the moment a yield begins:
   * asking the server for MORE time on a lease a person is waiting to take
   * is the opposite of standing down, and a renewal landing inside the
   * grace window is exactly the kind of "one more message after the yield"
   * that makes a half-yielded agent worse than no yield at all. Separate
   * from `markRevoked()` because a yield's step 1 is not a revocation:
   * the lease is still live, and a withdrawn preemption puts it straight
   * back to work through `resumeAutoRenew()`.
   */
  suspendAutoRenew(): void {
    this.stopAutoRenew();
  }

  /** Called by `AutomationCore` on `control.preempt.cancelled`: the requester went away and this lease is a working lease again. A no-op when the caller never asked for auto-renew in the first place. */
  resumeAutoRenew(): void {
    if (!this.autoRenewWanted || this.revoked) return;
    this.scheduleAutoRenew();
  }

  /** Called by `AutomationCore` when this lease actually ends, for any reason. Idempotent. */
  markRevoked(reason: RevokeReason): void {
    if (this.revoked) return;
    this.revoked = true;
    this.stopAutoRenew();
    for (const cb of this.revokedCbs) cb(reason);
  }

  private scheduleAutoRenew(): void {
    this.stopAutoRenew();
    if (this.revoked) return;
    const delay = Math.max(1000, this._expiresAt - Date.now() - this.renewWithinMs);
    this.autoRenewTimer = setTimeout(() => {
      if (this.revoked) return;
      this.renew()
        .catch(() => {
          // a failed renew (lease already gone, network hiccup) is surfaced
          // through the normal control.revoked/preempted path, not thrown
          // out of a background timer
        })
        .finally(() => this.scheduleAutoRenew());
    }, delay);
    this.autoRenewTimer.unref?.();
  }

  private stopAutoRenew(): void {
    if (this.autoRenewTimer) clearTimeout(this.autoRenewTimer);
    this.autoRenewTimer = null;
  }
}
