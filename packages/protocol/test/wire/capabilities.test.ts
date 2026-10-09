import { describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  CONTROL_REQUEST_CAPABILITY_RULE,
  type Capability,
  EVALUATE_USER_GESTURE_CAPABILITY_RULE,
  INSTANCE_RESTART_CAPABILITY_RULE,
  INTERCEPT_BODY_CAPABILITY_RULE,
  MAX_CAPS,
  MIN_CAPS,
  PARAMETER_DEPENDENT_CAPABILITY_RULES,
  PROBE_CAPABILITY_RULE,
  ROLE_BUNDLES,
  isCapability,
} from '../../src/wire/capabilities.js';

/**
 * The full expected inventory, written out rather than derived from
 * `CAPABILITIES` itself.
 *
 * The count assertion below used to be the only guard, and a bare integer
 * is a weak one: it fails when a capability is added, which is the point,
 * but it goes green again the moment someone bumps the number, which
 * defeats it. Listing the names means adding a capability requires saying
 * WHICH capability, in a file a reviewer of a security change is looking at
 * anyway, and it additionally catches a rename or a reorder that a count
 * cannot see.
 */
const EXPECTED_CAPABILITIES: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'clipboard.read',
  'clipboard.write',
  'upload',
  'download',
  'devtools',
  'automation',
  'instance.create',
  'instance.restart',
  'instance.destroy',
  'profile.read',
  'profile.write',
  'admin',
  'cdp',
  'evaluate',
  'intercept',
];

describe('capabilities', () => {
  it('is exactly the expected capability inventory, in order', () => {
    expect([...CAPABILITIES]).toEqual([...EXPECTED_CAPABILITIES]);
    expect(CAPABILITIES.length).toBe(21);
    expect(MIN_CAPS).toBe(1);
    // `MAX_CAPS` bounds a token's `caps` claim, so it must track the
    // inventory: a capability nobody can put in a token is a capability
    // nobody can be granted.
    expect(MAX_CAPS).toBe(CAPABILITIES.length);
  });

  it('only agent and owner grant evaluate or intercept, and no other role bundle does', () => {
    // Both are escalation-shaped: `evaluate` authors code in the page,
    // `intercept` decides what the page may talk to. `agent` and `owner`
    // carry both deliberately: an `agent` token is meant to drive a
    // browser completely, with nothing left to opt into (see
    // `AGENT_BUNDLE`'s own comment in `capabilities.ts`), and `owner`
    // is widened to match so it is never weaker than `agent`.
    // `observer`, `driver` and `operator` still must not carry either.
    for (const [role, bundle] of Object.entries(ROLE_BUNDLES)) {
      if (role === 'agent' || role === 'owner') {
        expect(bundle, `${role} must grant evaluate`).toContain('evaluate');
        expect(bundle, `${role} must grant intercept`).toContain('intercept');
      } else {
        expect(bundle, `${role} must not grant evaluate`).not.toContain('evaluate');
        expect(bundle, `${role} must not grant intercept`).not.toContain('intercept');
      }
    }
  });

  it('isCapability accepts every canonical capability and rejects an unknown string', () => {
    for (const cap of CAPABILITIES) {
      expect(isCapability(cap)).toBe(true);
    }
    expect(isCapability('superadmin')).toBe(false);
  });

  it('every role bundle only contains canonical capabilities, with no duplicates', () => {
    for (const bundle of Object.values(ROLE_BUNDLES)) {
      const seen = new Set<string>();
      for (const cap of bundle) {
        expect(isCapability(cap)).toBe(true);
        expect(seen.has(cap)).toBe(false);
        seen.add(cap);
      }
    }
  });

  it('preserves the documented role-bundle asymmetries', () => {
    expect(ROLE_BUNDLES.observer).toEqual(['view']);
    expect(ROLE_BUNDLES.driver).not.toContain('clipboard.read');
    expect(ROLE_BUNDLES.driver).toContain('clipboard.write');
    expect(ROLE_BUNDLES.driver).not.toContain('instance.restart');
    expect(ROLE_BUNDLES.operator).toContain('instance.restart');
    expect(ROLE_BUNDLES.operator).toContain('profile.read');
    expect(ROLE_BUNDLES.operator).not.toContain('profile.write');
    // `agent` is meant to drive a browser completely, with nothing left
    // to opt into: it carries every capability that means "operate this
    // one browser", `evaluate`, `cdp` and `intercept` included, and
    // withholds only the fleet/tenant-management capabilities (see
    // `AGENT_BUNDLE`'s own comment in `capabilities.ts`).
    expect(ROLE_BUNDLES.agent).toContain('automation');
    expect(ROLE_BUNDLES.agent).toContain('devtools');
    expect(ROLE_BUNDLES.agent).toContain('download');
    expect(ROLE_BUNDLES.agent).toContain('clipboard.read');
    expect(ROLE_BUNDLES.agent).toContain('evaluate');
    expect(ROLE_BUNDLES.agent).toContain('cdp');
    expect(ROLE_BUNDLES.agent).toContain('intercept');
    // Deliberate reversal (not a caught regression): an agent must be able
    // to open and close its OWN browser, so `instance.create`,
    // `instance.restart` and `instance.destroy` moved from withheld to
    // granted (see `AGENT_BUNDLE`'s own comment in `capabilities.ts` for
    // why this is safe: `BrowserRouter.release`'s scope check confines an
    // instance-scoped agent token to its own instance, both via the
    // in-process call and the REST `DELETE /v1/instances/:instanceId`
    // handler, which shares that same `release()` call).
    expect(ROLE_BUNDLES.agent).toContain('instance.create');
    expect(ROLE_BUNDLES.agent).toContain('instance.restart');
    expect(ROLE_BUNDLES.agent).toContain('instance.destroy');
    expect(ROLE_BUNDLES.agent).not.toContain('profile.read');
    expect(ROLE_BUNDLES.agent).not.toContain('profile.write');
    expect(ROLE_BUNDLES.agent).not.toContain('admin');
    // `owner` is widened to match `agent` (an `owner` token must be able
    // to do everything an `agent` token can do) and is now the full
    // 21-member capability set.
    expect(ROLE_BUNDLES.owner.length).toBe(21);
    for (const cap of CAPABILITIES) {
      expect(ROLE_BUNDLES.owner, `owner must contain ${cap}`).toContain(cap);
    }
  });

  it('has exactly the five parameter-dependent capability rules, one per message', () => {
    expect(PARAMETER_DEPENDENT_CAPABILITY_RULES).toHaveLength(5);
    expect(PARAMETER_DEPENDENT_CAPABILITY_RULES).toContain(PROBE_CAPABILITY_RULE);
    expect(PARAMETER_DEPENDENT_CAPABILITY_RULES).toContain(CONTROL_REQUEST_CAPABILITY_RULE);
    expect(PARAMETER_DEPENDENT_CAPABILITY_RULES).toContain(INSTANCE_RESTART_CAPABILITY_RULE);
    expect(PARAMETER_DEPENDENT_CAPABILITY_RULES).toContain(EVALUATE_USER_GESTURE_CAPABILITY_RULE);
    expect(PARAMETER_DEPENDENT_CAPABILITY_RULES).toContain(INTERCEPT_BODY_CAPABILITY_RULE);
    // Named messages, not just a count, for the same reason the inventory
    // above is written out: a rule added without a message name is a rule
    // the server's generic `checkCapability` will silently never match.
    expect(PARAMETER_DEPENDENT_CAPABILITY_RULES.map((r) => r.message).sort()).toEqual([
      'control.request',
      'instance.restart',
      'page.evaluate',
      'request.gate.enable',
      'target.probe',
    ]);
    // Every capability a rule names must itself be canonical. A typo here
    // fails open: `checkCapability` would look for a capability no token
    // can ever carry, so the rule would refuse everyone, or (worse, for a
    // base capability) never match and gate nothing.
    for (const rule of PARAMETER_DEPENDENT_CAPABILITY_RULES) {
      expect(isCapability(rule.baseCapability)).toBe(true);
      expect(isCapability(rule.additionalCapability)).toBe(true);
    }
  });

  it('page.evaluate requires control only when userGesture is true', () => {
    expect(EVALUATE_USER_GESTURE_CAPABILITY_RULE.baseCapability).toBe('evaluate');
    expect(EVALUATE_USER_GESTURE_CAPABILITY_RULE.additionalCapability).toBe('control');
    expect(EVALUATE_USER_GESTURE_CAPABILITY_RULE.appliesWhen({})).toBe(false);
    expect(EVALUATE_USER_GESTURE_CAPABILITY_RULE.appliesWhen({ userGesture: false })).toBe(false);
    // Strictly `true`, never truthy: an accidental `userGesture: 'yes'`
    // must not silently escalate the capability requirement, the same
    // strictness the other three rules use.
    expect(EVALUATE_USER_GESTURE_CAPABILITY_RULE.appliesWhen({ userGesture: 'true' })).toBe(false);
    expect(EVALUATE_USER_GESTURE_CAPABILITY_RULE.appliesWhen({ userGesture: true })).toBe(true);
  });

  /**
   * `evaluate` is never IMPLIED by another capability: holding `control`,
   * `automation`, `devtools`, `cdp` or `admin` never carries `evaluate`
   * along with it, so a bundle that lacks `evaluate` cannot reach it by
   * any other capability it holds. See the `evaluate` member's own
   * comment in `capabilities.ts` for why each of those five in particular
   * is not enough on its own. `agent` and `owner` still carry `evaluate`
   * and `cdp` directly, by deliberate, explicit inclusion in those two
   * bundles, not by implication from anything else the bundle grants.
   */
  it('evaluate and cdp are never implied by another capability in a bundle that lacks them', () => {
    for (const [name, bundle] of Object.entries(ROLE_BUNDLES)) {
      if (name === 'agent' || name === 'owner') continue;
      expect(bundle, `${name} must not carry evaluate`).not.toContain('evaluate');
      expect(bundle, `${name} must not carry cdp`).not.toContain('cdp');
    }
  });

  it('target.probe requires probe only when detail is full', () => {
    expect(PROBE_CAPABILITY_RULE.appliesWhen({})).toBe(false);
    expect(PROBE_CAPABILITY_RULE.appliesWhen({ detail: 'hover' })).toBe(false);
    expect(PROBE_CAPABILITY_RULE.appliesWhen({ detail: 'full' })).toBe(true);
  });

  it('control.request requires admin only when force is true', () => {
    expect(CONTROL_REQUEST_CAPABILITY_RULE.appliesWhen({})).toBe(false);
    expect(CONTROL_REQUEST_CAPABILITY_RULE.appliesWhen({ force: false })).toBe(false);
    expect(CONTROL_REQUEST_CAPABILITY_RULE.appliesWhen({ force: true })).toBe(true);
  });

  it('instance.restart requires profile.write only when preserveProfile is false', () => {
    expect(INSTANCE_RESTART_CAPABILITY_RULE.appliesWhen({})).toBe(false);
    expect(INSTANCE_RESTART_CAPABILITY_RULE.appliesWhen({ preserveProfile: true })).toBe(false);
    expect(INSTANCE_RESTART_CAPABILITY_RULE.appliesWhen({ preserveProfile: false })).toBe(true);
  });
});
