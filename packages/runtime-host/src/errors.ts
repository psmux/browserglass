/**
 * `LaunchError` factory helpers for the codes `HostRuntime` actually
 * throws. `LaunchError` itself, and the full 19-code `LaunchErrorCode`
 * union, live in `@browserglass/protocol`; this module only
 * builds instances with this package's own remediation text.
 */

import { LaunchError } from '@browserglass/protocol';
import type { LaunchPhase } from '@browserglass/protocol';

/** `E_BINARY_NOT_FOUND`: no Chrome binary for the requested channel. */
export function binaryNotFoundError(
  channel: string,
  searched: readonly string[],
  phase: LaunchPhase = 'preflight',
): LaunchError {
  return new LaunchError({
    code: 'E_BINARY_NOT_FOUND',
    phase,
    message: `no runnable '${channel}' binary found`,
    remediation: `install Chrome for channel '${channel}', or set BGLS_CHROME_PATH / runtimes.host.binaries.${channel}`,
    retryable: false,
    context: { channel, searchedCount: searched.length },
  });
}

/** `E_PROFILE_LOCKED` / lease refusal: the profile has no valid lease, or the fence is stale. */
export function noValidLeaseError(profileId: string | null): LaunchError {
  return new LaunchError({
    code: 'E_LEASE_LOST',
    phase: 'preflight',
    message: `profile ${profileId ?? '(none)'} has no valid, unexpired lease; refusing to launch`,
    remediation: 'the router must acquire a lease before calling launch()',
    retryable: true,
    context: { profileId: profileId ?? '' },
  });
}

/** `E_PROFILE_FOREIGN_OWNER`: another supervisor's Chrome holds the data dir. */
export function foreignOwnerError(profilePath: string, pids: readonly number[]): LaunchError {
  return new LaunchError({
    code: 'E_PROFILE_FOREIGN_OWNER',
    phase: 'reconcile',
    message: `profile directory ${profilePath} is held by a Chrome this process did not launch (pids: ${pids.join(', ')})`,
    remediation: `confirm the owning process, then terminate it manually if it is stale: kill ${pids.join(' ')}`,
    retryable: false,
    context: { profilePath, pids: pids.join(',') },
  });
}

/** `E_PROFILE_LOCKED`: `SingletonLock`/process table names a live pid this launch cannot classify as ours. */
export function profileLockedError(profilePath: string, pid: number): LaunchError {
  return new LaunchError({
    code: 'E_PROFILE_LOCKED',
    phase: 'reconcile',
    message: `profile directory ${profilePath} is locked by live pid ${pid}`,
    remediation: `kill ${pid} if it is stale, then retry`,
    retryable: false,
    context: { profilePath, pid },
  });
}

/** `E_NO_DISPLAY`: a headful launch on Linux with neither `DISPLAY` nor `WAYLAND_DISPLAY` set, which Chrome cannot start under. */
export function noDisplayError(): LaunchError {
  return new LaunchError({
    code: 'E_NO_DISPLAY',
    phase: 'preflight',
    message: "headless: 'off' needs a display, and neither DISPLAY nor WAYLAND_DISPLAY is set",
    remediation:
      "use headless: 'new', or run under a display server (for example xvfb-run) so DISPLAY is set",
    retryable: false,
  });
}

/** `E_CDP_TIMEOUT`: the CDP endpoint never confirmed the expected identity before the deadline. */
export function cdpTimeoutError(detail: string, phase: LaunchPhase = 'cdpWait'): LaunchError {
  return new LaunchError({
    code: 'E_CDP_TIMEOUT',
    phase,
    message: `CDP endpoint never confirmed readiness: ${detail}`,
    remediation:
      'check for a proxy or firewall intercepting loopback traffic (NO_PROXY), and that the profile directory is writable',
    retryable: true,
  });
}

/** `E_STEALTH_LEVEL_DISALLOWED`: `spec.stealth` named a level this node's `enabledStealthLevels` does not list. */
export function stealthLevelDisallowedError(
  level: 'basic' | 'full',
  enabledLevels: readonly string[],
): LaunchError {
  return new LaunchError({
    code: 'E_STEALTH_LEVEL_DISALLOWED',
    phase: 'preflight',
    message: `spec.stealth: '${level}' is not permitted on this node (enabledStealthLevels: [${enabledLevels.join(', ')}])`,
    remediation: `add '${level}' to runtimes.host.enabledStealthLevels on this node if this level is meant to be reachable, or lower the request`,
    retryable: false,
    context: { level, enabledLevels: enabledLevels.join(',') },
  });
}

/**
 * `E_STEALTH_PROFILE_MISSING`: `spec.stealth` named an enabled level, but
 * `HostRuntimeConfig.stealthProfiles` has no profile registered for it.
 * The failure this whole feature exists to make reachable: before it, a
 * request like this was accepted and ran no stealth patches at all,
 * silently.
 */
export function stealthProfileMissingError(level: 'basic' | 'full'): LaunchError {
  return new LaunchError({
    code: 'E_STEALTH_PROFILE_MISSING',
    phase: 'preflight',
    message: `spec.stealth: '${level}' is enabled on this node, but no StealthProfile is registered for level '${level}'`,
    remediation: `register a StealthProfile for level '${level}' in runtimes.host.stealthProfiles (a reference '${'basic'}' implementation ships as BASIC_STEALTH_PROFILE), or remove '${level}' from enabledStealthLevels so this request is refused instead of silently unpatched`,
    retryable: false,
    context: { level },
  });
}

/**
 * `E_ARG_DENIED`, specific to a registered `StealthProfile`'s own
 * `launchArgs(spec)` output. Unlike `spec.extraArgs` (untrusted app input,
 * silently filtered by `buildLaunchArgs`), a denied arg from a REGISTERED
 * profile is an operator/vendor configuration defect: the profile author
 * expected that flag to reach Chrome, and it did not. Failing loudly here
 * is the same "silence must not survive" reasoning as the two errors
 * above, applied to the launch-arg half of the injection slot rather than
 * its permission-gate half.
 */
export function stealthArgDeniedError(
  profileName: string,
  deniedArgs: readonly string[],
): LaunchError {
  return new LaunchError({
    code: 'E_ARG_DENIED',
    phase: 'preflight',
    message: `StealthProfile '${profileName}'.launchArgs() returned an argument ARG_ALLOW/ARG_DENY rejects: ${deniedArgs.join(', ')}`,
    remediation: `fix StealthProfile '${profileName}' to only request arguments ARG_ALLOW permits; launchArgs() gets no exemption from that screening`,
    retryable: false,
    context: { profileName, deniedArgs: deniedArgs.join(',') },
  });
}
