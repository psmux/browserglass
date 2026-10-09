import { describe, expect, it } from 'vitest';
import { CRASH_BUDGET_WINDOW_MS, CrashBudget } from '../../src/recovery/crash-budget.js';

describe('CrashBudget', () => {
  it('escalates through plain, blank_url, quarantine_profile, then exceeds', () => {
    const budget = new CrashBudget();
    const r1 = budget.recordCrash('t1', 0);
    expect(r1).toEqual({ attempt: 1, condition: 'plain', exceeded: false, triedSoFar: ['plain'] });
    const r2 = budget.recordCrash('t1', 1000);
    expect(r2).toEqual({
      attempt: 2,
      condition: 'blank_url',
      exceeded: false,
      triedSoFar: ['plain', 'blank_url'],
    });
    const r3 = budget.recordCrash('t1', 2000);
    expect(r3).toEqual({
      attempt: 3,
      condition: 'quarantine_profile',
      exceeded: false,
      triedSoFar: ['plain', 'blank_url', 'quarantine_profile'],
    });
    const r4 = budget.recordCrash('t1', 3000);
    expect(r4.exceeded).toBe(true);
    expect(r4.triedSoFar).toEqual(['plain', 'blank_url', 'quarantine_profile']);
  });

  it('prunes attempts outside the sliding window, resetting the escalation', () => {
    const budget = new CrashBudget();
    budget.recordCrash('t1', 0);
    budget.recordCrash('t1', 1000);
    budget.recordCrash('t1', 2000);
    // Well past the ten minute window: the first three attempts age out.
    const r = budget.recordCrash('t1', CRASH_BUDGET_WINDOW_MS + 3000 + 1);
    expect(r.exceeded).toBe(false);
    expect(r.condition).toBe('plain');
  });

  it('tracks independent keys independently', () => {
    const budget = new CrashBudget();
    budget.recordCrash('t1', 0);
    budget.recordCrash('t1', 0);
    budget.recordCrash('t1', 0);
    const other = budget.recordCrash('t2', 0);
    expect(other.attempt).toBe(1);
    expect(other.exceeded).toBe(false);
  });

  it('reset() clears a key entirely', () => {
    const budget = new CrashBudget();
    budget.recordCrash('t1', 0);
    budget.recordCrash('t1', 0);
    budget.recordCrash('t1', 0);
    budget.reset('t1');
    const r = budget.recordCrash('t1', 0);
    expect(r).toEqual({ attempt: 1, condition: 'plain', exceeded: false, triedSoFar: ['plain'] });
  });

  it('a custom window/maxAttempts is honoured', () => {
    const budget = new CrashBudget(1000, 1);
    const r1 = budget.recordCrash('t1', 0);
    expect(r1.exceeded).toBe(false);
    const r2 = budget.recordCrash('t1', 500);
    expect(r2.exceeded).toBe(true);
    const r3 = budget.recordCrash('t1', 1501); // outside the 1000ms window from the first attempt.
    expect(r3.exceeded).toBe(false);
  });
});
