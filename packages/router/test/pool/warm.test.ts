import type { WarmPolicy } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { RateEwma, ValueEwma } from '../../src/pool/ewma.js';
import { desiredWarmCount } from '../../src/pool/warm.js';
import { createFakeClock } from '../support/fakeClock.js';

const WARM: WarmPolicy = {
  min: 1,
  max: 5,
  maxIdleMs: 300_000,
  minAcquiresPerMinute: 2,
  allowPersistentAdoption: false,
};

describe('desiredWarmCount', () => {
  it('suppresses warming entirely below minAcquiresPerMinute, ignoring warm.min', () => {
    // arrivalRatePerSec so low that arrivalPerMinute < 2
    expect(desiredWarmCount(WARM, 0.01, 5, 1.5)).toBe(0);
  });

  it('clamps to warm.min when the formula would suggest fewer', () => {
    // Above the suppression gate, but ceil(arrivalRate*coldLaunch*safety) < min
    const result = desiredWarmCount(WARM, 0.05, 1, 1.5); // 0.05*60=3/min, passes gate; raw = ceil(0.075)=1
    expect(result).toBe(WARM.min);
  });

  it('clamps to warm.max when the formula would suggest more', () => {
    const result = desiredWarmCount(WARM, 1, 30, 1.5); // huge raw value
    expect(result).toBe(WARM.max);
  });

  it('floors meanColdLaunchSec at 0.5 and caps at 30', () => {
    const low = desiredWarmCount(WARM, 0.1, 0.001, 1.5); // arrivalPerMinute=6
    const flooredAt05 = desiredWarmCount(WARM, 0.1, 0.5, 1.5);
    expect(low).toBe(flooredAt05);
  });
});

describe('RateEwma', () => {
  it('reports 0 before a second arrival', () => {
    const clock = createFakeClock();
    const ewma = new RateEwma(300_000);
    ewma.recordArrival(clock.now());
    expect(ewma.ratePerSec()).toBe(0);
  });

  it('estimates roughly 1 event/sec for arrivals 1000ms apart, freshly seeded', () => {
    const clock = createFakeClock();
    const ewma = new RateEwma(300_000);
    ewma.recordArrival(clock.now());
    clock.advance(1000);
    ewma.recordArrival(clock.now());
    expect(ewma.ratePerSec()).toBeCloseTo(1, 1);
  });
});

describe('ValueEwma', () => {
  it('seeds directly from the first observation', () => {
    const ewma = new ValueEwma(900_000);
    ewma.observe(0, 5);
    expect(ewma.value(0.5)).toBe(5);
  });
  it('falls back when no observation has ever been made', () => {
    const ewma = new ValueEwma(900_000);
    expect(ewma.value(0.5)).toBe(0.5);
  });
});
