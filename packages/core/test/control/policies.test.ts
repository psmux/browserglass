import { describe, expect, it } from 'vitest';
import { CONTROL_TIMING } from '../../src/control/constants.js';
import {
  ControlPolicyNotImplementedError,
  EXCLUSIVE_POLICY,
  FIRST_COME_FIRST_SERVED_POLICY,
  FREE_FOR_ALL_POLICY,
  OBSERVER_ONLY_POLICY,
  OWNER_PRIORITY_POLICY,
  type PolicyContext,
  getControlPolicy,
} from '../../src/control/policies.js';
import { type LeaseHolder, createLease } from '../../src/control/types.js';

/**
 * The single holder these EXCLUSIVE_POLICY cases put on a lease. Written
 * into `lease.holders` rather than assigned to `lease.holder`, which is now
 * derived from it (`types.ts`): the lease state being expressed is exactly
 * the same one holder it always was.
 */
function holder(overrides: Partial<LeaseHolder> = {}): LeaseHolder {
  return {
    leaseId: 'lse_holder',
    viewerId: 'vwr_holder',
    identity: 'sub:holder',
    label: 'Holder',
    kind: 'human',
    priority: 100,
    grantedAt: 0,
    lastInputAt: 0,
    lastRenewAt: 0,
    connected: true,
    graceUntil: null,
    ...overrides,
  };
}

const NOT_IMPLEMENTED_NAMES = [
  'firstComeFirstServed',
  'ownerPriority',
  'freeForAll',
  'observerOnly',
] as const;

function baseCtx(): PolicyContext {
  return {
    lease: createLease('sess_1', 'tgt_1'),
    requester: {
      viewerId: 'vwr_1',
      identity: 'sub:1',
      label: 'Alice',
      kind: 'human',
      isAdmin: false,
    },
    request: { force: false, priority: 100 },
    now: 0,
    ownerViewerIds: new Set(),
    capabilities: new Set(['control']),
    timing: CONTROL_TIMING,
  };
}

describe('getControlPolicy', () => {
  it('resolving any of the five names never throws by itself', () => {
    expect(() => getControlPolicy('exclusive')).not.toThrow();
    for (const name of NOT_IMPLEMENTED_NAMES) expect(() => getControlPolicy(name)).not.toThrow();
  });

  it('returns the singleton objects', () => {
    expect(getControlPolicy('exclusive')).toBe(EXCLUSIVE_POLICY);
    expect(getControlPolicy('firstComeFirstServed')).toBe(FIRST_COME_FIRST_SERVED_POLICY);
    expect(getControlPolicy('ownerPriority')).toBe(OWNER_PRIORITY_POLICY);
    expect(getControlPolicy('freeForAll')).toBe(FREE_FOR_ALL_POLICY);
    expect(getControlPolicy('observerOnly')).toBe(OBSERVER_ONLY_POLICY);
  });
});

describe('EXCLUSIVE_POLICY: the only implemented policy', () => {
  it('canRequest is always true, onRequestUnheld always grants', () => {
    const ctx = baseCtx();
    expect(EXCLUSIVE_POLICY.canRequest(ctx)).toBe(true);
    expect(EXCLUSIVE_POLICY.onRequestUnheld(ctx)).toBe('grant');
  });

  it('onRequestHeld queues a lower-priority requester once minHoldMs has elapsed', () => {
    const lease = createLease('sess_1', 'tgt_1');
    lease.phase = 'held';
    lease.holders = [holder()];
    const ctx: PolicyContext = {
      ...baseCtx(),
      lease,
      now: 10_000,
      request: { force: false, priority: 50 },
    };
    expect(EXCLUSIVE_POLICY.onRequestHeld(ctx)).toBe('queue');
  });

  it('onRequestHeld preempts once minHoldMs has elapsed and the requester outranks the holder', () => {
    const lease = createLease('sess_1', 'tgt_1');
    lease.phase = 'held';
    lease.holders = [holder()];
    const ctx: PolicyContext = {
      ...baseCtx(),
      lease,
      now: CONTROL_TIMING.minHoldMs + 1,
      request: { force: false, priority: 200 },
    };
    expect(EXCLUSIVE_POLICY.onRequestHeld(ctx)).toBe('preempt');
  });

  /**
   * `minHoldSatisfied`'s whole table, asserted one row per pairing INSIDE the
   * floor (one millisecond short of it), where the only thing that can decide
   * the answer is who is asking and who is holding.
   */
  describe('the minHoldMs floor is lifted for a human over an AGENT holder and for nothing else', () => {
    function contendInsideFloor(requesterKind: 'human' | 'agent', holderKind: 'human' | 'agent') {
      const lease = createLease('sess_1', 'tgt_1');
      lease.phase = 'held';
      lease.holders = [holder({ kind: holderKind, priority: holderKind === 'agent' ? 50 : 100 })];
      const base = baseCtx();
      const ctx: PolicyContext = {
        ...base,
        lease,
        requester: { ...base.requester, kind: requesterKind },
        now: CONTROL_TIMING.minHoldMs - 1,
        request: { force: false, priority: 900 },
      };
      return EXCLUSIVE_POLICY.onRequestHeld(ctx);
    }

    it('human over agent: LIFTED', () => {
      expect(contendInsideFloor('human', 'agent')).toBe('preempt');
    });

    it('human over human: kept, because a person mid drag is who the rule is for', () => {
      expect(contendInsideFloor('human', 'human')).toBe('queue');
    });

    it('agent over human: kept', () => {
      expect(contendInsideFloor('agent', 'human')).toBe('queue');
    });

    it('agent over agent: kept', () => {
      expect(contendInsideFloor('agent', 'agent')).toBe('queue');
    });

    it('lifting the floor grants no new right: an agent holder ranked above the human asking still keeps it', () => {
      const lease = createLease('sess_1', 'tgt_1');
      lease.phase = 'held';
      lease.holders = [holder({ kind: 'agent', priority: 500 })];
      const ctx: PolicyContext = {
        ...baseCtx(),
        lease,
        now: 0,
        request: { force: false, priority: 100 },
      };
      expect(EXCLUSIVE_POLICY.onRequestHeld(ctx)).toBe('queue');
    });
  });

  it('mayInject is true only for the current holder', () => {
    const lease = createLease('sess_1', 'tgt_1');
    lease.holders = [holder()];
    const holderCtx: PolicyContext = {
      ...baseCtx(),
      lease,
      requester: { ...baseCtx().requester, viewerId: 'vwr_holder' },
    };
    const otherCtx: PolicyContext = {
      ...baseCtx(),
      lease,
      requester: { ...baseCtx().requester, viewerId: 'vwr_other' },
    };
    expect(EXCLUSIVE_POLICY.mayInject(holderCtx)).toBe(true);
    expect(EXCLUSIVE_POLICY.mayInject(otherCtx)).toBe(false);
  });
});

describe('the four unshipped policies: typed, and throwing the moment any method is called', () => {
  for (const [name, policy] of [
    ['firstComeFirstServed', FIRST_COME_FIRST_SERVED_POLICY],
    ['ownerPriority', OWNER_PRIORITY_POLICY],
    ['freeForAll', FREE_FOR_ALL_POLICY],
    ['observerOnly', OBSERVER_ONLY_POLICY],
  ] as const) {
    it(`${name}: every ControlPolicy method throws ControlPolicyNotImplementedError`, () => {
      const ctx = baseCtx();
      expect(policy.name).toBe(name);
      expect(() => policy.canRequest(ctx)).toThrow(ControlPolicyNotImplementedError);
      expect(() => policy.onRequestUnheld(ctx)).toThrow(ControlPolicyNotImplementedError);
      expect(() => policy.onRequestHeld(ctx)).toThrow(ControlPolicyNotImplementedError);
      expect(() => policy.selectNext([], ctx)).toThrow(ControlPolicyNotImplementedError);
      expect(() => policy.mayInject(ctx)).toThrow(ControlPolicyNotImplementedError);
    });
  }
});
