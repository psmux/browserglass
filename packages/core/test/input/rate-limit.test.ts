import { describe, expect, it } from 'vitest';
import {
  CriticalStarvationTracker,
  RATE_DEFAULTS,
  admit,
  classifyAdmission,
  createTokenBucket,
} from '../../src/input/rate-limit.js';

describe('classifyAdmission', () => {
  it('classifies mouse move, mouse wheel, and touch move as droppable', () => {
    expect(classifyAdmission('mouse.move')).toBe('droppable');
    expect(classifyAdmission('mouse.wheel')).toBe('droppable');
    expect(classifyAdmission('touch.move')).toBe('droppable');
  });
  it('classifies drag.over as droppable too: a drag produces a lot of these, same as a mouse move', () => {
    expect(classifyAdmission('drag.over')).toBe('droppable');
  });
  it('classifies the release class (up, end, cancel) as exempt, not merely critical', () => {
    expect(classifyAdmission('mouse.up')).toBe('exempt');
    expect(classifyAdmission('key.up')).toBe('exempt');
    expect(classifyAdmission('touch.end')).toBe('exempt');
    expect(classifyAdmission('touch.cancel')).toBe('exempt');
  });
  it('classifies drag.drop and drag.leave as exempt too, matching how mouse.up is already treated', () => {
    expect(classifyAdmission('drag.drop')).toBe('exempt');
    expect(classifyAdmission('drag.leave')).toBe('exempt');
  });
  it('classifies down, key.down, key.char, touch.start, drag.enter, and other as critical', () => {
    expect(classifyAdmission('mouse.down')).toBe('critical');
    expect(classifyAdmission('key.down')).toBe('critical');
    expect(classifyAdmission('key.char')).toBe('critical');
    expect(classifyAdmission('touch.start')).toBe('critical');
    expect(classifyAdmission('drag.enter')).toBe('critical');
    expect(classifyAdmission('other')).toBe('critical');
  });
});

describe('admit / token bucket', () => {
  it('droppable may not dip below reserveTokens (60): once the bucket reaches the reserve, further moves are denied', () => {
    const rate = 300;
    const bucket = createTokenBucket(rate, 0);
    // Drain the bucket from 300 down toward the reserve, one droppable admit at a time, no time passing.
    let admittedCount = 0;
    for (let i = 0; i < 300; i++) {
      if (admit(bucket, 'droppable', rate, RATE_DEFAULTS.reserveTokens, 0)) {
        admittedCount += 1;
      } else {
        break;
      }
    }
    // 300 - 60 = 240 droppable events fit before the reserve floor is hit.
    expect(admittedCount).toBe(240);
    expect(bucket.tokens).toBeCloseTo(RATE_DEFAULTS.reserveTokens, 5);
    expect(admit(bucket, 'droppable', rate, RATE_DEFAULTS.reserveTokens, 0)).toBe(false);
  });

  it('critical may dip all the way to zero, past the droppable reserve', () => {
    const rate = 300;
    const bucket = createTokenBucket(rate, 0);
    bucket.tokens = RATE_DEFAULTS.reserveTokens; // at the droppable floor already
    expect(admit(bucket, 'droppable', rate, RATE_DEFAULTS.reserveTokens, 0)).toBe(false);
    expect(admit(bucket, 'critical', rate, RATE_DEFAULTS.reserveTokens, 0)).toBe(true);
  });

  it('refills over elapsed time, capped at the configured rate (one second of burst)', () => {
    const rate = 300;
    const bucket = createTokenBucket(rate, 0);
    bucket.tokens = 0;
    expect(admit(bucket, 'critical', rate, RATE_DEFAULTS.reserveTokens, 500)).toBe(true); // 500ms * 300/s = 150 tokens refilled
    expect(bucket.tokens).toBeCloseTo(149, 0);
    // Refilling for a very long time never exceeds the rate cap.
    bucket.tokens = 0;
    admit(bucket, 'critical', rate, RATE_DEFAULTS.reserveTokens, 100_000);
    expect(bucket.tokens).toBeLessThanOrEqual(rate);
  });
});

describe('CriticalStarvationTracker', () => {
  it('does not escalate before criticalOverrunMs of continuous denial', () => {
    const tracker = new CriticalStarvationTracker();
    expect(tracker.note(false, 0, 10_000)).toBe('ok');
    expect(tracker.note(false, 9_999, 10_000)).toBe('ok');
  });

  it('escalates exactly once when the continuous denial streak reaches criticalOverrunMs (10s)', () => {
    const tracker = new CriticalStarvationTracker();
    tracker.note(false, 0, 10_000);
    expect(tracker.note(false, 10_000, 10_000)).toBe('escalate');
    // Continuing to deny does not escalate again until reset by an admission.
    expect(tracker.note(false, 10_001, 10_000)).toBe('ok');
  });

  it('resets the streak the moment an event is admitted', () => {
    const tracker = new CriticalStarvationTracker();
    tracker.note(false, 0, 10_000);
    tracker.note(true, 5_000, 10_000);
    expect(tracker.note(false, 14_999, 10_000)).toBe('ok'); // streak restarted at 5000, not the original 0
  });
});
