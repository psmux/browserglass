import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { swarmRunCommand } from '../../src/commands/swarm.js';
import { EXIT_CODES } from '../../src/util/exit.js';
import { captureStdio, parseJsonLines } from '../support/capture-io.js';
import { createFakeGatewayHarness } from '../support/fake-gateway.js';
import { installFetchMock } from '../support/rest-fetch-mock.js';
import { completeHandshakeAt, waitForCondition } from '../support/ws-helpers.js';

const BASE_ARGS = { endpoint: 'http://127.0.0.1:7443', token: 'admin-tkn' };

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

/** Every member's `acquire()` gets a fresh `inst_swarm_<n>` id, immediately `ready` (no poll delay to keep the concurrency proof fast), plus a distinct token. Tracks every `POST /v1/instances` and every `DELETE` for teardown assertions. */
function installSwarmRestMock() {
  let createCount = 0;
  const routes = [
    {
      method: 'POST',
      test: (p: string) => p === '/browserglass/v1/instances',
      handle: () => {
        const id = `inst_swarm_${createCount}`;
        createCount += 1;
        return { status: 201, body: { instanceId: id, sessionId: `sess_${id}`, state: 'ready' } };
      },
    },
    {
      method: 'GET',
      test: (p: string) => /^\/browserglass\/v1\/instances\/inst_swarm_\d+$/.test(p),
      handle: (call: { pathname: string }) => {
        const id = call.pathname.split('/').pop() as string;
        return { status: 200, body: { instance: { id, state: 'ready' }, live: null } };
      },
    },
    {
      method: 'POST',
      test: (p: string) => p === '/browserglass/v1/tokens',
      handle: (call: { body: unknown }) => {
        const scope = (call.body as { scope: { instanceId: string } }).scope;
        return { status: 201, body: { token: `tkn-${scope.instanceId}` } };
      },
    },
    {
      method: 'DELETE',
      test: (p: string) => /^\/browserglass\/v1\/instances\/inst_swarm_\d+$/.test(p),
      handle: () => ({ status: 200, body: { released: true } }),
    },
  ];
  return installFetchMock(routes);
}

describe('swarm run', () => {
  it('--dry-run makes zero network calls', async () => {
    const mock = installSwarmRestMock();
    const io = captureStdio();
    await swarmRunCommand.run!({
      args: { ...BASE_ARGS, json: true, size: '3', action: 'status', 'dry-run': true },
    } as never);
    io.restore();
    mock.restore();
    expect(mock.calls).toHaveLength(0);
  });

  it('rejects a non-positive --size before any network call', async () => {
    const mock = installSwarmRestMock();
    await swarmRunCommand.run!({
      args: { ...BASE_ARGS, json: true, size: '0', action: 'status' },
    } as never);
    mock.restore();
    expect(process.exitCode).toBe(EXIT_CODES.usageError);
    expect(mock.calls).toHaveLength(0);
  });

  it("opens every member concurrently: all N sockets exist before any one member's handshake is completed", async () => {
    const mock = installSwarmRestMock();
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = swarmRunCommand.run!({
      args: { ...BASE_ARGS, json: true, size: '3', action: 'status' },
    } as never);

    // A serial acquire+connect (a `for` loop awaiting each member fully,
    // including its handshake, before starting the next) could never get
    // past member 0's socket construction, because member 0's handshake
    // is deliberately withheld below until every one of the 3 sockets
    // already exists. This is the real, structural version of
    // `@browserglass/automation`'s own swarm concurrency proof
    // (`packages/automation/test/swarm.test.ts`'s "all() runs every
    // member concurrently"), applied one level up at this command's own
    // acquire()+connect fan-out rather than at `swarm.all()`.
    await waitForCondition(() => harness.instances.length >= 3, 4000);
    expect(harness.instances).toHaveLength(3);

    for (let i = 0; i < 3; i++) {
      const gateway = completeHandshakeAt(harness, i, {
        instance: {
          instanceId: `inst_swarm_${i}`,
          state: 'running',
          engine: 'chromium',
          channel: 'stable',
          engineVersion: '1',
          headless: true,
          runtime: 'host',
          nodeId: null,
          profile: { mode: 'ephemeral', key: `eph:${i}`, sizeBytes: 0 },
          viewport: { width: 1280, height: 800, dpr: 1 },
          startedAt: Date.now(),
        },
        targets: [
          {
            targetId: `tgt_swarm_${i}`,
            kind: 'page',
            title: '',
            url: 'about:blank',
            faviconUrl: null,
            index: 0,
            active: true,
            audible: false,
            muted: false,
            loading: false,
            canGoBack: false,
            canGoForward: false,
            openerTargetId: null,
            viewers: 0,
            createdAt: Date.now(),
          },
        ],
      });
      void gateway;
    }

    const io = captureStdio();
    await runPromise;
    io.restore();
    mock.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const [line] = parseJsonLines(io.stdout) as [
      { size: number; results: Array<{ index: number; instanceId: string; ok: boolean }> },
    ];
    expect(line.size).toBe(3);
    expect(line.results).toHaveLength(3);
    expect(line.results.every((r) => r.ok)).toBe(true);
    expect(new Set(line.results.map((r) => r.instanceId)).size).toBe(3);

    // Default (no --keep): every acquired instance is released afterward.
    const deletes = mock.calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(3);
  }, 10000);

  it('--keep skips releasing the acquired instances', async () => {
    const mock = installSwarmRestMock();
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = swarmRunCommand.run!({
      args: { ...BASE_ARGS, json: true, size: '2', action: 'status', keep: true },
    } as never);
    await waitForCondition(() => harness.instances.length >= 2, 4000);
    for (let i = 0; i < 2; i++) {
      completeHandshakeAt(harness, i, {
        instance: {
          instanceId: `inst_swarm_${i}`,
          state: 'running',
          engine: 'chromium',
          channel: 'stable',
          engineVersion: '1',
          headless: true,
          runtime: 'host',
          nodeId: null,
          profile: { mode: 'ephemeral', key: `eph:${i}`, sizeBytes: 0 },
          viewport: { width: 1280, height: 800, dpr: 1 },
          startedAt: Date.now(),
        },
        targets: [
          {
            targetId: `tgt_swarm_${i}`,
            kind: 'page',
            title: '',
            url: 'about:blank',
            faviconUrl: null,
            index: 0,
            active: true,
            audible: false,
            muted: false,
            loading: false,
            canGoBack: false,
            canGoForward: false,
            openerTargetId: null,
            viewers: 0,
            createdAt: Date.now(),
          },
        ],
      });
    }
    const io = captureStdio();
    await runPromise;
    io.restore();
    mock.restore();

    expect(mock.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
  }, 10000);
});
