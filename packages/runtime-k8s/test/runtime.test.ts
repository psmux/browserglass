import { newId } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, LaunchError } from '@browserglass/protocol';
import type { LaunchRequest } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../src/not-implemented.js';
import { K8sRuntime } from '../src/runtime.js';

const neverAborted = { aborted: false } as const;

function makeLaunchRequest(): LaunchRequest {
  return {
    instanceId: newId('inst'),
    spec: DEFAULT_BROWSER_SPEC,
    profile: { profileId: null, path: '', containerPath: null, mode: 'ephemeral', lease: null },
    deadlineAt: Date.now() + 30000,
    labels: {},
    signal: neverAborted,
  };
}

describe('K8sRuntime.probe, outside a cluster (this test environment)', () => {
  it('resolves with status unavailable and inCluster false, never throws', async () => {
    const runtime = new K8sRuntime();
    const probe = await runtime.probe();
    expect(probe.status).toBe('unavailable');
    expect(probe.ok).toBe(false);
    expect(typeof probe.checkedAt).toBe('number');
  });
});

describe('K8sRuntime capabilities', () => {
  it('is real, not a stub placeholder', () => {
    const runtime = new K8sRuntime();
    const caps = runtime.capabilities();
    expect(caps.kind).toBe('k8s');
    expect(caps.survivesNodeRestart).toBe(true);
  });
});

describe('K8sRuntime stub methods', () => {
  it('launch() and attach() reject with LaunchError, never throwing synchronously', async () => {
    const runtime = new K8sRuntime();
    await expect(runtime.launch(makeLaunchRequest())).rejects.toThrow(LaunchError);
    await expect(
      runtime.attach({
        instanceId: newId('inst'),
        endpoint: null,
        recovered: null,
        deadlineAt: Date.now() + 5000,
        signal: neverAborted,
      }),
    ).rejects.toThrow(LaunchError);
  });

  it('terminate(), stats(), and list() throw NotImplementedError', async () => {
    const runtime = new K8sRuntime();
    const fakeHandle = { instanceId: newId('inst') } as Parameters<typeof runtime.terminate>[0];
    await expect(runtime.terminate(fakeHandle, 'clean')).rejects.toThrow(NotImplementedError);
    await expect(runtime.stats(fakeHandle)).rejects.toThrow(NotImplementedError);
    await expect(runtime.list()).rejects.toThrow(NotImplementedError);
  });

  it('dispose() resolves without throwing', async () => {
    const runtime = new K8sRuntime();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });
});
