import { describe, expect, it } from 'vitest';
import type { BrowserSpec } from '../../src/domain/entities.js';
import {
  DEFAULT_BROWSER_SPEC,
  STRICT_OVERRIDE_POLICY,
  TRUSTED_OVERRIDE_POLICY,
  resolveBrowserSpec,
} from '../../src/domain/settings.js';

describe('BrowserSpec.isolation defaults', () => {
  it('DEFAULT_BROWSER_SPEC keeps the historical tab-per-window behaviour', () => {
    expect(DEFAULT_BROWSER_SPEC.isolation).toBe('tab');
  });
});

describe('BrowserSpec.isolation is not a per-request override, under either policy', () => {
  it('a pool template can set isolation: window (full spec layer, overwritten wholesale)', () => {
    const pool: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, isolation: 'window' };
    const { spec, rejected } = resolveBrowserSpec(
      { defaults: DEFAULT_BROWSER_SPEC, pool },
      STRICT_OVERRIDE_POLICY,
    );
    expect(spec.isolation).toBe('window');
    expect(rejected).toEqual([]);
  });

  it('a request cannot flip a pool from tab to window: rejected as not_overridable, under STRICT_OVERRIDE_POLICY', () => {
    const pool: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, isolation: 'tab' };
    const { spec, rejected } = resolveBrowserSpec(
      { defaults: DEFAULT_BROWSER_SPEC, pool, request: { isolation: 'window' } },
      STRICT_OVERRIDE_POLICY,
    );
    expect(spec.isolation).toBe('tab');
    expect(rejected).toEqual([
      {
        field: 'isolation',
        requestedValue: 'window',
        reason: 'not_overridable',
        fallbackValue: 'tab',
      },
    ]);
  });

  it('same rejection under TRUSTED_OVERRIDE_POLICY: isolation spawns real OS windows, an operator decision, not a per-acquire one', () => {
    const pool: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, isolation: 'tab' };
    const { spec, rejected } = resolveBrowserSpec(
      { defaults: DEFAULT_BROWSER_SPEC, pool, request: { isolation: 'window' } },
      TRUSTED_OVERRIDE_POLICY,
    );
    expect(spec.isolation).toBe('tab');
    expect(rejected).toEqual([
      {
        field: 'isolation',
        requestedValue: 'window',
        reason: 'not_overridable',
        fallbackValue: 'tab',
      },
    ]);
  });
});
