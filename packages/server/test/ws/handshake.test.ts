import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitClose,
  waitOpen,
} from './support/test-gateway.js';

// Tier-1 (non-passthrough) encodes would otherwise load the native `sharp`
// binding; this suite's targets are all served at the default capture
// spec, so tier 0 passthrough is exercised throughout, but the encoder is
// stubbed defensively anyway, the same way `core`'s own tests do.
setTier1EncoderFactory(async (input) => input);

let gw: TestGateway;

beforeEach(async () => {
  gw = await startTestGateway();
  gw.addTarget({
    targetId: 'cdp-a',
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
  });
});

afterEach(async () => {
  await gw.close();
});

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    ...overrides,
  };
}

describe('bgls.v1 handshake', () => {
  it('completes the full conformance handshake: hello -> welcome with sq 1', async () => {
    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const welcome = await nextMessage(ws);
    expect(welcome['t']).toBe('welcome');
    expect(welcome['sq']).toBe(1);
    expect(welcome['re']).toBeDefined();
    expect(welcome['viewerId']).toBeTruthy();
    expect(welcome['sessionId']).toBeTruthy();
    expect(Array.isArray(welcome['targets'])).toBe(true);
    ws.close();
  });

  it('a client offering no bgls.v1 subprotocol gets HTTP 400 and no socket', async () => {
    const ws = gw.connect({ protocols: ['not-bgls'] });
    await expect(waitOpen(ws)).rejects.toThrow();
  });

  it('a bad token completes the WS handshake, then closes 4200', async () => {
    const ws = gw.connect();
    await waitOpen(ws); // the WS handshake itself succeeds
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token: 'not-a-real-token' } })));
    const closed = await waitClose(ws);
    expect(closed.code).toBe(4200);
  });

  it('hello.subscribe folds a subscription into the handshake, stream.subscribed arrives after welcome', async () => {
    // Discover the real (`tgt_...`) wire id for the fake target first: a
    // fresh connection's `welcome.targets` is the only place a client
    // learns it (`hello.subscribe` cannot reference an id it does not
    // already know).
    const discovery = gw.connect();
    await waitOpen(discovery);
    discovery.send(
      JSON.stringify(hello({ auth: { scheme: 'bearer', token: await gw.issueToken() } })),
    );
    const discoveryWelcome = await nextMessage(discovery);
    const targets = discoveryWelcome['targets'] as Array<{ targetId: string }>;
    expect(targets.length).toBeGreaterThan(0);
    const targetId = targets[0]!.targetId;
    discovery.close();

    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(
      JSON.stringify(hello({ auth: { scheme: 'bearer', token }, subscribe: [{ targetId }] })),
    );
    const welcome = await nextMessage(ws);
    expect(welcome['t']).toBe('welcome');
    const subscribed = await nextMessageSkipping(ws, ['presence.state']);
    expect(subscribed['t']).toBe('stream.subscribed');
    expect(subscribed['targetId']).toBe(targetId);
    expect(typeof subscribed['streamId']).toBe('number');
    ws.close();
  });

  it('anything but hello as the first message closes 4202 expected_hello', async () => {
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify({ v: 1, t: 'ping', cts: Date.now() }));
    const closed = await waitClose(ws);
    expect(closed.code).toBe(4202);
  });

  it('a second hello without reauth:true closes 4202 duplicate_hello', async () => {
    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    await nextMessage(ws); // welcome
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const closed = await waitClose(ws);
    expect(closed.code).toBe(4202);
  });

  it('hello{reauth:true} answers with a fresh welcome{reauth:true}, viewerId unchanged', async () => {
    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const welcome1 = await nextMessage(ws);
    // presence.state always follows a fresh welcome (ManagedSession.
    // broadcastPresence()); drain it before sending anything else, since
    // nextMessageSkipping only discards a *leading* run of matching
    // messages and welcome1 itself is not in the skip list, so it would
    // return immediately without ever reaching this one.
    await nextMessage(ws);

    const token2 = await gw.issueToken({ viewerId: welcome1['viewerId'] as string });
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token: token2 }, reauth: true })));
    const welcome2 = await nextMessage(ws);
    expect(welcome2['t']).toBe('welcome');
    expect(welcome2['reauth']).toBe(true);
    expect(welcome2['viewerId']).toBe(welcome1['viewerId']);
    ws.close();
  });
});
