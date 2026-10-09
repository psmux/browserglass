import type {
  BrowserRuntime,
  Node,
  ProfileFs,
  RuntimeCapabilities,
  RuntimeProbe,
  Store,
  StoreCapabilities,
} from '@browserglass/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserGlass } from '../../src/index.js';
import { PreflightError } from '../../src/lifecycle/types.js';

function fakeCapabilities(): RuntimeCapabilities {
  return {
    kind: 'host',
    channels: ['chrome'],
    headlessModes: ['new'],
    resourceLimits: { cpus: false, memoryMb: false, shmMb: false, pidsLimit: false },
    extensions: { unpacked: false, crx: false, withHeadlessNew: false },
    proxyPerInstance: false,
    proxyAuthPerInstance: false,
    timezonePerInstance: false,
    localePerInstance: false,
    fileBridge: { download: false, upload: false },
    survivesNodeRestart: true,
    supportsAttach: true,
    gracefulTerminate: true,
    maxConcurrentBrowsers: 2,
    maxLaunchTimeoutMs: 45000,
    notes: [],
  };
}

function fakeUnavailableRuntime(): BrowserRuntime {
  const probe: RuntimeProbe = {
    ok: false,
    status: 'unavailable',
    detail: 'Chrome executable was not found on this machine.',
    engine: null,
    remediation: 'Install Chrome, or set runtime.executablePath.',
    checkedAt: Date.now(),
  };
  return {
    kind: 'host',
    capabilities: () => fakeCapabilities(),
    probe: async () => probe,
    launch: vi.fn(),
    attach: vi.fn(),
    stats: vi.fn(),
    terminate: vi.fn(),
    list: vi.fn(async () => []),
    dispose: vi.fn(async () => undefined),
  } as unknown as BrowserRuntime;
}

function fakeStoreCapabilities(): StoreCapabilities {
  return {
    transactions: true,
    advisoryLocks: false,
    skipLocked: false,
    notify: false,
    concurrentWriters: false,
    maxWriteConcurrency: 1,
  };
}

function instrumentedFakeStore(): { store: Store; initCalled: () => boolean } {
  let initCalled = false;
  const store = {
    init: vi.fn(async () => {
      initCalled = true;
    }),
    close: vi.fn(async () => undefined),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 0 })),
    capabilities: () => fakeStoreCapabilities(),
    schemaVersion: vi.fn(async () => 1),
    migrate: vi.fn(async () => ({ fromVersion: 1, toVersion: 1, applied: [] })),
    // `buildRouterWiring` registers its own minted `nodeId` on the way to
    // `router.start()`; the "warn" case below runs
    // that full path, so the fake store needs a `registerNode` stub too.
    registerNode: vi.fn(
      async (n: { id?: string }) => ({ id: n.id ?? 'nod_fake' }) as unknown as Node,
    ),
  } as unknown as Store;
  return { store, initCalled: () => initCalled };
}

function fakeProfileFs(): ProfileFs {
  return {
    capabilities: async () => ({ cow: 'none', fsType: 'ext4', root: '/tmp' }),
    materialise: vi.fn(),
    writeFence: vi.fn(),
    readFence: vi.fn(),
    probe: vi.fn(),
    clearSingleton: vi.fn(),
    measure: vi.fn(),
    trash: vi.fn(),
    sweep: vi.fn(),
    reconcile: vi.fn(),
  } as unknown as ProfileFs;
}

describe('preflight: chrome missing fails start() before the store opens', () => {
  it('start() throws PreflightError and never calls store.init()', async () => {
    const { store, initCalled } = instrumentedFakeStore();
    const bg = createBrowserGlass({
      mode: 'embedded',
      store,
      runtime: fakeUnavailableRuntime(),
      profiles: { dir: '/tmp/bgls-test-profiles', fs: fakeProfileFs() },
      preflight: { mode: 'fail' },
    });

    await expect(bg.start()).rejects.toThrow(PreflightError);
    expect(initCalled()).toBe(false);
  });

  it('preflight.mode "warn" reports the failure but does not throw', async () => {
    const { store } = instrumentedFakeStore();
    const bg = createBrowserGlass({
      mode: 'embedded',
      store,
      runtime: fakeUnavailableRuntime(),
      profiles: { dir: '/tmp/bgls-test-profiles', fs: fakeProfileFs() },
      preflight: { mode: 'warn' },
    });
    const report = await bg.start();
    expect(report.preflight.some((r) => r.name === 'chrome' && r.verdict === 'fail')).toBe(true);
    expect(report.warnings.some((w) => w.code === 'preflight.chrome')).toBe(true);
  });
});

describe('preflight: body-parser detector (Express) names the fix', () => {
  it('fires when a detector reports a parser mounted ahead of bg.rest()', async () => {
    const { runPreflight } = await import('../../src/lifecycle/preflight.js');
    const { resolveConfig } = await import('../../src/config/resolve.js');
    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const { noopLogger } = await import('../../src/config/logger.js');

    const results = await runPreflight(
      config,
      { detectBodyParserAheadOfRest: () => 'jsonParser' },
      noopLogger,
    );
    const bodyParser = results.find((r) => r.name === 'body-parser');
    expect(bodyParser?.verdict).toBe('warn');
    expect(bodyParser?.detail).toMatch(/jsonParser/);
    expect(bodyParser?.fix).toMatch(/bg\.rest\(\)/);
  });

  it('passes when no detector or no conflict is reported', async () => {
    const { runPreflight } = await import('../../src/lifecycle/preflight.js');
    const { resolveConfig } = await import('../../src/config/resolve.js');
    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const { noopLogger } = await import('../../src/config/logger.js');

    const results = await runPreflight(config, {}, noopLogger);
    const bodyParser = results.find((r) => r.name === 'body-parser');
    expect(bodyParser?.verdict).toBe('skipped');
  });
});
