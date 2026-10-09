/**
 * What this file tests, and what it deliberately does not.
 *
 * Real, on this machine: {@link googleChromeRoot}'s path construction,
 * {@link isRemoteDebuggingToggleEnabled} against real fixture `Local
 * State` files on a real filesystem, {@link buildOsascriptArgs}'s argv
 * shape, and every branch of {@link approveRemoteDebugging}'s outcome
 * classification, with `deps.run` always an injected fake standing in for
 * `osascript`.
 *
 * Never real, anywhere in this file: an actual `osascript` process, an
 * actual Chrome "Allow remote debugging?" sheet, or an actual macOS
 * Accessibility grant. No test here proves the AppleScript traversal
 * itself works; see `src/macos.ts`'s own header for why that cannot be
 * proven on this machine.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ACCESSIBILITY_DETAIL,
  ALLOW_SHEET_APPLESCRIPT,
  type MacApproveResult,
  approveRemoteDebugging,
  buildOsascriptArgs,
  googleChromeRoot,
  isRemoteDebuggingToggleEnabled,
} from '../src/macos.js';

/** Runs `fn` with `process.platform` forced to `plat`, restoring the real value afterward. Needed because this whole package was built on Windows: exercising the darwin-only branches of `approveRemoteDebugging` requires overriding what platform Node reports, not what platform this machine actually is. */
async function withPlatform<T>(plat: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: plat, configurable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(process, 'platform', original);
  }
}

describe('the AppleScript itself, ported unchanged from browser-harness', () => {
  it('names the exact sheet and button browser-harness matches, so a reader can audit it without running it', () => {
    expect(ALLOW_SHEET_APPLESCRIPT).toContain('"Allow remote debugging?"');
    expect(ALLOW_SHEET_APPLESCRIPT).toContain('AXButton');
    expect(ALLOW_SHEET_APPLESCRIPT).toContain('"Allow"');
    expect(ALLOW_SHEET_APPLESCRIPT).toContain('perform action "AXPress"');
    // Never told to activate: this must not steal focus onto Chrome.
    expect(ALLOW_SHEET_APPLESCRIPT).not.toContain('activate');
  });
});

describe('buildOsascriptArgs: the real argv, no shell, no string interpolation', () => {
  it('is exactly one literal argument: the path to a script file this process wrote itself', () => {
    expect(buildOsascriptArgs('/tmp/whatever/allow-sheet.applescript')).toEqual([
      '/tmp/whatever/allow-sheet.applescript',
    ]);
  });
});

describe('googleChromeRoot', () => {
  it('builds the same Chrome root local-browser-discovery.ts\'s macProfileTable names for the plain "chrome" label', () => {
    const root = googleChromeRoot('/Users/alex');
    const segments = root.split(/[/\\]/).filter(Boolean);
    expect(segments.slice(-4)).toEqual(['Library', 'Application Support', 'Google', 'Chrome']);
  });
});

describe('isRemoteDebuggingToggleEnabled: real fixture files on a real filesystem', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bgls-plugin-permission-assist-toggle-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when Local State does not exist at all', () => {
    expect(isRemoteDebuggingToggleEnabled(dir)).toBeNull();
  });

  it('returns null when Local State exists but is not valid JSON', () => {
    writeFileSync(join(dir, 'Local State'), 'not json{{{', 'utf8');
    expect(isRemoteDebuggingToggleEnabled(dir)).toBeNull();
  });

  it('returns null when the devtools.remote_debugging.user-enabled field is absent', () => {
    writeFileSync(join(dir, 'Local State'), JSON.stringify({ devtools: {} }), 'utf8');
    expect(isRemoteDebuggingToggleEnabled(dir)).toBeNull();
  });

  it('returns true when the toggle is recorded on', () => {
    writeFileSync(
      join(dir, 'Local State'),
      JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }),
      'utf8',
    );
    expect(isRemoteDebuggingToggleEnabled(dir)).toBe(true);
  });

  it('returns false when the toggle is recorded off, distinct from unknown', () => {
    writeFileSync(
      join(dir, 'Local State'),
      JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': false } } }),
      'utf8',
    );
    expect(isRemoteDebuggingToggleEnabled(dir)).toBe(false);
  });
});

describe('approveRemoteDebugging: platform gate and outcome classification, osascript itself always faked', () => {
  it('refuses immediately off macOS, without reading any toggle or running anything', async () => {
    // This machine really is not darwin, so this exercises the real branch.
    const controller = new AbortController();
    const result = await approveRemoteDebugging(controller.signal, { home: '/nonexistent' });
    expect(result.status).toBe('unsupported');
    expect(result.detail).toContain(process.platform);
  });

  it('reports setup-required on darwin when the chrome://inspect toggle has never been ticked', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgls-plugin-permission-assist-'));
    try {
      const result = await withPlatform('darwin', () => {
        const controller = new AbortController();
        return approveRemoteDebugging(controller.signal, { home: dir });
      });
      expect(result.status).toBe('setup-required');
      expect(result.detail).toContain('chrome://inspect');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function withToggleOn(
    fn: (home: string) => Promise<MacApproveResult>,
  ): Promise<MacApproveResult> {
    const home = mkdtempSync(join(tmpdir(), 'bgls-plugin-permission-assist-'));
    const chromeDir = join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(chromeDir, { recursive: true });
    writeFileSync(
      join(chromeDir, 'Local State'),
      JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': true } } }),
      'utf8',
    );
    try {
      return await withPlatform('darwin', () => fn(home));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it('reports ready when the fake osascript reports "ready"', async () => {
    const result = await withToggleOn((home) => {
      const controller = new AbortController();
      return approveRemoteDebugging(controller.signal, {
        home,
        run: async () => ({ stdout: 'ready', stderr: '' }),
      });
    });
    expect(result).toEqual({ status: 'ready', detail: null });
  });

  it('reports not-found when the fake osascript found no matching sheet', async () => {
    const result = await withToggleOn((home) => {
      const controller = new AbortController();
      return approveRemoteDebugging(controller.signal, {
        home,
        run: async () => ({ stdout: 'not-found', stderr: '' }),
      });
    });
    expect(result.status).toBe('not-found');
    expect(result.detail).toContain('retry');
  });

  it('reports error for any other stdout the fake osascript returns', async () => {
    const result = await withToggleOn((home) => {
      const controller = new AbortController();
      return approveRemoteDebugging(controller.signal, {
        home,
        run: async () => ({ stdout: 'something-unexpected', stderr: '' }),
      });
    });
    expect(result.status).toBe('error');
    expect(result.detail).toContain('something-unexpected');
  });

  it('reports accessibility-required when osascript itself refuses for lack of Accessibility', async () => {
    const result = await withToggleOn((home) => {
      const controller = new AbortController();
      return approveRemoteDebugging(controller.signal, {
        home,
        run: async () => {
          throw new Error('osascript is not authorized to send Apple events to System Events');
        },
      });
    });
    expect(result).toEqual({ status: 'accessibility-required', detail: ACCESSIBILITY_DETAIL });
  });

  it("reports accessibility-required when the run rejects after this call's own signal was aborted", async () => {
    const result = await withToggleOn((home) => {
      const controller = new AbortController();
      controller.abort();
      return approveRemoteDebugging(controller.signal, {
        home,
        run: async () => {
          throw new Error('AbortError');
        },
      });
    });
    expect(result.status).toBe('accessibility-required');
  });

  it('reports a plain error for any other failure the fake run throws', async () => {
    const result = await withToggleOn((home) => {
      const controller = new AbortController();
      return approveRemoteDebugging(controller.signal, {
        home,
        run: async () => {
          throw new Error('spawn osascript ENOENT');
        },
      });
    });
    expect(result.status).toBe('error');
    expect(result.detail).toContain('ENOENT');
  });
});
