import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LocalBrowserNotFoundError,
  LocalBrowserPermissionBlockedError,
  candidateLocalBrowserProfiles,
  discoverLocalBrowser,
  probeLocalBrowserCandidate,
} from '../src/local-browser-discovery.js';

let dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-local-browser-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function fakeFetch(
  bodies: readonly ({ status: number; body?: Record<string, unknown> } | 'network-error')[],
): typeof fetch {
  let call = 0;
  return (async () => {
    const entry = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    if (entry === 'network-error') throw new Error('ECONNREFUSED');
    return new Response(JSON.stringify(entry.body ?? {}), { status: entry.status });
  }) as typeof fetch;
}

function wsUrlBody(guid: string): { status: number; body: Record<string, unknown> } {
  return {
    status: 200,
    body: { webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/browser/${guid}` },
  };
}

describe('candidateLocalBrowserProfiles', () => {
  it('builds the Windows table under %LOCALAPPDATA%, including chrome, edge, and brave', () => {
    const entries = candidateLocalBrowserProfiles({
      platform: 'win32',
      localAppData: 'C:\\Users\\me\\AppData\\Local',
    });
    const chrome = entries.find((e) => e.label === 'chrome');
    expect(chrome?.userDataDir).toBe(
      join('C:\\Users\\me\\AppData\\Local', 'Google', 'Chrome', 'User Data'),
    );
    expect(entries.some((e) => e.label === 'msedge')).toBe(true);
    expect(entries.some((e) => e.label === 'brave')).toBe(true);
    expect(entries.some((e) => e.label === 'chrome-canary')).toBe(true);
  });

  it('builds the macOS table under $HOME/Library/Application Support', () => {
    const entries = candidateLocalBrowserProfiles({ platform: 'darwin', homeDir: '/Users/me' });
    const chrome = entries.find((e) => e.label === 'chrome');
    expect(chrome?.userDataDir).toBe(
      join('/Users/me', 'Library', 'Application Support', 'Google', 'Chrome'),
    );
  });

  it('builds the Linux table under $HOME, including Flatpak sandboxed config dirs', () => {
    const entries = candidateLocalBrowserProfiles({ platform: 'linux', homeDir: '/home/me' });
    expect(
      entries.some((e) => e.userDataDir === join('/home/me', '.config', 'google-chrome')),
    ).toBe(true);
    expect(entries.some((e) => e.userDataDir.includes('.var'))).toBe(true);
  });
});

describe('probeLocalBrowserCandidate', () => {
  it('reports not-running when no DevToolsActivePort file exists and no process holds the profile', async () => {
    const dir = freshDir();
    const result = await probeLocalBrowserCandidate(
      { label: 'chrome', userDataDir: dir },
      { hasRunningProcess: async () => false },
    );
    expect(result.status).toBe('not-running');
    expect(result.cdpUrl).toBeNull();
  });

  it('reports remote-debugging-disabled when a process holds the profile but wrote no DevToolsActivePort file', async () => {
    const dir = freshDir();
    const result = await probeLocalBrowserCandidate(
      { label: 'chrome', userDataDir: dir },
      { hasRunningProcess: async () => true },
    );
    expect(result.status).toBe('remote-debugging-disabled');
    expect(result.detail).toMatch(/remote debugging/);
  });

  it('reports remote-debugging-disabled with the toggle-off wording when Local State records it off', async () => {
    const dir = freshDir();
    writeFileSync(
      join(dir, 'Local State'),
      JSON.stringify({ devtools: { remote_debugging: { 'user-enabled': false } } }),
    );
    const result = await probeLocalBrowserCandidate(
      { label: 'chrome', userDataDir: dir },
      { hasRunningProcess: async () => true },
    );
    expect(result.status).toBe('remote-debugging-disabled');
    expect(result.detail).toMatch(/recorded off/);
  });

  it('a stale DevToolsActivePort file (nothing answers its port) does not produce a false positive', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'DevToolsActivePort'), '9999\n/devtools/browser/stale-guid');
    const result = await probeLocalBrowserCandidate(
      { label: 'chrome', userDataDir: dir },
      { fetchImpl: fakeFetch(['network-error']) },
    );
    expect(result.status).toBe('stale-port-file');
    expect(result.cdpUrl).toBeNull();
  });

  it('a live browser is found via /json/version, confirmed by two matching polls', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/live-guid');
    const result = await probeLocalBrowserCandidate(
      { label: 'chrome', userDataDir: dir },
      {
        fetchImpl: fakeFetch([wsUrlBody('live-guid'), wsUrlBody('live-guid')]),
        identityProbeTimeoutMs: 2000,
      },
    );
    expect(result.status).toBe('live');
    expect(result.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(result.wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/live-guid');
    expect(result.browserGuid).toBe('live-guid');
  });

  it('remote debugging being off (the popup path) produces the actionable permission-blocked error, not a generic failure', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/pending-guid');
    const result = await probeLocalBrowserCandidate(
      { label: 'chrome', userDataDir: dir },
      { fetchImpl: fakeFetch([{ status: 403 }]) },
    );
    expect(result.status).toBe('permission-blocked');
    expect(result.detail).toMatch(/permission-blocked/);
    expect(result.detail).toMatch(/Allow remote debugging/);
    expect(result.cdpUrl).toBe('http://127.0.0.1:9222');
  });

  it('falls back to the DevToolsActivePort websocket path on a 404 (Chrome 147+ default-profile /json/* lockdown)', async () => {
    const dir = freshDir();
    writeFileSync(join(dir, 'DevToolsActivePort'), '9222\n/devtools/browser/locked-down-guid');
    const result = await probeLocalBrowserCandidate(
      { label: 'chrome', userDataDir: dir },
      { fetchImpl: fakeFetch([{ status: 404 }]) },
    );
    expect(result.status).toBe('live');
    expect(result.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(result.wsUrl).toBe('ws://127.0.0.1:9222/devtools/browser/locked-down-guid');
    expect(result.browserGuid).toBe('locked-down-guid');
  });
});

describe('discoverLocalBrowser', () => {
  it('returns the first live candidate among several checked in order', async () => {
    const deadDir = freshDir();
    const liveDir = freshDir();
    writeFileSync(join(liveDir, 'DevToolsActivePort'), '9222\n/devtools/browser/found-guid');
    let call = 0;
    const found = await discoverLocalBrowser({
      candidates: [
        { label: 'chrome', userDataDir: deadDir },
        { label: 'msedge', userDataDir: liveDir },
      ],
      hasRunningProcess: async () => false,
      fetchImpl: (async () => {
        call += 1;
        return new Response(
          JSON.stringify({
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/found-guid',
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(found.candidate.label).toBe('msedge');
    expect(found.candidate.browserGuid).toBe('found-guid');
    expect(found.results).toHaveLength(2);
    expect(call).toBeGreaterThan(0);
  });

  it('throws LocalBrowserPermissionBlockedError when nothing is live but a candidate is waiting on the Allow popup', async () => {
    const blockedDir = freshDir();
    writeFileSync(join(blockedDir, 'DevToolsActivePort'), '9222\n/devtools/browser/pending');
    await expect(
      discoverLocalBrowser({
        candidates: [{ label: 'chrome', userDataDir: blockedDir }],
        fetchImpl: fakeFetch([{ status: 403 }]),
      }),
    ).rejects.toThrow(LocalBrowserPermissionBlockedError);
  });

  it('throws LocalBrowserNotFoundError, carrying every candidate checked, when nothing is running anywhere', async () => {
    const dir = freshDir();
    try {
      await discoverLocalBrowser({
        candidates: [{ label: 'chrome', userDataDir: dir }],
        hasRunningProcess: async () => false,
      });
      throw new Error('expected discoverLocalBrowser to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LocalBrowserNotFoundError);
      const e = err as LocalBrowserNotFoundError;
      expect(e.searched).toHaveLength(1);
      expect(e.searched[0]?.status).toBe('not-running');
    }
  });
});
