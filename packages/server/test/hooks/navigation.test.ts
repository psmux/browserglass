/**
 * `onNavigation`, fired from `ws/connection.ts`'s `runNav` for `nav.goto`
 * only (see that call site's own comment for why `back`/`forward`/
 * `reload`/`stop` stay ungated: they would need a `Page.getNavigationHistory`
 * round trip to even learn the URL, which is exactly the cost
 * `HookRegistry.has` exists to let a call site skip when nobody is
 * listening). A veto here means `ManagedSession.navigate()` (and therefore
 * `Page.navigate`) is never called at all.
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import type { NavigationEvent } from '../../src/hooks/types.js';
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

describe('onNavigation: fire', () => {
  it('fires for nav.goto with kind:"user", the target url, and lets a normal navigation through', async () => {
    const seen: NavigationEvent[] = [];
    gw.connectionDeps.hooks.on('onNavigation', (e) => {
      seen.push(e);
      return undefined;
    });

    const { ws, targetId } = await connect(gw);
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'nav.goto',
        id: 'n1',
        ts: Date.now(),
        targetId,
        url: 'https://b.example',
      }),
    );
    const reply = await nextMessageSkipping(ws, UNSOLICITED);

    expect(reply['t']).toBe('nav.state');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.targetId).toBe(targetId);
    expect(seen[0]!.url).toBe('https://b.example');
    expect(seen[0]!.kind).toBe('user');
    expect(seen[0]!.redirectChain).toEqual([]);
    expect(gw.chrome.cdpCalls.some((c) => c.method === 'Page.navigate')).toBe(true);
    ws.close();
  });

  it('is not consulted, and costs nothing, when nothing is registered: nav.goto behaves exactly as before', async () => {
    const { ws, targetId } = await connect(gw);
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'nav.goto',
        id: 'n1',
        ts: Date.now(),
        targetId,
        url: 'https://b.example',
      }),
    );
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('nav.state');
    ws.close();
  });

  it('does not fire for nav.back/nav.forward/nav.reload/nav.stop, by design (see the call site comment)', async () => {
    const seen: NavigationEvent[] = [];
    gw.connectionDeps.hooks.on('onNavigation', (e) => {
      seen.push(e);
      return undefined;
    });
    const { ws, targetId } = await connect(gw);
    ws.send(JSON.stringify({ v: 1, t: 'nav.stop', id: 'n1', ts: Date.now(), targetId }));
    await nextMessageSkipping(ws, UNSOLICITED);
    expect(seen).toHaveLength(0);
    ws.close();
  });
});

describe('onNavigation: veto', () => {
  it('a handler returning false stops the navigation: a correlated policy.denied error, and Page.navigate is never sent', async () => {
    gw.connectionDeps.hooks.on('onNavigation', (e) => {
      e.reason = 'egress to that host is blocked';
      return false;
    });

    const { ws, targetId } = await connect(gw);
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'nav.goto',
        id: 'n1',
        ts: Date.now(),
        targetId,
        url: 'https://blocked.example',
      }),
    );
    const reply = await nextMessageSkipping(ws, UNSOLICITED);

    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.policy.denied');
    expect(reply['fatal']).toBe(false);
    expect(reply['re']).toBe('n1');
    expect((reply['context'] as Record<string, unknown>)['reason']).toBe(
      'egress to that host is blocked',
    );
    expect(gw.chrome.cdpCalls.some((c) => c.method === 'Page.navigate')).toBe(false);
    ws.close();
  });
});
