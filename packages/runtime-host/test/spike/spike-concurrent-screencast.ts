/**
 * BrowserGlass spikes S1 (concurrent screencast ceiling) and S2 (background
 * tab frame rate), run against a real Chrome instance on this machine.
 *
 * This is a throwaway measurement script, not a package with exported
 * symbols and not part of the regular test suite. It is excluded from
 * `pnpm -r test` because its filename does not match the default
 * `*.test.ts`/`*.spec.ts` include glob; run it explicitly with:
 *
 *   pnpm --filter @browserglass/runtime-host exec vitest run --config test/spike/vitest.spike.config.ts
 *
 * It launches one real, visible (headless: 'off') Chrome, opens tabs each
 * running a canvas animation via `requestAnimationFrame` (so there is
 * always something changing to stream, a static page would trivially
 * report zero frames), starts a `Page.startScreencast` on each via
 * `CdpBridge` and `CdpScreencastSource` (the same primitives the real
 * streaming pipeline uses), and records aggregate and per stream frame
 * rates while ramping the tab count from 1 to 12 (S1), then compares a
 * foregrounded tab's frame rate against a backgrounded one (S2), with the
 * backgrounding launch flags left at their default (always on, see
 * `../../src/flags.ts`). Every Chrome process this script launches is
 * force killed in a `finally` block, even on failure, and a final process
 * table scan confirms nothing survived.
 *
 * Findings are read from this script's console output; this file itself
 * is not the report.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LaunchRequest, LaunchedBrowser, MaterialisedProfile } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, it } from 'vitest';
import { CdpBridgeImpl } from '../../../core/src/cdp/bridge.js';
import type { CdpSessionId } from '../../../core/src/cdp/types.js';
import { CdpScreencastSource } from '../../../core/src/stream/cdp-screencast-source.js';
import { BACKGROUNDING_FLAGS } from '../../src/flags.js';
import { listAllChromeFamilyProcesses } from '../../src/process-table.js';
import { type HostRuntime, createHostRuntime } from '../../src/runtime.js';
import {
  assertNoTrackedChromeProcessesRemain,
  killEverythingTracked,
  trackProfileDir,
} from '../chrome-cleanup.js';
import { fixtureBrowserSpec } from '../fixtures.js';

/** A small canvas animation, always producing changed pixels at roughly display refresh rate, so a stalled screencast is unambiguous. */
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

/**
 * Best effort total CPU seconds consumed so far by every Chrome family
 * process attached to this profile's data dir (browser main plus
 * renderer/GPU/utility children), read via `Get-Process`. Returns `null`
 * if the sample cannot be taken; CPU measurement is explicitly optional
 * for this spike and must never block or fail the run.
 */
function totalChromeCpuSeconds(profilePath: string): number | null {
  try {
    const procs = listAllChromeFamilyProcesses().filter((p) =>
      p.commandLine.includes(`--user-data-dir=${profilePath}`),
    );
    if (procs.length === 0) return 0;
    const idList = procs.map((p) => p.pid).join(',');
    const script = `(Get-Process -Id ${idList} -ErrorAction SilentlyContinue | Measure-Object -Property CPU -Sum).Sum`;
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      },
    ).trim();
    const val = Number(out);
    return Number.isFinite(val) ? val : null;
  } catch {
    return null;
  }
}

interface TabStream {
  targetId: string;
  sessionId: CdpSessionId;
  source: CdpScreencastSource;
  frameCount: number;
}

interface S1Row {
  n: number;
  aggregateFps: number;
  perStreamFps: number;
  minStreamFps: number;
  cpuPercent: number | null;
  stalledStreams: number;
  browserResponsive: boolean;
}

describe('spike S1/S2: concurrent screencast ceiling and background tab frame rate', () => {
  it('measures aggregate/per-stream fps ramping 1..12 concurrent screencasts, then compares foreground vs background tab fps', async () => {
    const base = mkdtempSync(join(tmpdir(), 'bgls-spike-'));
    const profileRoot = join(base, 'profiles');
    const stateDir = join(base, 'state');

    let runtime: HostRuntime | null = null;
    let bridge: CdpBridgeImpl | null = null;
    let handle: LaunchedBrowser | null = null;

    const s1Rows: S1Row[] = [];
    let s2: { foregroundFps: number; backgroundFps: number } | null = null;

    try {
      console.log(
        `[spike] backgrounding flags (unconditionally included in every launch, see ../../src/flags.ts): ${BACKGROUNDING_FLAGS.join(' ')}`,
      );

      const created = await createHostRuntime({ nodeId: 'nod_spike', profileRoot, stateDir });
      runtime = created.runtime;

      const instanceId = newId('inst');
      const req: LaunchRequest = {
        instanceId,
        spec: fixtureBrowserSpec({
          headless: 'new',
          viewport: { width: 480, height: 420, deviceScaleFactor: 1 },
        }),
        profile: fixtureProfile(profileRoot, `prf-${instanceId}`),
        deadlineAt: Date.now() + 45_000,
        labels: {},
        signal: { aborted: false },
      };
      handle = await runtime.launch(req);
      console.log(`[spike] launched real Chrome pid=${handle.pid} engine=${handle.engineVersion}`);

      bridge = new CdpBridgeImpl(instanceId);
      await bridge.connect({ url: handle.cdpWsUrl });
      const liveBridge = bridge;

      const tabs: TabStream[] = [];

      async function openStreamingTab(): Promise<TabStream> {
        const createdTarget = (await liveBridge.send('Target.createTarget', {
          url: 'about:blank',
        })) as { targetId: string };
        const targetId = createdTarget.targetId;
        const session = await liveBridge.sessionFor(targetId);
        await liveBridge.send('Page.enable', {}, session.id);
        await liveBridge.send('Page.navigate', { url: ANIMATED_PAGE_URL }, session.id);
        await wait(300);

        const source = new CdpScreencastSource({ bridge: liveBridge, sessionId: session.id });
        const tab: TabStream = { targetId, sessionId: session.id, source, frameCount: 0 };
        await source.start(
          { codec: 'jpeg', quality: 60, maxWidth: 480, maxHeight: 360, everyNthFrame: 1 },
          () => {
            tab.frameCount += 1;
          },
        );
        return tab;
      }

      // ── S1: ramp concurrent screencasts 1..12 ────────────────────────
      for (let n = 1; n <= 12; n++) {
        while (tabs.length < n) {
          tabs.push(await openStreamingTab());
        }
        for (const t of tabs) t.frameCount = 0;

        const cpuBefore = totalChromeCpuSeconds(handle.profilePath);
        const windowStart = Date.now();
        await wait(5000);
        const elapsedMs = Date.now() - windowStart;
        const cpuAfter = totalChromeCpuSeconds(handle.profilePath);

        let browserResponsive = true;
        try {
          await liveBridge.send('Browser.getVersion', undefined, undefined, { timeoutMs: 3000 });
        } catch {
          browserResponsive = false;
        }

        const counts = tabs.map((t) => t.frameCount);
        const aggregateFrames = counts.reduce((a, b) => a + b, 0);
        const aggregateFps = aggregateFrames / (elapsedMs / 1000);
        const perStreamFps = aggregateFps / n;
        const minStreamFps = Math.min(...counts) / (elapsedMs / 1000);
        const stalledStreams = counts.filter((c) => c === 0).length;
        const cpuPercent =
          cpuBefore !== null && cpuAfter !== null
            ? ((cpuAfter - cpuBefore) / (elapsedMs / 1000) / cpus().length) * 100
            : null;

        const row: S1Row = {
          n,
          aggregateFps,
          perStreamFps,
          minStreamFps,
          cpuPercent,
          stalledStreams,
          browserResponsive,
        };
        s1Rows.push(row);
        console.log(
          `[spike] N=${n} aggregateFps=${aggregateFps.toFixed(1)} perStreamFps=${perStreamFps.toFixed(1)} minStreamFps=${minStreamFps.toFixed(1)} cpu%=${cpuPercent === null ? 'n/a' : cpuPercent.toFixed(1)} stalledStreams=${stalledStreams} browserResponsive=${browserResponsive} perTabFrames=[${counts.join(',')}]`,
        );

        if (!browserResponsive || (n >= 3 && minStreamFps < 1)) {
          console.log(
            `[spike] stopping the ramp early at N=${n}: browser unresponsive or a stream stalled`,
          );
          break;
        }
      }

      // ── S2: foreground versus background tab, same window ───────────
      for (const t of tabs) {
        await t.source.stop();
        await liveBridge.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      }
      tabs.length = 0;

      const createdFg = (await liveBridge.send('Target.createTarget', { url: 'about:blank' })) as {
        targetId: string;
      };
      const foregroundTargetId = createdFg.targetId;
      const foregroundSession = await liveBridge.sessionFor(foregroundTargetId);
      await liveBridge.send('Page.enable', {}, foregroundSession.id);
      await liveBridge.send('Page.navigate', { url: ANIMATED_PAGE_URL }, foregroundSession.id);

      const createdBg = (await liveBridge.send('Target.createTarget', {
        url: 'about:blank',
        background: true,
      })) as { targetId: string };
      const backgroundTargetId = createdBg.targetId;
      const backgroundSession = await liveBridge.sessionFor(backgroundTargetId);
      await liveBridge.send('Page.enable', {}, backgroundSession.id);
      await liveBridge.send('Page.navigate', { url: ANIMATED_PAGE_URL }, backgroundSession.id);

      await wait(300);
      await liveBridge.send('Target.activateTarget', { targetId: foregroundTargetId });
      await wait(200);

      let fgCount = 0;
      let bgCount = 0;
      const fgSource = new CdpScreencastSource({
        bridge: liveBridge,
        sessionId: foregroundSession.id,
      });
      const bgSource = new CdpScreencastSource({
        bridge: liveBridge,
        sessionId: backgroundSession.id,
      });
      await fgSource.start(
        { codec: 'jpeg', quality: 60, maxWidth: 480, maxHeight: 360, everyNthFrame: 1 },
        () => {
          fgCount += 1;
        },
      );
      await bgSource.start(
        { codec: 'jpeg', quality: 60, maxWidth: 480, maxHeight: 360, everyNthFrame: 1 },
        () => {
          bgCount += 1;
        },
      );

      const s2Start = Date.now();
      await wait(10_000);
      const s2Elapsed = Date.now() - s2Start;

      s2 = {
        foregroundFps: fgCount / (s2Elapsed / 1000),
        backgroundFps: bgCount / (s2Elapsed / 1000),
      };
      console.log(
        `[spike] S2 foregroundFps=${s2.foregroundFps.toFixed(1)} backgroundFps=${s2.backgroundFps.toFixed(1)}`,
      );

      // ── S2b: mechanism check, does activating the background tab resume
      // its frames (and stall the now-backgrounded original), confirming
      // activation state (not attach order or which screencast started
      // first) is what governs delivery? ─────────────────────────────
      fgCount = 0;
      bgCount = 0;
      await liveBridge.send('Target.activateTarget', { targetId: backgroundTargetId });
      await wait(300);
      const swapStart = Date.now();
      await wait(3000);
      const swapElapsed = Date.now() - swapStart;
      console.log(
        `[spike] S2b after activating the formerly-background tab: nowActiveFps=${(bgCount / (swapElapsed / 1000)).toFixed(1)} nowBackgroundFps=${(fgCount / (swapElapsed / 1000)).toFixed(1)}`,
      );

      // ── S2c: does a forced Page.captureScreenshot on the (now)
      // backgrounded target still return fresh, changing pixels, even
      // though the continuous screencast delivers none? This checks
      // whether the existing `ScreenshotPollSource` fallback / forced
      // thumbnail path is a viable mitigation for a background tab,
      // short of giving it its own OS window. ──────────────────────────
      const shot1 = (await liveBridge.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 60, scale: 'css' },
        foregroundSession.id,
      )) as { data: string };
      await wait(1000);
      const shot2 = (await liveBridge.send(
        'Page.captureScreenshot',
        { format: 'jpeg', quality: 60, scale: 'css' },
        foregroundSession.id,
      )) as { data: string };
      console.log(
        `[spike] S2c forced screenshots on the backgrounded target 1s apart: lengths=${shot1.data.length},${shot2.data.length} identical=${shot1.data === shot2.data}`,
      );

      await fgSource.stop();
      await bgSource.stop();
    } finally {
      console.log('[spike] S1 raw results:');
      console.table(s1Rows);
      if (s2) {
        console.log(
          `[spike] S2 result: foreground=${s2.foregroundFps.toFixed(1)}fps background=${s2.backgroundFps.toFixed(1)}fps`,
        );
      }

      if (bridge) {
        await bridge.close('spike cleanup').catch(() => {});
      }
      if (runtime && handle) {
        await runtime.terminate(handle, 'force').catch(() => {});
        await runtime.dispose();
      } else if (runtime) {
        await runtime.dispose();
      }
      killEverythingTracked();
      const survivors = assertNoTrackedChromeProcessesRemain();
      if (survivors.length > 0) {
        console.error(
          `[spike] WARNING: chrome processes survived cleanup: ${survivors.join(', ')}`,
        );
      } else {
        console.log('[spike] cleanup verified: no tracked chrome processes remain');
      }
    }
  }, 300_000);
});
