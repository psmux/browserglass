/**
 * `bgls doctor`: the most valuable command. Answers "why is this not working" without reading source, across
 * six check groups plus `--check-invariants`, with `--fix` for the
 * mechanical subset and `--deep` for a full real-browser round trip.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { GLOBAL_ARGS, resolveGlobalFlags } from '../context.js';
import {
  checkChrome,
  checkChromeLaunchTiming,
  checkCpuAndRam,
  checkInvariants,
  checkNetworkListener,
  checkNetworkOutbound,
  checkNetworkTunnel,
  checkNodeVersion,
  checkPackageVersions,
  checkPlugins,
  checkProfileDirFilesystem,
  checkProfiles,
  checkStoreLockHolder,
  checkStoreSchema,
  checkUvThreadpoolSize,
  checkWindowsDefender,
  fixWindowsDefenderExclusion,
} from '../doctor/checks.js';
import { runDeepCheck } from '../doctor/deep.js';
import type { DoctorCheckResult } from '../doctor/types.js';
import { resolvePluginsFileForRead } from '../plugins/record.js';
import { defaultDataDir } from '../session-file.js';
import { EXIT_CODES } from '../util/exit.js';
import { Printer } from '../util/output.js';

const VERDICT_LABEL: Readonly<Record<DoctorCheckResult['verdict'], string>> = {
  pass: 'PASS',
  warn: 'WARN',
  fail: 'FAIL',
  skipped: 'SKIP',
};

function printHuman(printer: Printer, results: readonly DoctorCheckResult[]): void {
  const groups = new Map<string, DoctorCheckResult[]>();
  for (const r of results) {
    const list = groups.get(r.group) ?? [];
    list.push(r);
    groups.set(r.group, list);
  }
  for (const [group, list] of groups) {
    printer.info(`\n${group}`);
    for (const r of list) {
      const line = `  [${VERDICT_LABEL[r.verdict]}] ${r.name} (${r.durationMs.toFixed(0)}ms) - ${r.detail}`;
      if (r.verdict === 'fail') printer.error(line);
      else if (r.verdict === 'warn') printer.warn(line);
      else printer.info(line);
      if (r.fix !== undefined && (r.verdict === 'fail' || r.verdict === 'warn')) {
        printer.info(`         fix: ${r.fix}`);
      }
    }
  }
  const counts = { pass: 0, warn: 0, fail: 0, skipped: 0 };
  for (const r of results) counts[r.verdict] += 1;
  printer.info(
    `\n${counts.pass} passed, ${counts.warn} warned, ${counts.fail} failed, ${counts.skipped} skipped.`,
  );
}

function applyMechanicalFixes(
  printer: Printer,
  results: readonly DoctorCheckResult[],
  profilesDir: string,
): void {
  const defenderResult = results.find((r) => r.name === 'windows-defender');
  if (
    defenderResult !== undefined &&
    (defenderResult.verdict === 'warn' || defenderResult.verdict === 'fail')
  ) {
    const outcome = fixWindowsDefenderExclusion(profilesDir);
    printer.info(`--fix windows-defender: ${outcome.detail}`);
  }

  const uvResult = results.find((r) => r.name === 'uv-threadpool-size');
  if (uvResult !== undefined && uvResult.verdict === 'warn') {
    const envPath = join(process.cwd(), '.env');
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    if (!/^UV_THREADPOOL_SIZE=/m.test(existing)) {
      writeFileSync(
        envPath,
        `${existing}${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}UV_THREADPOOL_SIZE=16\n`,
      );
      printer.info(
        `--fix uv-threadpool-size: wrote UV_THREADPOOL_SIZE=16 to ${envPath} (takes effect on the next process start).`,
      );
    }
  }
}

/** `bgls doctor`. */
export const doctorCommand = defineCommand({
  meta: { name: 'doctor', description: 'Diagnose why BrowserGlass is not working.' },
  args: {
    ...GLOBAL_ARGS,
    fix: {
      type: 'boolean',
      description:
        'Apply known mechanical fixes. Never touches package versions or deletes profile data.',
      default: false,
    },
    check: { type: 'string', description: 'Run one named check only.' },
    'check-invariants': {
      type: 'boolean',
      description: 'Run the INV-* domain invariant checks against the store.',
      default: false,
    },
    deep: {
      type: 'boolean',
      description:
        'Also launch a real browser end to end (~8s): open a page, stream, inject a click, confirm a frame changed.',
      default: false,
    },
    'data-dir': { type: 'string', description: 'Root directory to inspect. Default ./bgls-data.' },
    'profiles-dir': { type: 'string', description: 'Default <data-dir>/profiles.' },
    store: { type: 'string', description: 'sqlite:./bgls.db. Default sqlite:<data-dir>/bgls.db.' },
    listen: {
      type: 'string',
      description: 'host:port doctor checks for availability. Default 127.0.0.1:7443.',
    },
  },
  async run({ args }) {
    const flags = resolveGlobalFlags(args);
    const printer = new Printer(flags);

    const dataDir = args['data-dir'] ?? defaultDataDir();
    const profilesDir = args['profiles-dir'] ?? join(dataDir, 'profiles');
    const storePath =
      args.store !== undefined ? args.store.replace(/^sqlite:/, '') : join(dataDir, 'bgls.db');
    const [listenHost, listenPortRaw] = (args.listen ?? '127.0.0.1:7443').split(':');
    const listenPort = Number(listenPortRaw ?? '7443') || 7443;

    if (args['check-invariants'] === true) {
      const results = await checkInvariants(storePath);
      printer.result(results, (r) => printHuman(printer, r));
      process.exitCode = results.some((r) => r.verdict === 'fail')
        ? EXIT_CODES.preconditionFailed
        : EXIT_CODES.ok;
      return;
    }

    const allChecks: Record<string, () => Promise<DoctorCheckResult>> = {
      'node-version': checkNodeVersion,
      'uv-threadpool-size': checkUvThreadpoolSize,
      'cpu-ram': checkCpuAndRam,
      'profile-dir-fs': () => checkProfileDirFilesystem(profilesDir),
      'windows-defender': () => checkWindowsDefender(profilesDir),
      chrome: () => checkChrome(),
      'chrome-launch': () => checkChromeLaunchTiming(join(dataDir, 'doctor-scratch')),
      'store-schema': () => checkStoreSchema(storePath),
      'store-lock': () => checkStoreLockHolder(storePath),
      profiles: () => checkProfiles(storePath),
      packages: () => checkPackageVersions(),
      plugins: () => checkPlugins(dataDir, resolvePluginsFileForRead(dataDir)),
      'network-listener': () => checkNetworkListener(listenHost ?? '127.0.0.1', listenPort),
      'network-outbound': () => checkNetworkOutbound(),
      'network-tunnel': () => checkNetworkTunnel(),
    };

    if (args.check !== undefined) {
      const fn = allChecks[args.check];
      if (fn === undefined) {
        printer.error(
          `Unknown check "${args.check}". Known checks: ${Object.keys(allChecks).join(', ')}.`,
        );
        process.exitCode = EXIT_CODES.usageError;
        return;
      }
      const result = await fn();
      printer.result([result], (r) => printHuman(printer, r));
      process.exitCode = result.verdict === 'fail' ? EXIT_CODES.preconditionFailed : EXIT_CODES.ok;
      return;
    }

    const results: DoctorCheckResult[] = [];
    for (const fn of Object.values(allChecks)) {
      results.push(await fn());
    }

    if (args.fix === true) {
      applyMechanicalFixes(printer, results, profilesDir);
      // Re-run only the checks a fix could plausibly have changed.
      const rerunNames = ['windows-defender', 'uv-threadpool-size'];
      for (const name of rerunNames) {
        const idx = results.findIndex((r) => r.name === name);
        if (idx !== -1) results[idx] = await allChecks[name]!();
      }
    }

    if (args.deep === true) {
      results.push(await runDeepCheck());
    }

    printer.result(results, (r) => printHuman(printer, r));
    process.exitCode = results.some((r) => r.verdict === 'fail')
      ? EXIT_CODES.preconditionFailed
      : EXIT_CODES.ok;
  },
});
