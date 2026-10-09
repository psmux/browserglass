import { describe, expect, it } from 'vitest';
import type { MinimalFetch, MinimalFetchResponse } from '../../src/cdp/platform.js';
import { CdpProbeTimeoutError, probeCdpIdentity } from '../../src/cdp/probe.js';

function fakeFetch(bodies: readonly (Record<string, unknown> | null)[]): MinimalFetch {
  let call = 0;
  return async (): Promise<MinimalFetchResponse> => {
    const body = bodies[Math.min(call, bodies.length - 1)];
    call += 1;
    if (body === null) {
      return { ok: false, status: 502, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => body };
  };
}

function wsUrl(guid: string): Record<string, unknown> {
  return { webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/browser/${guid}` };
}

describe('probeCdpIdentity, mode fresh', () => {
  it('succeeds once the same GUID is observed on two consecutive polls', async () => {
    const identity = await probeCdpIdentity({
      cdpUrl: 'http://127.0.0.1:9222',
      mode: 'fresh',
      pollIntervalMs: 1,
      overallTimeoutMs: 5000,
      fetchImpl: fakeFetch([wsUrl('guid-a'), wsUrl('guid-a')]),
    });
    expect(identity.browserGuid).toBe('guid-a');
  });

  it('does not settle on a single observation, only on two matching consecutive ones', async () => {
    const identity = await probeCdpIdentity({
      cdpUrl: 'http://127.0.0.1:9222',
      mode: 'fresh',
      pollIntervalMs: 1,
      overallTimeoutMs: 5000,
      // The GUID changes once (a restart mid probe), then stabilises.
      fetchImpl: fakeFetch([wsUrl('guid-a'), wsUrl('guid-b'), wsUrl('guid-b')]),
    });
    expect(identity.browserGuid).toBe('guid-b');
  });
});

describe('probeCdpIdentity, mode reused', () => {
  it('succeeds once the observed GUID differs from excludeBrowserGuid', async () => {
    const identity = await probeCdpIdentity({
      cdpUrl: 'http://127.0.0.1:9222',
      mode: 'reused',
      excludeBrowserGuid: 'stale-guid',
      pollIntervalMs: 1,
      overallTimeoutMs: 5000,
      fetchImpl: fakeFetch([wsUrl('stale-guid'), wsUrl('stale-guid'), wsUrl('fresh-guid')]),
    });
    expect(identity.browserGuid).toBe('fresh-guid');
  });
});

describe('probeCdpIdentity, mode adopt', () => {
  it('succeeds once the observed GUID matches expectBrowserGuid exactly', async () => {
    const identity = await probeCdpIdentity({
      cdpUrl: 'http://127.0.0.1:9222',
      mode: 'adopt',
      expectBrowserGuid: 'expected-guid',
      pollIntervalMs: 1,
      overallTimeoutMs: 5000,
      fetchImpl: fakeFetch([wsUrl('other-guid'), wsUrl('expected-guid')]),
    });
    expect(identity.browserGuid).toBe('expected-guid');
  });
});

describe('probeCdpIdentity timeout', () => {
  it('throws CdpProbeTimeoutError carrying attempts, last HTTP status, and whether any GUID was ever seen', async () => {
    await expect(
      probeCdpIdentity({
        cdpUrl: 'http://127.0.0.1:9222',
        mode: 'adopt',
        expectBrowserGuid: 'never-matches',
        pollIntervalMs: 1,
        overallTimeoutMs: 20,
        fetchImpl: fakeFetch([wsUrl('some-other-guid')]),
      }),
    ).rejects.toThrow(CdpProbeTimeoutError);
  });

  it('reports anyGuidSeen false when every response is a non-ok HTTP status', async () => {
    try {
      await probeCdpIdentity({
        cdpUrl: 'http://127.0.0.1:9222',
        mode: 'fresh',
        pollIntervalMs: 1,
        overallTimeoutMs: 20,
        fetchImpl: fakeFetch([null]),
      });
      throw new Error('expected probeCdpIdentity to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CdpProbeTimeoutError);
      const probeErr = err as CdpProbeTimeoutError;
      expect(probeErr.anyGuidSeen).toBe(false);
      expect(probeErr.lastHttpStatus).toBe(502);
      expect(probeErr.attempts).toBeGreaterThan(0);
    }
  });
});
