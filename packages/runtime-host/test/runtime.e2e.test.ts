/**
 * The real deliverable: launches the actual Chrome 151 installed on this
 * machine, end to end, and verifies the host runtime's contract against a
 * real process, not a mock. Every test
 * cleans up its own Chrome process (and the shared `afterAll` sweep below
 * force-kills anything a failed assertion left behind), so this machine
 * never keeps a test-launched Chrome window after this suite finishes.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CDP_MIN_MAJOR_DEFAULT } from '@browserglass/core';
import { newId } from '@browserglass/protocol';
import type { LaunchRequest, MaterialisedProfile, StealthProfile } from '@browserglass/protocol';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { chromeProcsForDataDir } from '../src/process-table.js';
import { type HostRuntime, createHostRuntime } from '../src/runtime.js';
import { BASIC_STEALTH_PROFILE } from '../src/stealth-profiles/basic.js';
import {
  assertNoTrackedChromeProcessesRemain,
  killEverythingTracked,
  trackProfileDir,
} from './chrome-cleanup.js';
import { fixtureBrowserSpec } from './fixtures.js';

const runtimesToDispose: HostRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimesToDispose.splice(0)) {
    await runtime.dispose();
  }
  killEverythingTracked();
});

afterAll(() => {
  killEverythingTracked();
  const survivors = assertNoTrackedChromeProcessesRemain();
  if (survivors.length > 0) {
    throw new Error(`chrome processes survived test cleanup: ${survivors.join(', ')}`);
  }
});

function freshWorkspace(): { stateDir: string; profileRoot: string } {
  const base = mkdtempSync(join(tmpdir(), 'bgls-runtime-host-e2e-'));
  return { stateDir: join(base, 'state'), profileRoot: join(base, 'profiles') };
}

function fixtureProfile(profileRoot: string, profileId: string): MaterialisedProfile {
  const path = join(profileRoot, profileId);
  mkdirSync(path, { recursive: true });
  trackProfileDir(path);
  return {
    profileId: profileId as MaterialisedProfile['profileId'],
    path,
    containerPath: null,
    mode: 'ephemeral',
    lease: { fence: 1, expiresAt: Date.now() + 60_000 },
  };
}

/** How long any one launch in this file is given. Applied per launch, never shared across two of them; see {@link freshDeadline}. */
const LAUNCH_BUDGET_MS = 45_000;

function fixtureLaunchRequest(
  profileRoot: string,
  overrides: Partial<LaunchRequest> = {},
): LaunchRequest {
  const instanceId = newId('inst');
  return {
    instanceId,
    spec: fixtureBrowserSpec(),
    profile: fixtureProfile(profileRoot, `prf-${instanceId}`),
    deadlineAt: Date.now() + LAUNCH_BUDGET_MS,
    labels: {},
    signal: { aborted: false },
    ...overrides,
  };
}

/**
 * `LaunchRequest.deadlineAt` is an absolute instant, so spreading an
 * already-used request into a second `launch()` hands the second launch
 * whatever is left of the first one's budget rather than a budget of its
 * own. On a loaded machine the first launch and its orphan reaping can eat
 * most of 45 seconds, and the second then fails in `resolveBrowserPid`
 * with "no chrome browser-main process found before the deadline", which
 * looks like a product fault and is not one. Every reused request gets a
 * fresh deadline through this.
 */
function freshDeadline(): { deadlineAt: number } {
  return { deadlineAt: Date.now() + LAUNCH_BUDGET_MS };
}

describe('HostRuntime.launch, real Chrome', () => {
  it('launches the real Chrome on this machine and probeCdpIdentity confirms a stable GUID', async () => {
    const { profileRoot, ...rest } = freshWorkspace();
    const { runtime } = await createHostRuntime({ nodeId: 'nod_test', profileRoot, ...rest });
    runtimesToDispose.push(runtime);

    const req = fixtureLaunchRequest(profileRoot);
    const handle = await runtime.launch(req);

    expect(handle.browserGuid).toMatch(/^[0-9a-f-]{20,}$/i);
    // Asserts the SHAPE and a floor, never a specific major. This line
    // used to read `toContain('151.')`, which passed only while the
    // machine happened to have Chrome 151 installed and then failed on
    // every run once Chrome auto updated to 152 (`expected
    // 'Chrome/152.0.7977.64' to contain '151.'`), five runs out of five.
    // That is a test pinned to a moving external dependency, not a
    // product signal: this test's subject is `probeCdpIdentity` returning
    // a stable GUID and a real engine version, not which Chrome the
    // machine is on this month. `CDP_MIN_MAJOR_DEFAULT` (120,
    // `core/src/cdp/types.ts`) is the floor the bridge itself enforces,
    // so it is the only version bound this assertion has any business
    // caring about.
    const engineMajor = Number(/^Chrome\/(\d+)\./.exec(handle.engineVersion ?? '')?.[1]);
    expect(Number.isFinite(engineMajor)).toBe(true);
    expect(engineMajor).toBeGreaterThanOrEqual(CDP_MIN_MAJOR_DEFAULT);
    expect(handle.pid).not.toBeNull();
    expect(handle.adopted).toBe(false);

    const result = await runtime.terminate(handle, 'force');
    expect(result.effective).toBe('force');
  }, 60_000);

  it('launch() is idempotent per instanceId: a second call while the first is live returns the same handle', async () => {
    const { runtime } = await createHostRuntime({ nodeId: 'nod_test', ...freshWorkspace() });
    runtimesToDispose.push(runtime);
    const req = fixtureLaunchRequest(tmpdir());
    const [a, b] = await Promise.all([runtime.launch(req), runtime.launch(req)]);
    expect(a.browserGuid).toBe(b.browserGuid);
    expect(a.pid).toBe(b.pid);
    await runtime.terminate(a, 'force');
  }, 60_000);
});

describe('HostRuntime.dispose, killOnShutdown, real Chrome', () => {
  it('ends every browser it still tracks, found by profile directory', async () => {
    // The backstop a gateway shutdown falls back to for anything its own
    // release pass missed. It used to kill only the remembered pid's tree,
    // which on Windows can miss the process that actually holds the
    // profile (see terminate.ts).
    const { profileRoot, ...rest } = freshWorkspace();
    const { runtime } = await createHostRuntime({
      nodeId: 'nod_test',
      profileRoot,
      ...rest,
      killOnShutdown: true,
    });
    const handle = await runtime.launch(fixtureLaunchRequest(profileRoot));
    expect(chromeProcsForDataDir(handle.profilePath).length).toBeGreaterThan(0);

    await runtime.dispose();

    expect(chromeProcsForDataDir(handle.profilePath)).toEqual([]);
  }, 90_000);
});

describe('HostRuntime.launch, stealth: silence must not survive, real Chrome', () => {
  // Both refusal tests below throw before this runtime ever touches
  // Chrome binary discovery or spawns a process (`resolveRequiredStealthProfile`
  // runs first in `doLaunch`, ahead of `resolveChromeBinary`): the point is
  // that a disallowed level or a missing profile is refused as a pure
  // config decision, not something that only surfaces after most of a
  // launch has already run.

  it('refuses spec.stealth: full when enabledStealthLevels only lists basic, rather than silently downgrading it', async () => {
    const { runtime } = await createHostRuntime({
      nodeId: 'nod_test',
      ...freshWorkspace(),
      enabledStealthLevels: ['basic'],
      stealthProfiles: [BASIC_STEALTH_PROFILE],
    });
    runtimesToDispose.push(runtime);
    const req = fixtureLaunchRequest(tmpdir(), { spec: fixtureBrowserSpec({ stealth: 'full' }) });

    await expect(runtime.launch(req)).rejects.toMatchObject({ code: 'E_STEALTH_LEVEL_DISALLOWED' });
  });

  it('refuses spec.stealth: basic when the level is enabled but no profile is registered for it, rather than launching a browser with no stealth patches and no error', async () => {
    const { runtime } = await createHostRuntime({
      nodeId: 'nod_test',
      ...freshWorkspace(),
      enabledStealthLevels: ['basic'],
      // stealthProfiles deliberately omitted: the exact defect this
      // feature exists to make loud.
    });
    runtimesToDispose.push(runtime);
    const req = fixtureLaunchRequest(tmpdir(), { spec: fixtureBrowserSpec({ stealth: 'basic' }) });

    await expect(runtime.launch(req)).rejects.toMatchObject({ code: 'E_STEALTH_PROFILE_MISSING' });
  });

  it('launches real Chrome with the registered basic profile, and records its name/level/version on the handle', async () => {
    const { profileRoot, ...rest } = freshWorkspace();
    const { runtime } = await createHostRuntime({
      nodeId: 'nod_test',
      profileRoot,
      ...rest,
      enabledStealthLevels: ['basic'],
      stealthProfiles: [BASIC_STEALTH_PROFILE],
    });
    runtimesToDispose.push(runtime);

    const req = fixtureLaunchRequest(profileRoot, {
      spec: fixtureBrowserSpec({ stealth: 'basic' }),
    });
    const handle = await runtime.launch(req);

    expect(handle.stealthProfile).toEqual({
      name: BASIC_STEALTH_PROFILE.name,
      level: 'basic',
      version: BASIC_STEALTH_PROFILE.version,
    });

    await runtime.terminate(handle, 'force');
  }, 60_000);

  it('spec.stealth: off launches normally and records no stealth profile at all, even when profiles are registered for other levels', async () => {
    const { runtime } = await createHostRuntime({
      nodeId: 'nod_test',
      ...freshWorkspace(),
      enabledStealthLevels: ['basic'],
      stealthProfiles: [BASIC_STEALTH_PROFILE],
    });
    runtimesToDispose.push(runtime);

    const req = fixtureLaunchRequest(tmpdir(), { spec: fixtureBrowserSpec({ stealth: 'off' }) });
    const handle = await runtime.launch(req);

    expect(handle.stealthProfile ?? null).toBeNull();

    await runtime.terminate(handle, 'force');
  }, 60_000);

  it('fails the launch when a registered profile’s own launchArgs is rejected by ARG_ALLOW/ARG_DENY, rather than silently dropping it', async () => {
    const badProfile: StealthProfile = {
      ...BASIC_STEALTH_PROFILE,
      name: 'fixture-bad-launch-args',
      // --no-sandbox is on ARG_DENY unconditionally: this profile
      // is deliberately misbehaving, to exercise the failure path.
      launchArgs: () => ['--no-sandbox'],
    };
    const { runtime } = await createHostRuntime({
      nodeId: 'nod_test',
      ...freshWorkspace(),
      enabledStealthLevels: ['basic'],
      stealthProfiles: [badProfile],
    });
    runtimesToDispose.push(runtime);

    const req = fixtureLaunchRequest(tmpdir(), { spec: fixtureBrowserSpec({ stealth: 'basic' }) });
    await expect(runtime.launch(req)).rejects.toMatchObject({ code: 'E_ARG_DENIED' });
  }, 60_000);
});

describe('HostRuntime terminate ladder, real Chrome', () => {
  it('killing the parent pid alone leaves no orphaned renderers when the process group is killed', async () => {
    const { runtime } = await createHostRuntime({ nodeId: 'nod_test', ...freshWorkspace() });
    runtimesToDispose.push(runtime);
    const req = fixtureLaunchRequest(tmpdir());
    const handle = await runtime.launch(req);

    const beforeKill = chromeProcsForDataDir(handle.profilePath);
    expect(beforeKill.length).toBeGreaterThan(0);

    const result = await runtime.terminate(handle, 'graceful');
    // 'graceful' first asks Chrome to close itself over CDP, which usually
    // ends it. When it does not, Windows has no soft signal a taskkill can
    // send, so 'graceful' collapses to force there, and the result must
    // say so.
    if (process.platform === 'win32') {
      expect(['graceful', 'force']).toContain(result.effective);
      if (result.effective === 'force') {
        expect(result.warnings.some((w) => w.includes('force'))).toBe(true);
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterKill = chromeProcsForDataDir(handle.profilePath);
    expect(afterKill).toHaveLength(0);
  }, 60_000);

  it("'clean' attempts a CDP Browser.close before falling back, and still leaves nothing running", async () => {
    const { runtime } = await createHostRuntime({ nodeId: 'nod_test', ...freshWorkspace() });
    runtimesToDispose.push(runtime);
    const req = fixtureLaunchRequest(tmpdir());
    const handle = await runtime.launch(req);

    await runtime.terminate(handle, 'clean');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(chromeProcsForDataDir(handle.profilePath)).toHaveLength(0);
  }, 60_000);
});

describe('startup reattach, real Chrome, across two HostRuntime instances', () => {
  it('a fresh HostRuntime reattaches to a survivor with adopted:true and the same browserGuid, after the first HostRuntime stops supervising without killing it', async () => {
    const { stateDir, profileRoot } = freshWorkspace();
    const { runtime: runtimeA } = await createHostRuntime({
      nodeId: 'nod_test',
      stateDir,
      profileRoot,
    });
    const req = fixtureLaunchRequest(profileRoot);
    const handleA = await runtimeA.launch(req);
    expect(handleA.adopted).toBe(false);

    // Simulate "the Node process died": stop supervising WITHOUT killing
    // Chrome (killOnShutdown defaults to false), leaving the real browser
    // process running and the state file on disk exactly as a crashed
    // process would leave it.
    await runtimeA.dispose();

    const stillRunning = chromeProcsForDataDir(handleA.profilePath);
    expect(stillRunning.length).toBeGreaterThan(0);

    // A fresh process, reading the same state file, runs the full startup
    // reattach algorithm.
    const { runtime: runtimeB, reconcileReport } = await createHostRuntime({
      nodeId: 'nod_test',
      stateDir,
      profileRoot,
    });
    runtimesToDispose.push(runtimeB);

    expect(reconcileReport.adoptedCount).toBe(1);
    const list = await runtimeB.list();
    const adoptedEntry = list.find((e) => e.instanceId === handleA.instanceId);
    expect(adoptedEntry).toBeDefined();
    expect(adoptedEntry?.browserGuid).toBe(handleA.browserGuid);
    expect(adoptedEntry?.status).toBe('live');

    await runtimeB.terminate({ ...handleA, pid: adoptedEntry?.pid ?? handleA.pid }, 'force');
  }, 90_000);
});

describe('stale DevToolsActivePort does not produce a false-positive connect', () => {
  it('a leftover DevToolsActivePort naming the wrong port is unlinked before spawn, so discovery waits for the real one', async () => {
    const { runtime } = await createHostRuntime({ nodeId: 'nod_test', ...freshWorkspace() });
    runtimesToDispose.push(runtime);
    const req = fixtureLaunchRequest(tmpdir());

    // Plant a stale DevToolsActivePort naming a port nothing is listening
    // on, exactly what a previous run's leftover file would look like.
    writeFileSync(
      join(req.profile.path, 'DevToolsActivePort'),
      '9\n/devtools/browser/stale-guid-that-does-not-exist',
    );

    const handle = await runtime.launch(req);
    // A successful, GUID-confirmed launch on a real port proves the stale
    // file did not short-circuit discovery.
    expect(handle.browserGuid).not.toBe('stale-guid-that-does-not-exist');
    await runtime.terminate(handle, 'force');
  }, 60_000);
});

describe('orphan handling on the launch path', () => {
  it('reaps a leftover orphan Chrome for a profile before relaunching onto it', async () => {
    const { runtime } = await createHostRuntime({ nodeId: 'nod_test', ...freshWorkspace() });
    runtimesToDispose.push(runtime);
    const req = fixtureLaunchRequest(tmpdir());

    const first = await runtime.launch(req);
    // Detach: stop supervising but leave the process running, simulating
    // an orphan this runtime instance no longer tracks in `this.live`.
    await runtime.terminate(first, 'detach');
    expect(chromeProcsForDataDir(req.profile.path).length).toBeGreaterThan(0);

    // A second launch onto the same profile path (a fresh instanceId,
    // same directory) must reap the orphan rather than refuse or race it
    // for the singleton lock.
    const second = await runtime.launch({ ...req, instanceId: newId('inst'), ...freshDeadline() });
    expect(second.browserGuid).not.toBe(first.browserGuid);
    await runtime.terminate(second, 'force');
  }, 60_000);
});
