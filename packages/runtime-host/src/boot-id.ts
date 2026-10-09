/**
 * `writerBootId`, the value the durable state file (`state-file.ts`) uses to
 * distinguish "pids from a previous run of this machine" from "pids from a
 * previous run of this process, same boot". Pids are reused across a reboot, so a boot id mismatch means
 * every recorded entry is treated as dead unconditionally.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

let cached: string | null = null;

/**
 * Returns a value that is stable for the lifetime of one boot of this
 * machine and changes across a reboot. Linux reads
 * `/proc/sys/kernel/random/boot_id` directly (already boot scoped and
 * unique by design). Windows and macOS shell out to a boot-timestamp query
 * and hash it into a stable string, since neither exposes a boot id file;
 * the shell-out result is cached in-process so it only ever runs once. Any
 * platform where the lookup fails falls back to a fresh random id for this
 * process's lifetime, which is conservative: it treats every prior entry as
 * a different boot and forces cleanup rather than a false adoption.
 */
export function getBootId(): string {
  if (cached !== null) return cached;
  cached = detectBootId();
  return cached;
}

function detectBootId(): string {
  try {
    if (process.platform === 'linux') {
      return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    }
    if (process.platform === 'win32') {
      // LastBootUpTime is stable for the duration of one boot and changes
      // on every restart, which is exactly the property needed here.
      const out = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime',
        ],
        { encoding: 'utf8', timeout: 5000 },
      );
      return `win32-${out.trim()}`;
    }
    if (process.platform === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        timeout: 2000,
      });
      return `darwin-${out.trim()}`;
    }
  } catch {
    // Fall through to the random fallback below.
  }
  return `unknown-${randomUUID()}`;
}

/** Test-only escape hatch: clears the in-process cache so a test can force re-detection. */
export function __resetBootIdCacheForTests(): void {
  cached = null;
}
