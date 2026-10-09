import type { StealthTargetContext } from '@browserglass/protocol';
import { describe, expect, it, vi } from 'vitest';
import { BASIC_STEALTH_PROFILE } from '../../src/stealth-profiles/basic.js';
import { fixtureBrowserSpec } from '../fixtures.js';

function fixtureCtx(overrides: Partial<StealthTargetContext> = {}): StealthTargetContext {
  return {
    cdpSessionId: 'S1',
    targetId: 'T1',
    evaluate: vi.fn(async () => undefined),
    send: vi.fn(async () => ({})),
    ...overrides,
  };
}

describe('BASIC_STEALTH_PROFILE identity', () => {
  it('is registered at level basic, with a name and version for regression tracking', () => {
    expect(BASIC_STEALTH_PROFILE.level).toBe('basic');
    expect(BASIC_STEALTH_PROFILE.name).toBeTruthy();
    expect(BASIC_STEALTH_PROFILE.version).toBeTruthy();
  });
});

describe('BASIC_STEALTH_PROFILE.launchArgs', () => {
  it('returns no launch args: the flag-level tells it addresses are already unconditional in flags.ts', () => {
    expect(BASIC_STEALTH_PROFILE.launchArgs(fixtureBrowserSpec())).toEqual([]);
  });
});

describe('BASIC_STEALTH_PROFILE.initScripts', () => {
  it('returns exactly one script patching navigator.webdriver', () => {
    const scripts = BASIC_STEALTH_PROFILE.initScripts(fixtureBrowserSpec());
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.source).toContain('webdriver');
    expect(scripts[0]?.name).toContain('navigator-webdriver');
  });
});

describe('BASIC_STEALTH_PROFILE.onTargetAttached', () => {
  it('calls Emulation.setAutomationOverride with enabled: false on the target session', async () => {
    const send = vi.fn(async () => ({}));
    const ctx = fixtureCtx({ send });
    await BASIC_STEALTH_PROFILE.onTargetAttached(ctx);
    expect(send).toHaveBeenCalledWith('Emulation.setAutomationOverride', { enabled: false });
  });

  it('does not throw when the CDP command is rejected (older Chrome build)', async () => {
    const send = vi.fn(async () => {
      throw new Error('unknown method');
    });
    const ctx = fixtureCtx({ send });
    await expect(BASIC_STEALTH_PROFILE.onTargetAttached(ctx)).resolves.toBeUndefined();
  });
});

describe('BASIC_STEALTH_PROFILE.selfTest', () => {
  it('reports ok: true when navigator.webdriver evaluates to undefined', async () => {
    const ctx = fixtureCtx({ evaluate: vi.fn(async () => undefined) });
    const results = await BASIC_STEALTH_PROFILE.selfTest(ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      check: 'navigator.webdriver',
      expected: 'undefined',
      ok: true,
    });
  });

  it('reports ok: false when navigator.webdriver still evaluates to true, the patch failed to take effect', async () => {
    const ctx = fixtureCtx({ evaluate: vi.fn(async () => true) });
    const results = await BASIC_STEALTH_PROFILE.selfTest(ctx);
    expect(results[0]).toMatchObject({ check: 'navigator.webdriver', observed: 'true', ok: false });
  });

  it('reports ok: false, not a thrown error, when evaluate itself fails', async () => {
    const ctx = fixtureCtx({
      evaluate: vi.fn(async () => {
        throw new Error('target gone');
      }),
    });
    const results = await BASIC_STEALTH_PROFILE.selfTest(ctx);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.observed).toContain('target gone');
  });
});
