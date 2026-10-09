import { describe, expect, it } from 'vitest';
import { buildDockerCapabilities } from '../src/capabilities.js';

describe('buildDockerCapabilities', () => {
  it('reports resource limits all true, per the container-per-browser decision', () => {
    const caps = buildDockerCapabilities('x64');
    expect(caps.resourceLimits).toEqual({
      cpus: true,
      memoryMb: true,
      shmMb: true,
      pidsLimit: true,
    });
  });

  it('omits chrome from channels on arm64, where no official build exists', () => {
    const caps = buildDockerCapabilities('arm64');
    expect(caps.channels).not.toContain('chrome');
    expect(caps.channels).toContain('chromium');
  });

  it('includes chrome on x64', () => {
    const caps = buildDockerCapabilities('x64');
    expect(caps.channels).toContain('chrome');
  });

  it('advertises xvfb-headful, never off', () => {
    const caps = buildDockerCapabilities('x64');
    expect(caps.headlessModes).toContain('xvfb-headful');
    expect(caps.headlessModes).not.toContain('off');
  });

  it('kind is docker', () => {
    expect(buildDockerCapabilities('x64').kind).toBe('docker');
  });
});
