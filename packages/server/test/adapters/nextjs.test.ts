import { type Server as HttpServer, createServer } from 'node:http';
import path from 'node:path';
import next from 'next';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { createUpgradeDispatcher, defineGlobalBg, getBg } from '../../src/adapters/nextjs.js';
import { createBrowserGlass } from '../../src/index.js';

/**
 * Next.js custom server integration, and the "upgrade chain didn't
 * break" test: an existing `/ws/terminal` upgrade listener and
 * `/browserglass/socket` must coexist, with the BrowserGlass branch first
 * so a BrowserGlass upgrade never falls through to another comparison.
 *
 * Uses a minimal real Next.js dev app fixture
 * (`test/adapters/fixtures/nextjs-app`) so `nextApp.prepare()`,
 * `nextApp.getRequestHandler()`, and `nextApp.getUpgradeHandler()` are the
 * genuine Next.js implementations, not stand-ins. The first `prepare()`
 * against a cold `.next` cache is slow (Next's own dev compiler warm up),
 * hence the generous `beforeAll` timeout.
 */
describe('Next.js custom server adapter', () => {
  let httpServer: HttpServer;
  let port: number;
  let bg: ReturnType<typeof createBrowserGlass>;
  let terminalWss: WebSocketServer;

  beforeAll(async () => {
    const dir = path.resolve(import.meta.dirname, 'fixtures/nextjs-app');
    const nextApp = next({ dev: true, dir });
    // This installed Next.js version requires prepare() before either
    // handler can be retrieved (getUpgradeHandler() throws "prepare()
    // must be called before performing this operation" otherwise),
    // reversing the more obvious handler-first ordering.
    await nextApp.prepare();
    const nextHandle = nextApp.getRequestHandler();
    const nextUpgrade = nextApp.getUpgradeHandler();

    bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    defineGlobalBg(bg);

    // The "existing upgrade chain": a
    // terminal WebSocket route the app already had before adding
    // BrowserGlass.
    terminalWss = new WebSocketServer({ noServer: true });
    terminalWss.on('connection', (ws) => {
      ws.send('terminal-hello');
    });

    httpServer = createServer((req, res) => {
      void (async () => {
        if (await bg.handleRequest(req, res)) return;
        await nextHandle(req, res);
      })();
    });

    const dispatchUpgrade = createUpgradeDispatcher(bg, (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/ws/terminal') {
        terminalWss.handleUpgrade(req, socket, head, (ws) =>
          terminalWss.emit('connection', ws, req),
        );
        return;
      }
      nextUpgrade(req, socket, head);
    });
    httpServer.on('upgrade', dispatchUpgrade);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    port = typeof address === 'object' && address ? address.port : 0;
  }, 60_000);

  afterAll(async () => {
    terminalWss?.close();
    if (httpServer !== undefined) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    (globalThis as { __bg?: unknown }).__bg = undefined;
  });

  it('bg.handleRequest answers a REST call, and Next.js still serves its own page for everything else', async () => {
    const claimed = await fetch(`http://127.0.0.1:${port}${bg.config.basePath}/v1/instances`);
    expect(claimed.status).toBe(401); // no AuthResolver configured; BrowserGlass answered it

    const page = await fetch(`http://127.0.0.1:${port}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('ok');
  }, 30_000);

  it('the existing /ws/terminal upgrade and /browserglass/socket coexist without one breaking the other', async () => {
    const terminal = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal?workspace=ws_1`);
    const terminalOpen = new Promise<void>((resolve, reject) => {
      terminal.once('open', () => resolve());
      terminal.once('error', reject);
    });
    await terminalOpen;
    expect(terminal.readyState).toBe(WebSocket.OPEN);

    const bgls = new WebSocket(`ws://127.0.0.1:${port}${bg.config.wsPath}`, ['bgls.v1']);
    await new Promise<void>((resolve, reject) => {
      bgls.once('open', () => resolve());
      bgls.once('error', reject);
    });
    expect(bgls.protocol).toBe('bgls.v1');

    // Both sockets are simultaneously live: neither upgrade broke the
    // other.
    expect(terminal.readyState).toBe(WebSocket.OPEN);
    expect(bgls.readyState).toBe(WebSocket.OPEN);

    terminal.close();
    bgls.close();
    await Promise.all([
      new Promise<void>((resolve) => terminal.once('close', () => resolve())),
      new Promise<void>((resolve) => bgls.once('close', () => resolve())),
    ]);
  }, 15_000);

  it('createUpgradeDispatcher checks bg.shouldHandleUpgrade first, so a bgls path never falls through to the app fallback', async () => {
    let fallbackCalled = false;
    const dispatcher = createUpgradeDispatcher(bg, () => {
      fallbackCalled = true;
    });
    const fakeSocket = { write: () => undefined, destroy: () => undefined };
    dispatcher(
      { url: bg.config.wsPath, headers: {} } as never,
      fakeSocket as never,
      Buffer.alloc(0),
    );
    // bg.handleUpgrade runs synchronously up to the point of needing real
    // I/O; either way, the fallback must never have been invoked for a
    // path bg.shouldHandleUpgrade claims.
    expect(fallbackCalled).toBe(false);
  });

  it('getBg() returns the instance defineGlobalBg stored, the pattern App Router route handlers use', () => {
    expect(getBg()).toBe(bg);
  });

  it('getBg() throws a plain, readable message about server.mjs vs next dev when nothing was defined', () => {
    const saved = (globalThis as { __bg?: unknown }).__bg;
    (globalThis as { __bg?: unknown }).__bg = undefined;
    try {
      expect(() => getBg()).toThrow(/next dev/);
      expect(() => getBg()).toThrow(/server\.mjs/);
    } finally {
      (globalThis as { __bg?: unknown }).__bg = saved;
    }
  });
});
