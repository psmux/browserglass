import { describe, expect, it, vi } from 'vitest';
import { BrowserSupervisor, StderrRingBuffer } from '../src/supervisor.js';

describe('StderrRingBuffer', () => {
  it('keeps only the trailing maxBytes once the buffer grows past it', () => {
    const ring = new StderrRingBuffer(10);
    ring.push('0123456789');
    ring.push('abcde');
    expect(ring.contents).toBe('56789abcde');
    expect(ring.contents.length).toBe(10);
  });

  it('detects a GPU init failure phrase', () => {
    const ring = new StderrRingBuffer();
    ring.push('some noise\n');
    expect(ring.looksLikeGpuInitFailure()).toBe(false);
    ring.push("[ERROR] GPU process isn't usable, disabling.\n");
    expect(ring.looksLikeGpuInitFailure()).toBe(true);
  });
});

describe('BrowserSupervisor, poll-based liveness (not the ChildProcess exit event)', () => {
  it('fires onExit only after unhealthyProbes consecutive dead readings, using a pid that never existed', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    // A pid essentially guaranteed not to exist, standing in for "the
    // browser is gone" without needing a real dead process to reference.
    const deadPid = 2_000_000_000;
    const supervisor = new BrowserSupervisor({
      instanceId: 'inst_test',
      pid: deadPid,
      statsIntervalMs: 10,
      unhealthyProbes: 3,
      onExit,
    });
    supervisor.start();

    await vi.advanceTimersByTimeAsync(10);
    expect(onExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(onExit).toHaveBeenCalledTimes(1);

    // Never fires twice, and stop() after firing is a safe no-op.
    await vi.advanceTimersByTimeAsync(50);
    expect(onExit).toHaveBeenCalledTimes(1);
    supervisor.stop();
    vi.useRealTimers();
  });

  it('stop() before any exit never fires onExit, and does not touch the process itself', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const supervisor = new BrowserSupervisor({
      instanceId: 'inst_test',
      pid: 2_000_000_001,
      statsIntervalMs: 10,
      unhealthyProbes: 3,
      onExit,
    });
    supervisor.start();
    await vi.advanceTimersByTimeAsync(10);
    supervisor.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(onExit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
