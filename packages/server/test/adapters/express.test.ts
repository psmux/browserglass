import { createServer } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { checkExpressBodyParser, expressRest } from '../../src/adapters/express.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { createBrowserGlass } from '../../src/index.js';

/**
 * Express integration. `bg.rest()` is standard `(req, res, next)`
 * middleware, mounted unscoped (see `src/adapters/express.ts`'s module doc
 * for why it is not scoped under basePath); the only adapter specific
 * surface is the `body-parser` preflight check.
 */
describe('Express adapter', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('bg.rest() serves a real REST call and completes a real WebSocket handshake', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const app = express();
    app.use(expressRest(bg));

    const server = createServer(app);
    bg.attachUpgrade(server, { path: bg.config.wsPath });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    cleanup = async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    // A real REST call, routed by Express to BrowserGlass, answered by the
    // real dispatchRest. No AuthResolver is configured, so the live
    // `view` capable route correctly 401s: that is BrowserGlass having
    // served the call, not Express's own 404.
    const res = await fetch(`http://127.0.0.1:${port}${bg.config.basePath}/v1/instances`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBeTruthy();

    // The unscoped mount also reaches the two root level health paths,
    // which a basePath-scoped `app.use('/browserglass', ...)` never could.
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);

    // A real WebSocket handshake against the same server.
    const ws = new WebSocket(`ws://127.0.0.1:${port}${bg.config.wsPath}`, ['bgls.v1']);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(ws.protocol).toBe('bgls.v1');
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('the body-parser preflight check passes when BrowserGlass is mounted before express.json()', async () => {
    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const app = express();
    app.use(expressRest(bg));
    app.use(express.json());

    const result = await checkExpressBodyParser(config, app);
    expect(result.verdict).toBe('pass');
  });

  it('the body-parser preflight check fires (warn) when express.json() is mounted ahead of BrowserGlass, naming the exact fix', async () => {
    const config = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const app = express();
    // The common misordering: a global body
    // parser mounted before BrowserGlass drains the request body, so
    // every upload silently receives zero bytes.
    app.use(express.json());
    app.use(expressRest(bg));

    const result = await checkExpressBodyParser(config, app);
    expect(result.verdict).toBe('warn');
    expect(result.detail).toMatch(/jsonParser/);
    expect(result.detail).toMatch(/drains the request body/);
    expect(result.fix).toMatch(/bg\.rest\(\)/);
    expect(result.fix).toMatch(/express\.json\(\)/);
  });
});
