import { describe, expect, it } from 'vitest';
import {
  LEASE_PHASE_TRANSITIONS,
  applyLeasePhaseTransition,
} from '../../src/control/transitions.js';

/**
 * One test per row of the 18-row `LeasePhase` transition
 * table (row 18 carries two outcomes, tested separately), driven through
 * `applyLeasePhaseTransition` (which wraps `@browserglass/protocol`'s
 * shared `transition()` helper) rather than through `ControlLeaseEngine`,
 * so each row's guard behaviour is verified in isolation from the engine's
 * side effects.
 */
describe('LEASE_PHASE_TRANSITIONS: the 18-row table', () => {
  it('row 1: unheld + request, policy permits -> held', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'unheld', 'request', {
      policyPermits: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'held' });
  });

  it('row 2: unheld + request, policy is observerOnly -> unheld (denied)', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'unheld', 'request', {
      policyObserverOnly: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'unheld' });
  });

  it('row 3: held + release from holder -> handing-over', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'release', {});
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 4: held + expiryWarning -> held (no phase change)', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'expiryWarning', {});
    expect(outcome).toEqual({ kind: 'ok', to: 'held' });
  });

  it('row 5: held + idleExpired, queue non-empty -> handing-over', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'idleExpired', {
      queueNonEmpty: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 5 (guard failure): held + idleExpired, queue empty -> ignored, not thrown', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'idleExpired', {
      queueNonEmpty: false,
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'queue_non_empty' });
  });

  it('row 6: held + renewGraceExpired -> handing-over', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'renewGraceExpired', {});
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 7: held + socketClosed -> held-grace', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'socketClosed', {});
    expect(outcome).toEqual({ kind: 'ok', to: 'held-grace' });
  });

  it('row 8: held-grace + reconnected with a valid resume token -> held', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held-grace', 'reconnected', {
      validResumeToken: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'held' });
  });

  it('row 8 (guard failure): held-grace + reconnected without a valid resume token -> ignored', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held-grace', 'reconnected', {
      validResumeToken: false,
    });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'valid_resume_token' });
  });

  it('row 9: held-grace + disconnectGraceExpired -> handing-over', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held-grace', 'disconnectGraceExpired', {});
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 10: held-grace + a higher-priority request arrives -> handing-over (grace cut short)', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held-grace', 'preempted', {
      higherPriorityWaiting: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 11: held + request with priority > holder.priority -> preempt-pending', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'preempted', {
      priorityExceedsHolder: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'preempt-pending' });
  });

  it('row 12: held + request{force:true} from admin -> preempt-pending', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'preempted', {
      forceClaimByAdmin: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'preempt-pending' });
  });

  it('row 13: held + revoke from admin -> revoking', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'revoke', { isAdmin: true });
    expect(outcome).toEqual({ kind: 'ok', to: 'revoking' });
  });

  it('row 13 (guard failure): held + revoke without admin -> ignored, not thrown', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'held', 'revoke', { isAdmin: false });
    expect(outcome).toEqual({ kind: 'ignored', reason: 'is_admin' });
  });

  it('row 14: preempt-pending + holder releases -> handing-over (released:true recorded by the caller)', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'preempt-pending', 'preemptResolved', {
      holderReleased: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 15: preempt-pending + deadline passes -> handing-over (released:false recorded by the caller)', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'preempt-pending', 'preemptResolved', {
      deadlinePassed: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 16: preempt-pending + requester withdraws or disconnects -> held (grace cancelled)', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'preempt-pending', 'preemptWithdrawn', {});
    expect(outcome).toEqual({ kind: 'ok', to: 'held' });
  });

  it('row 17: revoking + queue drained -> handing-over', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'revoking', 'queueDrained', {});
    expect(outcome).toEqual({ kind: 'ok', to: 'handing-over' });
  });

  it('row 18a: handing-over + drain settles with a queue head -> held', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'handing-over', 'drainSettled', {
      hasQueueHead: true,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'held' });
  });

  it('row 18b: handing-over + drain settles with an empty queue -> unheld', () => {
    const outcome = applyLeasePhaseTransition('lse_x', 'handing-over', 'drainSettled', {
      hasQueueHead: false,
    });
    expect(outcome).toEqual({ kind: 'ok', to: 'unheld' });
  });

  it('every phase is reachable as a `from` key in the table (six phases, six or fewer rows missing is a bug)', () => {
    const phases = Object.keys(LEASE_PHASE_TRANSITIONS);
    expect(phases.sort()).toEqual(
      ['handing-over', 'held', 'held-grace', 'preempt-pending', 'revoking', 'unheld'].sort(),
    );
  });

  it('an event with no matching row from a live phase throws InvalidStateTransition, never silently ignored', () => {
    expect(() => applyLeasePhaseTransition('lse_x', 'unheld', 'release', {})).toThrow(/illegal/);
  });
});
