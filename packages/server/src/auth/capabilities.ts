import type { Capability } from '@browserglass/protocol';

/** Result of intersecting three capability sets, naming exactly what was removed and why. */
export interface EffectiveCapsResult {
  readonly caps: readonly Capability[];
  readonly narrowed: readonly Capability[];
}

/**
 * Computes the effective capability set as `token.caps ∩ app.max_caps ∩
 * tenant.allowed_caps`. Called at
 * handshake and at every refresh; never cached across a capability change.
 * `narrowed` lists what the token asked for that this intersection removed,
 * in the token's original order, so an issuer can render an honest error.
 */
export function effectiveCapabilities(
  requested: readonly Capability[],
  appMaxCaps: readonly Capability[],
  tenantAllowedCaps: readonly Capability[],
): EffectiveCapsResult {
  const appSet = new Set(appMaxCaps);
  const tenantSet = new Set(tenantAllowedCaps);
  const caps: Capability[] = [];
  const narrowed: Capability[] = [];
  for (const cap of requested) {
    if (appSet.has(cap) && tenantSet.has(cap)) {
      caps.push(cap);
    } else {
      narrowed.push(cap);
    }
  }
  return { caps, narrowed };
}
