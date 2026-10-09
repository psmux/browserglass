import { validatePluginManifest } from '@browserglass/plugin-api';
import { describe, expect, it } from 'vitest';
import plugin from '../src/index.js';

describe('the plugin default export', () => {
  it("validates against @browserglass/plugin-api's own run-time validator, not just its TypeScript type", () => {
    const result = validatePluginManifest(plugin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe('permission-assist');
    expect(result.manifest.id).toBe('@browserglass/plugin-permission-assist');
  });

  it('declares darwin only, never a platform this plugin cannot actually act on', () => {
    // The whole point of this test: a false capability claim (declaring
    // win32/linux for a macOS-only AppleScript automator) is exactly the
    // class of bug the plugin design refuses to repeat.
    expect(plugin.platforms).toEqual(['darwin']);
  });

  it('has a non-empty summary and a semver-shaped hostApi range', () => {
    expect(plugin.summary.length).toBeGreaterThan(0);
    expect(plugin.hostApi).toMatch(/^[\^~]?\d+\.\d+\.\d+/);
  });

  it('probe() never throws, on this machine or any other', async () => {
    await expect(plugin.probe()).resolves.toMatchObject({
      usable: expect.any(Boolean),
      detail: expect.any(String),
    });
  });

  it('probe() honestly reports unusable off macOS, which this machine is', async () => {
    // This test only asserts something meaningful when it actually runs on
    // a non-darwin machine; on darwin it degrades to checking probe()'s
    // shape, already covered above.
    if (process.platform === 'darwin') return;
    const result = await plugin.probe();
    expect(result.usable).toBe(false);
    expect(result.detail).toContain(process.platform);
  });

  it("assist() never throws even for a situation status it does not expect, and reports 'unavailable' instead", async () => {
    const bogusSituation = {
      status: 'live',
      userDataDir: 'C:/chrome',
      label: 'chrome',
      cdpUrl: null,
      detail: 'not actually a permission-assist situation',
      // biome-ignore lint/suspicious/noExplicitAny: deliberately passes a situation shape the type does not allow.
    } as any;
    const controller = new AbortController();
    const result = await plugin.assist(bogusSituation, controller.signal);
    expect(result.outcome).toBe('unavailable');
  });
});
