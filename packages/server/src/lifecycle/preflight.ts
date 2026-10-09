import { accessSync, constants as fsConstants, mkdirSync, statfsSync } from 'node:fs';
import type { BrowserRuntime } from '@browserglass/protocol';
import type { Logger } from '../config/logger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { PreflightResult } from './types.js';

/**
 * Optional, framework specific detectors a caller (typically a framework
 * adapter) may supply so the framework dependent checks
 * (`basepath-conflict`, `body-parser`) can run for real instead of being
 * reported `skipped`. `@browserglass/server` itself has no dependency on
 * Express or Fastify, so it cannot inspect their internals directly; this
 * is the seam a caller uses to hand that introspection in.
 */
export interface PreflightDetectors {
  /** Returns true when some app route is already registered under `basePath`. */
  readonly detectBasePathConflict?: () => boolean;
  /**
   * Returns the name of a body parsing middleware mounted ahead of
   * `bg.rest()` at or above `basePath`, or `null` when none is found.
   */
  readonly detectBodyParserAheadOfRest?: () => string | null;
}

async function timed(
  name: string,
  fn: () => Promise<Omit<PreflightResult, 'name' | 'durationMs'>>,
): Promise<PreflightResult> {
  const start = performance.now();
  try {
    const result = await fn();
    return { name, durationMs: performance.now() - start, ...result };
  } catch (err) {
    return {
      name,
      durationMs: performance.now() - start,
      verdict: 'fail',
      detail: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'This is an internal preflight bug; report it with the stack trace from logs.',
    };
  }
}

function skip(name: string, detail: string): PreflightResult {
  return { name, durationMs: 0, verdict: 'skipped', detail };
}

async function checkChrome(runtimes: readonly BrowserRuntime[]): Promise<PreflightResult> {
  return timed('chrome', async () => {
    const hostLike = runtimes.find((r) => r.kind === 'host' || r.kind === 'remote') ?? runtimes[0];
    if (hostLike === undefined) {
      return {
        verdict: 'fail',
        detail: 'No BrowserRuntime is configured.',
        fix: 'Pass runtime: hostRuntime({ channel: "chrome" }) (or an equivalent BrowserRuntime) to createBrowserGlass.',
      };
    }
    const probe = await hostLike.probe();
    if (probe.status === 'ready') {
      return {
        verdict: 'pass',
        detail: probe.detail,
        observed: { engine: probe.engine ?? undefined },
      };
    }
    return {
      verdict: probe.status === 'degraded' ? 'warn' : 'fail',
      detail: probe.detail,
      fix:
        probe.remediation ?? 'Install Chrome, or point runtime.executablePath at a working binary.',
      observed: { status: probe.status, engine: probe.engine ?? undefined },
    };
  });
}

async function checkChromeLaunch(
  runtimes: readonly BrowserRuntime[],
  strict: boolean,
): Promise<PreflightResult> {
  return timed('chrome-launch', async () => {
    const hostLike = runtimes.find((r) => r.kind === 'host');
    if (hostLike === undefined) {
      return { verdict: 'skipped', detail: 'No host runtime configured; nothing to launch.' };
    }
    const caps = hostLike.capabilities();
    if (caps.maxConcurrentBrowsers <= 0) {
      return {
        verdict: strict ? 'fail' : 'warn',
        detail: 'The host runtime reports it cannot launch any concurrent browsers right now.',
        fix: "Check the runtime's own preflight output for the underlying cause (disk, memory, or a launch queue at capacity).",
      };
    }
    return {
      verdict: 'pass',
      detail: `Host runtime reports capacity for up to ${caps.maxConcurrentBrowsers} concurrent browsers.`,
    };
  });
}

async function checkDocker(runtimes: readonly BrowserRuntime[]): Promise<PreflightResult> {
  return timed('docker', async () => {
    const docker = runtimes.find((r) => r.kind === 'docker');
    if (docker === undefined)
      return { verdict: 'skipped', detail: 'No docker runtime configured.' };
    const probe = await docker.probe();
    if (probe.status === 'ready') return { verdict: 'pass', detail: probe.detail };
    return {
      verdict: 'fail',
      detail: probe.detail,
      fix:
        probe.remediation ??
        'Ensure the Docker daemon is reachable and the configured image is present.',
    };
  });
}

async function checkDockerShm(runtimes: readonly BrowserRuntime[]): Promise<PreflightResult> {
  return timed('docker-shm', async () => {
    const docker = runtimes.find((r) => r.kind === 'docker');
    if (docker === undefined)
      return { verdict: 'skipped', detail: 'No docker runtime configured.' };
    const caps = docker.capabilities();
    if (!caps.resourceLimits.shmMb) {
      return {
        verdict: 'fail',
        detail:
          'The docker runtime reports it cannot configure a shared memory size for its containers.',
        fix: 'Configure the docker runtime with an explicit shmMb of at least 256 (recommended 512); Chrome renderers use /dev/shm for tile buffers and a too small value crashes them under load.',
      };
    }
    return {
      verdict: 'pass',
      detail: 'The docker runtime supports a configurable shared memory size.',
    };
  });
}

async function checkProfileDir(dir: string): Promise<PreflightResult> {
  return timed('profile-dir', async () => {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      return {
        verdict: 'fail',
        detail: `profiles.dir "${dir}" could not be created: ${err instanceof Error ? err.message : String(err)}.`,
        fix: 'Create the directory by hand and grant this process write access, or point profiles.dir at a writable path.',
      };
    }
    try {
      accessSync(dir, fsConstants.W_OK);
    } catch {
      return {
        verdict: 'fail',
        detail: `profiles.dir "${dir}" is not writable by this process.`,
        fix: `Grant write access to "${dir}" for the user this process runs as, or point profiles.dir elsewhere.`,
      };
    }
    return { verdict: 'pass', detail: `profiles.dir "${dir}" exists and is writable.` };
  });
}

async function checkProfileSpace(dir: string, minFreeBytes: number): Promise<PreflightResult> {
  return timed('profile-space', async () => {
    let free: number;
    try {
      const stats = statfsSync(dir);
      free = stats.bavail * stats.bsize;
    } catch (err) {
      return {
        verdict: 'warn',
        detail: `Could not measure free space at "${dir}": ${err instanceof Error ? err.message : String(err)}.`,
      };
    }
    if (free < minFreeBytes) {
      return {
        verdict: 'fail',
        detail: `"${dir}" has ${free} bytes free, below profiles.minFreeBytes (${minFreeBytes}). A profile directory that fills up mid session corrupts Chrome's LevelDB state, which surfaces as a full unexpected logout.`,
        fix: `Free at least ${minFreeBytes - free} more bytes on the volume backing "${dir}", or lower profiles.minFreeBytes.`,
        observed: { freeBytes: free, minFreeBytes },
      };
    }
    return {
      verdict: 'pass',
      detail: `"${dir}" has ${free} bytes free.`,
      observed: { freeBytes: free },
    };
  });
}

async function checkStore(config: ResolvedConfig): Promise<PreflightResult> {
  return timed('store', async () => {
    if (config.store === undefined) {
      return { verdict: 'skipped', detail: `No store configured (mode is "${config.mode}").` };
    }
    const ping = await config.store.ping();
    if (!ping.ok) {
      return {
        verdict: 'fail',
        detail: 'store.ping() reported not ok.',
        fix: "Check the store's own connection/health, then retry.",
      };
    }
    const version = await config.store.schemaVersion();
    if (config.migrate === 'check' && version === 0) {
      return {
        verdict: 'fail',
        detail: `Schema version is 0 (no migrations applied) and store.migrate is "check", which never applies migrations.`,
        fix: 'Run migrations out of band, or set store.migrate to "auto".',
      };
    }
    return {
      verdict: 'pass',
      detail: `Store reachable (${ping.latencyMs}ms), schema version ${version}.`,
      observed: { schemaVersion: version },
    };
  });
}

async function checkClock(clockSkewSeconds: number): Promise<PreflightResult> {
  return timed('clock', async () => {
    const before = performance.now();
    await new Promise((resolve) => setTimeout(resolve, 5).unref?.());
    const elapsed = performance.now() - before;
    if (elapsed < 0) {
      return {
        verdict: 'warn',
        detail: 'The monotonic clock (performance.now()) went backwards across a 5ms sleep.',
        fix: "This host's clock source is unreliable; timers tied to session and lease logic may misbehave.",
      };
    }
    return {
      verdict: 'pass',
      detail: `Monotonic clock is sane. Configured clock skew tolerance is ${clockSkewSeconds}s.`,
    };
  });
}

async function checkSigningKey(config: ResolvedConfig): Promise<PreflightResult> {
  return timed('signing-key', async () => {
    const usable = config.auth.keys.filter(
      (k) => (k.status ?? 'active') === 'active' && k.privateKey !== undefined,
    );
    if (usable.length === 0) {
      return {
        verdict: 'warn',
        detail:
          'No active signing key with private key material is configured; bg.tokens.issue() will fail.',
        fix: 'Pass at least one key in auth.keys with alg, publicKey, and privateKey set, or supply auth.resolver directly if this process never issues tokens.',
      };
    }
    return { verdict: 'pass', detail: `${usable.length} usable signing key(s) configured.` };
  });
}

async function checkBasePathConflict(
  detect: (() => boolean) | undefined,
  basePath: string,
): Promise<PreflightResult> {
  return timed('basepath-conflict', async () => {
    if (detect === undefined) {
      return {
        verdict: 'skipped',
        detail: 'No basePath conflict detector supplied by the framework adapter.',
      };
    }
    if (detect()) {
      return {
        verdict: 'warn',
        detail: `An app route already appears to be registered under "${basePath}".`,
        fix: 'Mount bg.rest()/bg.attach() at a basePath your app has not already claimed, or move the conflicting app route elsewhere.',
      };
    }
    return { verdict: 'pass', detail: `No route conflict detected under "${basePath}".` };
  });
}

async function checkBodyParser(
  detect: (() => string | null) | undefined,
  basePath: string,
): Promise<PreflightResult> {
  return timed('body-parser', async () => {
    if (detect === undefined) {
      return {
        verdict: 'skipped',
        detail: 'No body-parser detector supplied by the framework adapter (Express only).',
      };
    }
    const parserName = detect();
    if (parserName === null) {
      return { verdict: 'pass', detail: 'No body parser mounted ahead of bg.rest().' };
    }
    return {
      verdict: 'warn',
      detail: `"${parserName}" is mounted ahead of bg.rest() at or above "${basePath}", which drains the request body before BrowserGlass sees it. Every upload silently receives zero bytes.`,
      fix: `Mount bg.rest() before the body parser: app.use("${basePath}", bg.rest()) above app.use(express.json()), or scope the parser with a path exclusion.`,
    };
  });
}

/**
 * Runs the twelve named preflight checks inside `start()`, after config
 * validation and before the store opens. Every failing check's message
 * states what failed, the observed value, the expected value, and what to
 * do next. That is a hard rule: a message
 * satisfying only the first three is a bug.
 */
export async function runPreflight(
  config: ResolvedConfig,
  detectors: PreflightDetectors,
  logger: Logger,
): Promise<readonly PreflightResult[]> {
  const allChecks: Record<string, () => Promise<PreflightResult>> = {
    chrome: () => checkChrome(config.runtimes),
    'chrome-launch': () => checkChromeLaunch(config.runtimes, config.preflight.mode === 'fail'),
    docker: () => checkDocker(config.runtimes),
    'docker-shm': () => checkDockerShm(config.runtimes),
    'profile-dir': () => checkProfileDir(config.profiles.dir),
    'profile-space': () => checkProfileSpace(config.profiles.dir, config.profiles.minFreeBytes),
    port: async () =>
      skip('port', 'BrowserGlass never owns the HTTP server or its port; nothing to check here.'),
    store: () => checkStore(config),
    clock: () => checkClock(config.auth.clockSkewSeconds),
    'signing-key': () => checkSigningKey(config),
    'basepath-conflict': () =>
      checkBasePathConflict(detectors.detectBasePathConflict, config.basePath),
    'body-parser': () => checkBodyParser(detectors.detectBodyParserAheadOfRest, config.basePath),
  };

  const results: PreflightResult[] = [];
  for (const [name, run] of Object.entries(allChecks)) {
    if (config.preflight.skip.includes(name)) {
      results.push(skip(name, 'Skipped via preflight.skip.'));
      continue;
    }
    const result = await run();
    results.push(result);
    if (result.verdict === 'fail') {
      logger.error(
        { component: 'server', check: name, detail: result.detail },
        'preflight check failed',
      );
    } else if (result.verdict === 'warn') {
      logger.warn(
        { component: 'server', check: name, detail: result.detail },
        'preflight check warned',
      );
    }
  }
  return results;
}
