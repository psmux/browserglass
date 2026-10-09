import { describe, expect, it } from 'vitest';
import { SingleFlight, targetFlightKey } from '../../src/recovery/single-flight.js';

describe('SingleFlight', () => {
  it('a lone caller runs and reports "ran"', async () => {
    const flight = new SingleFlight<string>();
    let ran = 0;
    const outcome = await flight.run('k', async () => {
      ran += 1;
    });
    expect(outcome).toBe('ran');
    expect(ran).toBe(1);
    expect(flight.isRunning('k')).toBe(false);
  });

  it('a second concurrent caller for the same key coalesces and reports "waited", running fn only once', async () => {
    const flight = new SingleFlight<string>();
    let runs = 0;
    let resolveFirst!: () => void;
    const first = flight.run(
      'k',
      () =>
        new Promise<void>((resolve) => {
          runs += 1;
          resolveFirst = resolve;
        }),
    );
    await Promise.resolve();
    expect(flight.isRunning('k')).toBe(true);
    const second = flight.run('k', async () => {
      runs += 1;
    });
    resolveFirst();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe('ran');
    expect(b).toBe('waited');
    expect(runs).toBe(1);
  });

  it('a waiting caller does not throw even if the in-flight run rejects', async () => {
    const flight = new SingleFlight<string>();
    let rejectFirst!: (e: Error) => void;
    const first = flight.run(
      'k',
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        }),
    );
    await Promise.resolve();
    const second = flight.run('k', async () => {});
    rejectFirst(new Error('boom'));
    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('waited');
  });

  it('different keys run independently and concurrently', async () => {
    const flight = new SingleFlight<string>();
    let concurrentRuns = 0;
    let maxConcurrent = 0;
    const run = () =>
      flight.run(Math.random().toString(), async () => {
        concurrentRuns += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrentRuns);
        await Promise.resolve();
        concurrentRuns -= 1;
      });
    await Promise.all([run(), run(), run()]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it('targetFlightKey composes a stable, distinct key per (instanceId, targetId)', () => {
    expect(targetFlightKey('inst_1', 'tgt_1')).toBe('inst_1:tgt_1');
    expect(targetFlightKey('inst_1', 'tgt_1')).not.toBe(targetFlightKey('inst_2', 'tgt_1'));
    expect(targetFlightKey('inst_1', 'tgt_1')).not.toBe(targetFlightKey('inst_1', 'tgt_2'));
  });
});
