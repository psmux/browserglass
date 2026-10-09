import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AutomationClient,
  AutomationError,
  BrowserSwarm,
  DEFAULT_LAUNCH_CAPS,
  launchInstance,
} from '../src/index.js';

/**
 * The REST half of `AutomationClient.launch()` against a stubbed `fetch`.
 * No socket is opened here: `launchInstance()` stops at the attach
 * ticket, and the connect step is the same `AutomationClient.connect()`
 * the rest of this suite already covers.
 */

interface Call {
  method: string;
  url: string;
  body: unknown;
  auth: string | undefined;
}

type Reply = { status: number; body?: unknown };

/** A `fetch` that answers from `route` and records every call. */
function fakeFetch(route: (call: Call, n: number) => Reply) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      auth: headers['authorization'],
    };
    calls.push(call);
    const r = route(call, calls.length);
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  return { impl, calls };
}

const GW = 'http://gw.test/browserglass';
const TOKEN = 'secret-admin-token-value';

/** A gateway that launches `inst_1`, reports `launching` `pendingPolls` times, then `ready`. */
function happyGateway(pendingPolls: number, extra?: (call: Call) => Reply | undefined) {
  let polls = 0;
  return fakeFetch((call) => {
    const override = extra?.(call);
    if (override) return override;
    if (call.method === 'POST' && call.url === `${GW}/v1/instances`) {
      return { status: 201, body: { instanceId: 'inst_1', state: 'launching' } };
    }
    if (call.method === 'GET' && call.url === `${GW}/v1/instances/inst_1`) {
      polls += 1;
      return {
        status: 200,
        body: { instance: { state: polls > pendingPolls ? 'ready' : 'launching' } },
      };
    }
    if (call.method === 'POST' && call.url === `${GW}/v1/instances/inst_1/attach`) {
      return {
        status: 200,
        body: { attach: { wsUrl: 'ws://gw.test/browserglass/socket', ticket: 'tkt' } },
      };
    }
    if (call.method === 'DELETE') return { status: 200, body: { released: true } };
    return { status: 404, body: { error: { code: 'E_NOT_FOUND', message: 'no route' } } };
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('launchInstance()', () => {
  it('acquires with a fresh requestId, polls until ready, then asks for a narrowed ticket', async () => {
    const gw = happyGateway(2);
    const opts = {
      gateway: `${GW}/`,
      adminToken: TOKEN,
      viewport: { width: 1280, height: 800 },
      profileKey: 'acct',
      pollIntervalMs: 1,
      fetch: gw.impl,
    };
    const a = await launchInstance(opts);
    expect(a).toMatchObject({
      instanceId: 'inst_1',
      wsUrl: 'ws://gw.test/browserglass/socket',
      ticket: 'tkt',
    });

    const [acquire] = gw.calls;
    expect(acquire?.auth).toBe(`Bearer ${TOKEN}`);
    expect(acquire?.body).toMatchObject({
      browser: { headless: 'new', viewport: { width: 1280, height: 800, deviceScaleFactor: 1 } },
      profile: { mode: 'persistent', key: 'acct' },
    });
    // two `launching` answers and one `ready`
    expect(gw.calls.filter((c) => c.method === 'GET')).toHaveLength(3);
    const attach = gw.calls.find((c) => c.url.endsWith('/attach'));
    expect(attach?.body).toMatchObject({ capabilities: [...DEFAULT_LAUNCH_CAPS] });
    expect(DEFAULT_LAUNCH_CAPS).toEqual(
      expect.arrayContaining(['evaluate', 'capture', 'devtools', 'intercept', 'download']),
    );
    expect(DEFAULT_LAUNCH_CAPS).not.toContain('admin');

    // a second launch never reuses the requestId
    await launchInstance(opts);
    const ids = gw.calls
      .filter((c) => c.method === 'POST' && c.url === `${GW}/v1/instances`)
      .map((c) => (c.body as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('passes headless: false through as off, and caller caps as given', async () => {
    const gw = happyGateway(0);
    await launchInstance({
      gateway: GW,
      adminToken: TOKEN,
      headless: false,
      caps: ['view', 'control', 'navigate'],
      fetch: gw.impl,
    });
    expect(gw.calls[0]?.body).toMatchObject({ browser: { headless: 'off' } });
    expect(gw.calls.find((c) => c.url.endsWith('/attach'))?.body).toMatchObject({
      capabilities: ['view', 'control', 'navigate'],
    });
  });

  it('times out while the browser stays launching, and ends it', async () => {
    const gw = happyGateway(Number.POSITIVE_INFINITY);
    const err = await launchInstance({
      gateway: GW,
      adminToken: TOKEN,
      readyTimeoutMs: 30,
      pollIntervalMs: 5,
      fetch: gw.impl,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutomationError);
    expect((err as AutomationError).code).toBe('TIMEOUT');
    expect(gw.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${GW}/v1/instances/inst_1?force=true`,
    });
  });

  it('fails fast on a failed instance', async () => {
    const gw = happyGateway(0, (c) =>
      c.method === 'GET' ? { status: 200, body: { instance: { state: 'failed' } } } : undefined,
    );
    const err = await launchInstance({
      gateway: GW,
      adminToken: TOKEN,
      pollIntervalMs: 1,
      fetch: gw.impl,
    }).catch((e: unknown) => e);
    expect((err as AutomationError).code).toBe('INSTANCE_GONE');
  });

  it('says how to get a token when none is given, without calling the gateway', async () => {
    vi.stubEnv('BGLS_ADMIN_TOKEN', '');
    const gw = happyGateway(0);
    const err = await launchInstance({ gateway: GW, fetch: gw.impl }).catch((e: unknown) => e);
    expect((err as AutomationError).code).toBe('UNAUTHENTICATED');
    expect((err as Error).message).toContain('pnpm bgls token');
    expect(gw.calls).toHaveLength(0);
  });

  it('reads the gateway and token from the environment', async () => {
    vi.stubEnv('BGLS_URL', GW);
    vi.stubEnv('BGLS_ADMIN_TOKEN', TOKEN);
    const gw = happyGateway(0);
    await launchInstance({ fetch: gw.impl });
    expect(gw.calls[0]?.url).toBe(`${GW}/v1/instances`);
    expect(gw.calls[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('explains an expired token and never echoes it', async () => {
    const gw = fakeFetch(() => ({
      status: 401,
      body: { error: { code: 'E_TOKEN_EXPIRED', message: 'token expired' } },
    }));
    const err = await launchInstance({ gateway: GW, adminToken: TOKEN, fetch: gw.impl }).catch(
      (e: unknown) => e,
    );
    expect((err as AutomationError).code).toBe('UNAUTHENTICATED');
    expect((err as Error).message).toMatch(/expired/);
    expect((err as Error).message).toContain('pnpm bgls token');
    expect((err as Error).message).not.toContain(TOKEN);
    expect(JSON.stringify((err as AutomationError).details)).not.toContain(TOKEN);
  });

  it('release() retries E_TERMINATE_FAILED and then succeeds', async () => {
    let deletes = 0;
    const gw = happyGateway(0, (c) => {
      if (c.method !== 'DELETE') return undefined;
      deletes += 1;
      return deletes < 3
        ? { status: 502, body: { error: { code: 'E_TERMINATE_FAILED', message: 'nope' } } }
        : { status: 200, body: { released: true } };
    });
    const a = await launchInstance({ gateway: GW, adminToken: TOKEN, fetch: gw.impl });
    vi.useFakeTimers();
    const done = a.release();
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(deletes).toBe(3);
    for (const c of gw.calls.filter((x) => x.method === 'DELETE')) {
      expect(c.url).toBe(`${GW}/v1/instances/inst_1?force=true`);
    }
  });

  it('release() gives up after three E_TERMINATE_FAILED answers', async () => {
    const gw = happyGateway(0, (c) =>
      c.method === 'DELETE'
        ? { status: 502, body: { error: { code: 'E_TERMINATE_FAILED', message: 'nope' } } }
        : undefined,
    );
    const a = await launchInstance({ gateway: GW, adminToken: TOKEN, fetch: gw.impl });
    vi.useFakeTimers();
    const done = a.release().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await done;
    expect((err as AutomationError).details?.['gatewayCode']).toBe('E_TERMINATE_FAILED');
    expect(gw.calls.filter((c) => c.method === 'DELETE')).toHaveLength(3);
  });

  it('release() treats a 404 as already released', async () => {
    const gw = happyGateway(0, (c) =>
      c.method === 'DELETE'
        ? { status: 404, body: { error: { code: 'E_INSTANCE_NOT_FOUND', message: 'gone' } } }
        : undefined,
    );
    const a = await launchInstance({ gateway: GW, adminToken: TOKEN, fetch: gw.impl });
    await expect(a.release()).resolves.toBeUndefined();
  });
});

describe('AutomationClient.launch()', () => {
  it('ends the browser when the socket connect fails', async () => {
    const gw = happyGateway(0);
    class RefusingSocket {
      constructor() {
        throw new Error('connect refused');
      }
    }
    await expect(
      AutomationClient.launch({
        gateway: GW,
        adminToken: TOKEN,
        fetch: gw.impl,
        transport: { WebSocketImpl: RefusingSocket as never },
      }),
    ).rejects.toThrow();
    expect(gw.calls.at(-1)).toMatchObject({
      method: 'DELETE',
      url: `${GW}/v1/instances/inst_1?force=true`,
    });
  });
});

describe('BrowserSwarm.open() options', () => {
  it('refuses both acquire and launch, and neither', async () => {
    await expect(BrowserSwarm.open({ size: 1 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    await expect(
      BrowserSwarm.open({
        size: 1,
        launch: {},
        acquire: async () => ({ instanceId: 'x', wsUrl: 'ws://x', token: 't' }),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});
