import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  instancesClickCommand,
  instancesConsoleCommand,
  instancesCreateCommand,
  instancesDescribeCommand,
  instancesKillCommand,
  instancesListCommand,
  instancesNavigateCommand,
  instancesReleaseCommand,
  instancesScreenshotCommand,
  instancesTargetsCommand,
  instancesTypeCommand,
} from '../../src/commands/instances-cmd.js';
import { EXIT_CODES } from '../../src/util/exit.js';
import { captureStdio, parseJsonLines } from '../support/capture-io.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../support/fake-gateway.js';
import { type FetchRoute, installFetchMock } from '../support/rest-fetch-mock.js';
import { waitForCondition } from '../support/ws-helpers.js';

// Every test resolves a `GatewayConnection` straight from `--endpoint`/
// `--token` flags (see `context.ts`'s `resolveGatewayConnection`), never
// from a `dev-session.json`, so none of this depends on a real `bgls
// serve` having run anywhere near this test's cwd. `127.0.0.1`, not an
// arbitrary hostname: `Transport` refuses `ws://` to a non-loopback host
// outright.
const BASE_ARGS = { endpoint: 'http://127.0.0.1:7443', token: 'admin-tkn' };

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.exitCode = undefined;
});

describe('instances list', () => {
  it('--json prints exactly one JSON line on stdout matching the REST response, nothing else on stdout', async () => {
    const mock = installFetchMock([
      {
        method: 'GET',
        test: (p) => p === '/browserglass/v1/instances',
        handle: () => ({
          status: 200,
          body: {
            items: [
              {
                instance: { id: 'inst_1', state: 'ready', poolId: 'default', nodeId: 'nod_1' },
                live: null,
              },
            ],
            nextCursor: null,
            hasMore: false,
          },
        }),
      },
    ]);
    const io = captureStdio();
    await instancesListCommand.run!({ args: { ...BASE_ARGS, json: true } } as never);
    io.restore();
    mock.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const lines = parseJsonLines(io.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ items: [{ instance: { id: 'inst_1', state: 'ready' } }] });
  });

  it('applies --pool and --state as REST query parameters', async () => {
    const mock = installFetchMock([
      {
        method: 'GET',
        test: (p) => p === '/browserglass/v1/instances',
        handle: () => ({ status: 200, body: { items: [], nextCursor: null, hasMore: false } }),
      },
    ]);
    const io = captureStdio();
    await instancesListCommand.run!({
      args: { ...BASE_ARGS, json: true, pool: 'default', state: 'ready' },
    } as never);
    io.restore();
    mock.restore();
    expect(mock.calls[0]?.search.get('poolId')).toBe('default');
    expect(mock.calls[0]?.search.get('state')).toBe('ready');
  });
});

describe('instances describe', () => {
  it('a 404 sets EXIT_CODES.notFound and writes the error to stderr, nothing to stdout, in --json mode', async () => {
    const mock = installFetchMock([
      {
        method: 'GET',
        test: (p) => p === '/browserglass/v1/instances/inst_missing',
        handle: () => ({
          status: 404,
          body: { error: { code: 'E_NOT_FOUND', message: 'no such instance' } },
        }),
      },
    ]);
    const io = captureStdio();
    await instancesDescribeCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_missing' },
    } as never);
    io.restore();
    mock.restore();

    expect(process.exitCode).toBe(EXIT_CODES.notFound);
    expect(io.stdout.join('')).toBe('');
    expect(io.stderr.join('')).toContain('E_NOT_FOUND');
  });
});

describe('instances create', () => {
  it('--dry-run makes zero network calls and prints the AcquireRequest it would have sent', async () => {
    const mock = installFetchMock([]);
    const io = captureStdio();
    await instancesCreateCommand.run!({
      args: { ...BASE_ARGS, json: true, pool: 'default', viewport: '800x600', 'dry-run': true },
    } as never);
    io.restore();
    mock.restore();

    expect(mock.calls).toHaveLength(0);
    const [line] = parseJsonLines(io.stdout) as [
      { dryRun: boolean; request: { pool: string; browser: { viewport: { width: number } } } },
    ];
    expect(line.dryRun).toBe(true);
    expect(line.request.pool).toBe('default');
    expect(line.request.browser.viewport.width).toBe(800);
  });

  it('a malformed --viewport is a usage error before any network call', async () => {
    const mock = installFetchMock([]);
    const io = captureStdio();
    await instancesCreateCommand.run!({
      args: { ...BASE_ARGS, json: true, viewport: 'nope' },
    } as never);
    io.restore();
    mock.restore();

    expect(process.exitCode).toBe(EXIT_CODES.usageError);
    expect(mock.calls).toHaveLength(0);
  });

  it('acquires, polls until ready, and reports ready:true', async () => {
    const mock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/instances',
        handle: () => ({
          status: 201,
          body: { instanceId: 'inst_new', sessionId: 'sess_new', state: 'launching' },
        }),
      },
      {
        method: 'GET',
        test: (p) => p === '/browserglass/v1/instances/inst_new',
        handle: () => ({
          status: 200,
          body: {
            instance: { id: 'inst_new', state: 'ready', poolId: 'default', profileId: null },
            live: null,
          },
        }),
      },
    ]);
    const io = captureStdio();
    await instancesCreateCommand.run!({ args: { ...BASE_ARGS, json: true } } as never);
    io.restore();
    mock.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const [line] = parseJsonLines(io.stdout) as [
      { instanceId: string; ready: boolean; state: string },
    ];
    expect(line).toMatchObject({ instanceId: 'inst_new', ready: true, state: 'ready' });
  });
});

describe('instances release', () => {
  it('--dry-run makes zero network calls', async () => {
    const mock = installFetchMock([]);
    const io = captureStdio();
    await instancesReleaseCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_1', 'dry-run': true },
    } as never);
    io.restore();
    mock.restore();
    expect(mock.calls).toHaveLength(0);
  });

  it('DELETEs the instance and reports released:true', async () => {
    const mock = installFetchMock([
      {
        method: 'DELETE',
        test: (p) => p === '/browserglass/v1/instances/inst_1',
        handle: () => ({ status: 200, body: { released: true } }),
      },
    ]);
    const io = captureStdio();
    await instancesReleaseCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_1' },
    } as never);
    io.restore();
    mock.restore();

    const [line] = parseJsonLines(io.stdout) as [{ released: boolean }];
    expect(line.released).toBe(true);
  });
});

describe('instances kill', () => {
  it('stays a stub: makes zero network calls, exits operationalFailure, names E_NOT_IMPLEMENTED', async () => {
    const mock = installFetchMock([]);
    const io = captureStdio();
    await instancesKillCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_1' },
    } as never);
    io.restore();
    mock.restore();

    expect(mock.calls).toHaveLength(0);
    expect(process.exitCode).toBe(EXIT_CODES.operationalFailure);
    const [line] = parseJsonLines(io.stdout) as [{ error: { code: string } }];
    expect(line.error.code).toBe('E_NOT_IMPLEMENTED');
  });
});

describe('driving commands (AutomationClient over a fake bgls.v1 socket)', () => {
  it("instances targets lists what the gateway's target.list answers with", async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = instancesTargetsCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_0000000000000000000000001' },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    const gateway = startScriptedGateway(harness);
    gateway.targets = [
      { targetId: 'tgt_a', kind: 'page', title: 'A', url: 'https://a.test/', active: true },
      { targetId: 'tgt_b', kind: 'page', title: 'B', url: 'https://b.test/', active: false },
    ];

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    const [line] = parseJsonLines(io.stdout) as [{ targets: Array<{ targetId: string }> }];
    expect(line.targets.map((t) => t.targetId)).toEqual(['tgt_a', 'tgt_b']);
  });

  it('instances navigate acquires a lease, navigates, and reports the resulting StatusResult', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = instancesNavigateCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        instanceId: 'inst_0000000000000000000000001',
        url: 'https://example.test/next',
      },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    startScriptedGateway(harness);

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const [line] = parseJsonLines(io.stdout) as [{ url: string }];
    expect(line.url).toBe('https://example.test/next');
  });

  it('instances navigate without --url is a usage error before connecting', async () => {
    const io = captureStdio();
    await instancesNavigateCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_1' },
    } as never);
    io.restore();
    expect(process.exitCode).toBe(EXIT_CODES.usageError);
  });

  it('instances click reports the clicked point', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = instancesClickCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        instanceId: 'inst_0000000000000000000000001',
        x: '10',
        y: '20',
      },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    startScriptedGateway(harness);

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    const [line] = parseJsonLines(io.stdout) as [{ x: number; y: number; clicked: boolean }];
    expect(line).toMatchObject({ x: 10, y: 20, clicked: true });
  });

  it('instances type reports the character count typed', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = instancesTypeCommand.run!({
      args: {
        ...BASE_ARGS,
        json: true,
        instanceId: 'inst_0000000000000000000000001',
        text: 'hello',
      },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    startScriptedGateway(harness);

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    const [line] = parseJsonLines(io.stdout) as [{ length: number; typed: boolean }];
    expect(line).toMatchObject({ length: 5, typed: true });
  });

  it('instances screenshot with --out saves the PNG and reports the path, not inline data', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bgls-cli-test-'));
    const out = join(dir, 'shot.png');
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = instancesScreenshotCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_0000000000000000000000001', out },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    startScriptedGateway(harness);

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    const [line] = parseJsonLines(io.stdout) as [{ savedTo: string; data?: string }];
    expect(line.savedTo).toBe(out);
    expect(line.data).toBeUndefined();
    expect(readFileSync(out).length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it('instances console (no --follow) collects broadcast console entries and prints them once the window elapses', async () => {
    const tokenMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => ({ status: 201, body: { token: 'tkn' } }),
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const runPromise = instancesConsoleCommand.run!({
      args: { ...BASE_ARGS, json: true, instanceId: 'inst_0000000000000000000000001' },
    } as never);
    await waitForCondition(() => harness.instances.length > 0);
    const gateway = startScriptedGateway(harness);
    await waitForCondition(() =>
      gateway.ws.sentJsonMessages().some((m) => m['t'] === 'diagnostics.subscribe'),
    );
    gateway.sendConsoleEntry('tgt_0000000000000000000000001', { level: 'error', text: 'boom' });

    const io = captureStdio();
    await runPromise;
    io.restore();
    tokenMock.restore();

    const [line] = parseJsonLines(io.stdout) as [
      { entries: Array<{ type: string; entry: { text: string } }> },
    ];
    expect(line.entries).toHaveLength(1);
    expect(line.entries[0]).toMatchObject({ type: 'console', entry: { text: 'boom' } });
  }, 10000);
});
