/**
 * Spike S4: can a browser survive having zero windows, so a viewer who
 * closed every pane can open a new one?
 *
 * Found by driving the real demo after window isolation landed. Closing all
 * three panes at once (the user's own "closing, reopening parallelly
 * simultaneously" requirement) worked, and every subsequent `target.new`
 * then failed with `CdpError: Target.createTarget rejected, the bridge
 * closed`. Chrome exits when its last window closes, which takes the CDP
 * endpoint with it, so the Instance is alive on paper and dead in fact.
 *
 * This is sharper under `isolation: 'window'` than it ever was under
 * `'tab'`, because every streamed target is now a whole OS window: closing
 * N panes closes N windows, and the Nth close is always the last one.
 *
 * RESULT, measured against Chrome 151.0.7922.174 on Windows 11:
 *
 *   headless, no flag:               reopened=true
 *   HEADFUL, no flag:                reopened=false, "the bridge closed"
 *   HEADFUL, --keep-alive-for-test:  reopened=false, "the bridge closed"
 *
 * Two things to take from that.
 *
 * First, this is a headful-only problem. "Quit when the last window closes"
 * is a desktop shell behaviour and headless Chrome has no shell, so the
 * conformance suite (which runs `headless: 'new'`) cannot see it and the
 * demo (`headless: 'off'`, examples/nextjs-demo/server.mjs) hits it every
 * time. Anything guarding this has to run headful to mean anything.
 *
 * Second, `--keep-alive-for-test` (`switches::kKeepAliveForTest`) does NOT
 * fix it. That switch was the obvious candidate and it was worth measuring
 * rather than assuming, because reasoning from its name would have shipped
 * a flag that does nothing. Whatever it keeps alive, it is not the headful
 * browser process past its last window.
 *
 * So the fix cannot be a launch flag. It has to be either an anchor target
 * the browser keeps that no viewer ever sees (which costs one visible
 * window, and the whole point of this design is that no browser should
 * exist that is not being used), or relaunch on demand: let the browser die
 * with its last window, and bring it back when a viewer asks for a target
 * again. The second is the honest reading of "excess browsers should not be
 * spawned except what is used", and BrowserGlass already owns the machinery
 * for it in `Session.restartInstance`/`applyRebind`.
 *
 * Run explicitly (never collected by `pnpm -r test`, the filename does not
 * match the default include glob):
 *
 *   pnpm --filter @browserglass/runtime-host exec vitest run --config test/spike/vitest.spike.config.ts spike-keep-alive
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchRequest, LaunchedBrowser, MaterialisedProfile } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { CdpBridgeImpl } from '../../../core/src/cdp/bridge.js';
import { type HostRuntime, createHostRuntime } from '../../src/runtime.js';
import {
  assertNoTrackedChromeProcessesRemain,
  killEverythingTracked,
  trackProfileDir,
} from '../chrome-cleanup.js';
import { fixtureBrowserSpec } from '../fixtures.js';

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    lease: { fence: 1, expiresAt: Date.now() + 20 * 60_000 },
  };
}

/** Opens two windows, closes both, then reports whether a fresh target can still be created. */
async function survivesZeroWindows(
  extraArgs: readonly string[],
  headless: 'off' | 'new',
): Promise<{ reopened: boolean; error: string | null }> {
  const base = mkdtempSync(join(tmpdir(), 'bgls-spike-ka-'));
  const profileRoot = join(base, 'profiles');
  const stateDir = join(base, 'state');

  let runtime: HostRuntime | null = null;
  let bridge: CdpBridgeImpl | null = null;
  let handle: LaunchedBrowser | null = null;

  try {
    const created = await createHostRuntime({ nodeId: 'nod_spikes4', profileRoot, stateDir });
    runtime = created.runtime;

    const instanceId = newId('inst');
    const req: LaunchRequest = {
      instanceId,
      spec: fixtureBrowserSpec({
        headless,
        viewport: { width: 640, height: 480, deviceScaleFactor: 1 },
        extraArgs: [...extraArgs],
      }),
      profile: fixtureProfile(profileRoot, `prf-${instanceId}`),
      deadlineAt: Date.now() + 45_000,
      labels: {},
      signal: { aborted: false },
    };
    handle = await runtime.launch(req);

    bridge = new CdpBridgeImpl(instanceId);
    await bridge.connect({ url: handle.cdpWsUrl });
    const live = bridge;

    // Two extra windows, plus whatever Chrome opened at launch.
    const opened: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = (await live.send('Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
      })) as { targetId: string };
      opened.push(r.targetId);
    }

    // Close EVERY page target, which is what closing every pane does.
    const all = (await live.send('Target.getTargets', {})) as {
      targetInfos: Array<{ targetId: string; type: string }>;
    };
    for (const info of all.targetInfos) {
      if (info.type !== 'page') continue;
      await live.send('Target.closeTarget', { targetId: info.targetId }).catch(() => undefined);
    }
    await wait(1500);

    try {
      const r = (await live.send('Target.createTarget', {
        url: 'about:blank',
        newWindow: true,
      })) as { targetId: string };
      return { reopened: typeof r.targetId === 'string' && r.targetId.length > 0, error: null };
    } catch (err) {
      return { reopened: false, error: String(err) };
    }
  } finally {
    try {
      if (bridge) await bridge.close();
    } catch {
      // best effort
    }
    try {
      if (handle && runtime) await runtime.terminate(handle.instanceId, { reason: 'spike-done' });
    } catch {
      // best effort
    }
  }
}

describe('spike S4: browser survives zero open windows', () => {
  it('reports whether a target can be created again after every window was closed, with and without --keep-alive-for-test', async () => {
    try {
      // Headless is measured too, but only headful can actually fail:
      // "quit when the last window closes" is a desktop shell behaviour
      // and headless Chrome has no shell. The demo runs headful
      // (`headless: 'off'`, examples/nextjs-demo/server.mjs), so headful
      // is the arm the fix has to satisfy.
      const headlessBase = await survivesZeroWindows([], 'new');
      console.log(
        `[spike-s4] headless, no flag:               reopened=${headlessBase.reopened} error=${headlessBase.error ?? 'none'}`,
      );

      const headfulBase = await survivesZeroWindows([], 'off');
      console.log(
        `[spike-s4] HEADFUL, no flag:                reopened=${headfulBase.reopened} error=${(headfulBase.error ?? 'none').slice(0, 90)}`,
      );

      const headfulKept = await survivesZeroWindows(['--keep-alive-for-test'], 'off');
      console.log(
        `[spike-s4] HEADFUL, --keep-alive-for-test:  reopened=${headfulKept.reopened} error=${(headfulKept.error ?? 'none').slice(0, 90)}`,
      );

      // These assertions record what was measured, so a future Chrome
      // that changes any of it fails loudly here rather than silently
      // invalidating the design decision above.
      expect(headlessBase.reopened, 'headless stopped surviving zero windows').toBe(true);
      expect(
        headfulBase.reopened,
        'headful unexpectedly survived zero windows; relaunch-on-demand may no longer be needed',
      ).toBe(false);
      expect(
        headfulKept.reopened,
        '--keep-alive-for-test started working; it would now be the cheaper fix',
      ).toBe(false);
    } finally {
      killEverythingTracked();
      assertNoTrackedChromeProcessesRemain();
    }
  }, 300_000);
});
