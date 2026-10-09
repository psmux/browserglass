/**
 * Test-only guarantee that no test-launched `chrome.exe` process survives
 * this run, even on a failed assertion. Every real-Chrome test registers
 * the profile directories it launched against; `killEverything()` runs in
 * an `afterEach`/`afterAll` regardless of pass or fail.
 */
import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { chromeProcsForDataDir } from '../src/process-table.js';

const trackedProfileDirs = new Set<string>();

export function trackProfileDir(dir: string): void {
  trackedProfileDirs.add(dir);
}

function killTree(pid: number): void {
  if (platform() === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        timeout: 5000,
        windowsHide: true,
        stdio: 'ignore' as const,
      });
    } catch {
      // Already gone.
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

/** Force-kills every chrome process still attached to any tracked test profile directory. Safe to call multiple times. */
export function killEverythingTracked(): void {
  for (const dir of trackedProfileDirs) {
    for (const proc of chromeProcsForDataDir(dir)) {
      killTree(proc.pid);
    }
  }
}

/** Asserts no chrome process remains for any tracked directory, for a final "we really cleaned up" check. */
export function assertNoTrackedChromeProcessesRemain(): string[] {
  const survivors: string[] = [];
  for (const dir of trackedProfileDirs) {
    for (const proc of chromeProcsForDataDir(dir)) {
      survivors.push(`pid ${proc.pid} for ${dir}`);
    }
  }
  return survivors;
}
