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

/** Same shape as `swarm.test.ts`'s own mock, duplicated rather than shared so the two suites can assert on their own call lists independently. */
function installSwarmRestMock() {
  let createCount = 0;
  return installFetchMock([
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
      handle: (call: { pathname: string }) => ({
        status: 200,
        body: {
          instance: { id: call.pathname.split('/').pop() as string, state: 'ready' },
          live: null,
        },
      }),
    },
    {
      method: 'POST',
      test: (p: string) => p === '/browserglass/v1/tokens',
      handle: (call: { body: unknown }) => ({
        status: 201,
        body: { token: `tkn-${(call.body as { scope: { instanceId: string } }).scope.instanceId}` },
      }),
    },
    {
      method: 'DELETE',
      test: (p: string) => /^\/browserglass\/v1\/instances\/inst_swarm_\d+$/.test(p),
      handle: () => ({
        status: 200,
        body: { released: true, outcome: 'terminated', remainingViewers: 0 },
      }),
    },
  ]);
}

/** Drives `size` members' handshakes, matching the instance ids the REST mock above hands out. */
async function completeMembers(
  harness: ReturnType<typeof createFakeGatewayHarness>,
  size: number,
): Promise<void> {
  await waitForCondition(() => harness.instances.length >= size, 4000);
  for (let i = 0; i < size; i++) {
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
}

describe('swarm run --sticky-subject', () => {
  it('sends one distinct slot subject per member, on both sticky.subject and subject', async () => {
    const mock = installSwarmRestMock();
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = swarmRunCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        size: '3',
        action: 'status',
        'sticky-subject': 'nightly-crawler',
      },
    } as never);
    await completeMembers(harness, 3);
    const io = captureStdio();
    await runPromise;
    io.restore();
    mock.restore();

    const creates = mock.calls.filter(
      (c) => c.method === 'POST' && c.pathname === '/browserglass/v1/instances',
    );
    expect(creates).toHaveLength(3);
    const bodies = creates.map((c) => c.body as { sticky?: { subject: string }; subject?: string });
    // One subject per member slot. The bare `nightly-crawler` never
    // appears: three requests carrying it would all select whichever
    // single instance the router resolves that subject to.
    expect(bodies.map((b) => b.sticky?.subject).sort()).toEqual([
      'nightly-crawler#0',
      'nightly-crawler#1',
      'nightly-crawler#2',
    ]);
    // The tag travels with the selector, or the browsers this run
    // launches are filed under the CLI token's own sub and the next run
    // finds none of them.
    expect(bodies.map((b) => b.subject).sort()).toEqual([
      'nightly-crawler#0',
      'nightly-crawler#1',
      'nightly-crawler#2',
    ]);
  }, 10000);

  it('forwards --sticky-within-ms to every member', async () => {
    const mock = installSwarmRestMock();
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = swarmRunCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        size: '2',
        action: 'status',
        'sticky-subject': 'crawler',
        'sticky-within-ms': '600000',
      },
    } as never);
    await completeMembers(harness, 2);
    const io = captureStdio();
    await runPromise;
    io.restore();
    mock.restore();

    const creates = mock.calls.filter(
      (c) => c.method === 'POST' && c.pathname === '/browserglass/v1/instances',
    );
    expect(
      creates.map((c) => (c.body as { sticky: { withinMs: number } }).sticky.withinMs),
    ).toEqual([600_000, 600_000]);
  }, 10000);

  it('keeps the instances by default when a subject is given: releasing browsers this run just claimed would make the next run relaunch them', async () => {
    const mock = installSwarmRestMock();
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = swarmRunCommand.run!({
      args: { ...BASE_ARGS, json: true, size: '2', action: 'status', 'sticky-subject': 'crawler' },
    } as never);
    await completeMembers(harness, 2);
    const io = captureStdio();
    await runPromise;
    io.restore();
    mock.restore();

    expect(mock.calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    const [line] = parseJsonLines(io.stdout) as [{ stickySubject: string; released: boolean }];
    expect(line.stickySubject).toBe('crawler');
    expect(line.released).toBe(false);
  }, 10000);

  it('--keep false releases anyway, so the ownership-aware default is a default and not a lock', async () => {
    const mock = installSwarmRestMock();
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = swarmRunCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        size: '2',
        action: 'status',
        'sticky-subject': 'crawler',
        keep: false,
      },
    } as never);
    await completeMembers(harness, 2);
    const io = captureStdio();
    await runPromise;
    io.restore();
    mock.restore();

    expect(mock.calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
  }, 10000);

  it('rejects --sticky-within-ms that is not a number before any network call', async () => {
    const mock = installSwarmRestMock();
    await swarmRunCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        size: '2',
        action: 'status',
        'sticky-subject': 'crawler',
        'sticky-within-ms': 'soon',
      },
    } as never);
    mock.restore();

    expect(process.exitCode).toBe(EXIT_CODES.usageError);
    expect(mock.calls).toHaveLength(0);
  });

  it('--dry-run names which of the two behaviours the run would get', async () => {
    const mock = installSwarmRestMock();
    const io = captureStdio();
    await swarmRunCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        size: '4',
        action: 'status',
        'sticky-subject': 'crawler',
        'dry-run': true,
      },
    } as never);
    io.restore();
    mock.restore();

    expect(mock.calls).toHaveLength(0);
    const [line] = parseJsonLines(io.stdout) as [{ stickySubject: string }];
    expect(line.stickySubject).toBe('crawler');
  });
});
