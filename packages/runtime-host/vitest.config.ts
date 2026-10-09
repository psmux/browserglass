import { defineConfig } from 'vitest/config';

/**
 * `@browserglass/runtime-host` vitest config.
 *
 * Vitest's default `testTimeout` is 5000ms. Most of this package's own
 * tests call the real OS process table (`process-table.ts`'s
 * `chromeProcsForDataDirAsync`/`listAllChromeFamilyProcessesAsync`, which
 * `healProfile` calls on every invocation with `maxAgeMs: 0`, forcing a
 * fresh scan): a real `powershell.exe Get-CimInstance Win32_Process` child
 * process on Windows, or a real `ps` on POSIX. `process-table.ts`'s own
 * doc comment puts a single scan at "~1.45 seconds" measured and sizes its
 * own `SCAN_TIMEOUT_MS` at 30000 for exactly this reason: "the failure
 * mode this replaces was a scan being killed at 8s on a machine that was
 * merely busy." `test/terminate-confirm.test.ts` already raises three of
 * its own tests to a 10000ms per-test timeout for the same class of real
 * process spawn/kill cost.
 *
 * Under `pnpm -w test`, where every package in the workspace spawns its
 * own child processes at once, that cost compounds: a full run observed
 * `test/profile-heal.test.ts` individual tests (each one real
 * `healProfile()` call, each forcing one fresh scan) taking up to 3.3s,
 * and other files in this same package (`corruption-probe.test.ts`,
 * `state-file.test.ts`, `terminate-grace.test.ts`) landing within a second
 * of the 5000ms default under the same load, all for a correct, non-hung
 * async operation rather than a stalled one. Solo, every one of these
 * tests finishes in well under a second; only a busy machine pushes them
 * near, and past, the default budget, exactly the scenario
 * `SCAN_TIMEOUT_MS`'s own comment already anticipated. Raising the
 * package-wide default here, rather than sprinkling a third `it()`
 * argument across every file that happens to call into the process table,
 * keeps every test in this package (not only the ones caught failing on
 * one particular run) honest about the real cost of the dependency they
 * share.
 */
export default defineConfig({
  test: {
    testTimeout: 20_000,
  },
});
