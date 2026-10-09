/**
 * `HostRuntime.terminate`'s `gracePeriodMs` plumbing: a caller supplied grace period must override
 * `config.supervisor.gracePeriodMs`/`DEFAULT_SUPERVISOR_CONFIG.gracePeriodMs`
 * rather than that static default silently winning regardless of what
 * `BrowserRouter.release()` asked for. Before this fix,
 * `ReleaseOptions.gracefulMs` never reached this file at all: `terminate()`
 * always built its `terminateBrowser` call from the node's own static
 * config only.
 *
 * `terminateBrowser` itself (the real terminate ladder: sending signals,
 * waiting, escalating) is mocked. This test is about whether the right
 * number reaches that call, not the ladder's own timing behaviour, which
 * has no unit coverage reachable without a real Chrome process (the
 * existing `runtime.e2e.test.ts` covers that ground against a real
 * browser).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchedBrowser, TerminateResult } from '@browserglass/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

interface FakeTerminateBrowserOpts {
  pid: number;
  cdpWsUrl: string | null;
  mode: string;
  cdpCloseTimeoutMs: number;
  gracePeriodMs: number;
  stopSupervision: () => void;
}

const terminateBrowserMock = vi.fn<(opts: FakeTerminateBrowserOpts) => Promise<TerminateResult>>();

vi.mock('../src/terminate.js', () => ({
  terminateBrowser: (opts: FakeTerminateBrowserOpts) => terminateBrowserMock(opts),
}));

const { HostRuntime } = await import('../src/runtime.js');
const { DEFAULT_SUPERVISOR_CONFIG } = await import('../src/config.js');

let dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-terminate-grace-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  terminateBrowserMock.mockReset();
});

function fakeResult(mode: string): TerminateResult {
  return {
    mode: mode as TerminateResult['mode'],
    effective: mode as TerminateResult['mode'],
    exitCode: 0,
    signal: null,
    durationMs: 1,
    locksCleared: [],
    warnings: [],
  };
}

/** A minimal, fully valid `LaunchedBrowser`, never passed through `launch()`: `terminate()` only reads `instanceId`/`pid`/`cdpWsUrl` and looks itself up in `this.live`, which is fine to miss (an untracked handle) for this test's purposes. */
function fakeHandle(instanceId: string, pid: number): LaunchedBrowser {
  return {
    instanceId: instanceId as LaunchedBrowser['instanceId'],
    runtimeKind: 'host',
    transport: { kind: 'http', cdpUrl: 'http://127.0.0.1:9222', host: '127.0.0.1', port: 9222 },
    cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake',
    browserGuid: 'guid-fake',
    pid,
    containerId: null,
    podName: null,
    profilePath: 'C:\\does-not-exist',
    containerProfilePath: null,
    engineVersion: 'Chrome/999.0.0.0',
    protocolVersion: '1.3',
    nativeUserAgent: 'fake-ua',
    launchDurationMs: 0,
    launchPhases: { preflight: 0, reconcile: 0, spawn: 0, cdpWait: 0, postLaunch: 0 },
    startedAt: Date.now(),
    adopted: false,
    teardown: () =>
      Promise.reject(new Error('not used by this test: terminate() is called directly')),
    onUnexpectedExit: () => () => undefined,
  };
}

describe('HostRuntime.terminate: gracePeriodMs override', () => {
  it('forwards a caller supplied gracePeriodMs to terminateBrowser, overriding the static default', async () => {
    terminateBrowserMock.mockImplementation(async (opts) => {
      opts.stopSupervision();
      return fakeResult('graceful');
    });
    const { runtime } = await HostRuntime.create({
      nodeId: 'nod_test',
      stateDir: freshDir(),
      profileRoot: freshDir(),
    });

    await runtime.terminate(fakeHandle('inst_grace_override', 900001), 'graceful', 12_345);

    expect(terminateBrowserMock).toHaveBeenCalledTimes(1);
    expect(terminateBrowserMock.mock.calls[0]?.[0]?.gracePeriodMs).toBe(12_345);
  });

  it('falls back to the static default when no gracePeriodMs is supplied', async () => {
    terminateBrowserMock.mockImplementation(async (opts) => {
      opts.stopSupervision();
      return fakeResult('graceful');
    });
    const { runtime } = await HostRuntime.create({
      nodeId: 'nod_test',
      stateDir: freshDir(),
      profileRoot: freshDir(),
    });

    await runtime.terminate(fakeHandle('inst_grace_default', 900002), 'graceful');

    expect(terminateBrowserMock.mock.calls[0]?.[0]?.gracePeriodMs).toBe(
      DEFAULT_SUPERVISOR_CONFIG.gracePeriodMs,
    );
  });

  it('falls back to a configured supervisor.gracePeriodMs, not the built in default, when no per call override is supplied', async () => {
    terminateBrowserMock.mockImplementation(async (opts) => {
      opts.stopSupervision();
      return fakeResult('graceful');
    });
    const { runtime } = await HostRuntime.create({
      nodeId: 'nod_test',
      stateDir: freshDir(),
      profileRoot: freshDir(),
      supervisor: { gracePeriodMs: 9_999 },
    });

    await runtime.terminate(fakeHandle('inst_grace_configured', 900003), 'graceful');

    expect(terminateBrowserMock.mock.calls[0]?.[0]?.gracePeriodMs).toBe(9_999);
  });
});
