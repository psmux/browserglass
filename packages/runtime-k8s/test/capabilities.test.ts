import { describe, expect, it } from 'vitest';
import { buildK8sCapabilities } from '../src/capabilities.js';

describe('buildK8sCapabilities', () => {
  it('reports survivesNodeRestart and supportsAttach true', () => {
    const caps = buildK8sCapabilities('x64');
    expect(caps.survivesNodeRestart).toBe(true);
    expect(caps.supportsAttach).toBe(true);
  });

  it('reports no file bridge yet, pending the PVC design', () => {
    const caps = buildK8sCapabilities('x64');
    expect(caps.fileBridge).toEqual({ download: false, upload: false });
  });

  it('reports resource limits all true (Pod container resource requests/limits)', () => {
    const caps = buildK8sCapabilities('x64');
    expect(caps.resourceLimits).toEqual({
      cpus: true,
      memoryMb: true,
      shmMb: true,
      pidsLimit: true,
    });
  });

  it('kind is k8s', () => {
    expect(buildK8sCapabilities('x64').kind).toBe('k8s');
  });
});
