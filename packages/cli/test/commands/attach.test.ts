import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  AssistResult,
  AssistSituation,
  PermissionAssistPlugin,
} from '@browserglass/plugin-api';
import type { LaunchedBrowser } from '@browserglass/protocol';
import {
  type LocalBrowserCandidateResult,
  type LocalBrowserDiscoveryResult,
  LocalBrowserNotFoundError,
  LocalBrowserPermissionBlockedError,
} from '@browserglass/runtime-host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AttachDeps,
  buildOpenUrlCommand,
  openChromeInspectOnce,
  runAttach,
} from '../../src/commands/attach.js';
import type { PluginAvailability } from '../../src/plugins/registry.js';
import { EXIT_CODES } from '../../src/util/exit.js';
import { Printer } from '../../src/util/output.js';
import { captureStdio, parseJsonLines } from '../support/capture-io.js';

// `runAttach` takes its `@browserglass/runtime-host` calls as an injected
// `AttachDeps`, precisely so these tests can exercise the discover-then-
// attach composition and every discovery outcome without depending on this
// machine having a real, running, remote-debuggable Chrome.

function printer(json = false): Printer {
  return new Printer({ json, quiet: false, verbose: false, noColor: true });
}

function notRunning(label: string, userDataDir: string): LocalBrowserCandidateResult {
  return {
    label,
    userDataDir,
    status: 'not-running',
    cdpUrl: null,
    wsUrl: null,
    browserGuid: null,
    detail: `no ${label} process is using ${userDataDir}`,
  };
}

function debugOff(label: string, userDataDir: string): LocalBrowserCandidateResult {
  return {
    label,
    userDataDir,
    status: 'remote-debugging-disabled',
    cdpUrl: null,
    wsUrl: null,
    browserGuid: null,
    detail: `${label} is running on ${userDataDir} with remote debugging recorded off; enable chrome://inspect/#remote-debugging ("Allow remote debugging for this browser instance") in that browser, then retry`,
  };
}

function liveCandidate(
  label: string,
  userDataDir: string,
): LocalBrowserCandidateResult & { status: 'live'; cdpUrl: string; wsUrl: string } {
  return {
    label,
    userDataDir,
    status: 'live',
    cdpUrl: 'http://127.0.0.1:9222',
    wsUrl: 'ws://127.0.0.1:9222/devtools/browser/live-guid',
    browserGuid: 'live-guid',
    detail: 'confirmed live via /json/version',
  };
}

/** A `permission-assist` plugin's minimal shape, for tests that need a `'ready'` {@link PluginAvailability}. */
function fakeAssistPlugin(
  assist: (s: AssistSituation, signal: AbortSignal) => Promise<AssistResult>,
): PermissionAssistPlugin {
  return {
    id: 'fake-permission-assist',
    kind: 'permission-assist',
    hostApi: '^0.1.0-alpha.0',
    platforms: ['darwin', 'linux', 'win32'],
    summary: 'test double',
    probe: async () => ({ usable: true, detail: 'fake, always usable' }),
    assist,
  };
}

function fakeDeps(overrides: Partial<AttachDeps>): AttachDeps {
  return {
    discover: vi.fn(async () => {
      throw new Error('discover() not stubbed for this test');
    }),
    scanCandidates: vi.fn(async () => []),
    createRuntime: vi.fn(async () => {
      throw new Error('createRuntime() not stubbed for this test');
    }),
    // The default, ordinary state (nothing is installed by default): no
    // plugin, and nothing opened.
    resolveAssistPlugin: vi.fn(
      async (): Promise<PluginAvailability<PermissionAssistPlugin>> => ({ status: 'absent' }),
    ),
    openChromeInspect: vi.fn(async () => false),
    ...overrides,
  } as AttachDeps;
}

describe('bgls attach --list', () => {
  it('reports every candidate and its status, human output', async () => {
    const results = [notRunning('chrome', 'C:/chrome'), liveCandidate('msedge', 'C:/edge')];
    const deps = fakeDeps({ scanCandidates: vi.fn(async () => results) });
    const io = captureStdio();
    const code = await runAttach(printer(false), true, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.ok);
    const out = io.stdout.join('');
    expect(out).toContain('[NOT-RUNNING] chrome');
    expect(out).toContain('[LIVE] msedge');
    expect(out).toContain('2 candidate profiles checked, 1 live.');
  });

  it('--json emits every candidate as structured data, one line', async () => {
    const results = [notRunning('chrome', 'C:/chrome')];
    const deps = fakeDeps({ scanCandidates: vi.fn(async () => results) });
    const io = captureStdio();
    const code = await runAttach(printer(true), true, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.preconditionFailed);
    const lines = parseJsonLines(io.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ candidates: results });
  });

  it('exits ok when at least one listed candidate is live, even though nothing was attached', async () => {
    const deps = fakeDeps({
      scanCandidates: vi.fn(async () => [liveCandidate('chrome', 'C:/chrome')]),
    });
    const code = await runAttach(printer(true), true, deps);
    expect(code).toBe(EXIT_CODES.ok);
  });
});

describe('bgls attach, discovery outcomes reaching the user intact', () => {
  it('remote debugging disabled: the actionable detail text survives into both human and --json output', async () => {
    const searched = [debugOff('chrome', 'C:/chrome')];
    const err = new LocalBrowserNotFoundError(searched, true);
    const deps = fakeDeps({
      discover: vi.fn(async () => {
        throw err;
      }),
    });

    const humanIo = captureStdio();
    const humanCode = await runAttach(printer(false), false, deps);
    humanIo.restore();
    expect(humanCode).toBe(EXIT_CODES.preconditionFailed);
    expect(humanIo.stderr.join('')).toContain('remote debugging enabled');
    expect(humanIo.stdout.join('')).toContain('remote debugging recorded off');

    const jsonIo = captureStdio();
    const jsonCode = await runAttach(printer(true), false, deps);
    jsonIo.restore();
    expect(jsonCode).toBe(EXIT_CODES.preconditionFailed);
    const result = parseJsonLines(jsonIo.stdout)[0] as {
      attached: false;
      code: string;
      detail: string;
      candidates: readonly LocalBrowserCandidateResult[];
    };
    expect(result.attached).toBe(false);
    expect(result.code).toBe('E_LOCAL_BROWSER_NOT_FOUND');
    expect(result.detail).toContain('remote debugging enabled');
    expect(result.candidates).toEqual(searched);
    // No `permission-assist` field at all, and nothing opened: absence is
    // the default state and this path must look exactly as it did before
    // plugins existed.
    expect(Object.keys(result)).not.toContain('assist');
    expect(deps.openChromeInspect).not.toHaveBeenCalled();
  });

  it('permission blocked (the Allow popup): the click-Allow instruction reaches the user, not a generic failure', async () => {
    const err = new LocalBrowserPermissionBlockedError(
      'C:/chrome',
      'http://127.0.0.1:9222',
      'permission-blocked: Chrome is reachable at http://127.0.0.1:9222, but the per-session "Allow remote debugging" popup has not been accepted; click Allow in the browser, then retry',
    );
    const deps = fakeDeps({
      discover: vi.fn(async () => {
        throw err;
      }),
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.preconditionFailed);
    const result = parseJsonLines(io.stdout)[0] as {
      attached: false;
      code: string;
      detail: string;
    };
    expect(result.code).toBe('E_LOCAL_BROWSER_PERMISSION_BLOCKED');
    expect(result.detail).toContain('click Allow in the browser');
    expect(Object.keys(result)).not.toContain('assist');
    expect(deps.openChromeInspect).not.toHaveBeenCalled();
  });

  it('nothing running anywhere: the not-found detail names every profile checked', async () => {
    const searched = [notRunning('chrome', 'C:/chrome'), notRunning('msedge', 'C:/edge')];
    const err = new LocalBrowserNotFoundError(searched, false);
    const deps = fakeDeps({
      discover: vi.fn(async () => {
        throw err;
      }),
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.preconditionFailed);
    const result = parseJsonLines(io.stdout)[0] as { detail: string };
    expect(result.detail).toContain('open the browser you want to attach to');
    // Neither actionable status (`permission-blocked`, `remote-debugging-
    // disabled`) is present here, so nothing is assistable: the registry is
    // never even consulted.
    expect(deps.resolveAssistPlugin).not.toHaveBeenCalled();
  });
});

describe('bgls attach, permission-assist plugin choreography', () => {
  function debugOffNotFound(): LocalBrowserNotFoundError {
    return new LocalBrowserNotFoundError([debugOff('chrome', 'C:/chrome')], true);
  }

  it('an installed plugin that is not ready (e.g. not applicable on this platform) falls back to the unchanged default message', async () => {
    const err = debugOffNotFound();
    const resolveAssistPlugin = vi.fn(
      async (): Promise<PluginAvailability<PermissionAssistPlugin>> => ({
        status: 'not-applicable',
        reason: 'declares platforms [darwin]; this machine is win32',
      }),
    );
    const openChromeInspect = vi.fn(async () => true);
    const deps = fakeDeps({
      discover: vi.fn(async () => {
        throw err;
      }),
      resolveAssistPlugin,
      openChromeInspect,
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.preconditionFailed);
    expect(resolveAssistPlugin).toHaveBeenCalledTimes(1);
    expect(openChromeInspect).not.toHaveBeenCalled();
    const result = parseJsonLines(io.stdout)[0] as { detail: string };
    expect(Object.keys(result)).not.toContain('assist');
  });

  it('a ready plugin resolving the block: opens chrome://inspect, calls assist() with the right situation, re-probes before retrying, and attaches on success', async () => {
    const err = debugOffNotFound();
    const assistFn = vi.fn(async (situation: AssistSituation): Promise<AssistResult> => {
      expect(situation.status).toBe('remote-debugging-disabled');
      expect(situation.userDataDir).toBe('C:/chrome');
      expect(situation.label).toBe('chrome');
      return { outcome: 'resolved', detail: 'ticked the toggle' };
    });
    const plugin = fakeAssistPlugin(assistFn);
    const resolveAssistPlugin = vi.fn(
      async (): Promise<PluginAvailability<PermissionAssistPlugin>> => ({
        status: 'ready',
        plugin,
        probe: { usable: true, detail: 'ready' },
      }),
    );
    const openChromeInspect = vi.fn(async () => true);

    const candidate = liveCandidate('chrome', 'C:/chrome');
    const discovery: LocalBrowserDiscoveryResult = { candidate, results: [candidate] };
    const discover = vi
      .fn(async () => discovery)
      .mockImplementationOnce(async () => {
        throw err;
      });

    const teardown = vi.fn(async (mode: string) => ({
      mode,
      effective: mode,
      exitCode: null,
      signal: null,
      durationMs: 0,
      locksCleared: [],
      warnings: [],
    }));
    const handle = {
      instanceId: 'inst_x',
      profilePath: candidate.userDataDir,
      pid: 4242,
      cdpWsUrl: candidate.wsUrl,
      browserGuid: candidate.browserGuid,
      engineVersion: 'Chrome/147.0.0.0',
      protocolVersion: '1.3',
      adopted: true,
      teardown,
    } as unknown as LaunchedBrowser;
    const attachFn = vi.fn(async () => handle);
    const createRuntime = vi.fn(async () => ({
      runtime: { attach: attachFn, dispose: vi.fn(async () => undefined) },
      reconcileReport: {},
    }));

    const deps = fakeDeps({
      discover,
      resolveAssistPlugin,
      openChromeInspect,
      createRuntime: createRuntime as unknown as AttachDeps['createRuntime'],
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.ok);
    expect(openChromeInspect).toHaveBeenCalledTimes(1);
    expect(assistFn).toHaveBeenCalledTimes(1);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(attachFn).toHaveBeenCalledTimes(1);
    const result = parseJsonLines(io.stdout)[0] as { attached: true };
    expect(result.attached).toBe(true);
  });

  it('a ready plugin claiming resolved, but a re-probe still fails: reported, not trusted', async () => {
    const err = debugOffNotFound();
    const plugin = fakeAssistPlugin(async () => ({ outcome: 'resolved', detail: 'clicked it' }));
    const resolveAssistPlugin = vi.fn(
      async (): Promise<PluginAvailability<PermissionAssistPlugin>> => ({
        status: 'ready',
        plugin,
        probe: { usable: true, detail: 'ready' },
      }),
    );
    // Every call to discover() fails: the plugin's "resolved" is not proof.
    const discover = vi.fn(async () => {
      throw err;
    });
    const deps = fakeDeps({
      discover,
      resolveAssistPlugin,
      openChromeInspect: vi.fn(async () => true),
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.preconditionFailed);
    expect(discover).toHaveBeenCalledTimes(2);
    const result = parseJsonLines(io.stdout)[0] as {
      assist: { pluginId: string; outcome: string; detail: string };
    };
    expect(result.assist.outcome).toBe('resolved');
    expect(result.assist.detail).toContain('re-probe');
  });

  it('a ready plugin reporting user-action-required: surfaced as extra detail, exit code unchanged', async () => {
    const err = debugOffNotFound();
    const plugin = fakeAssistPlugin(async () => ({
      outcome: 'user-action-required',
      detail: 'tick the checkbox and click Allow on the next popup',
    }));
    const resolveAssistPlugin = vi.fn(
      async (): Promise<PluginAvailability<PermissionAssistPlugin>> => ({
        status: 'ready',
        plugin,
        probe: { usable: true, detail: 'ready' },
      }),
    );
    const deps = fakeDeps({
      discover: vi.fn(async () => {
        throw err;
      }),
      resolveAssistPlugin,
      openChromeInspect: vi.fn(async () => true),
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.preconditionFailed);
    const result = parseJsonLines(io.stdout)[0] as { assist: { outcome: string; detail: string } };
    expect(result.assist.outcome).toBe('user-action-required');
    expect(result.assist.detail).toContain('tick the checkbox');
  });

  it('a ready plugin that throws inside assist() is reported as unavailable, never crashes the command', async () => {
    const err = debugOffNotFound();
    const plugin = fakeAssistPlugin(async () => {
      throw new Error('osascript blew up');
    });
    const resolveAssistPlugin = vi.fn(
      async (): Promise<PluginAvailability<PermissionAssistPlugin>> => ({
        status: 'ready',
        plugin,
        probe: { usable: true, detail: 'ready' },
      }),
    );
    const deps = fakeDeps({
      discover: vi.fn(async () => {
        throw err;
      }),
      resolveAssistPlugin,
      openChromeInspect: vi.fn(async () => true),
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.preconditionFailed);
    const result = parseJsonLines(io.stdout)[0] as { assist: { outcome: string; detail: string } };
    expect(result.assist.outcome).toBe('unavailable');
    expect(result.assist.detail).toContain('osascript blew up');
  });
});

describe('bgls attach, opening chrome://inspect (the cross platform half)', () => {
  it('buildOpenUrlCommand: an argument array per platform, never a shell string', () => {
    const url = 'chrome://inspect/#remote-debugging';
    expect(buildOpenUrlCommand(url, 'darwin')).toEqual({ cmd: 'open', args: [url] });
    expect(buildOpenUrlCommand(url, 'win32')).toEqual({
      cmd: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    });
    expect(buildOpenUrlCommand(url, 'linux')).toEqual({ cmd: 'xdg-open', args: [url] });
  });

  describe('openChromeInspectOnce: rate limited by a marker file mtime, real filesystem work', () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'bgls-attach-inspect-test-'));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it('opens on the first call, when no marker exists yet', async () => {
      const marker = join(dir, 'marker');
      const open = vi.fn(async () => true);
      const opened = await openChromeInspectOnce(marker, { open, now: () => 1_000_000 });
      expect(opened).toBe(true);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('refuses a second call inside the TTL window', async () => {
      const marker = join(dir, 'marker');
      const open = vi.fn(async () => true);
      const first = await openChromeInspectOnce(marker, {
        open,
        now: () => 1_000_000,
        ttlMs: 180_000,
      });
      expect(first).toBe(true);

      const second = await openChromeInspectOnce(marker, {
        open,
        now: () => 1_000_000 + 60_000,
        ttlMs: 180_000,
      });
      expect(second).toBe(false);
      expect(open).toHaveBeenCalledTimes(1);
    });

    it('opens again once the TTL has elapsed', async () => {
      const marker = join(dir, 'marker');
      const open = vi.fn(async () => true);
      const first = await openChromeInspectOnce(marker, {
        open,
        now: () => 1_000_000,
        ttlMs: 180_000,
      });
      expect(first).toBe(true);

      // Simulate real elapsed time by backdating the marker's own mtime,
      // exactly what a real second `bgls attach` invocation, minutes
      // later, would see on disk.
      const longAgoSeconds = (1_000_000 - 200_000) / 1000;
      utimesSync(marker, longAgoSeconds, longAgoSeconds);

      const second = await openChromeInspectOnce(marker, {
        open,
        now: () => 1_000_000,
        ttlMs: 180_000,
      });
      expect(second).toBe(true);
      expect(open).toHaveBeenCalledTimes(2);
    });

    it('does not open, and does not throw, when the marker cannot be written because opening itself failed', async () => {
      const marker = join(dir, 'marker');
      const open = vi.fn(async () => false);
      const opened = await openChromeInspectOnce(marker, { open, now: () => 1_000_000 });
      expect(opened).toBe(false);
      expect(open).toHaveBeenCalledTimes(1);
    });
  });
});

describe('bgls attach, real attach composition', () => {
  it('composes discovery with HostRuntime.attach(), reports the live handle, then detaches without touching the browser', async () => {
    const candidate = liveCandidate('chrome', 'C:/Users/me/AppData/Local/Google/Chrome/User Data');
    const discovery: LocalBrowserDiscoveryResult = { candidate, results: [candidate] };

    const teardown = vi.fn(async (mode: string) => ({
      mode,
      effective: mode,
      exitCode: null,
      signal: null,
      durationMs: 0,
      locksCleared: [],
      warnings: [],
    }));
    const handle = {
      instanceId: 'inst_x',
      profilePath: candidate.userDataDir,
      pid: 4242,
      cdpWsUrl: candidate.wsUrl,
      browserGuid: candidate.browserGuid,
      engineVersion: 'Chrome/147.0.0.0',
      protocolVersion: '1.3',
      adopted: true,
      teardown,
    } as unknown as LaunchedBrowser;

    const attachFn = vi.fn(async () => handle);
    const dispose = vi.fn(async () => undefined);
    const createRuntime = vi.fn(async () => ({
      runtime: { attach: attachFn, dispose },
      reconcileReport: {},
    }));

    const deps = fakeDeps({
      discover: vi.fn(async () => discovery),
      createRuntime: createRuntime as unknown as AttachDeps['createRuntime'],
    });

    const io = captureStdio();
    const code = await runAttach(printer(true), false, deps);
    io.restore();

    expect(code).toBe(EXIT_CODES.ok);
    expect(attachFn).toHaveBeenCalledTimes(1);
    const req = attachFn.mock.calls[0]?.[0] as {
      endpoint: { url: string };
      recovered: { profilePath: string; cdpUrl: string };
    };
    expect(req.endpoint.url).toBe(candidate.wsUrl);
    expect(req.recovered.profilePath).toBe(candidate.userDataDir);
    expect(req.recovered.cdpUrl).toBe(candidate.cdpUrl);

    // Detached, not killed: the browser this process did not launch is left
    // exactly as it was, whether the probe succeeds or fails.
    expect(teardown).toHaveBeenCalledWith('detach');
    expect(dispose).toHaveBeenCalledTimes(1);

    const result = parseJsonLines(io.stdout)[0] as {
      attached: true;
      pid: number;
      cdpWsUrl: string;
      adopted: boolean;
      note: string;
    };
    expect(result.attached).toBe(true);
    expect(result.pid).toBe(4242);
    expect(result.cdpWsUrl).toBe(candidate.wsUrl);
    expect(result.adopted).toBe(true);
    // The honesty requirement: a browser this process did not launch is
    // reported with no control over channel, headless mode, args, profile,
    // extensions, or proxy, said plainly rather than left implicit.
    expect(result.note).toContain('not launched by BrowserGlass');
    expect(result.note).toContain('channel');
    expect(result.note).toContain('proxy');
  });
});
