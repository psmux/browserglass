/**
 * `LocalNode.dispatch`/`LocalNodeTransport.dispatch`: the "must not pay a
 * serialisation round trip to reach itself" half of
 * node aware dispatch, tested
 * one layer below `BrowserRouter` (`../router/drive.test.ts` covers the
 * gate and forwarding through a fake `NodeTransport`; this file covers the
 * real `LocalNode`/`LocalNodeTransport` implementation dispatch lands in).
 */

import type {
  BrowserRuntime,
  LaunchRequest,
  LaunchedBrowser,
  NodeActionRequest,
  NodeActionResult,
  TerminateResult,
} from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { LocalNode, type NodeActionExecutor } from '../../src/node/LocalNode.js';
import { LocalNodeTransport } from '../../src/node/LocalNodeTransport.js';
import { NodeRegistry } from '../../src/node/NodeRegistry.js';
import { createFakeClock } from '../support/fakeClock.js';
import { createFakeProfileService } from '../support/fakeProfileService.js';

function createFakeRuntime(): BrowserRuntime {
  return {
    kind: 'host',
    capabilities: () => ({
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
    launch: (req: LaunchRequest): Promise<LaunchedBrowser> =>
      Promise.resolve({
        instanceId: req.instanceId,
        runtimeKind: 'host',
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
        teardown: (mode): Promise<TerminateResult> =>
          Promise.resolve({
            mode,
            effective: mode,
            exitCode: 0,
            signal: null,
            durationMs: 1,
            locksCleared: [],
            warnings: [],
          }),
        onUnexpectedExit: () => () => undefined,
      }),
    attach: () => {
      throw new Error('not used');
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
    list: () => Promise.resolve([]),
    dispose: () => Promise.resolve(),
  };
}

describe('LocalNode.dispatch', () => {
  it('throws a plain, non router error when no NodeActionExecutor is configured', async () => {
    const clock = createFakeClock();
    const node = new LocalNode({
      runtime: createFakeRuntime(),
      profiles: createFakeProfileService(),
      clock,
    });

    const req: NodeActionRequest = { kind: 'target.list', instanceId: newId('inst') };
    await expect(node.dispatch(req)).rejects.toThrow(/NodeActionExecutor/);
  });

  it('delegates to the injected NodeActionExecutor', async () => {
    const clock = createFakeClock();
    const seen: NodeActionRequest[] = [];
    const actions: NodeActionExecutor = {
      execute: (req: NodeActionRequest): Promise<NodeActionResult> => {
        seen.push(req);
        return Promise.resolve({ kind: 'click' });
      },
    };
    const node = new LocalNode({
      runtime: createFakeRuntime(),
      profiles: createFakeProfileService(),
      clock,
      actions,
    });

    const req: NodeActionRequest = {
      kind: 'click',
      instanceId: newId('inst'),
      targetId: 'tgt-1',
      x: 5,
      y: 6,
    };
    const result = await node.dispatch(req);

    expect(result).toEqual({ kind: 'click' });
    expect(seen).toEqual([req]);
  });
});

describe('LocalNodeTransport.dispatch', () => {
  it("dispatches to this transport's own node id directly, with no serialisation step", async () => {
    const clock = createFakeClock();
    const actions: NodeActionExecutor = {
      execute: (req: NodeActionRequest): Promise<NodeActionResult> =>
        Promise.resolve({
          kind: 'target.list',
          targets: [{ targetId: 'tgt-1', url: 'about:blank', title: '' }],
        }),
    };
    const node = new LocalNode({
      runtime: createFakeRuntime(),
      profiles: createFakeProfileService(),
      clock,
      actions,
    });
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

    const req: NodeActionRequest = { kind: 'target.list', instanceId: newId('inst') };
    const result = await transport.dispatch(registry.id(), req);
    expect(result).toEqual({
      kind: 'target.list',
      targets: [{ targetId: 'tgt-1', url: 'about:blank', title: '' }],
    });
  });

  it('rejects a nodeId that is not its own with E_NODE_LOST, distinct from a launch/terminate failure', async () => {
    const clock = createFakeClock();
    const node = new LocalNode({
      runtime: createFakeRuntime(),
      profiles: createFakeProfileService(),
      clock,
    });
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

    const req: NodeActionRequest = {
      kind: 'cdp',
      instanceId: newId('inst'),
      targetId: 'tgt-1',
      method: 'Page.enable',
      params: {},
    };
    await expect(
      transport.dispatch(newId('nod') /* a different node */, req),
    ).rejects.toMatchObject({ code: 'E_NODE_LOST' });
  });
});
