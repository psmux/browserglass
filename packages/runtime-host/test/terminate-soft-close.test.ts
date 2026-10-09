/**
 * Step 1 of the terminate ladder: ask Chrome to close itself over CDP, and
 * wait for it to exit, before any kill.
 *
 * Chrome writes its cookie store in batches about every 30 seconds and
 * flushes the last batch only on a controlled shutdown. The ladder used to
 * send `Browser.close` for `'clean'` only, and on Windows `'graceful'`
 * went straight to `taskkill /T /F`, so a cookie set in the last half
 * minute before a release never reached a persistent profile's disk.
 * These tests pin the order: `Browser.close` first, kill only if Chrome is
 * still there once the soft budget runs out, and never ahead of it.
 *
 * The platform is forced to win32 because that is where the old behaviour
 * lost data: there is no softer signal than `taskkill` to fall back on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const pidAliveMock = vi.fn<(pid: number) => boolean>();
const killProcessTreeMock = vi.fn<(pid: number, signal?: NodeJS.Signals) => Promise<void>>();
const sendBrowserCloseMock = vi.fn<(url: string, timeoutMs: number) => Promise<void>>();
const order: string[] = [];

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, platform: () => 'win32' };
});
vi.mock('../src/process-table.js', () => ({
  pidAlive: (pid: number) => pidAliveMock(pid),
  chromeProcsForDataDirAsync: async () => [],
}));
vi.mock('../src/spawn.js', () => ({
  killProcessTree: (pid: number, signal?: NodeJS.Signals) => {
    order.push('kill');
    return killProcessTreeMock(pid, signal);
  },
}));
vi.mock('../src/cdp-close.js', () => ({
  sendBrowserClose: (url: string, timeoutMs: number) => {
    order.push('Browser.close');
    return sendBrowserCloseMock(url, timeoutMs);
  },
}));

const { terminateBrowser, softCloseBudgetMs } = await import('../src/terminate.js');

afterEach(() => {
  pidAliveMock.mockReset();
  killProcessTreeMock.mockReset();
  sendBrowserCloseMock.mockReset();
  order.length = 0;
});

function opts(overrides: Partial<Parameters<typeof terminateBrowser>[0]> = {}) {
  return {
    pid: 4242,
    cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/x',
    mode: 'graceful' as const,
    cdpCloseTimeoutMs: 3000,
    gracePeriodMs: 1000,
    profilePath: 'C:\\profiles\\p1\\udd',
    stopSupervision: vi.fn(),
    ...overrides,
  };
}

describe('terminateBrowser step 1: Browser.close before any kill', () => {
  it('a graceful terminate asks Chrome to close and kills nothing when it exits by itself', async () => {
    let closed = false;
    sendBrowserCloseMock.mockImplementation(async () => {
      // Chrome acknowledges, then takes a moment to write its stores and exit.
      setTimeout(() => {
        closed = true;
      }, 150);
    });
    pidAliveMock.mockImplementation(() => !closed);
    killProcessTreeMock.mockResolvedValue(undefined);

    const result = await terminateBrowser(opts());

    expect(order).toEqual(['Browser.close']);
    expect(result.effective).toBe('graceful');
    expect(result.warnings).toEqual([]);
  });

  it('still kills, after the soft budget, a Chrome that ignores Browser.close', async () => {
    sendBrowserCloseMock.mockResolvedValue(undefined);
    let killed = false;
    pidAliveMock.mockImplementation(() => !killed);
    killProcessTreeMock.mockImplementation(async () => {
      killed = true;
    });

    const started = Date.now();
    const result = await terminateBrowser(opts({ gracePeriodMs: 900 }));

    expect(order).toEqual(['Browser.close', 'kill']);
    // The soft budget here is 900 - 500 = 400 ms; the kill waited it out.
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(result.effective).toBe('force');
  });

  it("'force' skips Browser.close entirely", async () => {
    let killed = false;
    pidAliveMock.mockImplementation(() => !killed);
    killProcessTreeMock.mockImplementation(async () => {
      killed = true;
    });

    await terminateBrowser(opts({ mode: 'force' }));

    expect(sendBrowserCloseMock).not.toHaveBeenCalled();
    expect(order).toEqual(['kill']);
  });

  it('keeps the soft close inside the caller grace period', () => {
    expect(softCloseBudgetMs(3000, 3000)).toBe(2500);
    expect(softCloseBudgetMs(3000, 5000)).toBe(3000);
    expect(softCloseBudgetMs(3000, 400)).toBe(0);
  });
});
