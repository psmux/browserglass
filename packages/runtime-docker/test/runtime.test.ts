import { newId } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, LaunchError } from '@browserglass/protocol';
import type { LaunchRequest } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { NotImplementedError } from '../src/not-implemented.js';
import { DockerRuntime } from '../src/runtime.js';

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

describe('DockerRuntime.probe, no daemon reachable in this test environment', () => {
  it('resolves with status unavailable rather than throwing', async () => {
    const runtime = new DockerRuntime();
    const probe = await runtime.probe();
    // This suite does not assume a Docker daemon is running; if one
    // happens to be reachable on the CI/dev machine, ready is fine too.
    // What matters, and what the "Done when" criterion requires, is that
    // probe() never throws and reports a clean status either way.
    expect(['ready', 'unavailable']).toContain(probe.status);
    expect(typeof probe.checkedAt).toBe('number');
  }, 10000);
});

describe('DockerRuntime capabilities', () => {
  it('is real, not a stub placeholder', () => {
    const runtime = new DockerRuntime();
    const caps = runtime.capabilities();
    expect(caps.kind).toBe('docker');
    expect(caps.resourceLimits.cpus).toBe(true);
  });
});

describe('DockerRuntime stub methods', () => {
  it('launch() throws LaunchError coded E_DOCKER_UNAVAILABLE, preserving the real signature', async () => {
    const runtime = new DockerRuntime();
    await expect(runtime.launch(makeLaunchRequest())).rejects.toThrow(LaunchError);
    try {
      await runtime.launch(makeLaunchRequest());
      throw new Error('expected launch() to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchError);
      expect((err as LaunchError).code).toBe('E_DOCKER_UNAVAILABLE');
    }
  });

  it('attach() throws LaunchError coded E_DOCKER_UNAVAILABLE', async () => {
    const runtime = new DockerRuntime();
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
    const runtime = new DockerRuntime();
    const fakeHandle = { instanceId: newId('inst') } as Parameters<typeof runtime.terminate>[0];
    await expect(runtime.terminate(fakeHandle, 'clean')).rejects.toThrow(NotImplementedError);
    await expect(runtime.stats(fakeHandle)).rejects.toThrow(NotImplementedError);
    await expect(runtime.list()).rejects.toThrow(NotImplementedError);
  });

  it('dispose() resolves without throwing', async () => {
    const runtime = new DockerRuntime();
    await expect(runtime.dispose()).resolves.toBeUndefined();
  });
});
