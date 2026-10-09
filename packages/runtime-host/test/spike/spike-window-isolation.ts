/**
 * Spike S3: does one OS window per target lift the "only one live
 * screencast per Chrome instance" wall that S1/S2 found?
 *
 * Spikes S1 and S2 established, three ways, that a Chrome tab
 * which is not its window's *visible* tab produces exactly zero screencast
 * frames: not a reduced rate, a hard zero. Their own closing
 * recommendation names the only way out ("give each of those tabs its own
 * real OS window, which is exactly what `isolation: 'window'` would need
 * to become") but never measured it, because `Target.createTarget` was
 * only ever called with `{url, background}` and nothing in the build could
 * create a second window.
 *
 * This script measures exactly that claim, against the same real Chrome,
 * with the same `CdpScreencastSource` the production pipeline uses, and
 * the same animated `data:` page S1/S2 used, so the numbers are directly
 * comparable to S1/S2's results. The only variable changed
 * is `newWindow: true` on `Target.createTarget`.
 *
 * Three arms, all in one launched Chrome:
 *   A. N tabs in one window (the S1 baseline, reproduced here so the
 *      comparison is same-machine, same-run, not across two reports).
 *   B. N tabs each in its own window, every window left where Chrome put
 *      it (overlapping, most of them unfocused and partly occluded).
 *   C. Arm B repeated after the OS focus has been moved to the *first*
 *      window, to check that a window losing focus does not stall it, the
 *      failure mode `--disable-backgrounding-occluded-windows` is supposed
 *      to prevent and which arm B alone would not isolate.
 *
 * Run explicitly (never collected by `pnpm -r test`, the filename does not
 * match the default include glob):
 *
 *   pnpm --filter @browserglass/runtime-host exec vitest run --config test/spike/vitest.spike.config.ts
 *
 * Every Chrome process launched here is force killed in a `finally`, and a
 * process table scan asserts nothing survived, the same contract
 * `spike-concurrent-screencast.ts` and `test/chrome-cleanup.ts` already use.
 */
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchRequest, LaunchedBrowser, MaterialisedProfile } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, it } from 'vitest';
import { CdpBridgeImpl } from '../../../core/src/cdp/bridge.js';
import type { CdpSessionId } from '../../../core/src/cdp/types.js';
import { CdpScreencastSource } from '../../../core/src/stream/cdp-screencast-source.js';
import { BACKGROUNDING_FLAGS } from '../../src/flags.js';
import { type HostRuntime, createHostRuntime } from '../../src/runtime.js';
import {
  assertNoTrackedChromeProcessesRemain,
  killEverythingTracked,
  trackProfileDir,
} from '../chrome-cleanup.js';
import { fixtureBrowserSpec } from '../fixtures.js';

/** Identical to the S1/S2 page, so the frame rates are comparable. */
const ANIMATED_PAGE_URL = `data:text/html,${encodeURIComponent(`<!doctype html><html><body style="margin:0;background:#111">
<canvas id="c" width="480" height="360"></canvas>
<script>
  const ctx = document.getElementById('c').getContext('2d');
  let x = 0;
  function draw() {
    x = (x + 4) % 480;
    ctx.fillStyle = 'hsl(' + x + ', 80%, 50%)';
    ctx.fillRect(0, 0, 480, 360);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(x, 180, 24, 0, Math.PI * 2);
    ctx.fill();
    requestAnimationFrame(draw);
  }
  draw();
</script>
</body></html>`)}`;

const N = 4;
const HEADLESS = (process.env['BGLS_SPIKE_HEADLESS'] as 'off' | 'new') ?? 'off';
const WINDOW_MS = 5000;

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

interface TabStream {
  label: string;
  targetId: string;
  sessionId: CdpSessionId;
  source: CdpScreencastSource;
  frameCount: number;
  windowId: number | null;
}

describe('spike S3: one OS window per target', () => {
  it('compares per-stream fps for N tabs in one window against N tabs in N windows', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bgls-spike-win-'));
    const profileRoot = join(base, 'profiles');
    const stateDir = join(base, 'state');

    let runtime: HostRuntime | null = null;
    let bridge: CdpBridgeImpl | null = null;
    let handle: LaunchedBrowser | null = null;

    try {
      console.log(
        `[spike-s3] backgrounding flags on every launch: ${BACKGROUNDING_FLAGS.join(' ')}`,
      );

      const created = await createHostRuntime({ nodeId: 'nod_spikes3', profileRoot, stateDir });
      runtime = created.runtime;

      const instanceId = newId('inst');
      const req: LaunchRequest = {
        instanceId,
        // headless 'off': a real, visible window, which is the mode the
        // demo actually runs in and the only mode where "one OS window
        // per target" means anything at all.
        spec: fixtureBrowserSpec({
          headless: HEADLESS,
          viewport: { width: 480, height: 420, deviceScaleFactor: 1 },
        }),
        profile: fixtureProfile(profileRoot, `prf-${instanceId}`),
        deadlineAt: Date.now() + 45_000,
        labels: {},
        signal: { aborted: false },
      };
      handle = await runtime.launch(req);
      console.log(
        `[spike-s3] headless=${HEADLESS} launched real Chrome pid=${handle.pid} engine=${handle.engineVersion}`,
      );

      bridge = new CdpBridgeImpl(instanceId);
      await bridge.connect({ url: handle.cdpWsUrl });
      const liveBridge = bridge;

      async function openStreamingTab(
        label: string,
        newWindow: boolean,
        background = false,
      ): Promise<TabStream> {
        const createdTarget = (await liveBridge.send('Target.createTarget', {
          url: 'about:blank',
          ...(newWindow ? { newWindow: true } : {}),
          ...(background ? { background: true } : {}),
        })) as { targetId: string };
        const targetId = createdTarget.targetId;
        const session = await liveBridge.sessionFor(targetId);
        await liveBridge.send('Page.enable', {}, session.id);
        await liveBridge.send('Page.navigate', { url: ANIMATED_PAGE_URL }, session.id);
        await wait(400);

        // Prove the window really is distinct, rather than trusting the
        // flag: `Browser.getWindowForTarget` returns the OS window this
        // target lives in. Arm A should report one shared id for all N.
        let windowId: number | null = null;
        try {
          const w = (await liveBridge.send('Browser.getWindowForTarget', { targetId })) as {
            windowId: number;
          };
          windowId = w.windowId;
        } catch (err) {
          console.log(`[spike-s3] getWindowForTarget failed for ${label}: ${String(err)}`);
        }

        const source = new CdpScreencastSource({ bridge: liveBridge, sessionId: session.id });
        const tab: TabStream = {
          label,
          targetId,
          sessionId: session.id,
          source,
          frameCount: 0,
          windowId,
        };
        await source.start(
          { codec: 'jpeg', quality: 60, maxWidth: 480, maxHeight: 360, everyNthFrame: 1 },
          () => {
            tab.frameCount += 1;
          },
        );
        return tab;
      }

      async function measure(tabs: TabStream[], arm: string): Promise<void> {
        for (const t of tabs) t.frameCount = 0;
        const start = Date.now();
        await wait(WINDOW_MS);
        const elapsed = (Date.now() - start) / 1000;
        const rows = tabs.map((t) => ({
          tab: t.label,
          windowId: t.windowId,
          frames: t.frameCount,
          fps: Number((t.frameCount / elapsed).toFixed(1)),
        }));
        const live = rows.filter((r) => r.fps >= 1).length;
        console.log(
          `\n[spike-s3] ARM ${arm}: ${live}/${tabs.length} streams live (>=1 fps), distinct windowIds=${new Set(tabs.map((t) => t.windowId)).size}`,
        );
        console.table(rows);
      }

      async function teardown(tabs: TabStream[]): Promise<void> {
        for (const t of tabs) {
          await t.source.stop().catch(() => undefined);
          await liveBridge
            .send('Target.closeTarget', { targetId: t.targetId })
            .catch(() => undefined);
        }
        await wait(500);
      }

      // ── ARM A: N tabs, one window (the S1 baseline) ──────────────────
      const armA: TabStream[] = [];
      for (let i = 0; i < N; i++) armA.push(await openStreamingTab(`A${i}`, false));
      await measure(armA, 'A (N tabs, ONE window)');
      await teardown(armA);

      // ── ARM B: N tabs, N windows ─────────────────────────────────────
      const armB: TabStream[] = [];
      for (let i = 0; i < N; i++) armB.push(await openStreamingTab(`B${i}`, true));
      await measure(armB, 'B (N tabs, N windows, as placed)');

      // ── ARM C: same windows, after focus is yanked to the first ──────
      // `Target.activateTarget` on B0 raises and focuses B0's window,
      // leaving every other window unfocused and behind it. If unfocused
      // windows stall, this is where it shows.
      await liveBridge
        .send('Target.activateTarget', { targetId: armB[0]!.targetId })
        .catch(() => undefined);
      await wait(1000);
      await measure(armB, 'C (N windows, focus forced onto the first)');
      await teardown(armB);

      // ── ARM D: newWindow AND background together ─────────────────────
      // The demo opens its extra panes with `background: true` (so
      // opening three in a row does not yank the user's focus three
      // times). `background` and `newWindow` are separate parameters of
      // the same CDP call and nothing documents how they interact, so
      // this arm checks the exact combination the demo will send rather
      // than assuming the clean `newWindow`-only result carries over.
      const armD: TabStream[] = [];
      for (let i = 0; i < N; i++) armD.push(await openStreamingTab(`D${i}`, true, true));
      await measure(armD, 'D (N windows, opened with background: true)');
      await teardown(armD);
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
      killEverythingTracked();
      assertNoTrackedChromeProcessesRemain();
    }
  }, 300_000);
});
