/**
 * Proves two things against a real, locally installed Chrome, launched
 * directly through `@browserglass/runtime-host` (not the shared demo
 * gateway on :3000, which this probe must not disturb, matching
 * `remote-endpoint-probe.mjs`'s own precedent for standalone throwaway
 * probes):
 *
 *   1. `StealthProfile.selfTest` is no longer a dead contract.
 *      `runStealthSelfTest` (`packages/runtime-host/src/stealth-self-test.ts`)
 *      connects to the browser this probe just launched, attaches a fresh
 *      target, runs `MEASURED_STEALTH_PROFILE`'s `initScripts`,
 *      `onTargetAttached`, and `selfTest` in that order, and returns every
 *      `StealthCheckResult`.
 *   2. `MEASURED_STEALTH_PROFILE` (`packages/runtime-host/src/stealth-profiles/measured.ts`)
 *      actually closes the tells its own header comment claims, on THIS
 *      Chrome, both headful and `--headless=new`: `navigator.webdriver`
 *      reads `false` with a native getter, and under `--headless=new`
 *      specifically, `navigator.userAgent` no longer contains
 *      `"Headless"`, also with a native getter (proving the fix landed at
 *      the CDP/network layer, not as a JS-defined shim), and
 *      `navigator.userAgentData` was not wiped in the process.
 *
 * Exits non-zero if any `StealthCheckResult.ok` is false, or if the probe
 * itself throws.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newId } from '@browserglass/protocol';
import {
  MEASURED_STEALTH_PROFILE,
  createHostRuntime,
  runStealthSelfTest,
} from '@browserglass/runtime-host';

function buildSpec(overrides = {}) {
  return {
    engine: 'chromium',
    channel: 'chrome',
    executablePath: null,
    headless: 'new',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    window: null,
    isolation: 'tab',
    userAgent: null,
    clientHints: null,
    locale: null,
    timezoneId: null,
    geolocation: null,
    permissions: [],
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    proxy: null,
    extraArgs: [],
    ignoreDefaultArgs: ['--disable-web-security'],
    env: {},
    extensions: [],
    stealth: 'full',
    initScripts: [],
    ignoreHttpsErrors: false,
    downloadDir: null,
    uploadDir: null,
    acceptDownloads: false,
    maxDownloadBytes: null,
    resources: { cpus: null, memoryMb: null, shmMb: null, pidsLimit: null },
    initialUrl: null,
    launchTimeoutMs: 45000,
    ...overrides,
  };
}

function buildLaunchRequest(profileRoot, spec) {
  const instanceId = newId('inst');
  const profileId = `prf-${instanceId}`;
  const path = join(profileRoot, profileId);
  mkdirSync(path, { recursive: true });
  return {
    instanceId,
    spec,
    profile: {
      profileId,
      path,
      containerPath: null,
      mode: 'ephemeral',
      lease: { fence: 1, expiresAt: Date.now() + 60_000 },
    },
    deadlineAt: Date.now() + 45_000,
    labels: {},
    signal: { aborted: false },
  };
}

let overallOk = true;
function report(label, results) {
  console.log(`\n=== ${label} ===`);
  for (const r of results) {
    overallOk = overallOk && r.ok;
    console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.check.padEnd(38)} observed=${r.observed}`);
    if (!r.ok) console.log(`        expected: ${r.expected}`);
  }
}

async function main() {
  const base = mkdtempSync(join(tmpdir(), 'bgls-stealth-selftest-'));
  const stateDir = join(base, 'state');
  const profileRoot = join(base, 'profiles');

  const { runtime } = await createHostRuntime({
    nodeId: 'nod_stealth_selftest_probe',
    stateDir,
    profileRoot,
    enabledStealthLevels: ['full'],
    stealthProfiles: [MEASURED_STEALTH_PROFILE],
  });

  const launched = [];
  try {
    for (const [label, headless] of [
      ['headless=new', 'new'],
      ['headful', 'xvfb-headful'],
    ]) {
      const spec = buildSpec({ headless });
      const req = buildLaunchRequest(profileRoot, spec);
      console.log(`\nlaunching Chrome (${label}) under MEASURED_STEALTH_PROFILE...`);
      const handle = await runtime.launch(req);
      launched.push(handle);

      if (!handle.stealthProfile || handle.stealthProfile.name !== MEASURED_STEALTH_PROFILE.name) {
        throw new Error(
          `launch() did not record MEASURED_STEALTH_PROFILE on the handle for ${label}: ${JSON.stringify(handle.stealthProfile)}`,
        );
      }

      const selfTestReport = await runStealthSelfTest({
        profile: MEASURED_STEALTH_PROFILE,
        spec,
        cdpUrl: handle.cdpWsUrl,
      });
      console.log(`Chrome ${selfTestReport.chromeProduct} (major ${selfTestReport.chromeMajor})`);
      report(label, selfTestReport.results);

      if (!MEASURED_STEALTH_PROFILE.validatedChromeMajors.includes(selfTestReport.chromeMajor)) {
        console.log(
          `  NOTE: Chrome major ${selfTestReport.chromeMajor} is not in validatedChromeMajors (${MEASURED_STEALTH_PROFILE.validatedChromeMajors.join(', ')}); this run's own results are what would justify adding it.`,
        );
      }
    }
  } finally {
    for (const handle of launched) {
      await runtime.terminate(handle, 'force').catch(() => {});
    }
    await runtime.dispose().catch(() => {});
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      // Best effort cleanup; a leftover temp dir is not this probe's assertion.
    }
  }

  if (!overallOk) {
    console.error('\nFAIL: at least one StealthCheckResult was not ok.');
    process.exit(1);
  }
  console.log('\nPASS: every StealthCheckResult was ok, for both headless and headful launches.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
