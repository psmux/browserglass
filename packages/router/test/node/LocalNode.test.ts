import type {
  BrowserRuntime,
  LaunchRequest,
  LaunchedBrowser,
  NodeLaunchRequest,
  RuntimeInventoryEntry,
  RuntimeKind,
  TerminateMode,
  TerminateResult,
} from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, LaunchError, newId } from '@browserglass/protocol';
import { RemoteRuntime } from '@browserglass/runtime-remote';
import { describe, expect, it } from 'vitest';
import { LocalNode } from '../../src/node/LocalNode.js';
import { LocalNodeTransport } from '../../src/node/LocalNodeTransport.js';
import { NodeRegistry } from '../../src/node/NodeRegistry.js';
import { createFakeClock } from '../support/fakeClock.js';
import { createFakeProfileService } from '../support/fakeProfileService.js';

/**
 * `inventory` and `listThrows` drive `LocalNode.terminate`'s new runtime
 * inventory consultation: a test can say "the runtime still sees this
 * browser", "the runtime has never heard of it", or "the inventory cannot
 * be read", which are the three cases that method now distinguishes.
 */
type FakeRuntime = BrowserRuntime & {
  lastLaunchRequest: LaunchRequest | null;
  launchCount: number;
  inventory: RuntimeInventoryEntry[];
  listThrows: boolean;
  /** Every mode that actually reached `handle.teardown`, in order, so a test can assert what `LocalNode` forwarded rather than what it was asked. */
  teardownModes: TerminateMode[];
};

/** One `RuntimeInventoryEntry` for `instanceId`, `status` picking whether the runtime believes the browser is still alive. */
function inventoryEntry(
  instanceId: string,
  status: RuntimeInventoryEntry['status'],
): RuntimeInventoryEntry {
  return {
    instanceId: instanceId as RuntimeInventoryEntry['instanceId'],
    runtimeKind: 'host',
    pid: 4242,
    containerId: null,
    podName: null,
    cdpUrl: 'http://127.0.0.1:9222',
    browserGuid: 'guid-1',
    profilePath: '/tmp/profiles/x',
    profileFence: 1,
    startedAt: 0,
    engineVersion: 'Chrome/999.0.0.0',
    channel: 'chrome',
    headless: 'new',
    labels: {},
    status,
  };
}

/**
 * `kind` picks whether this runtime is one that CREATES the browsers it
 * hands back (`'host'`, the default, and what every pre-existing test in
 * this file wants) or one that merely attaches to a browser somebody else
 * started (`'remote'`). `LocalNode.terminate` reads exactly that to decide
 * whether a `'detach'` may be honoured.
 */
function createFakeRuntime(kind: RuntimeKind = 'host'): FakeRuntime {
  const handles = new Map<string, LaunchedBrowser>();
  const runtime: FakeRuntime = {
    kind,
    lastLaunchRequest: null,
    launchCount: 0,
    inventory: [],
    listThrows: false,
    teardownModes: [],
    capabilities: () => ({
      kind,
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
      maxConcurrentBrowsers: 8,
      maxLaunchTimeoutMs: 120_000,
      notes: [],
    }),
    probe: () =>
      Promise.resolve({
        ok: true,
        status: 'ready',
        detail: '',
        engine: null,
        remediation: null,
        checkedAt: Date.now(),
      }),
    launch: (req: LaunchRequest): Promise<LaunchedBrowser> => {
      runtime.launchCount += 1;
      runtime.lastLaunchRequest = req;
      const handle: LaunchedBrowser = {
        instanceId: req.instanceId,
        runtimeKind: kind,
        transport: { kind: 'http', cdpUrl: 'http://127.0.0.1:9222', host: '127.0.0.1', port: 9222 },
        cdpWsUrl: 'ws://127.0.0.1:9222/devtools/browser/fake',
        browserGuid: 'guid-1',
        pid: 999,
        containerId: null,
        podName: null,
        profilePath: req.profile.path,
        containerProfilePath: null,
        engineVersion: 'Chrome/999.0.0.0',
        protocolVersion: '1.3',
        nativeUserAgent: 'fake-ua',
        launchDurationMs: 1,
        launchPhases: { preflight: 0, reconcile: 0, spawn: 1, cdpWait: 0, postLaunch: 0 },
        startedAt: Date.now(),
        adopted: false,
        teardown: (mode): Promise<TerminateResult> => {
          runtime.teardownModes.push(mode);
          return Promise.resolve({
            mode,
            effective: mode,
            exitCode: 0,
            signal: null,
            durationMs: 1,
            locksCleared: [],
            warnings: [],
          });
        },
        onUnexpectedExit: () => () => undefined,
      };
      handles.set(req.instanceId, handle);
      return Promise.resolve(handle);
    },
    attach: (req) => {
      const handle = handles.get(req.instanceId);
      if (!handle) throw new Error('no handle');
      return Promise.resolve(handle);
    },
    stats: () =>
      Promise.resolve({
        instanceId: newId('inst'),
        at: Date.now(),
        cpuPercent: null,
        rssBytes: null,
        memoryLimitBytes: null,
        memoryPressure: null,
        processCount: null,
        openFds: null,
        diskWrittenBytes: null,
        oomKilledSince: false,
      }),
    terminate: (handle, mode) => handle.teardown(mode),
    list: () =>
      runtime.listThrows
        ? Promise.reject(new Error('runtime inventory unavailable'))
        : Promise.resolve(runtime.inventory),
    dispose: () => Promise.resolve(),
  };
  return runtime;
}

describe('LocalNode', () => {
  it('translates a NodeLaunchRequest into a real LaunchRequest and calls the injected runtime', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime();
    const profiles = createFakeProfileService();
    const node = new LocalNode({ runtime, profiles, clock });

    const req: NodeLaunchRequest = {
      instanceId: newId('inst'),
      sessionId: newId('sess'),
      spec: {
        engine: 'chromium',
        channel: 'chrome',
        executablePath: null,
        headless: 'new',
        viewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
        window: null,
        isolation: 'tab' as const,
        userAgent: null,
        clientHints: null,
        locale: null,
        timezoneId: null,
        geolocation: null,
        permissions: [],
        colorScheme: 'light',
        reducedMotion: 'no-preference',
        proxy: null,
        extraArgs: [],
        ignoreDefaultArgs: [],
        env: {},
        extensions: [],
        stealth: 'off',
        ignoreHttpsErrors: false,
        downloadDir: null,
        uploadDir: null,
        acceptDownloads: false,
        maxDownloadBytes: null,
        resources: { cpus: null, memoryMb: null, shmMb: null, pidsLimit: null },
        initialUrl: null,
        launchTimeoutMs: 30_000,
      },
      profile: {
        storedKey: 't:ten/a:app/eph:x',
        mode: 'ephemeral',
        fence: 1,
        source: 'empty',
        templateId: null,
        seed: null,
      },
      limits: {},
      leaseMs: 30_000,
      term: 0,
    };

    const handle = await node.launch(req);
    expect(runtime.launchCount).toBe(1);
    expect(runtime.lastLaunchRequest?.profile.path).toBe('/tmp/profiles/t:ten/a:app/eph:x');
    expect(runtime.lastLaunchRequest?.profile.lease).toEqual({
      fence: 1,
      expiresAt: expect.any(Number),
    });
    expect(handle.instanceId).toBe(req.instanceId);
    expect(node.handleFor(req.instanceId)).toBe(handle);
  });

  it('terminate() tears down the handle it holds for that instance', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime();
    const profiles = createFakeProfileService();
    const node = new LocalNode({ runtime, profiles, clock });
    const instanceId = newId('inst');
    const req: NodeLaunchRequest = {
      instanceId,
      sessionId: null,
      spec: {
        engine: 'chromium',
        channel: 'chrome',
        executablePath: null,
        headless: 'new',
        viewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
        window: null,
        isolation: 'tab' as const,
        userAgent: null,
        clientHints: null,
        locale: null,
        timezoneId: null,
        geolocation: null,
        permissions: [],
        colorScheme: 'light',
        reducedMotion: 'no-preference',
        proxy: null,
        extraArgs: [],
        ignoreDefaultArgs: [],
        env: {},
        extensions: [],
        stealth: 'off',
        ignoreHttpsErrors: false,
        downloadDir: null,
        uploadDir: null,
        acceptDownloads: false,
        maxDownloadBytes: null,
        resources: { cpus: null, memoryMb: null, shmMb: null, pidsLimit: null },
        initialUrl: null,
        launchTimeoutMs: 30_000,
      },
      profile: {
        storedKey: 'k',
        mode: 'ephemeral',
        fence: 1,
        source: 'empty',
        templateId: null,
        seed: null,
      },
      limits: {},
      leaseMs: 30_000,
      term: 0,
    };
    await node.launch(req);

    const result = await node.terminate(instanceId, 'graceful');
    expect(result.effective).toBe('graceful');
    expect(node.handleFor(instanceId)).toBeNull();
  });

  /**
   * `terminate()` for an instance this node holds no handle for. This used
   * to be one test asserting a bare throw, which mirrored the old
   * implementation rather than a contract anyone wanted: a diagnosis
   * traced a silent 30 second infinite reaper loop to exactly that throw, since
   * `handles` is empty for every instance launched before the current
   * process started. The contract that actually matters is the split
   * below: a browser the runtime cannot see is reported as already gone,
   * and a browser that IS still running still throws, because a row must
   * never read `released` while its Chrome is alive.
   */
  describe('terminate() for an instance this node holds no handle for', () => {
    function nodeWithRuntime(): { node: LocalNode; runtime: ReturnType<typeof createFakeRuntime> } {
      const clock = createFakeClock();
      const runtime = createFakeRuntime();
      const profiles = createFakeProfileService();
      return { node: new LocalNode({ runtime, profiles, clock }), runtime };
    }

    it('reports a clean termination when the runtime does not list the instance at all', async () => {
      const { node } = nodeWithRuntime();
      const instanceId = newId('inst');

      const result = await node.terminate(instanceId, 'graceful');
      expect(result.effective).toBe('graceful');
      expect(result.warnings.join(' ')).toContain('already terminated');
    });

    it('reports a clean termination when the runtime lists it with a dead pid (status: unknown)', async () => {
      // The post restart shape: `runtime-host`'s durable state file still
      // remembers the browser, but `pidAlive` is false, so `list()` reports
      // `'unknown'`. That is the row the reaper was retrying forever.
      const { node, runtime } = nodeWithRuntime();
      const instanceId = newId('inst');
      runtime.inventory = [inventoryEntry(instanceId, 'unknown')];

      const result = await node.terminate(instanceId, 'force');
      expect(result.effective).toBe('force');
      expect(result.exitCode).toBeNull();
    });

    it('still throws when the runtime reports the browser running, so the row stays live', async () => {
      const { node, runtime } = nodeWithRuntime();
      const instanceId = newId('inst');
      runtime.inventory = [inventoryEntry(instanceId, 'live')];

      await expect(node.terminate(instanceId, 'graceful')).rejects.toThrow(/still running/);
    });

    it('still throws for an orphaned browser, which is running and merely untracked', async () => {
      const { node, runtime } = nodeWithRuntime();
      const instanceId = newId('inst');
      runtime.inventory = [inventoryEntry(instanceId, 'orphan')];

      await expect(node.terminate(instanceId, 'graceful')).rejects.toThrow(/still running/);
    });

    it('throws rather than guessing when the runtime inventory cannot be read', async () => {
      const { node, runtime } = nodeWithRuntime();
      runtime.listThrows = true;

      await expect(node.terminate(newId('inst'), 'graceful')).rejects.toThrow(/could not be read/);
    });

    it('a second terminate after a clean one stays idempotent without re-reading the inventory', async () => {
      const { node, runtime } = nodeWithRuntime();
      const instanceId = newId('inst');

      await node.terminate(instanceId, 'graceful');
      // If the first call had not recorded the teardown, this second call
      // would consult an inventory that now claims the browser is live and
      // would throw.
      runtime.inventory = [inventoryEntry(instanceId, 'live')];
      const second = await node.terminate(instanceId, 'graceful');
      expect(second.warnings.join(' ')).toContain('already terminated');
    });
  });
});

describe('LocalNodeTransport', () => {
  it('constructs the documented NodeHeartbeatAck shape by direct call', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime();
    const profiles = createFakeProfileService();
    const node = new LocalNode({ runtime, profiles, clock });
    const registry = new NodeRegistry(clock, {
      nodeId: newId('nod'),
      capacity: {
        maxInstances: 10,
        maxMemoryMb: 1000,
        cpuCores: 4,
        profileDiskMb: 1000,
        maxConcurrentLaunches: 4,
      },
    });
    registry.markReady();
    const transport = new LocalNodeTransport(node, registry, clock);

    const ack = await transport.heartbeat(registry.id(), {
      nodeId: registry.id(),
      epoch: 0,
      load: registry.currentLoad(),
      hostsProfiles: [],
      at: clock.now(),
    });
    expect(ack.accepted).toBe(true);
    expect(ack.drain).toBeNull();
    expect(ack.serverTime).toBe(clock.now());
  });

  /**
   * `launch`/`terminate`/`list` used to silently ignore a foreign `nodeId`
   * argument (`launch` and `terminate` called straight into `this.node`
   * with no check at all; `list` the same). That is the exact failure mode
   * that matters most here: a placement bug that does
   * not throw, and strands a Chrome nobody will ever reap, because the
   * caller believes it launched on a REMOTE node (`Instance.nodeId` is
   * stamped with that remote id, `BrowserRouter.doAcquire`'s step 8) while
   * the browser actually runs HERE, invisible to this node's own
   * `orphanSweepScope` (`@browserglass/server`'s `lifecycle/wiring.ts`
   * scopes reaping to `instance.node_id === ourNodeId`) and never found by
   * the remote node's sweep either, since it never launched anything.
   * `dispatch()` already had this guard (`action-dispatch.test.ts`'s own
   * "rejects a nodeId that is not its own" case); these three bring the
   * other methods up to the same contract this class's own top comment
   * states: "`nodeId === this.registry.id()` is the only address this
   * transport can ever legitimately be asked to reach."
   */
  describe('foreign nodeId guard', () => {
    it('launch() rejects a nodeId that is not its own with E_NODE_LOST, and never reaches the runtime', async () => {
      const clock = createFakeClock();
      const runtime = createFakeRuntime();
      const profiles = createFakeProfileService();
      const node = new LocalNode({ runtime, profiles, clock });
      const registry = new NodeRegistry(clock, {
        nodeId: newId('nod'),
        capacity: {
          maxInstances: 10,
          maxMemoryMb: 1000,
          cpuCores: 4,
          profileDiskMb: 1000,
          maxConcurrentLaunches: 4,
        },
      });
      registry.markReady();
      const transport = new LocalNodeTransport(node, registry, clock);

      const foreignId = newId('nod');
      await expect(
        transport.launch(foreignId, {} as unknown as NodeLaunchRequest),
      ).rejects.toMatchObject({ code: 'E_NODE_LOST' });
      expect(runtime.launchCount).toBe(0);
    });

    it('terminate() rejects a nodeId that is not its own with E_NODE_LOST', async () => {
      const clock = createFakeClock();
      const runtime = createFakeRuntime();
      const profiles = createFakeProfileService();
      const node = new LocalNode({ runtime, profiles, clock });
      const registry = new NodeRegistry(clock, {
        nodeId: newId('nod'),
        capacity: {
          maxInstances: 10,
          maxMemoryMb: 1000,
          cpuCores: 4,
          profileDiskMb: 1000,
          maxConcurrentLaunches: 4,
        },
      });
      registry.markReady();
      const transport = new LocalNodeTransport(node, registry, clock);

      const foreignId = newId('nod');
      await expect(transport.terminate(foreignId, newId('inst'), 'force')).rejects.toMatchObject({
        code: 'E_NODE_LOST',
      });
    });

    it('list() rejects a nodeId that is not its own with E_NODE_LOST', async () => {
      const clock = createFakeClock();
      const runtime = createFakeRuntime();
      const profiles = createFakeProfileService();
      const node = new LocalNode({ runtime, profiles, clock });
      const registry = new NodeRegistry(clock, {
        nodeId: newId('nod'),
        capacity: {
          maxInstances: 10,
          maxMemoryMb: 1000,
          cpuCores: 4,
          profileDiskMb: 1000,
          maxConcurrentLaunches: 4,
        },
      });
      registry.markReady();
      const transport = new LocalNodeTransport(node, registry, clock);

      const foreignId = newId('nod');
      await expect(transport.list(foreignId)).rejects.toMatchObject({ code: 'E_NODE_LOST' });
    });

    it("launch()/terminate()/list() still work for this transport's own node id, unaffected by the guard", async () => {
      const clock = createFakeClock();
      const runtime = createFakeRuntime();
      const profiles = createFakeProfileService();
      const node = new LocalNode({ runtime, profiles, clock });
      const registry = new NodeRegistry(clock, {
        nodeId: newId('nod'),
        capacity: {
          maxInstances: 10,
          maxMemoryMb: 1000,
          cpuCores: 4,
          profileDiskMb: 1000,
          maxConcurrentLaunches: 4,
        },
      });
      registry.markReady();
      const transport = new LocalNodeTransport(node, registry, clock);

      await expect(transport.list(registry.id())).resolves.toEqual([]);
    });
  });
});

/**
 * `LocalNode.terminate`'s ownership guard, the second half of making
 * `TerminateMode`'s `'detach'` reachable.
 *
 * A caller opting into `'detach'` is saying "leave this browser running".
 * That is the right answer only for a browser BrowserGlass did not create,
 * and the caller is in no position to know which of those it has: the
 * runtime kind is a placement decision, made below the caller, and it can
 * change between two acquires of the same pool. `LocalNode` is the last
 * hop before the runtime and it holds the runtime object itself, so it is
 * the one place where "did we create this browser" is a fact rather than
 * an assumption.
 */
describe('LocalNode.terminate: the detach ownership guard', () => {
  function launchReqFor(instanceId: ReturnType<typeof newId>): NodeLaunchRequest {
    return {
      instanceId,
      sessionId: null,
      spec: {
        engine: 'chromium',
        channel: 'chrome',
        executablePath: null,
        headless: 'new',
        viewport: { width: 1024, height: 768, deviceScaleFactor: 1 },
        window: null,
        isolation: 'tab' as const,
        userAgent: null,
        clientHints: null,
        locale: null,
        timezoneId: null,
        geolocation: null,
        permissions: [],
        colorScheme: 'light',
        reducedMotion: 'no-preference',
        proxy: null,
        extraArgs: [],
        ignoreDefaultArgs: [],
        env: {},
        extensions: [],
        stealth: 'off',
        ignoreHttpsErrors: false,
        downloadDir: null,
        uploadDir: null,
        acceptDownloads: false,
        maxDownloadBytes: null,
        resources: { cpus: null, memoryMb: null, shmMb: null, pidsLimit: null },
        initialUrl: null,
        launchTimeoutMs: 30_000,
      },
      profile: {
        storedKey: 'k',
        mode: 'ephemeral',
        fence: 1,
        source: 'empty',
        templateId: null,
        seed: null,
      },
      limits: {},
      leaseMs: 30_000,
      term: 0,
    };
  }

  it('refuses a detach against a runtime that creates its own browsers, and tears the browser down instead', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime('host');
    const node = new LocalNode({ runtime, profiles: createFakeProfileService(), clock });
    const instanceId = newId('inst');
    await node.launch(launchReqFor(instanceId));

    const result = await node.terminate(instanceId, 'detach');

    // The browser BrowserGlass spawned is gone. Detaching from it would
    // leak it, which is the opposite defect.
    expect(runtime.teardownModes).toEqual(['clean']);
    expect(result.effective).not.toBe('detach');
    // Reported, never silent: the mode asked for is still `'detach'`, and
    // a warning names why it was not honoured.
    expect(result.mode).toBe('detach');
    expect(result.warnings.join(' ')).toMatch(/detach/i);
  });

  it('honours a detach against a runtime that never creates the browser it attaches to', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime('remote');
    const node = new LocalNode({ runtime, profiles: createFakeProfileService(), clock });
    const instanceId = newId('inst');
    await node.launch(launchReqFor(instanceId));

    const result = await node.terminate(instanceId, 'detach');

    expect(runtime.teardownModes).toEqual(['detach']);
    expect(result.effective).toBe('detach');
  });

  it('refuses to KILL a browser it never created, converting the teardown into a detach', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime('remote');
    const node = new LocalNode({ runtime, profiles: createFakeProfileService(), clock });
    const instanceId = newId('inst');
    await node.launch(launchReqFor(instanceId));

    const result = await node.terminate(instanceId, 'clean');

    // The load bearing assertion: no `Browser.close` reached the
    // endpoint. `runtime-remote`'s `doTerminate` sends exactly that for
    // every mode except `'detach'`, and the endpoint it sends it to is,
    // in practice, a person's own signed in Chrome.
    expect(runtime.teardownModes).toEqual(['detach']);
    // Honest in both fields: `mode` is what was asked for, `effective` is
    // what happened, so a caller that assumed the browser is gone can
    // find out that it is not.
    expect(result.mode).toBe('clean');
    expect(result.effective).toBe('detach');
    expect(result.warnings.join(' ')).toMatch(/never created this browser/i);
  });

  it("refuses a 'force' kill on a borrowed browser too, which is the path the reaper actually takes", async () => {
    // This is the case the guard exists for, and it is not a caller
    // forgetting a flag. `BrowserRouter`'s idle timeout, TTL expiry, max
    // duration, node drain and capacity eviction all call
    // `release(..., { force: true })` against rows they are sweeping by
    // policy. None of them knows which runtime backs the row, and none of
    // them could: the reaper has no opinion about somebody's browser, it
    // just knows a row went idle. Without this guard that closes a signed
    // in Chrome unattended, with no human in the loop at all.
    const clock = createFakeClock();
    const runtime = createFakeRuntime('remote');
    const node = new LocalNode({ runtime, profiles: createFakeProfileService(), clock });
    const instanceId = newId('inst');
    await node.launch(launchReqFor(instanceId));

    const result = await node.terminate(instanceId, 'force');

    expect(runtime.teardownModes).toEqual(['detach']);
    expect(result.effective).toBe('detach');
  });

  it('still really tears down a browser it did create, so the guard leaks nothing', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime('host');
    const node = new LocalNode({ runtime, profiles: createFakeProfileService(), clock });
    const instanceId = newId('inst');
    await node.launch(launchReqFor(instanceId));

    const result = await node.terminate(instanceId, 'clean');

    expect(runtime.teardownModes).toEqual(['clean']);
    expect(result.effective).toBe('clean');
  });

  it('leaves every non-detach mode exactly as the caller sent it', async () => {
    const clock = createFakeClock();
    const runtime = createFakeRuntime('host');
    const node = new LocalNode({ runtime, profiles: createFakeProfileService(), clock });
    const instanceId = newId('inst');
    await node.launch(launchReqFor(instanceId));

    await node.terminate(instanceId, 'graceful');
    expect(runtime.teardownModes).toEqual(['graceful']);
  });
});

/**
 * End to end proof that `LocalNode` genuinely plumbs
 * `BrowserSpec.remoteEndpointName` through to `RemoteRuntime`, against the
 * REAL `@browserglass/runtime-remote` package (not a fake `BrowserRuntime`
 * stand-in) rather than only against `LaunchRequest.labels` directly the
 * way `runtime-remote`'s own test suite does. That distinction is exactly
 * what let the underlying defect (`LocalNode.launch` hardcoding
 * `labels: Object.freeze({})`) ship unnoticed: every `RemoteRuntime` test
 * built its own `LaunchRequest` by hand, with the label already set, so
 * none of them ever exercised the one line that failed to set it for real.
 *
 * A minimal, self-written fake `fetch`/`WebSocket` pair stands in for the
 * network, mirroring `runtime-remote/test/fake-remote-endpoint.ts`'s
 * shape: that file lives under a sibling package's `test/` directory,
 * which `runtime-remote`'s `package.json` `exports` map does not expose
 * for a deep import from here, so this file keeps its own small copy
 * rather than reaching across the package boundary for test-only code.
 */
describe('LocalNode + RemoteRuntime, end-to-end remote attach', () => {
  /** A structural stand-in for `runtime-remote`'s `RemoteWebSocketLike`, just enough to answer the CDP handshake `RemoteCdpClient.connect()`/`attachFirstPage()` performs. */
  interface FakeSocket {
    readyState: number;
    onopen: (() => void) | null;
    onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: string }) => void) | null;
    send(data: string): void;
    close(code?: number, reason?: string): void;
  }

  function makeFakeSocket(): FakeSocket {
    const socket: FakeSocket = {
      readyState: 0, // CONNECTING
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
      send(data: string) {
        const msg = JSON.parse(data) as {
          id: number;
          method: string;
          params?: Record<string, unknown>;
        };
        // Answers exactly the two commands `RemoteCdpClient.attachFirstPage()`
        // sends, everything else with `{}`, mirroring
        // `fake-remote-endpoint.ts`'s `installDefaultResponder`.
        if (msg.method === 'Target.getTargets') {
          socket.onmessage?.({
            data: JSON.stringify({
              id: msg.id,
              result: { targetInfos: [{ targetId: 'page-1', type: 'page', attached: false }] },
            }),
          });
          return;
        }
        if (msg.method === 'Target.attachToTarget') {
          socket.onmessage?.({
            data: JSON.stringify({ id: msg.id, result: { sessionId: 'S_page-1_1' } }),
          });
          return;
        }
        socket.onmessage?.({ data: JSON.stringify({ id: msg.id, result: {} }) });
      },
      close(code = 1000, reason = '') {
        socket.readyState = 3; // CLOSED
        socket.onclose?.({ code, reason, wasClean: true });
      },
    };
    return socket;
  }

  /** Answers `/json/version` for `origin` with a fixed `browserGuid`, exactly what `probeCdpIdentity` needs. */
  function fakeFetchFor(origin: string, browserGuid: string) {
    return async (url: string) => {
      if (!url.startsWith(origin)) {
        return { ok: false, status: 502, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          webSocketDebuggerUrl: `ws://${origin.replace(/^https?:\/\//, '')}/devtools/browser/${browserGuid}`,
          Browser: 'Chrome/131.0.6778.86',
          'Protocol-Version': '1.3',
          'User-Agent': 'Mozilla/5.0 (fake)',
        }),
      };
    };
  }

  function nodeLaunchRequestWithRemoteEndpoint(
    instanceId: ReturnType<typeof newId>,
    remoteEndpointName: string | null,
  ): NodeLaunchRequest {
    return {
      instanceId,
      sessionId: null,
      spec: { ...DEFAULT_BROWSER_SPEC, remoteEndpointName },
      profile: {
        storedKey: 'k',
        mode: 'ephemeral',
        fence: 1,
        source: 'empty',
        templateId: null,
        seed: null,
      },
      limits: {},
      leaseMs: 30_000,
      term: 0,
    };
  }

  it('a NodeLaunchRequest whose spec names a registered RemoteEndpoint reaches that endpoint', async () => {
    const origin = 'http://127.0.0.1:9222';
    const clock = createFakeClock();
    const remoteRuntime = new RemoteRuntime({
      endpoints: [{ name: 'primary', tenantId: 'ten_x', url: origin, auth: null }],
      fetchImpl: fakeFetchFor(origin, 'guid-1'),
      wsFactory: () => {
        const socket = makeFakeSocket();
        queueMicrotask(() => {
          socket.readyState = 1; // OPEN
          socket.onopen?.();
        });
        return socket;
      },
    });
    const node = new LocalNode({
      runtime: remoteRuntime,
      profiles: createFakeProfileService(),
      clock,
    });

    const instanceId = newId('inst');
    const handle = await node.launch(nodeLaunchRequestWithRemoteEndpoint(instanceId, 'primary'));

    expect(handle.browserGuid).toBe('guid-1');
    expect(handle.runtimeKind).toBe('remote');
    expect(handle.adopted).toBe(false);
  });

  it('an unknown remoteEndpointName fails with a message naming the registered endpoints', async () => {
    const origin = 'http://127.0.0.1:9222';
    const clock = createFakeClock();
    const remoteRuntime = new RemoteRuntime({
      endpoints: [
        { name: 'primary', tenantId: 'ten_x', url: origin, auth: null },
        { name: 'secondary', tenantId: 'ten_x', url: 'http://127.0.0.1:9333', auth: null },
      ],
      fetchImpl: fakeFetchFor(origin, 'guid-1'),
      wsFactory: () => makeFakeSocket(),
    });
    const node = new LocalNode({
      runtime: remoteRuntime,
      profiles: createFakeProfileService(),
      clock,
    });

    const instanceId = newId('inst');
    await expect(
      node.launch(nodeLaunchRequestWithRemoteEndpoint(instanceId, 'does-not-exist')),
    ).rejects.toThrow(LaunchError);
    try {
      await node.launch(nodeLaunchRequestWithRemoteEndpoint(newId('inst'), 'does-not-exist'));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchError);
      const launchErr = err as InstanceType<typeof LaunchError>;
      expect(launchErr.message).toContain('does-not-exist');
      expect(launchErr.message).toContain('primary');
      expect(launchErr.message).toContain('secondary');
    }
  });

  it('a NodeLaunchRequest with no remoteEndpointName set never reaches a RemoteRuntime with an empty label bag (still fails, but on the missing-label preflight, not a network call)', async () => {
    const clock = createFakeClock();
    const remoteRuntime = new RemoteRuntime({
      endpoints: [{ name: 'primary', tenantId: 'ten_x', url: 'http://127.0.0.1:9222', auth: null }],
    });
    const node = new LocalNode({
      runtime: remoteRuntime,
      profiles: createFakeProfileService(),
      clock,
    });

    const instanceId = newId('inst');
    try {
      await node.launch(nodeLaunchRequestWithRemoteEndpoint(instanceId, null));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchError);
      const launchErr = err as InstanceType<typeof LaunchError>;
      expect(launchErr.message).toContain('browserglass.remoteEndpointName');
      expect(launchErr.remediation).toContain('primary');
    }
  });
});
