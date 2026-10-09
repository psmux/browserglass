import type { StealthTargetContext } from '@browserglass/protocol';
import { describe, expect, it, vi } from 'vitest';
import { MEASURED_STEALTH_PROFILE } from '../../src/stealth-profiles/measured.js';
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

/** JSON.stringify'd `READ_UA_STATE` result for a headless=new-looking page. */
function headlessUaJson(): string {
  return JSON.stringify({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36',
    uad: {
      brands: [
        { brand: 'Chromium', version: '152' },
        { brand: 'Not?A_Brand', version: '24' },
        { brand: 'Google Chrome', version: '152' },
      ],
      mobile: false,
      platform: 'Windows',
      platformVersion: '19.0.0',
      architecture: 'x86',
      model: '',
      fullVersionList: [
        { brand: 'Chromium', version: '152.0.7977.64' },
        { brand: 'Not?A_Brand', version: '24.0.0.0' },
        { brand: 'Google Chrome', version: '152.0.7977.64' },
      ],
    },
  });
}

/** Same shape, headful: no "Headless" marker, matching the measurement recorded in measured.ts's own header comment. */
function headfulUaJson(): string {
  return JSON.stringify({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    uad: {
      brands: [
        { brand: 'Chromium', version: '152' },
        { brand: 'Not?A_Brand', version: '24' },
        { brand: 'Google Chrome', version: '152' },
      ],
      mobile: false,
      platform: 'Windows',
      platformVersion: '19.0.0',
      architecture: 'x86',
      model: '',
      fullVersionList: [{ brand: 'Google Chrome', version: '152.0.7977.64' }],
    },
  });
}

describe('MEASURED_STEALTH_PROFILE identity', () => {
  it('is registered at level full (basic is already taken by BASIC_STEALTH_PROFILE), with a name and version', () => {
    expect(MEASURED_STEALTH_PROFILE.level).toBe('full');
    expect(MEASURED_STEALTH_PROFILE.name).toBeTruthy();
    expect(MEASURED_STEALTH_PROFILE.version).toBeTruthy();
  });

  it('records validatedChromeMajors from a real measured run, not an empty placeholder', () => {
    expect(MEASURED_STEALTH_PROFILE.validatedChromeMajors).toContain(152);
  });
});

describe('MEASURED_STEALTH_PROFILE.launchArgs', () => {
  it('returns no launch args: --user-agent= cannot pass ARG_ALLOW, and every other fix is CDP-level', () => {
    expect(MEASURED_STEALTH_PROFILE.launchArgs(fixtureBrowserSpec())).toEqual([]);
  });
});

describe('MEASURED_STEALTH_PROFILE.initScripts', () => {
  it('returns no scripts at all: every JS-level patch considered was measured unnecessary or regressive', () => {
    expect(MEASURED_STEALTH_PROFILE.initScripts(fixtureBrowserSpec())).toEqual([]);
  });
});

describe('MEASURED_STEALTH_PROFILE.onTargetAttached', () => {
  it('calls Emulation.setAutomationOverride with enabled: false, same as basic.ts', async () => {
    const send = vi.fn(async (method: string) =>
      method === 'Runtime.evaluate' ? { result: { value: headfulUaJson() } } : {},
    );
    const ctx = fixtureCtx({ send, evaluate: vi.fn(async () => headfulUaJson()) });
    await MEASURED_STEALTH_PROFILE.onTargetAttached(ctx);
    expect(send).toHaveBeenCalledWith('Emulation.setAutomationOverride', { enabled: false });
  });

  it('does not call Emulation.setUserAgentOverride when the UA already has no Headless marker (headful launch)', async () => {
    const send = vi.fn(async () => ({}));
    const ctx = fixtureCtx({ send, evaluate: vi.fn(async () => headfulUaJson()) });
    await MEASURED_STEALTH_PROFILE.onTargetAttached(ctx);
    expect(send).not.toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.anything());
  });

  it('strips "Headless" from navigator.userAgent via Emulation.setUserAgentOverride when the live UA carries it', async () => {
    const send = vi.fn(async () => ({}));
    const ctx = fixtureCtx({ send, evaluate: vi.fn(async () => headlessUaJson()) });
    await MEASURED_STEALTH_PROFILE.onTargetAttached(ctx);
    expect(send).toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.objectContaining({
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
      }),
    );
  });

  it('preserves userAgentData verbatim in the override, never sending a bare userAgent with no metadata (the measured empty-brands regression)', async () => {
    const send = vi.fn(async () => ({}));
    const ctx = fixtureCtx({ send, evaluate: vi.fn(async () => headlessUaJson()) });
    await MEASURED_STEALTH_PROFILE.onTargetAttached(ctx);
    const call = send.mock.calls.find((c) => c[0] === 'Emulation.setUserAgentOverride');
    expect(call).toBeDefined();
    const params = call?.[1] as { userAgentMetadata?: { brands?: unknown[] } };
    expect(params.userAgentMetadata).toBeDefined();
    expect(params.userAgentMetadata?.brands).toEqual([
      { brand: 'Chromium', version: '152' },
      { brand: 'Not?A_Brand', version: '24' },
      { brand: 'Google Chrome', version: '152' },
    ]);
  });

  it('omits userAgentMetadata (rather than sending an empty one) when the page has no userAgentData at all (insecure context)', async () => {
    const send = vi.fn(async () => ({}));
    const raw = JSON.stringify({
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0 Safari/537.36',
      uad: null,
    });
    const ctx = fixtureCtx({ send, evaluate: vi.fn(async () => raw) });
    await MEASURED_STEALTH_PROFILE.onTargetAttached(ctx);
    const call = send.mock.calls.find((c) => c[0] === 'Emulation.setUserAgentOverride');
    expect(call).toBeDefined();
    const params = call?.[1] as Record<string, unknown>;
    expect('userAgentMetadata' in params).toBe(false);
  });

  it('does not throw when Emulation.setAutomationOverride is rejected (older Chrome build)', async () => {
    const send = vi.fn(async (method: string) => {
      if (method === 'Emulation.setAutomationOverride') throw new Error('unknown method');
      return {};
    });
    const ctx = fixtureCtx({ send, evaluate: vi.fn(async () => headfulUaJson()) });
    await expect(MEASURED_STEALTH_PROFILE.onTargetAttached(ctx)).resolves.toBeUndefined();
  });

  it('does not throw when the UA-state evaluate call itself fails', async () => {
    const ctx = fixtureCtx({
      evaluate: vi.fn(async () => {
        throw new Error('target gone');
      }),
    });
    await expect(MEASURED_STEALTH_PROFILE.onTargetAttached(ctx)).resolves.toBeUndefined();
  });
});

describe('MEASURED_STEALTH_PROFILE.selfTest', () => {
  function evaluateRouter(webdriverValue: unknown, uaState: string) {
    return vi.fn(async (expr: string) => {
      if (expr === 'navigator.webdriver') return webdriverValue;
      if (expr === 'navigator.userAgent') return JSON.parse(uaState).ua as string;
      if (expr.includes("'webdriver'")) return 'function get webdriver() { [native code] }';
      if (expr.includes("'userAgent'")) return 'function get userAgent() { [native code] }';
      return uaState;
    });
  }

  it('reports every check ok: true against a correctly patched, headful-looking target', async () => {
    const ctx = fixtureCtx({ evaluate: evaluateRouter(false, headfulUaJson()) });
    const results = await MEASURED_STEALTH_PROFILE.selfTest(ctx);
    expect(results.length).toBeGreaterThanOrEqual(4);
    for (const r of results) expect(r.ok).toBe(true);
  });

  it('reports navigator.webdriver value check ok: false when the value is still true', async () => {
    const ctx = fixtureCtx({ evaluate: evaluateRouter(true, headfulUaJson()) });
    const results = await MEASURED_STEALTH_PROFILE.selfTest(ctx);
    const check = results.find((r) => r.check === 'navigator.webdriver value');
    expect(check).toMatchObject({ ok: false, observed: 'true' });
  });

  it('reports the webdriver shape check ok: false when the getter is a JS-defined shim, not native code (the basic.ts regression this check exists to catch)', async () => {
    const evaluate = vi.fn(async (expr: string) => {
      if (expr === 'navigator.webdriver') return false;
      if (expr.includes("'webdriver'")) return '() => undefined';
      if (expr === 'navigator.userAgent') return JSON.parse(headfulUaJson()).ua as string;
      if (expr.includes("'userAgent'")) return 'function get userAgent() { [native code] }';
      return headfulUaJson();
    });
    const ctx = fixtureCtx({ evaluate });
    const results = await MEASURED_STEALTH_PROFILE.selfTest(ctx);
    const check = results.find((r) => r.check === 'navigator.webdriver getter shape');
    expect(check?.ok).toBe(false);
  });

  it('reports the Headless-marker check ok: false when navigator.userAgent still contains "Headless"', async () => {
    const ctx = fixtureCtx({ evaluate: evaluateRouter(false, headlessUaJson()) });
    const results = await MEASURED_STEALTH_PROFILE.selfTest(ctx);
    const check = results.find((r) => r.check === 'navigator.userAgent has no "Headless" marker');
    expect(check?.ok).toBe(false);
  });

  it('passes the userAgentData-not-wiped check vacuously when there is no userAgentData at all', async () => {
    const noUad = JSON.stringify({ ua: 'Mozilla/5.0 Chrome/152.0.0.0', uad: null });
    const ctx = fixtureCtx({ evaluate: evaluateRouter(false, noUad) });
    const results = await MEASURED_STEALTH_PROFILE.selfTest(ctx);
    const check = results.find((r) => r.check === 'navigator.userAgentData not wiped');
    expect(check).toMatchObject({
      ok: true,
      observed: expect.stringContaining('no userAgentData') as unknown as string,
    });
  });

  it('fails the userAgentData-not-wiped check when brands came back empty (the measured setUserAgentOverride-without-metadata trap)', async () => {
    const wiped = JSON.stringify({
      ua: 'Mozilla/5.0 Chrome/152.0.0.0',
      uad: {
        brands: [],
        mobile: false,
        platform: '',
        platformVersion: '',
        architecture: '',
        model: '',
        fullVersionList: [],
      },
    });
    const ctx = fixtureCtx({ evaluate: evaluateRouter(false, wiped) });
    const results = await MEASURED_STEALTH_PROFILE.selfTest(ctx);
    const check = results.find((r) => r.check === 'navigator.userAgentData not wiped');
    expect(check?.ok).toBe(false);
  });

  it('reports ok: false, not a thrown error, when evaluate itself fails', async () => {
    const ctx = fixtureCtx({
      evaluate: vi.fn(async () => {
        throw new Error('target gone');
      }),
    });
    const results = await MEASURED_STEALTH_PROFILE.selfTest(ctx);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.ok).toBe(false);
  });
});
