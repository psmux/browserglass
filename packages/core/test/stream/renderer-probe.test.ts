import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../src/control/clock.js';
import {
  CONFIRM_ATTEMPTS,
  FAIL_STREAK_THRESHOLD,
  RendererProbe,
} from '../../src/stream/renderer-probe.js';

describe('RendererProbe.recordFailure', () => {
  it('only a literal "timeout" message while not loading advances the streak', () => {
    const probe = new RendererProbe({ targetId: 'tgt_1' });
    expect(probe.recordFailure(new Error('some other error'), false)).toBe(false);
    expect(probe.streak).toBe(0);
    expect(probe.recordFailure(new Error('timeout'), true)).toBe(false); // loading: never counts
    expect(probe.streak).toBe(0);
    expect(probe.recordFailure(new Error('timeout'), false)).toBe(false);
    expect(probe.streak).toBe(1);
  });

  it('confirms hung only after FAIL_STREAK_THRESHOLD consecutive counted timeouts', () => {
    const probe = new RendererProbe({ targetId: 'tgt_1' });
    let confirmDue = false;
    for (let i = 0; i < FAIL_STREAK_THRESHOLD; i += 1) {
      confirmDue = probe.recordFailure(new Error('timeout'), false);
    }
    expect(confirmDue).toBe(true);
    expect(probe.streak).toBe(FAIL_STREAK_THRESHOLD);
  });

  it('a non-timeout failure resets the streak (a closed page during tab switch must not count)', () => {
    const probe = new RendererProbe({ targetId: 'tgt_1' });
    probe.recordFailure(new Error('timeout'), false);
    probe.recordFailure(new Error('timeout'), false);
    probe.recordFailure(new Error('target closed'), false);
    expect(probe.streak).toBe(0);
  });
});

describe('RendererProbe.confirmHung', () => {
  it('a renderer that answers the first evaluate is not hung, and the streak resets', async () => {
    const probe = new RendererProbe({ targetId: 'tgt_1', clock: new ManualClock(0) });
    probe.recordFailure(new Error('timeout'), false);
    probe.recordFailure(new Error('timeout'), false);
    const hung = await probe.confirmHung(() => Promise.resolve('1'));
    expect(hung).toBe(false);
    expect(probe.streak).toBe(0);
  });

  it('a renderer that answers neither of two attempts is confirmed hung', async () => {
    const clock = new ManualClock(0);
    const probe = new RendererProbe({ targetId: 'tgt_1', clock });
    let calls = 0;
    const neverResolves = () =>
      new Promise<unknown>(() => {
        calls += 1;
      });
    const confirmPromise = probe.confirmHung(neverResolves);
    // Drive the clock through both 2500ms timeouts plus the 500ms gap.
    await clock.advance(2500);
    await clock.advance(500);
    await clock.advance(2500);
    const hung = await confirmPromise;
    expect(hung).toBe(true);
    expect(calls).toBe(CONFIRM_ATTEMPTS);
  });
});
