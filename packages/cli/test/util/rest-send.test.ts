/**
 * `restSend`, the primitive `bgls mcp` shutdown releases through.
 *
 * The point of it: an MCP host can kill `bgls mcp` about two seconds after
 * closing its stdin, and a release under load takes much longer than that
 * to answer. So shutdown waits only for `sent`, the gateway's `100
 * Continue`, and the gateway must still complete the request after the
 * client process is gone. The last test here runs the sender in a child
 * process that exits the moment `sent` resolves, against a server that
 * answers only seconds later.
 */
import { spawn } from 'node:child_process';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { GatewayConnection } from '../../src/context.js';
import { RestClientError, restSend } from '../../src/util/rest.js';

let server: Server | null = null;

afterEach(async () => {
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<GatewayConnection> {
  server = createServer(handler);
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    basePath: '',
    token: 'tok',
  } as unknown as GatewayConnection;
}

describe('restSend', () => {
  it('resolves sent long before a slow answer arrives, then resolves done with the body', async () => {
    let seen: { method?: string; url?: string; auth?: string; expect?: string } = {};
    const connection = await listen((req, res) => {
      seen = {
        method: req.method,
        url: req.url,
        auth: req.headers.authorization,
        expect: req.headers.expect,
      };
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ released: true, outcome: 'terminated' }));
      }, 1_500);
    });

    const started = Date.now();
    const call = restSend<{ outcome: string }>(connection, 'DELETE', '/v1/instances/inst_1');
    await call.sent;
    expect(Date.now() - started).toBeLessThan(1_000);
    // Acknowledged means the gateway's handler already has the request.
    expect(seen.url).toBe('/v1/instances/inst_1');

    const body = await call.done;
    expect(body.outcome).toBe('terminated');
    expect(seen).toEqual({
      method: 'DELETE',
      url: '/v1/instances/inst_1',
      auth: 'Bearer tok',
      expect: '100-continue',
    });
  });

  it('rejects done with the gateway error envelope on a non 2xx answer', async () => {
    const connection = await listen((_req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'E_TERMINATE_FAILED', message: 'nope' } }));
    });

    const call = restSend(connection, 'DELETE', '/v1/instances/inst_1');
    await call.sent;
    await expect(call.done).rejects.toBeInstanceOf(RestClientError);
    await expect(call.done).rejects.toMatchObject({ status: 502, code: 'E_TERMINATE_FAILED' });
  });

  it('rejects sent when nothing is listening', async () => {
    const connection = {
      endpoint: 'http://127.0.0.1:1',
      basePath: '',
      token: 'tok',
    } as unknown as GatewayConnection;
    const call = restSend(connection, 'DELETE', '/v1/instances/inst_1');
    await expect(call.sent).rejects.toBeDefined();
    await expect(call.done).rejects.toBeDefined();
  });

  it('the server completes a request whose sender exited as soon as it was acknowledged', async () => {
    let completed = 0;
    let allDone: () => void = () => undefined;
    const allCompleted = new Promise<void>((resolve) => {
      allDone = resolve;
    });
    const connection = await listen((_req, res) => {
      // The release takes 2 s here; the sender is long gone by then.
      res.on('error', () => undefined);
      setTimeout(() => {
        completed += 1;
        res.end('{}');
        if (completed === 3) allDone();
      }, 2_000);
    });

    const restModule = fileURLToPath(new URL('../../src/util/rest.ts', import.meta.url));
    const script = `
      const { restSend } = await import(${JSON.stringify(pathToFileURL(restModule).href)});
      const connection = ${JSON.stringify(connection)};
      const calls = ['inst_a', 'inst_b', 'inst_c'].map((id) =>
        restSend(connection, 'DELETE', '/v1/instances/' + id),
      );
      for (const c of calls) c.done.catch(() => undefined);
      await Promise.all(calls.map((c) => c.sent));
      process.exit(0);
    `;
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script],
      { stdio: 'ignore' },
    );
    const exitCode = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(exitCode).toBe(0);
    // Gone well before any answer could have come back.
    expect(completed).toBe(0);
    await allCompleted;
    expect(completed).toBe(3);
  }, 30_000);
});
