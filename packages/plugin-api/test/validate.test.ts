import { describe, expect, it } from 'vitest';
import { PLUGIN_KINDS, isPluginKind, validatePluginManifest } from '../src/index.js';

/** A minimal well-formed frame-encoder candidate, mutated per test below. */
function goodEncoder(): Record<string, unknown> {
  return {
    id: '@browserglass/plugin-video-export',
    kind: 'frame-encoder',
    hostApi: '^1.0.0',
    platforms: ['darwin', 'linux', 'win32'],
    summary: 'Encodes exported frames to mp4 via a system ffmpeg.',
    probe: async () => ({ usable: true, detail: 'ok' }),
    encode: async () => ({ outcome: 'encoded', detail: 'ok', bytesWritten: 1 }),
  };
}

/** A minimal well-formed permission-assist candidate, mutated per test below. */
function goodAssist(): Record<string, unknown> {
  return {
    id: 'bgls-plugin-macos-approve',
    kind: 'permission-assist',
    hostApi: '^1.0.0',
    platforms: ['darwin'],
    summary: 'Clicks the Allow remote debugging sheet via accessibility.',
    probe: async () => ({ usable: true, detail: 'ok' }),
    assist: async () => ({ outcome: 'resolved', detail: 'ok' }),
  };
}

describe('isPluginKind', () => {
  it('accepts both canonical kinds and rejects an unknown string', () => {
    for (const kind of PLUGIN_KINDS) expect(isPluginKind(kind)).toBe(true);
    expect(isPluginKind('video-encoder')).toBe(false);
    expect(isPluginKind(undefined)).toBe(false);
    expect(isPluginKind(3)).toBe(false);
  });
});

describe('validatePluginManifest', () => {
  it('accepts a well-formed frame-encoder plugin', () => {
    const result = validatePluginManifest(goodEncoder());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.kind).toBe('frame-encoder');
  });

  it('accepts a well-formed permission-assist plugin', () => {
    const result = validatePluginManifest(goodAssist());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.kind).toBe('permission-assist');
  });

  it('rejects a candidate that is not an object', () => {
    expect(validatePluginManifest(null).ok).toBe(false);
    expect(validatePluginManifest(undefined).ok).toBe(false);
    expect(validatePluginManifest('a plugin').ok).toBe(false);
    expect(validatePluginManifest(42).ok).toBe(false);
  });

  it('rejects an unknown plugin kind', () => {
    const candidate = goodEncoder();
    candidate['kind'] = 'video-encoder';
    const result = validatePluginManifest(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('kind');
  });

  it('rejects a candidate missing a required field', () => {
    for (const field of ['id', 'kind', 'hostApi', 'platforms', 'summary', 'probe']) {
      const candidate = goodEncoder();
      delete candidate[field];
      const result = validatePluginManifest(candidate);
      expect(result.ok, `expected missing '${field}' to fail validation`).toBe(false);
      if (!result.ok) expect(result.reason).toContain(field);
    }
  });

  it('rejects an empty id, an empty platforms array, and a non-string platform entry', () => {
    const empty = goodEncoder();
    empty['id'] = '';
    expect(validatePluginManifest(empty).ok).toBe(false);

    const noPlatforms = goodEncoder();
    noPlatforms['platforms'] = [];
    expect(validatePluginManifest(noPlatforms).ok).toBe(false);

    const badPlatform = goodEncoder();
    badPlatform['platforms'] = [1, 'darwin'];
    expect(validatePluginManifest(badPlatform).ok).toBe(false);
  });

  it('rejects a frame-encoder plugin with no encode function', () => {
    const candidate = goodEncoder();
    // biome-ignore lint/performance/noDelete: the case under test is a manifest with no encode key at all.
    delete candidate['encode'];
    const result = validatePluginManifest(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('encode');
  });

  it('rejects a permission-assist plugin with no assist function', () => {
    const candidate = goodAssist();
    // biome-ignore lint/performance/noDelete: the case under test is a manifest with no assist key at all.
    delete candidate['assist'];
    const result = validatePluginManifest(candidate);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('assist');
  });

  it("does not require the other kind's verb", () => {
    const encoder = goodEncoder();
    encoder['assist'] = undefined;
    expect(validatePluginManifest(encoder).ok).toBe(true);
  });
});
