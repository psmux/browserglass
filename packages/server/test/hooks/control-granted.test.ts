/**
 * `onControlGranted`, fired from `ws/connection.ts`'s
 * `checkControlGranted` BEFORE `ManagedSession.requestControl()` is ever
 * called (see that method's own doc for why it has to run first: by the
 * time `core.ControlLeaseEngine.requestControl()` returns, a grant it
 * admits has already been sent to the wire, through a synchronous
 * constructor-bound `emit` callback this package has no seam to intercept
 * without editing `@browserglass/core`). A veto here means
 * `requestControl` is never called at all: no lease, no `control.granted`,
 * only a correlated `error` reply.
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import type { ControlGrantedEvent } from '../../src/hooks/types.js';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from '../ws/support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: {
      codecs: ['jpeg'],
      binaryFrames: true,
      input: ['mouse', 'key', 'text', 'touch', 'scroll'],
    },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    ...overrides,
  };
}

async function connect(gw: TestGateway): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken();
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
  const welcome = await nextMessage(ws);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

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

describe('onControlGranted: fire', () => {
  it('fires before the grant, with subject === viewerId, no previous holder, and the request still succeeds', async () => {
    const seen: ControlGrantedEvent[] = [];
    gw.connectionDeps.hooks.on('onControlGranted', (e) => {
      seen.push(e);
      return undefined;
    });

    const { ws, targetId } = await connect(gw);
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, UNSOLICITED);

    expect(reply['t']).toBe('control.granted');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.targetId).toBe(targetId);
    expect(seen[0]!.subject).toBe(seen[0]!.viewerId);
    expect(seen[0]!.previousHolder).toBeNull();
    expect(seen[0]!.forceClaimed).toBe(false);
    expect(seen[0]!.ttlMs).toBeGreaterThan(0);
    ws.close();
  });

  it('is not consulted at all when nothing is registered (HookRegistry.has short-circuits it): control.request behaves exactly as before', async () => {
    const { ws, targetId } = await connect(gw);
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('control.granted');
    ws.close();
  });
});

describe('onControlGranted: veto', () => {
  it('a handler returning false stops the grant: a correlated policy.denied error instead of control.granted, and the lease stays unheld', async () => {
    gw.connectionDeps.hooks.on('onControlGranted', (e) => {
      e.reason = 'no automation on this target';
      return false;
    });

    const { ws, targetId } = await connect(gw);
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, UNSOLICITED);

    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.policy.denied');
    expect(reply['fatal']).toBe(false);
    expect(reply['re']).toBe('c1');
    expect((reply['context'] as Record<string, unknown>)['reason']).toBe(
      'no automation on this target',
    );

    // The lease was never actually granted: input from this same viewer,
    // which requires a held lease, is refused as not held rather than
    // accepted.
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'input.mouse',
        id: 'i1',
        ts: Date.now(),
        targetId,
        kind: 'move',
        x: 1,
        y: 1,
        fw: 800,
        fh: 600,
        buttons: 0,
        modifiers: 0,
        leaseId: 'lse_not_real',
        gen: 1,
      }),
    );
    const inputReply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(inputReply['t']).toBe('error');
    expect(inputReply['code']).toBe('bgls.error.control.not_held');
    ws.close();
  });

  it('a subsequent request succeeds once the veto is lifted, proving the earlier refusal left no lease behind', async () => {
    const unregister = gw.connectionDeps.hooks.on('onControlGranted', () => false);

    const { ws, targetId } = await connect(gw);
    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c1', ts: Date.now(), targetId }));
    const denied = await nextMessageSkipping(ws, UNSOLICITED);
    expect(denied['t']).toBe('error');

    unregister();

    ws.send(JSON.stringify({ v: 1, t: 'control.request', id: 'c2', ts: Date.now(), targetId }));
    const granted = await nextMessageSkipping(ws, UNSOLICITED);
    expect(granted['t']).toBe('control.granted');
    expect(granted['re']).toBe('c2');
    ws.close();
  });
});
