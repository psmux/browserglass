import type {
  StealthCheckResult,
  StealthProfile,
  StealthTargetContext,
} from '@browserglass/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureBrowserSpec } from './fixtures.js';

const connect = vi.fn();
const send = vi.fn();
const sessionFor = vi.fn();
const close = vi.fn();

vi.mock('@browserglass/core', () => ({
  createCdpBridge: vi.fn(() => ({ connect, send, sessionFor, close })),
}));

// Imported AFTER the mock so the module under test picks up the mocked `createCdpBridge`.
const { runStealthSelfTest } = await import('../src/stealth-self-test.js');

function fixtureProfile(overrides: Partial<StealthProfile> = {}): StealthProfile {
  return {
    name: 'fixture-profile',
    level: 'full',
    version: '1.0.0',
    validatedChromeMajors: [],
    launchArgs: () => [],
    initScripts: () => [],
    onTargetAttached: async (_ctx: StealthTargetContext) => {},
    selfTest: async (_ctx: StealthTargetContext): Promise<readonly StealthCheckResult[]> => [
      { check: 'fixture check', observed: 'x', expected: 'x', ok: true },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  connect.mockReset();
  send.mockReset();
  sessionFor.mockReset();
  close.mockReset();
  connect.mockResolvedValue({
    major: 152,
    full: 'Chrome/152.0.7977.64',
    product: 'Chrome/152.0.7977.64',
  });
  sessionFor.mockResolvedValue({
    id: 'S1',
    targetId: 'T1',
    type: 'page',
    attachedAt: 0,
    generation: 1,
    alive: true,
  });
  close.mockResolvedValue(undefined);
  send.mockImplementation(async (method: string) => {
    if (method === 'Target.createTarget') return { targetId: 'T1' };
    if (method === 'Runtime.evaluate') return { result: { value: undefined } };
    return {};
  });
});

describe('runStealthSelfTest', () => {
  it('connects directly when given a ws:// URL, without an HTTP round trip', async () => {
    const fetchImpl = vi.fn();
    await runStealthSelfTest({
      profile: fixtureProfile(),
      spec: fixtureBrowserSpec(),
      cdpUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
      fetchImpl,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledWith({ url: 'ws://127.0.0.1:9222/devtools/browser/abc' });
  });

  it('resolves the websocket URL via GET /json/version when given an HTTP origin', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/xyz' }),
    );
    await runStealthSelfTest({
      profile: fixtureProfile(),
      spec: fixtureBrowserSpec(),
      cdpUrl: 'http://127.0.0.1:9222',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:9222/json/version');
    expect(connect).toHaveBeenCalledWith({ url: 'ws://127.0.0.1:9222/devtools/browser/xyz' });
  });

  it('runs initScripts, onTargetAttached, then selfTest, in that order, against the attached session', async () => {
    const calls: string[] = [];
    const profile = fixtureProfile({
      initScripts: () => [{ name: 'a', source: '1+1' }],
      onTargetAttached: async () => {
        calls.push('onTargetAttached');
      },
      selfTest: async () => {
        calls.push('selfTest');
        return [{ check: 'c', observed: 'o', expected: 'e', ok: true }];
      },
    });
    send.mockImplementation(async (method: string, _params?: unknown) => {
      if (method === 'Target.createTarget') return { targetId: 'T1' };
      if (method === 'Runtime.evaluate') {
        calls.push('evaluate:initScript');
        return { result: { value: 2 } };
      }
      return {};
    });
    const report = await runStealthSelfTest({
      profile,
      spec: fixtureBrowserSpec(),
      cdpUrl: 'ws://x',
      fetchImpl: vi.fn(),
    });
    expect(calls).toEqual(['evaluate:initScript', 'onTargetAttached', 'selfTest']);
    expect(report.results).toEqual([{ check: 'c', observed: 'o', expected: 'e', ok: true }]);
  });

  it('reports allOk: false when any check failed', async () => {
    const profile = fixtureProfile({
      selfTest: async () => [
        { check: 'a', observed: '1', expected: '1', ok: true },
        { check: 'b', observed: '2', expected: '3', ok: false },
      ],
    });
    const report = await runStealthSelfTest({
      profile,
      spec: fixtureBrowserSpec(),
      cdpUrl: 'ws://x',
      fetchImpl: vi.fn(),
    });
    expect(report.allOk).toBe(false);
  });

  it('carries the profile identity and the connected Chrome major/product into the report', async () => {
    const profile = fixtureProfile({ name: 'p', level: 'full', version: '2.0.0' });
    const report = await runStealthSelfTest({
      profile,
      spec: fixtureBrowserSpec(),
      cdpUrl: 'ws://x',
      fetchImpl: vi.fn(),
    });
    expect(report.profile).toEqual({ name: 'p', level: 'full', version: '2.0.0' });
    expect(report.chromeMajor).toBe(152);
    expect(report.chromeProduct).toBe('Chrome/152.0.7977.64');
  });

  it('closes the target and the bridge even when selfTest throws', async () => {
    const profile = fixtureProfile({
      selfTest: async () => {
        throw new Error('boom');
      },
    });
    await expect(
      runStealthSelfTest({
        profile,
        spec: fixtureBrowserSpec(),
        cdpUrl: 'ws://x',
        fetchImpl: vi.fn(),
      }),
    ).rejects.toThrow('boom');
    expect(send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'T1' });
    expect(close).toHaveBeenCalled();
  });

  it('throws when GET /json/version fails to answer with a webSocketDebuggerUrl', async () => {
    const fetchImpl = vi.fn(async () => Response.json({}));
    await expect(
      runStealthSelfTest({
        profile: fixtureProfile(),
        spec: fixtureBrowserSpec(),
        cdpUrl: 'http://127.0.0.1:9222',
        fetchImpl,
      }),
    ).rejects.toThrow('webSocketDebuggerUrl');
  });
});
