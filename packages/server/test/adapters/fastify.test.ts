import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { fastifyBrowserGlass } from '../../src/adapters/fastify.js';
import { createBrowserGlass } from '../../src/index.js';

/**
 * Fastify integration. `fastifyBrowserGlass` registers routes inside Fastify's own router
 * (visible in `fastify.printRoutes()`), scoped to `bg.config.basePath`,
 * installs the raw octet-stream parser and unlimited body size for the
 * upload route, the `onClose` shutdown hook, and the upgrade handler.
 */
describe('Fastify adapter', () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });

  it('fastifyBrowserGlass serves a real REST call and completes a real WebSocket handshake', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const fastify = Fastify();
    await fastify.register(fastifyBrowserGlass, { bg });
    await fastify.listen({ port: 0, host: '127.0.0.1' });

    cleanup = async () => {
      await fastify.close();
    };

    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}${bg.config.basePath}/v1/instances`);
    expect(res.status).toBe(401); // no AuthResolver configured; BrowserGlass answered it
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBeTruthy();

    // BrowserGlass's wildcard route is registered inside Fastify's own
    // router, so it is visible via fastify.printRoutes(), not hidden
    // behind an opaque catch-all handler.
    expect(fastify.printRoutes()).toMatch(/\*/);

    const ws = new WebSocket(`ws://127.0.0.1:${port}${bg.config.wsPath}`, ['bgls.v1']);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    expect(ws.protocol).toBe('bgls.v1');
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));
  });

  it('the onClose hook calls bg.stop() when fastify.close() runs', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const fastify = Fastify();
    await fastify.register(fastifyBrowserGlass, { bg });
    await fastify.listen({ port: 0, host: '127.0.0.1' });

    expect(bg.state).not.toBe('stopped');
    await fastify.close();
    expect(bg.state).toBe('stopped');
  });

  it('registers a raw application/octet-stream parser scoped to the prefix, so an unrecognised content type does not 415 before BrowserGlass sees it', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const fastify = Fastify();
    await fastify.register(fastifyBrowserGlass, { bg });
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    cleanup = async () => {
      await fastify.close();
    };
    const address = fastify.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const res = await fetch(`http://127.0.0.1:${port}${bg.config.basePath}/v1/instances`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    // Not a 415 (Fastify's "unsupported media type" for an unregistered
    // content type parser): the request reached BrowserGlass's own
    // routing, which itself 404s POST /v1/instances is not a registered
    // method+path pair in the live subset.
    expect(res.status).not.toBe(415);
  });
});
