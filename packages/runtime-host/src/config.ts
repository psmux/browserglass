/**
 * `@browserglass/runtime-host` configuration: the node-local settings that
 * are not part of `BrowserSpec` (which the router already resolved) and are
 * not part of `ProfileFs`'s per-call arguments.
 */

import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { BrowserChannel, StealthProfile } from '@browserglass/protocol';
import type { TrashKind } from '@browserglass/protocol';

/**
 * Where the durable state file and profile root live by default, per
 * platform. Overridable by
 * `HostRuntimeConfig.stateDir`/`profileRoot`, which themselves default to
 * `BGLS_STATE_DIR`/`BGLS_PROFILE_ROOT` when set.
 */
export function defaultStateDir(): string {
  if (process.env['BGLS_STATE_DIR']) return process.env['BGLS_STATE_DIR'];
  switch (platform()) {
    case 'win32':
      return join(process.env['PROGRAMDATA'] ?? 'C:\\ProgramData', 'bgls');
    case 'darwin':
      return join(homedir(), 'Library', 'Application Support', 'bgls');
    default:
      return '/var/lib/bgls';
  }
}

/** Default profile root, sibling to the state directory unless overridden. */
export function defaultProfileRoot(): string {
  if (process.env['BGLS_PROFILE_ROOT']) return process.env['BGLS_PROFILE_ROOT'];
  return join(defaultStateDir(), 'profiles');
}

/** `SupervisorConfig` defaults. */
export const DEFAULT_SUPERVISOR_CONFIG = {
  gracePeriodMs: 5000,
  cdpCloseTimeoutMs: 3000,
  statsIntervalMs: 10000,
  unhealthyProbes: 3,
  killOnShutdown: false,
} as const;

/** `SweeperConfig.trashRetentionMsByKind` defaults. */
export const DEFAULT_TRASH_RETENTION_MS_BY_KIND: Readonly<Record<TrashKind, number>> = {
  ephemeral: 900_000,
  deleted: 604_800_000,
  quarantine: 2_592_000_000,
  migration: 86_400_000,
};

/** Sweeper pass defaults, node side. */
export const DEFAULT_SWEEPER_CONFIG = {
  intervalMs: 60_000,
  maxDeletesPerPass: 8,
  maxBytesPerPass: 8 * 1024 ** 3,
  createTimeoutMs: 120_000,
  batchLimit: 64,
} as const;

/** `maxInlineCopyBytes`: above this, a non COW recursive copy refuses with `E_COPY_TOO_SLOW`. */
export const MAX_INLINE_COPY_BYTES = 256 * 1024 * 1024;

/** Windows `MAX_PATH` guard: refuse to materialise a profile root longer than this. */
export const WINDOWS_MAX_PROFILE_ROOT_CHARS = 120;

/** The corruption probe's total time budget. */
export const CORRUPTION_PROBE_BUDGET_MS = 400;

/** `profileLeaseTtlMs` mirror, used only for the ephemeral sweeper's default reclaim window here; the router owns the authoritative lease. */
export const PROFILE_LEASE_TTL_MS = 30_000;
/** `profileLeaseStealGraceMs` mirror, used only for the ephemeral sweeper's default reclaim window here; the router owns the authoritative lease. */
export const PROFILE_LEASE_STEAL_GRACE_MS = 5_000;

/** Reserved node config for `runtimes.host.*`, the parts `HostRuntime` reads directly. */
export interface HostRuntimeConfig {
  /** This node's id, recorded into `RuntimeInventoryEntry` labels and the state file. */
  nodeId: string;
  /** Overrides binary discovery's default search order per channel. */
  binaries?: Partial<Record<BrowserChannel, string>>;
  /** Directory holding `runtime-host.json`. Defaults to {@link defaultStateDir}. */
  stateDir?: string;
  /** Root directory `ProfileFs` operates under. Defaults to {@link defaultProfileRoot}. */
  profileRoot?: string;
  /** `env` keys an app-supplied `BrowserSpec.env` may set (`env` itself stays app-forbidden per the deny table, this is the operator's own allowlist for values the runtime itself forwards). */
  allowedEnvKeys?: readonly string[];
  /** Maps to `BGLS_UNSAFE_NO_SANDBOX=1`. Logs a warning on every launch when true. */
  allowNoSandbox?: boolean;
  /**
   * Stealth levels this node permits a `BrowserSpec.stealth` request to
   * reach. `'off'` needs no listing here, it is always permitted (there is
   * nothing to gate: no profile runs). `'basic'` and `'full'` both need
   * explicit listing; leaving this unset permits neither, which is the
   * safe default for a "permission gate" (`resolveRequiredStealthProfile`,
   * `stealth.ts`, refuses rather than silently downgrading a level this
   * node has not opted into). Spelled `'off'` rather than the `'none'`
   * this field used before, to actually match `BrowserSpec.stealth`'s own
   * three values; a `'none'` entry here could never match a real request.
   */
  enabledStealthLevels?: readonly ('off' | 'basic' | 'full')[];
  /**
   * The `StealthProfile` implementations this node may run. This is the
   * registration slot `StealthProfile` (`@browserglass/protocol`,
   * `runtime.ts`) previously had no way to reach: at most one profile per
   * `level` (`HostRuntime.create` refuses a config with two profiles
   * naming the same level, rather than silently picking one), resolved by
   * `resolveStealthProfile` (`stealth.ts`) against `BrowserSpec.stealth`
   * on every launch. `@browserglass/runtime-host` also exports
   * `BASIC_STEALTH_PROFILE` (`stealth-profiles/basic.ts`), a reference
   * `'basic'` implementation an operator may register here as-is or use
   * as a starting point for its own.
   */
  stealthProfiles?: readonly StealthProfile[];
  supervisor?: Partial<typeof DEFAULT_SUPERVISOR_CONFIG>;
  /** Leave browsers running when `dispose()` is called, unless explicitly configured otherwise. */
  killOnShutdown?: boolean;
  maxConcurrentBrowsers?: number;
}

/** Resolves `allowNoSandbox` from config, falling through to the `BGLS_UNSAFE_NO_SANDBOX=1` env spelling (one switch, two spellings). */
export function resolveAllowNoSandbox(config: HostRuntimeConfig): boolean {
  if (config.allowNoSandbox !== undefined) return config.allowNoSandbox;
  return process.env['BGLS_UNSAFE_NO_SANDBOX'] === '1';
}
