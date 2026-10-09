import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createBrowserGlass } from '../../src/index.js';

/**
 * `node:http` is the baseline integration and gets no exported adapter:
 * `bg.handleRequest` plus `bg.attachUpgrade` is the whole pattern. This
 * test documents it by being exactly that wiring, against a real
 * `http.Server`, and proves both halves work: a real REST call through `handleRequest`, and a
 * real WebSocket handshake through `attachUpgrade`.
 */
describe('node:http baseline adapter', () => {
  it('bg.handleRequest answers a REST call and falls through for everything else', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });

    const server = createServer((req, res) => {
      void (async () => {
        if (await bg.handleRequest(req, res)) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not_found_by_app"}');
      })();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      // A path BrowserGlass claims (basePath default is /browserglass).
      const claimed = await fetch(`http://127.0.0.1:${port}/browserglass/v1/instances`);
      expect(claimed.status).toBe(401); // no AuthResolver configured
      const claimedBody = (await claimed.json()) as { error: { code: string } };
      expect(claimedBody.error.code).toBeTruthy();

      // A path BrowserGlass does not claim: handleRequest resolves false,
      // nothing was written, and the app's own fallback answers instead.
      const unclaimed = await fetch(`http://127.0.0.1:${port}/some/other/app/route`);
      expect(unclaimed.status).toBe(404);
      expect(await unclaimed.text()).toBe('{"error":"not_found_by_app"}');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bg.attachUpgrade completes a real WebSocket handshake, negotiating the bgls.v1 subprotocol', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });

    const server = createServer((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not_found"}');
    });

    const detach = bg.attachUpgrade(server, { path: '/browserglass/socket' });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/browserglass/socket`, ['bgls.v1']);
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
      expect(ws.protocol).toBe('bgls.v1');
      ws.close();
      await new Promise<void>((resolve) => ws.once('close', () => resolve()));
    } finally {
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('attachUpgrade returns cleanly (no socket write) for an unmatched path', () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const server = createServer();
    bg.attachUpgrade(server, { path: '/browserglass/socket' });

    // A real end-to-end socket for this case sits open forever by design
    // (it returns cleanly, with no socket write), which makes it
    // untestable through a real TCP round trip without an artificial
    // timeout. Instead, invoke the exact listener `attachUpgrade`
    // registered directly, the same one Node itself would call, and
    // assert it never touches the socket for a path it does not claim.
    const listener = server.listeners('upgrade')[0] as
      | ((req: unknown, socket: unknown, head: unknown) => void)
      | undefined;
    expect(listener).toBeTypeOf('function');

    let wrote = false;
    let destroyed = false;
    const fakeSocket = {
      write: () => {
        wrote = true;
      },
      destroy: () => {
        destroyed = true;
      },
    };
    const fakeReq = { url: '/totally/unrelated', headers: {} };
    listener?.(fakeReq, fakeSocket, Buffer.alloc(0));

    expect(wrote).toBe(false);
    expect(destroyed).toBe(false);
  });
});
