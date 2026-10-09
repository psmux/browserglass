import { Transport, type TransportHelloOptions } from '@browserglass/client';
import type { Envelope } from '@browserglass/protocol';
/**
 * Chaos scenario 1: `kill -9` the browser. The one assertion: **no
 * viewer socket closes, ever.**
 *
 * Scope note: the full design for this scenario runs the R4 and R5
 * recovery rungs immediately, relaunches within 30s with a new generation,
 * and restarts seq at 1. The current build implements recovery rungs R0
 * to R3 automatically and R4 manually only, via `instance.restart`
 * (`packages/core/src/recovery/types.ts`'s own
 * `automaticLadderFor('browser_dead')` is an empty array, since
 * `browser_dead`'s full ladder starts at R4). There is no automatic
 * relaunch yet for a fully dead browser process; a real `kill -9` of
 * Chrome is therefore expected to leave the instance unrecoverable until a
 * viewer issues `instance.restart`, and this test asserts the one thing
 * that must hold regardless of how much of the recovery ladder is wired,
 * with real Chrome, a real kill signal, and a real socket.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { type RealGateway, startRealGateway } from '../e2e/support/real-gateway.js';

const HELLO: TransportHelloOptions = {
  client: { name: 'conformance-chaos1', version: '0.0.0', runtime: 'node' },
  capabilities: {
    codecs: ['jpeg'],
    binaryFrames: true,
    input: ['mouse', 'key', 'text', 'touch', 'scroll'],
  },
  viewport: { width: 1280, height: 720, dpr: 1, visible: true, fitMode: 'contain' },
};

let gateway: RealGateway;

beforeAll(async () => {
  gateway = await startRealGateway({ headless: 'new' });
}, 120_000);

afterAll(async () => {
  await gateway.close();
}, 60_000);

describe('chaos scenario 1: kill -9 the browser, real Chrome', () => {
  it('no viewer socket closes, ever: the WS connection survives the browser process dying underneath it', async () => {
    const result = await gateway.acquireInstance();
    const token = await gateway.mintToken(result.instanceId);
    const transport = new Transport({
      url: gateway.wsUrl,
      token,
      autoReconnect: false,
      hello: HELLO,
      transport: { WebSocketImpl: WebSocket as never, allowInsecureTransport: true },
    });

    let closed: { code: number; reason: string } | undefined;
    transport.on('disconnected', (info) => {
      closed = { code: info.code, reason: info.reason };
    });
    const messages: Envelope[] = [];
    transport.on('message', (env) => messages.push(env));

    // The target list comes from `welcome.targets`, not
    // `AcquireResult.targets`: the router places and launches Chrome
    // but never talks CDP itself, so `acquire()`'s own
    // result always reports an empty `targets` array.
    const connected = new Promise<{ targets: readonly { targetId: string }[] }>((resolve) => {
      transport.once('connected', (info) => resolve(info.welcome));
    });
    await transport.connect();
    const welcome = await connected;
    const targetId = welcome.targets[0]?.targetId;
    if (!targetId) throw new Error('welcome reported no targets');

    transport.send({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId } as never);
    // Wait for the subscription to be live before killing the browser,
    // so a real frame pipeline exists to be disrupted.
    await new Promise<void>((resolve) => {
      const unsub = transport.on('message', (e) => {
        if (e['t'] === 'stream.subscribed') {
          unsub();
          resolve();
        }
      });
    });

    const { pid } = await gateway.describeInstance(result.instanceId);
    expect(pid).not.toBeNull();

    // The literal chaos scenario: `kill -9` the browser process itself,
    // not the whole process tree, and not a graceful `Browser.close`.
    process.kill(pid as number, 'SIGKILL');

    // Hold the connection open through the window the watchdog and
    // the automatic ladder would have used, proving the socket
    // was never closed as a side effect of the browser dying.
    await new Promise((resolve) => setTimeout(resolve, 8_000));

    expect(closed).toBeUndefined();
    expect(transport.state).not.toBe('fatal');
    expect(['live', 'degraded', 'resuming']).toContain(transport.state);

    // A real application ping/pong still round trips: the socket is not
    // merely "not yet closed", it is genuinely alive.
    const pong = new Promise<void>((resolve) => transport.once('pong', () => resolve()));
    transport.send({ v: 1, t: 'ping', ts: Date.now(), cts: Date.now() } as never);
    await pong;
    expect(closed).toBeUndefined();

    await transport.disconnect();
  }, 60_000);
});
