/**
 * Stealth profile registration and resolution for `HostRuntime`.
 *
 * `BrowserSpec.stealth` (`@browserglass/protocol`, `entities.ts`) and
 * `StealthProfile` (same package, `runtime.ts`) were both fully specified
 * before this file existed, but nothing connected them: a spec could ask
 * for `'basic'` or `'full'`, the request would be validated, stored, and
 * handed to `HostRuntime.launch()`, and then nothing would happen. This
 * module is that connection. `HostRuntimeConfig.stealthProfiles`
 * (`config.ts`) is where an operator registers implementations;
 * {@link resolveRequiredStealthProfile} is what `HostRuntime.doLaunch`
 * calls on every launch to turn one `BrowserSpec.stealth` value into
 * either the profile that must run, or a `LaunchError` naming exactly why
 * none can. There is deliberately no third outcome ("run nothing, say
 * nothing"): that outcome is the defect this module exists to remove.
 */

import type { BrowserSpec, StealthProfile } from '@browserglass/protocol';
import type { HostRuntimeConfig } from './config.js';
import { stealthLevelDisallowedError, stealthProfileMissingError } from './errors.js';

/**
 * True for `'off'` unconditionally (there is no profile to gate). For
 * `'basic'`/`'full'`, true only when `config.enabledStealthLevels` lists
 * that exact level. An unset `enabledStealthLevels` permits neither: this
 * is a permission gate, and a gate with nothing configured should deny,
 * not default-allow.
 */
export function isStealthLevelEnabled(
  config: HostRuntimeConfig,
  level: BrowserSpec['stealth'],
): boolean {
  if (level === 'off') return true;
  return (config.enabledStealthLevels ?? []).includes(level);
}

/**
 * The registered profile whose `level` exactly matches, or `null` if none
 * is registered. Exact match only: a `'full'` request never falls back to
 * a `'basic'` profile, and vice versa, because that fallback would be
 * exactly the silent downgrade this feature is required not to perform.
 */
export function resolveStealthProfile(
  config: HostRuntimeConfig,
  level: 'basic' | 'full',
): StealthProfile | null {
  const profiles = config.stealthProfiles ?? [];
  return profiles.find((profile) => profile.level === level) ?? null;
}

/**
 * Refuses a `stealthProfiles` list that registers more than one profile
 * for the same `level`: resolving that ambiguity by picking the first
 * match would silently ignore every profile after it, the same silent
 * failure this whole module exists to prevent, just moved one step
 * earlier. Called once, from `HostRuntime.create`, so a misconfigured
 * node fails at startup rather than on whichever launch happens to be
 * the one that needed the level nobody noticed was doubly registered.
 */
export function validateStealthProfiles(profiles: readonly StealthProfile[]): void {
  const seenBy = new Map<string, string>();
  for (const profile of profiles) {
    const prior = seenBy.get(profile.level);
    if (prior !== undefined) {
      throw new Error(
        `HostRuntimeConfig.stealthProfiles registers two profiles for level '${profile.level}': '${prior}' and '${profile.name}'. Register at most one profile per level.`,
      );
    }
    seenBy.set(profile.level, profile.name);
  }
}

/**
 * Resolves `spec.stealth` into the `StealthProfile` that must run for this
 * launch. Returns `null` only for `spec.stealth === 'off'`, the one case
 * where "no profile" is the correct answer rather than a defect. For
 * `'basic'`/`'full'`, throws a `LaunchError` rather than returning `null`
 * when:
 *
 * * the level is not in `config.enabledStealthLevels`
 *   (`E_STEALTH_LEVEL_DISALLOWED`), or
 * * the level is enabled but no profile is registered for it
 *   (`E_STEALTH_PROFILE_MISSING`).
 *
 * Before this function existed, both of those situations either did not
 * exist as a check at all, or (for the permission gate) had no failure
 * path defined; a caller got back a browser that silently ran no stealth
 * patches at all, indistinguishable from one that had never asked.
 */
export function resolveRequiredStealthProfile(
  config: HostRuntimeConfig,
  spec: BrowserSpec,
): StealthProfile | null {
  if (spec.stealth === 'off') return null;
  if (!isStealthLevelEnabled(config, spec.stealth)) {
    throw stealthLevelDisallowedError(spec.stealth, config.enabledStealthLevels ?? []);
  }
  const profile = resolveStealthProfile(config, spec.stealth);
  if (!profile) {
    throw stealthProfileMissingError(spec.stealth);
  }
  return profile;
}
