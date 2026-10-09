/**
 * `EmbeddedGateway.close()` with a client still connected.
 *
 * `close()` used to await `httpServer.close()` before it called
 * `bg.stop()`. The server's close callback only fires once every
 * connection has ended, and an upgraded WebSocket never ends on its own,
 * so a gateway with one client attached never reached `bg.stop()`. The
 * operator saw a Ctrl+C that did nothing, killed the process, and every
 * Chrome it had launched kept running. Here the socket is a bare upgrade
 * that never sends its hello, which the server would drop by itself after
 * five seconds, so a close that finishes well inside that proves
 * `close()` no longer waits on the client.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildEmbeddedGateway } from '../src/gateway.js';

let dataDir: string | undefined;

afterEach(() => {
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
  dataDir = undefined;
});

describe('EmbeddedGateway.close()', () => {
  it('returns promptly while a WebSocket client is still connected', async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'bgls-close-'));
    const gateway = await buildEmbeddedGateway({
      dataDir,
      listenHost: '127.0.0.1',
      listenPort: 0,
    });

    const socket = new WebSocket(gateway.wsUrl, 'bgls.v1');
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('socket failed to open')));
    });
    const socketClosed = new Promise<void>((resolve) => {
      socket.addEventListener('close', () => resolve());
    });

    const started = Date.now();
    await gateway.close();
    const tookMs = Date.now() - started;

    await socketClosed;
    expect(tookMs).toBeLessThan(4_000);
  }, 30_000);
});
