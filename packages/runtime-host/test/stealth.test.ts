import type {
  StealthCheckResult,
  StealthProfile,
  StealthTargetContext,
} from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import type { HostRuntimeConfig } from '../src/config.js';
import {
  isStealthLevelEnabled,
  resolveRequiredStealthProfile,
  resolveStealthProfile,
  validateStealthProfiles,
} from '../src/stealth.js';
import { fixtureBrowserSpec } from './fixtures.js';

function fixtureProfile(overrides: Partial<StealthProfile> = {}): StealthProfile {
  return {
    name: 'fixture-profile',
    level: 'basic',
    version: '1.0.0',
    validatedChromeMajors: [],
    launchArgs: () => [],
    initScripts: () => [],
    onTargetAttached: async (_ctx: StealthTargetContext) => {},
    selfTest: async (_ctx: StealthTargetContext): Promise<readonly StealthCheckResult[]> => [],
    ...overrides,
  };
}

function fixtureConfig(overrides: Partial<HostRuntimeConfig> = {}): HostRuntimeConfig {
  return { nodeId: 'nod_test', ...overrides };
}

describe('isStealthLevelEnabled', () => {
  it('always permits off, with no enabledStealthLevels configured', () => {
    expect(isStealthLevelEnabled(fixtureConfig(), 'off')).toBe(true);
  });

  it('denies basic and full by default, when enabledStealthLevels is unset', () => {
    const config = fixtureConfig();
    expect(isStealthLevelEnabled(config, 'basic')).toBe(false);
    expect(isStealthLevelEnabled(config, 'full')).toBe(false);
  });

  it('permits exactly the levels listed in enabledStealthLevels', () => {
    const config = fixtureConfig({ enabledStealthLevels: ['basic'] });
    expect(isStealthLevelEnabled(config, 'basic')).toBe(true);
    expect(isStealthLevelEnabled(config, 'full')).toBe(false);
  });
});

describe('resolveStealthProfile', () => {
  it('finds the profile whose level exactly matches', () => {
    const basic = fixtureProfile({ name: 'p-basic', level: 'basic' });
    const full = fixtureProfile({ name: 'p-full', level: 'full' });
    const config = fixtureConfig({ stealthProfiles: [basic, full] });
    expect(resolveStealthProfile(config, 'basic')).toBe(basic);
    expect(resolveStealthProfile(config, 'full')).toBe(full);
  });

  it('never falls back across levels: a full profile does not satisfy a basic request or vice versa', () => {
    const full = fixtureProfile({ name: 'p-full', level: 'full' });
    const config = fixtureConfig({ stealthProfiles: [full] });
    expect(resolveStealthProfile(config, 'basic')).toBeNull();
  });

  it('returns null when no profile is registered at all', () => {
    expect(resolveStealthProfile(fixtureConfig(), 'basic')).toBeNull();
  });
});

describe('validateStealthProfiles', () => {
  it('accepts one profile per level', () => {
    expect(() =>
      validateStealthProfiles([
        fixtureProfile({ name: 'a', level: 'basic' }),
        fixtureProfile({ name: 'b', level: 'full' }),
      ]),
    ).not.toThrow();
  });

  it('refuses two profiles registered for the same level', () => {
    expect(() =>
      validateStealthProfiles([
        fixtureProfile({ name: 'a', level: 'basic' }),
        fixtureProfile({ name: 'b', level: 'basic' }),
      ]),
    ).toThrow(/registers two profiles/i);
  });
});

describe('resolveRequiredStealthProfile', () => {
  it('returns null for spec.stealth off, without consulting enabledStealthLevels or stealthProfiles at all', () => {
    const config = fixtureConfig();
    const spec = fixtureBrowserSpec({ stealth: 'off' });
    expect(resolveRequiredStealthProfile(config, spec)).toBeNull();
  });

  it('throws E_STEALTH_LEVEL_DISALLOWED when the level is not enabled, even if a profile is registered for it', () => {
    const profile = fixtureProfile({ level: 'full' });
    const config = fixtureConfig({ stealthProfiles: [profile], enabledStealthLevels: ['basic'] });
    const spec = fixtureBrowserSpec({ stealth: 'full' });
    try {
      resolveRequiredStealthProfile(config, spec);
      throw new Error('expected resolveRequiredStealthProfile to throw');
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_STEALTH_LEVEL_DISALLOWED');
    }
  });

  it('throws E_STEALTH_PROFILE_MISSING when the level is enabled but nothing is registered for it: the silent-failure case this module exists to remove', () => {
    const config = fixtureConfig({ enabledStealthLevels: ['basic'] });
    const spec = fixtureBrowserSpec({ stealth: 'basic' });
    try {
      resolveRequiredStealthProfile(config, spec);
      throw new Error('expected resolveRequiredStealthProfile to throw');
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_STEALTH_PROFILE_MISSING');
    }
  });

  it('returns the registered profile when the level is enabled and a profile exists for it', () => {
    const profile = fixtureProfile({ name: 'p-basic', level: 'basic' });
    const config = fixtureConfig({ stealthProfiles: [profile], enabledStealthLevels: ['basic'] });
    const spec = fixtureBrowserSpec({ stealth: 'basic' });
    expect(resolveRequiredStealthProfile(config, spec)).toBe(profile);
  });
});
