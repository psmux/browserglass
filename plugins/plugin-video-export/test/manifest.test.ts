import { validatePluginManifest } from '@browserglass/plugin-api';
import { describe, expect, it } from 'vitest';
import plugin from '../src/index.js';

describe('the plugin default export', () => {
  it("validates against @browserglass/plugin-api's own run-time validator, not just its TypeScript type", () => {
    const result = validatePluginManifest(plugin);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.kind).toBe('frame-encoder');
    expect(result.manifest.id).toBe('@browserglass/plugin-video-export');
  });

  it('declares every platform the design asks a frame-encoder plugin to run on', () => {
    expect(plugin.platforms).toEqual(['darwin', 'linux', 'win32']);
  });

  it('probe() never throws, even with no ffmpeg findable in this environment or not', async () => {
    await expect(plugin.probe()).resolves.toMatchObject({
      usable: expect.any(Boolean),
      detail: expect.any(String),
    });
  });
});
