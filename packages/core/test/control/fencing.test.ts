import { describe, expect, it } from 'vitest';
import { resolveInputFencing } from '../../src/control/fencing.js';
import type { Lease } from '../../src/control/types.js';

/**
 * A minimal fake lease. `holderViewerId`/`leaseId` describe the ONE holder
 * of an exclusive lease, which is what every case below is about; the
 * shared-mode cases at the bottom of this file build `holders` directly.
 */
function leaseWith(overrides: {
  leaseId?: string | null;
  phase?: Lease['phase'];
  holderViewerId?: string | null;
}) {
  const leaseId = overrides.leaseId === undefined ? 'lse_current' : overrides.leaseId;
  const holders =
    overrides.holderViewerId && leaseId
      ? [{ leaseId, viewerId: overrides.holderViewerId, connected: true }]
      : [];
  return {
    phase: overrides.phase ?? 'held',
    holders,
  } as const;
}

describe('resolveInputFencing', () => {
  it('dispatches, attributed to the holder, when the leaseId is current and the phase is held', () => {
    const lease = leaseWith({ leaseId: 'lse_1', phase: 'held', holderViewerId: 'vwr_alice' });
    const decision = resolveInputFencing(lease, {
      viewerId: 'vwr_alice',
      leaseId: 'lse_1',
      kind: 'mouse.down',
    });
    expect(decision).toEqual({ dispatch: true, attributedTo: 'vwr_alice', reason: 'current' });
  });

  it('dispatches during preempt-pending too: the holder still drives through the grace', () => {
    const lease = leaseWith({
      leaseId: 'lse_1',
      phase: 'preempt-pending',
      holderViewerId: 'vwr_alice',
    });
    const decision = resolveInputFencing(lease, {
      viewerId: 'vwr_alice',
      leaseId: 'lse_1',
      kind: 'mouse.move',
    });
    expect(decision.dispatch).toBe(true);
  });

  it('a stale leaseId on mouse.down does NOT dispatch', () => {
    const lease = leaseWith({ leaseId: 'lse_2', phase: 'held', holderViewerId: 'vwr_bob' });
    const decision = resolveInputFencing(lease, {
      viewerId: 'vwr_alice',
      leaseId: 'lse_1',
      kind: 'mouse.down',
    });
    expect(decision).toEqual({ dispatch: false, attributedTo: null, reason: 'stale_lease' });
  });

  it('a stale leaseId on mouse.up DOES dispatch anyway, attributed to the previous holder when known', () => {
    const lease = leaseWith({ leaseId: 'lse_2', phase: 'held', holderViewerId: 'vwr_bob' });
    const decision = resolveInputFencing(
      lease,
      { viewerId: 'vwr_alice', leaseId: 'lse_1', kind: 'mouse.up' },
      { lastHolderViewerId: 'vwr_alice' },
    );
    expect(decision).toEqual({ dispatch: true, attributedTo: 'vwr_alice', reason: 'stale_lease' });
  });

  it('a stale leaseId on key.up, touch.end, and touch.cancel all dispatch anyway', () => {
    const lease = leaseWith({ leaseId: 'lse_2', phase: 'held', holderViewerId: 'vwr_bob' });
    for (const kind of ['key.up', 'touch.end', 'touch.cancel'] as const) {
      const decision = resolveInputFencing(lease, {
        viewerId: 'vwr_alice',
        leaseId: 'lse_1',
        kind,
      });
      expect(decision.dispatch, `${kind} should dispatch despite a stale leaseId`).toBe(true);
    }
  });

  it('a stale leaseId on key.down does NOT dispatch (only the release class is exempt)', () => {
    const lease = leaseWith({ leaseId: 'lse_2', phase: 'held', holderViewerId: 'vwr_bob' });
    const decision = resolveInputFencing(lease, {
      viewerId: 'vwr_alice',
      leaseId: 'lse_1',
      kind: 'key.down',
    });
    expect(decision.dispatch).toBe(false);
  });

  it('an unheld target (no lease at all): mouse.up still dispatches, mouse.down does not', () => {
    const lease = leaseWith({ leaseId: null, phase: 'unheld' });
    expect(
      resolveInputFencing(lease, { viewerId: 'vwr_x', leaseId: 'lse_anything', kind: 'mouse.up' })
        .dispatch,
    ).toBe(true);
    expect(
      resolveInputFencing(lease, { viewerId: 'vwr_x', leaseId: 'lse_anything', kind: 'mouse.down' })
        .dispatch,
    ).toBe(false);
  });

  it('handing-over does not dispatch ordinary input even with the still-current leaseId (the previous holder is fenced off immediately)', () => {
    const lease = leaseWith({
      leaseId: 'lse_1',
      phase: 'handing-over',
      holderViewerId: 'vwr_alice',
    });
    const decision = resolveInputFencing(lease, {
      viewerId: 'vwr_alice',
      leaseId: 'lse_1',
      kind: 'mouse.move',
    });
    expect(decision.dispatch).toBe(false);
  });

  it('does not extend or restore the lease: attributedTo is informational only, no lease field is mutated', () => {
    const lease = leaseWith({ leaseId: 'lse_2', phase: 'held', holderViewerId: 'vwr_bob' });
    const before = { ...lease };
    resolveInputFencing(lease, { viewerId: 'vwr_alice', leaseId: 'lse_1', kind: 'mouse.up' });
    expect(lease).toEqual(before);
  });
});
