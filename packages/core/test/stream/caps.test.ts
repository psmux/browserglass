import { BglsError } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_STREAMS_PER_INSTANCE, InstanceStreamCounter } from '../../src/stream/caps.js';

describe('InstanceStreamCounter', () => {
  it('defaults to a cap of 8, a resource guard now that per-window isolation lets several targets stream at once', () => {
    expect(DEFAULT_MAX_STREAMS_PER_INSTANCE).toBe(8);
  });

  it('allows up to the cap and throws a typed E_STREAM_LIMIT past it', () => {
    const counter = new InstanceStreamCounter({ maxStreamsPerInstance: 2 });
    const instanceId = 'inst_1' as never;
    counter.acquire(instanceId);
    counter.acquire(instanceId);
    expect(() => counter.acquire(instanceId)).toThrow(BglsError);
    try {
      counter.acquire(instanceId);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BglsError);
      const bgls = err as BglsError;
      expect(bgls.code).toBe('E_STREAM_LIMIT');
      expect(bgls.context).toEqual({ instanceId, current: 2, cap: 2 });
    }
  });

  it('release decrements, permitting another acquire', () => {
    const counter = new InstanceStreamCounter({ maxStreamsPerInstance: 1 });
    const instanceId = 'inst_1' as never;
    counter.acquire(instanceId);
    expect(() => counter.acquire(instanceId)).toThrow(BglsError);
    counter.release(instanceId);
    expect(() => counter.acquire(instanceId)).not.toThrow();
  });

  it('tracks caps independently per instance', () => {
    const counter = new InstanceStreamCounter({ maxStreamsPerInstance: 1 });
    const a = 'inst_a' as never;
    const b = 'inst_b' as never;
    counter.acquire(a);
    expect(() => counter.acquire(b)).not.toThrow();
    expect(() => counter.acquire(a)).toThrow(BglsError);
  });
});
