import { newId } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, LaunchError } from '@browserglass/protocol';
import type {
  AttachRequest,
  InstanceId,
  LaunchRequest,
  RemoteEndpoint,
} from '@browserglass/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { REMOTE_CAPABILITIES } from '../src/capabilities.js';
import { RemoteRuntime } from '../src/runtime.js';
import { REMOTE_ENDPOINT_LABEL } from '../src/types.js';
import {
  type FakeEndpointConfig,
  FakeRemoteWebSocket,
  fakeFetch,
  installDefaultResponder,
} from './fake-remote-endpoint.js';

/** A no-op `AbortSignalLike`; none of these tests exercise cancellation. */
const neverAborted = { aborted: false } as const;

function makeLaunchRequest(
  instanceId: InstanceId,
  endpointName: string,
  specOverride: Partial<typeof DEFAULT_BROWSER_SPEC> = {},
): LaunchRequest {
  return {
    instanceId,
    spec: { ...DEFAULT_BROWSER_SPEC, ...specOverride },
    profile: { profileId: null, path: '', containerPath: null, mode: 'ephemeral', lease: null },
    deadlineAt: Date.now() + 30000,
    labels: { [REMOTE_ENDPOINT_LABEL]: endpointName },
    signal: neverAborted,
  };
}

describe('RemoteRuntime.capabilities', () => {
  it('returns REMOTE_CAPABILITIES verbatim', () => {
    const runtime = new RemoteRuntime({ endpoints: [] });
    expect(runtime.capabilities()).toBe(REMOTE_CAPABILITIES);
  });
});

describe('RemoteRuntime.probe', () => {
  it('reports unavailable when no endpoint is configured', async () => {
    const runtime = new RemoteRuntime({ endpoints: [] });
    const probe = await runtime.probe();
    expect(probe.status).toBe('unavailable');
    expect(probe.ok).toBe(false);
  });

  it('reports ready when every configured endpoint answers /json/version', async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      ['http://127.0.0.1:9222', { origin: 'http://127.0.0.1:9222', browserGuid: 'guid-1' }],
    ]);
    const endpoints: RemoteEndpoint[] = [
      { name: 'primary', tenantId: 'ten_x', url: 'http://127.0.0.1:9222', auth: null },
    ];
    const runtime = new RemoteRuntime({ endpoints, fetchImpl: fakeFetch(guidByOrigin) });
    const probe = await runtime.probe();
    expect(probe.status).toBe('ready');
    expect(probe.ok).toBe(true);
  });

  it('reports degraded when some but not all configured endpoints answer', async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      ['http://127.0.0.1:9222', { origin: 'http://127.0.0.1:9222', browserGuid: 'guid-1' }],
      [
        'http://127.0.0.1:9333',
        { origin: 'http://127.0.0.1:9333', browserGuid: 'guid-2', reachable: false },
      ],
    ]);
    const endpoints: RemoteEndpoint[] = [
      { name: 'primary', tenantId: 'ten_x', url: 'http://127.0.0.1:9222', auth: null },
      { name: 'secondary', tenantId: 'ten_x', url: 'http://127.0.0.1:9333', auth: null },
    ];
    const runtime = new RemoteRuntime({ endpoints, fetchImpl: fakeFetch(guidByOrigin) });
    const probe = await runtime.probe();
    expect(probe.status).toBe('degraded');
  });
});

describe('RemoteRuntime.launch, endpoint selection', () => {
  it('throws a LaunchError when labels is missing the endpoint-name label, naming the registered endpoints', async () => {
    const runtime = new RemoteRuntime({
      endpoints: [
        { name: 'primary', tenantId: 'ten_x', url: 'http://127.0.0.1:9222', auth: null },
        { name: 'secondary', tenantId: 'ten_x', url: 'http://127.0.0.1:9333', auth: null },
      ],
    });
    const req = makeLaunchRequest(newId('inst'), 'primary');
    // Overwrite labels to omit the required key, simulating a caller that forgot it.
    const badReq: LaunchRequest = { ...req, labels: {} };
    await expect(runtime.launch(badReq)).rejects.toThrow(LaunchError);
    try {
      await runtime.launch(badReq);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchError);
      const launchErr = err as InstanceType<typeof LaunchError>;
      expect(launchErr.remediation).toContain('primary');
      expect(launchErr.remediation).toContain('secondary');
      expect(launchErr.context['registeredEndpoints']).toBe('primary,secondary');
    }
  });

  it('throws a LaunchError naming no registered endpoints when none are configured', async () => {
    const runtime = new RemoteRuntime({ endpoints: [] });
    const badReq: LaunchRequest = { ...makeLaunchRequest(newId('inst'), 'primary'), labels: {} };
    try {
      await runtime.launch(badReq);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchError);
      const launchErr = err as InstanceType<typeof LaunchError>;
      expect(launchErr.remediation).toContain('none registered');
      expect(launchErr.context['registeredEndpoints']).toBe('');
    }
  });

  it('throws a LaunchError when the named endpoint is not registered, naming the endpoints that are', async () => {
    const runtime = new RemoteRuntime({
      endpoints: [
        { name: 'primary', tenantId: 'ten_x', url: 'http://127.0.0.1:9222', auth: null },
        { name: 'secondary', tenantId: 'ten_x', url: 'http://127.0.0.1:9333', auth: null },
      ],
    });
    const req = makeLaunchRequest(newId('inst'), 'does-not-exist');
    try {
      await runtime.launch(req);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchError);
      const launchErr = err as InstanceType<typeof LaunchError>;
      expect(launchErr.message).toContain('does-not-exist');
      expect(launchErr.message).toContain('primary');
      expect(launchErr.message).toContain('secondary');
      expect(launchErr.context['registeredEndpoints']).toBe('primary,secondary');
    }
  });
});

describe('RemoteRuntime.launch, happy path', () => {
  const origin = 'http://127.0.0.1:9222';
  let guidByOrigin: Map<string, FakeEndpointConfig>;
  let sockets: FakeRemoteWebSocket[];
  let runtime: RemoteRuntime;

  beforeEach(() => {
    guidByOrigin = new Map([[origin, { origin, browserGuid: 'guid-1' }]]);
    sockets = [];
    const endpoints: RemoteEndpoint[] = [
      { name: 'primary', tenantId: 'ten_x', url: origin, auth: null },
    ];
    runtime = new RemoteRuntime({
      endpoints,
      fetchImpl: fakeFetch(guidByOrigin),
      wsFactory: () => {
        const socket = new FakeRemoteWebSocket();
        installDefaultResponder(socket);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
  });

  it('attaches and returns a LaunchedBrowser carrying the real browserGuid, never fails on an unhonourable field, and never spawns a process (pid/containerId/podName all null)', async () => {
    const req = makeLaunchRequest(newId('inst'), 'primary', { channel: 'msedge', headless: 'off' });
    const handle = await runtime.launch(req);
    expect(handle.browserGuid).toBe('guid-1');
    expect(handle.adopted).toBe(false);
    expect(handle.pid).toBeNull();
    expect(handle.containerId).toBeNull();
    expect(handle.podName).toBeNull();
  });

  it('records exactly one SPEC_IGNORED incident per unhonourable field and still returns a live handle', async () => {
    const req = makeLaunchRequest(newId('inst'), 'primary', {
      channel: 'msedge',
      headless: 'off',
      acceptDownloads: true,
    });
    const handle = await runtime.launch(req);
    const incidents = runtime.listIncidents(handle.instanceId);
    expect(incidents.map((i) => i.field).sort()).toEqual([
      'acceptDownloads',
      'channel',
      'headless',
    ]);
    for (const incident of incidents) expect(incident.code).toBe('SPEC_IGNORED');
  });

  it('is idempotent per instanceId: a second concurrent call returns the same handle', async () => {
    const req = makeLaunchRequest(newId('inst'), 'primary');
    const [a, b] = await Promise.all([runtime.launch(req), runtime.launch(req)]);
    expect(a).toBe(b);
  });

  it('is idempotent per instanceId for a sequential second call too', async () => {
    const req = makeLaunchRequest(newId('inst'), 'primary');
    const a = await runtime.launch(req);
    const b = await runtime.launch(req);
    expect(a).toBe(b);
  });

  it('refuses a second, different instanceId on the same endpoint while the first is still live (maxConcurrentBrowsers: 1)', async () => {
    const first = makeLaunchRequest(newId('inst'), 'primary');
    await runtime.launch(first);
    const second = makeLaunchRequest(newId('inst'), 'primary');
    await expect(runtime.launch(second)).rejects.toThrow(LaunchError);
  });

  it('list() reports the live instance bound to its endpoint', async () => {
    const req = makeLaunchRequest(newId('inst'), 'primary');
    const handle = await runtime.launch(req);
    const entries = await runtime.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.instanceId).toBe(handle.instanceId);
    expect(entries[0]?.status).toBe('live');
    expect(entries[0]?.browserGuid).toBe('guid-1');
  });

  it('terminate() attempts Browser.close and reports effective "clean"', async () => {
    const req = makeLaunchRequest(newId('inst'), 'primary');
    const handle = await runtime.launch(req);
    const result = await runtime.terminate(handle, 'graceful');
    expect(result.effective).toBe('clean');
    const socket = sockets[0];
    expect(socket?.allSent('Browser.close')).toHaveLength(1);
  });

  it('terminate() frees the endpoint so a new instanceId can launch onto it afterward', async () => {
    const first = makeLaunchRequest(newId('inst'), 'primary');
    const handle = await runtime.launch(first);
    await runtime.terminate(handle, 'clean');

    guidByOrigin.set(origin, { origin, browserGuid: 'guid-2' });
    const second = makeLaunchRequest(newId('inst'), 'primary');
    const secondHandle = await runtime.launch(second);
    expect(secondHandle.browserGuid).toBe('guid-2');
  });

  it('stats() populates processCount from SystemInfo.getProcessInfo and leaves unavailable fields null', async () => {
    const req = makeLaunchRequest(newId('inst'), 'primary');
    const handle = await runtime.launch(req);
    const socket = sockets[0];
    expect(socket).toBeDefined();
    if (socket) {
      socket.autoRespond = (msg, s) => {
        if (msg.method === 'SystemInfo.getProcessInfo') {
          s.emitResult(msg.id, {
            processInfo: [
              { type: 'browser', id: 1, cpuTime: 1 },
              { type: 'renderer', id: 2, cpuTime: 0.5 },
            ],
          });
          return;
        }
        s.emitResult(msg.id, {});
      };
    }
    const stats = await runtime.stats(handle);
    expect(stats.processCount).toBe(2);
    expect(stats.rssBytes).toBeNull();
    expect(stats.memoryLimitBytes).toBeNull();
    expect(stats.oomKilledSince).toBe(false);
  });
});

describe('RemoteRuntime.attach', () => {
  const origin = 'http://127.0.0.1:9222';

  it('adopts a browser given an explicit endpoint, marking the handle adopted:true', async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      [origin, { origin, browserGuid: 'guid-1' }],
    ]);
    const endpoints: RemoteEndpoint[] = [
      { name: 'primary', tenantId: 'ten_x', url: origin, auth: null },
    ];
    const runtime = new RemoteRuntime({
      endpoints,
      fetchImpl: fakeFetch(guidByOrigin),
      wsFactory: () => {
        const socket = new FakeRemoteWebSocket();
        installDefaultResponder(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const req: AttachRequest = {
      instanceId: newId('inst'),
      endpoint: { url: origin, auth: null, excludeBrowserGuid: null },
      recovered: null,
      deadlineAt: Date.now() + 30000,
      signal: neverAborted,
    };
    const handle = await runtime.attach(req);
    expect(handle.adopted).toBe(true);
    expect(handle.browserGuid).toBe('guid-1');
  });

  it('throws a LaunchError when neither endpoint nor recovered carries a URL', async () => {
    const runtime = new RemoteRuntime({ endpoints: [] });
    const req: AttachRequest = {
      instanceId: newId('inst'),
      endpoint: null,
      recovered: null,
      deadlineAt: Date.now() + 5000,
      signal: neverAborted,
    };
    await expect(runtime.attach(req)).rejects.toThrow(LaunchError);
  });
});

describe('RemoteRuntime.dispose', () => {
  it('closes every tracked client and clears list() results, without calling Browser.close', async () => {
    const origin = 'http://127.0.0.1:9222';
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      [origin, { origin, browserGuid: 'guid-1' }],
    ]);
    const endpoints: RemoteEndpoint[] = [
      { name: 'primary', tenantId: 'ten_x', url: origin, auth: null },
    ];
    const sockets: FakeRemoteWebSocket[] = [];
    const runtime = new RemoteRuntime({
      endpoints,
      fetchImpl: fakeFetch(guidByOrigin),
      wsFactory: () => {
        const socket = new FakeRemoteWebSocket();
        installDefaultResponder(socket);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    const req = makeLaunchRequest(newId('inst'), 'primary');
    await runtime.launch(req);
    await runtime.dispose();
    expect(sockets[0]?.allSent('Browser.close')).toHaveLength(0);
    expect(await runtime.list()).toEqual([]);
  });
});

/**
 * Two lifecycle defects, both about what this
 * runtime believes is true of an endpoint AFTER the browser at that
 * endpoint stops being the browser it last saw there.
 *
 * `runtime-remote` never spawns a process, so its whole notion of "which
 * browser is at this endpoint" is the `browserGuid` in
 * `/json/version`'s `webSocketDebuggerUrl`. Every one of these tests
 * changes that guid between calls, which is exactly what a person
 * restarting their Chrome does.
 */
describe('RemoteRuntime, endpoint bookkeeping after the remote browser goes away', () => {
  const origin = 'http://127.0.0.1:9222';

  function makeRuntime(
    guidByOrigin: Map<string, FakeEndpointConfig>,
    sockets: FakeRemoteWebSocket[],
  ): RemoteRuntime {
    const endpoints: RemoteEndpoint[] = [
      { name: 'primary', tenantId: 'ten_x', url: origin, auth: null },
    ];
    return new RemoteRuntime({
      endpoints,
      fetchImpl: fakeFetch(guidByOrigin),
      // Short enough that the failing shape of these tests (an identity
      // probe that can never be satisfied) reports its timeout in about a
      // second instead of the 15 second default.
      identityProbeTimeoutMs: 1200,
      wsFactory: () => {
        const socket = new FakeRemoteWebSocket();
        installDefaultResponder(socket);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
  }

  it('does not answer E_PORT_EXHAUSTED forever after the remote browser dies on its own', async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      [origin, { origin, browserGuid: 'guid-1' }],
    ]);
    const sockets: FakeRemoteWebSocket[] = [];
    const runtime = makeRuntime(guidByOrigin, sockets);

    await runtime.launch(makeLaunchRequest(newId('inst'), 'primary'));

    // The person quits Chrome, then starts it again on the same remote
    // debugging port: new process, new guid, same endpoint.
    sockets[0]?.simulateRemoteClose();
    await Promise.resolve();
    guidByOrigin.set(origin, { origin, browserGuid: 'guid-2' });

    const handle = await runtime.launch(makeLaunchRequest(newId('inst'), 'primary'));
    expect(handle.browserGuid).toBe('guid-2');
  });

  it('frees the endpoint binding when the remote browser dies on its own, so a relaunched Chrome on the same endpoint is usable again', async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      [origin, { origin, browserGuid: 'guid-1' }],
    ]);
    const sockets: FakeRemoteWebSocket[] = [];
    const runtime = makeRuntime(guidByOrigin, sockets);

    const first = makeLaunchRequest(newId('inst'), 'primary');
    await runtime.launch(first);

    // The person quits Chrome. The websocket drops; nothing asked it to.
    sockets[0]?.simulateRemoteClose();
    await Promise.resolve();

    // Nothing is running at this endpoint any more, so nothing should be
    // reported as running there either.
    expect(await runtime.list()).toEqual([]);

    // They start Chrome again with the same remote debugging port. New
    // process, new guid, same endpoint.
    guidByOrigin.set(origin, { origin, browserGuid: 'guid-2' });
    const second = makeLaunchRequest(newId('inst'), 'primary');
    const handle = await runtime.launch(second);
    expect(handle.browserGuid).toBe('guid-2');
  });

  it("terminate('detach') leaves the remote browser running: no Browser.close, effective 'detach'", async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      [origin, { origin, browserGuid: 'guid-1' }],
    ]);
    const sockets: FakeRemoteWebSocket[] = [];
    const runtime = makeRuntime(guidByOrigin, sockets);

    const handle = await runtime.launch(makeLaunchRequest(newId('inst'), 'primary'));
    const result = await runtime.terminate(handle, 'detach');

    expect(result.effective).toBe('detach');
    expect(sockets[0]?.allSent('Browser.close')).toHaveLength(0);
  });

  it('after an honest detach, a later launch matches the SAME browser still running at that endpoint', async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      [origin, { origin, browserGuid: 'guid-1' }],
    ]);
    const sockets: FakeRemoteWebSocket[] = [];
    const runtime = makeRuntime(guidByOrigin, sockets);

    const handle = await runtime.launch(makeLaunchRequest(newId('inst'), 'primary'));
    await runtime.terminate(handle, 'detach');

    // Nobody touched Chrome; it is the same process at the same guid.
    const again = await runtime.launch(makeLaunchRequest(newId('inst'), 'primary'));
    expect(again.browserGuid).toBe('guid-1');
  });

  it('after an honest detach, a later launch also matches a Chrome the person has since restarted at a NEW guid', async () => {
    const guidByOrigin = new Map<string, FakeEndpointConfig>([
      [origin, { origin, browserGuid: 'guid-1' }],
    ]);
    const sockets: FakeRemoteWebSocket[] = [];
    const runtime = makeRuntime(guidByOrigin, sockets);

    const handle = await runtime.launch(makeLaunchRequest(newId('inst'), 'primary'));
    await runtime.terminate(handle, 'detach');

    // The person restarts Chrome between the two acquires, which is the
    // routine thing this endpoint has to survive.
    guidByOrigin.set(origin, { origin, browserGuid: 'guid-2' });
    const again = await runtime.launch(makeLaunchRequest(newId('inst'), 'primary'));
    expect(again.browserGuid).toBe('guid-2');
  });
});
