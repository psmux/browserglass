import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { UpgradeUnsupportedError, honoRoute } from '../../src/adapters/hono.js';
import { createBrowserGlass } from '../../src/index.js';

/**
 * Hono integration. Hono speaks the web `Request`/`Response` types, so the adapter is
 * `bg.fetch`, mounted at `app.all('/browserglass/*', honoRoute(bg))`. WS
 * still comes off the raw `node:http` server `@hono/node-server`'s
 * `serve()` returns, via `bg.attachUpgrade`.
 */
describe('Hono adapter', () => {
  let cleanup: (() => void) | undefined;

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('honoRoute(bg) serves a real REST call over bg.fetch and completes a real WebSocket handshake via attachUpgrade', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const app = new Hono();
    app.all(`${bg.config.basePath}/*`, (c) => honoRoute(bg)(c));

    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
    });
    bg.attachUpgrade(server as unknown as import('node:http').Server, { path: bg.config.wsPath });
    cleanup = () => {
      server.close();
    };

    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}${bg.config.basePath}/v1/instances`);
    expect(res.status).toBe(401); // no AuthResolver configured; BrowserGlass answered it
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBeTruthy();

    const ws = new WebSocket(`ws://127.0.0.1:${port}${bg.config.wsPath}`, ['bgls.v1']);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(ws.protocol).toBe('bgls.v1');
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('honoRoute throws E_UPGRADE_UNSUPPORTED, naming attachUpgrade, for a request that looks like a WebSocket upgrade', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const route = honoRoute(bg);
    const req = new Request(`http://localhost${bg.config.wsPath}`, {
      headers: { upgrade: 'websocket' },
    });
    await expect(route({ req: { raw: req } })).rejects.toThrow(UpgradeUnsupportedError);
    await expect(route({ req: { raw: req } })).rejects.toThrow(/attachUpgrade/);
  });
});
