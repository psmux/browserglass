/**
 * Regression coverage for the browser-process leak reported against the
 * nextjs-demo gateway: releasing an instance under concurrent load reliably
 * reported `outcome: 'terminated'` while the Chrome process it launched
 * kept running forever.
 *
 * Two distinct defects, both in `src/terminate.ts`'s step 5 (the final
 * "confirm the process is actually gone" check), fixed one after the
 * other against the same symptom:
 *
 * 1. A process still alive after the whole terminate ladder only got a
 *    string pushed onto `TerminateResult.warnings`, and the call still
 *    RESOLVED normally. `BrowserRouter.release()` never inspected
 *    `warnings`, only whether the call threw, so it always reported
 *    `outcome: 'terminated'`. Fixed by throwing instead of returning a
 *    "successful" result with a buried warning. The first `describe`
 *    block below covers this, against the plain `pid` liveness check
 *    (`opts.profilePath: null`).
 *
 * 2. Even with that fix landed, the leak persisted under real concurrent
 *    load: the pid this ladder is handed is not reliably the process that
 *    ends up holding the profile directory. Chrome's own Windows launch
 *    sequence can hand off from the process this code spawned to a
 *    second, distinct process, and when that handoff races
 *    `killProcessTree`'s own process-tree snapshot, the second process is
 *    simply absent from it, survives untouched, and is orphaned the
 *    moment its parent dies. `pidAlive(pid)` truthfully confirms `pid` is
 *    gone; it has nothing to say about the orphan. `ProfileService`'s own
 *    independent scan (keyed on the user-data-dir, not a remembered pid)
 *    kept finding a live Chrome moments after this ladder reported
 *    success. Fixed by making step 5's confirmation, when a profile path
 *    is known, ask the same question that scan asks: rescan-and-kill by
 *    user-data-dir until nothing is left. The second `describe` block
 *    below covers this.
 *
 * Both suites exercise `terminateBrowser` directly with `pidAlive`,
 * `chromeProcsForDataDirAsync`, and `killProcessTree` mocked, so they can
 * force each failure shape deterministically, without depending on a real
 * Chrome process actually surviving a kill (which is exactly the flaky,
 * load-dependent condition that let both bugs hide for so long).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChromeProcessInfo } from '../src/process-table.js';

const pidAliveMock = vi.fn<(pid: number) => boolean>();
const killProcessTreeMock = vi.fn<(pid: number, signal?: NodeJS.Signals) => void>();
const chromeProcsForDataDirAsyncMock =
  vi.fn<(dataDir: string, opts?: { maxAgeMs?: number }) => Promise<ChromeProcessInfo[]>>();

vi.mock('../src/process-table.js', () => ({
  pidAlive: (pid: number) => pidAliveMock(pid),
  chromeProcsForDataDirAsync: (dataDir: string, opts?: { maxAgeMs?: number }) =>
    chromeProcsForDataDirAsyncMock(dataDir, opts),
}));
vi.mock('../src/spawn.js', () => ({
  killProcessTree: (pid: number, signal?: NodeJS.Signals) => killProcessTreeMock(pid, signal),
}));

const { terminateBrowser } = await import('../src/terminate.js');

afterEach(() => {
  pidAliveMock.mockReset();
  killProcessTreeMock.mockReset();
  chromeProcsForDataDirAsyncMock.mockReset();
});

function baseOpts(overrides: Partial<Parameters<typeof terminateBrowser>[0]> = {}) {
  return {
    pid: 4242,
    cdpWsUrl: null,
    mode: 'force' as const,
    cdpCloseTimeoutMs: 1000,
    gracePeriodMs: 50,
    profilePath: null as string | null,
    stopSupervision: vi.fn(),
    ...overrides,
  };
}

describe('terminateBrowser: the ladder must not report success for a process it never actually killed (pid check)', () => {
  it('throws, and never calls stopSupervision, when the process is still alive after every step of the ladder', async () => {
    // The process never dies no matter how many times something tries to
    // kill it: exactly the shape a `taskkill`/signal that silently failed
    // (or never got to run before the load-bearing timeout swallowed it,
    // see `spawn.ts`'s `killProcessTree`) leaves behind.
    pidAliveMock.mockReturnValue(true);
    const opts = baseOpts({ mode: 'force', profilePath: null });

    await expect(terminateBrowser(opts)).rejects.toThrow(/still reports alive/);

    expect(opts.stopSupervision).not.toHaveBeenCalled();
  }, 10_000);

  it('resolves normally, and stops supervision, once the process is confirmed dead', async () => {
    // Alive for the first two checks, then gone: a real (if fast) kill.
    let calls = 0;
    pidAliveMock.mockImplementation(() => {
      calls += 1;
      return calls <= 2;
    });
    const opts = baseOpts({ mode: 'force', profilePath: null });

    const result = await terminateBrowser(opts);

    expect(result.effective).toBe('force');
    expect(opts.stopSupervision).toHaveBeenCalledTimes(1);
  });

  it('escalating from graceful to force still throws (never reports terminated) if the process survives both', async () => {
    pidAliveMock.mockReturnValue(true);
    const opts = baseOpts({ mode: 'graceful', profilePath: null });

    await expect(terminateBrowser(opts)).rejects.toThrow(/still reports alive/);
    // Windows always collapses graceful straight to a kill attempt; either
    // platform's ladder must have actually tried before giving up.
    expect(killProcessTreeMock).toHaveBeenCalled();
  }, 10_000);
});

function straggler(pid: number): ChromeProcessInfo {
  return { pid, ppid: 1, commandLine: `"C:\\chrome.exe" --user-data-dir=C:\\fake\\profile` };
}

describe('terminateBrowser: the supervised pid is not reliably the process holding the profile directory', () => {
  it('kills and clears an orphaned browser process the pid-tree kill never enumerated', async () => {
    // The supervised pid dies immediately (a real, successful kill), but a
    // second, distinct process is still found holding the profile
    // directory on the first scan: exactly the handoff-raced-the-snapshot
    // shape the coordinator's pid-tree evidence showed (parent gone,
    // orphan still alive). The second scan (after this ladder kills it)
    // comes back clean.
    // The orphan is alive until something kills it; the confirm loop
    // cross checks every scan result against `pidAlive`.
    let orphanAlive = true;
    pidAliveMock.mockImplementation((pid) => pid === 9999 && orphanAlive);
    killProcessTreeMock.mockImplementation((pid) => {
      if (pid === 9999) orphanAlive = false;
    });
    let scanCalls = 0;
    chromeProcsForDataDirAsyncMock.mockImplementation(async () => {
      scanCalls += 1;
      return scanCalls === 1 ? [straggler(9999)] : [];
    });
    const opts = baseOpts({ mode: 'force', profilePath: 'C:\\fake\\profile' });

    const result = await terminateBrowser(opts);

    expect(result.effective).toBe('force');
    expect(killProcessTreeMock).toHaveBeenCalledWith(9999, 'SIGKILL');
    expect(opts.stopSupervision).toHaveBeenCalledTimes(1);
    expect(chromeProcsForDataDirAsyncMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('throws, and never calls stopSupervision, when a process keeps holding the profile directory past the scan budget', async () => {
    // The supervised pid is gone, the straggler never dies.
    pidAliveMock.mockImplementation((pid) => pid === 9999);
    // Every scan finds the same straggler still there: the profile
    // directory is never actually cleared within the budget.
    chromeProcsForDataDirAsyncMock.mockImplementation(async () => [straggler(9999)]);
    const opts = baseOpts({ mode: 'force', profilePath: 'C:\\fake\\profile' });

    await expect(terminateBrowser(opts)).rejects.toThrow(/still holds profile/);

    expect(opts.stopSupervision).not.toHaveBeenCalled();
    // It must have kept trying to kill the straggler, not given up silently.
    expect(killProcessTreeMock).toHaveBeenCalledWith(9999, 'SIGKILL');
    // This test's own wall-clock allowance, not a padding-out-flakiness
    // workaround: with mocked scans resolving instantly, this loop's real
    // duration is entirely `PROFILE_CLEAR_BUDGET_MS` (terminate.ts), which
    // a real machine-load measurement raised from 5000ms to 15000ms (see
    // that constant's own doc). This test's timeout has to stay above
    // whatever that constant is, or it fails on a change to production
    // behaviour it never actually asserts on.
  }, 20_000);

  it('falls back to the plain pid check when no profile path is known', async () => {
    pidAliveMock.mockReturnValue(false);
    const opts = baseOpts({ mode: 'force', profilePath: null });

    const result = await terminateBrowser(opts);

    expect(result.effective).toBe('force');
    expect(chromeProcsForDataDirAsyncMock).not.toHaveBeenCalled();
  });
});
