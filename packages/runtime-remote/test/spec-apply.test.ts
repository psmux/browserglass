import { DEFAULT_BROWSER_SPEC } from '@browserglass/protocol';
import type { BrowserSpec } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import type { CdpCommandSender } from '../src/cdp-client.js';
import { applyResolvedSpec } from '../src/spec-apply.js';

/** A `CdpCommandSender` that records every call and never fails, unless `failMethods` names one. */
function fakeSender(failMethods: readonly string[] = []): CdpCommandSender & {
  calls: {
    method: string;
    scope: 'browser' | 'page';
    params: Record<string, unknown> | undefined;
  }[];
} {
  const calls: {
    method: string;
    scope: 'browser' | 'page';
    params: Record<string, unknown> | undefined;
  }[] = [];
  return {
    calls,
    async sendBrowser(method, params) {
      calls.push({ method, scope: 'browser', params });
      if (failMethods.includes(method)) throw new Error(`${method} failed`);
      return {};
    },
    async sendPage(method, params) {
      calls.push({ method, scope: 'page', params });
      if (failMethods.includes(method)) throw new Error(`${method} failed`);
      return {};
    },
  };
}

describe('applyResolvedSpec, a spec at package defaults', () => {
  it('produces zero incidents and applies nothing beyond the always-safe viewport override', async () => {
    const sender = fakeSender();
    const result = await applyResolvedSpec(sender, DEFAULT_BROWSER_SPEC, true);
    expect(result.incidents).toEqual([]);
    // viewport is always applied, since it is always honourable and CDP-cheap even at the default value.
    expect(sender.calls.map((c) => c.method)).toEqual(['Emulation.setDeviceMetricsOverride']);
  });
});

describe('applyResolvedSpec, unhonourable fields', () => {
  it('records exactly one SPEC_IGNORED incident per unhonourable field that differs from the default, and does not throw', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      channel: 'msedge',
      headless: 'off',
      stealth: 'basic',
      acceptDownloads: true,
    };
    const result = await applyResolvedSpec(sender, spec, true);
    const fields = result.incidents.map((i) => i.field).sort();
    expect(fields).toEqual(['acceptDownloads', 'channel', 'headless', 'stealth']);
    for (const incident of result.incidents) {
      expect(incident.code).toBe('SPEC_IGNORED');
      expect(typeof incident.at).toBe('number');
    }
  });

  it('does not record an incident for an unhonourable field left at its package default', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, channel: 'msedge' };
    const result = await applyResolvedSpec(sender, spec, true);
    expect(result.incidents.map((i) => i.field)).toEqual(['channel']);
  });
});

describe('applyResolvedSpec, honourable fields', () => {
  it('applies viewport via Emulation.setDeviceMetricsOverride', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      viewport: { width: 1024, height: 768, deviceScaleFactor: 2 },
    };
    const result = await applyResolvedSpec(sender, spec, true);
    expect(result.appliedFields).toContain('viewport');
    const call = sender.calls.find((c) => c.method === 'Emulation.setDeviceMetricsOverride');
    expect(call?.params).toMatchObject({ width: 1024, height: 768, deviceScaleFactor: 2 });
  });

  it('applies userAgent plus clientHints via Emulation.setUserAgentOverride', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      userAgent: 'MyAgent/1.0',
      clientHints: {
        brands: [{ brand: 'MyAgent', version: '1' }],
        platform: 'Windows',
        platformVersion: '10',
        architecture: 'x86',
        model: '',
        mobile: false,
        fullVersion: '1.0',
      },
    };
    const result = await applyResolvedSpec(sender, spec, true);
    expect(result.appliedFields).toContain('userAgent');
    const call = sender.calls.find((c) => c.method === 'Emulation.setUserAgentOverride');
    expect(call?.params?.['userAgent']).toBe('MyAgent/1.0');
  });

  it('applies timezoneId and locale independently', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      timezoneId: 'Europe/London',
      locale: 'en-GB',
    };
    const result = await applyResolvedSpec(sender, spec, true);
    expect(result.appliedFields).toEqual(expect.arrayContaining(['timezoneId', 'locale']));
    expect(sender.calls.some((c) => c.method === 'Emulation.setTimezoneOverride')).toBe(true);
    expect(sender.calls.some((c) => c.method === 'Emulation.setLocaleOverride')).toBe(true);
  });

  it('applies permissions via Browser.grantPermissions, browser-scoped, without needing a page session', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      permissions: ['geolocation', 'notifications'],
    };
    const result = await applyResolvedSpec(sender, spec, false);
    expect(result.appliedFields).toContain('permissions');
    const call = sender.calls.find((c) => c.method === 'Browser.grantPermissions');
    expect(call?.scope).toBe('browser');
    expect(call?.params).toMatchObject({ permissions: ['geolocation', 'notifications'] });
  });

  it('applies geolocation via Emulation.setGeolocationOverride', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      geolocation: { latitude: 51.5, longitude: -0.12, accuracy: 10 },
    };
    const result = await applyResolvedSpec(sender, spec, true);
    expect(result.appliedFields).toContain('geolocation');
  });

  it('applies colorScheme and reducedMotion together via one Emulation.setEmulatedMedia call', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    };
    const result = await applyResolvedSpec(sender, spec, true);
    expect(result.appliedFields).toEqual(expect.arrayContaining(['colorScheme', 'reducedMotion']));
    expect(sender.calls.filter((c) => c.method === 'Emulation.setEmulatedMedia')).toHaveLength(1);
  });
});

describe('applyResolvedSpec, fields that need a page session but none exists', () => {
  it('records a SPEC_IGNORED incident instead of throwing when hasPageSession is false', async () => {
    const sender = fakeSender();
    const spec: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, timezoneId: 'Europe/London' };
    const result = await applyResolvedSpec(sender, spec, false);
    expect(result.incidents.map((i) => i.field)).toContain('timezoneId');
    expect(result.appliedFields).not.toContain('timezoneId');
  });
});

describe('applyResolvedSpec, an honourable field CDP itself refuses to apply', () => {
  it('records a SPEC_IGNORED incident rather than throwing when the underlying CDP call fails', async () => {
    const sender = fakeSender(['Emulation.setLocaleOverride']);
    const spec: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, locale: 'en-GB' };
    const result = await applyResolvedSpec(sender, spec, true);
    expect(result.incidents.map((i) => i.field)).toContain('locale');
    expect(result.appliedFields).not.toContain('locale');
  });
});
