/**
 * `onViewerJoined`, fired from `ws/connection.ts`'s `freshAttach` (and
 * `resumeInto`, `resumed: true`) BEFORE `ManagedSession.attachViewer()` /
 * `.resumeViewer()` ever runs, so a veto here genuinely stops the join:
 * no session attachment, no `welcome`, socket closed with
 * `CloseCode.PolicyViolation` (4100). See `connection.ts`'s own doc on
 * `freshAttach` for why this is the one vetoing hook that also closes the
 * socket, unlike `onControlGranted`/`onNavigation`.
 *
 * Timeout policy (750ms.. no: `onViewerJoined` is 1500ms, vetoes, fails
 * open) is covered generically for every hook in `dispatch-policy.test.ts`;
 * this file is about the real call site: does it fire with the right
 * data, and does a veto actually stop the join.
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ViewerJoinedEvent } from '../../src/hooks/types.js';
import {
  type TestGateway,
  nextMessage,
  startTestGateway,
  waitClose,
  waitOpen,
} from '../ws/support/test-gateway.js';

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

describe('onViewerJoined: fire', () => {
  it('fires before welcome, with resumed:false, existingViewers:0, and a real principal/viewerId', async () => {
    const seen: ViewerJoinedEvent[] = [];
    gw.connectionDeps.hooks.on('onViewerJoined', (e) => {
      seen.push(e);
      return undefined;
    });

    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const welcome = await nextMessage(ws);

    expect(welcome['t']).toBe('welcome');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.resumed).toBe(false);
    expect(seen[0]!.existingViewers).toBe(0);
    expect(seen[0]!.viewerId).toBe(welcome['viewerId']);
    expect(seen[0]!.sessionId).toBe(welcome['sessionId']);
    expect(seen[0]!.principal.tenantId).toBe(gw.tenantId);
    expect(seen[0]!.principal.appId).toBe(gw.appId);
    ws.close();
  });

  it('a second viewer sees existingViewers:1', async () => {
    const seen: ViewerJoinedEvent[] = [];
    gw.connectionDeps.hooks.on('onViewerJoined', (e) => {
      seen.push(e);
      return undefined;
    });

    const first = gw.connect();
    await waitOpen(first);
    first.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token: await gw.issueToken() } })));
    await nextMessage(first); // welcome

    const second = gw.connect();
    await waitOpen(second);
    second.send(
      JSON.stringify(hello({ auth: { scheme: 'bearer', token: await gw.issueToken() } })),
    );
    await nextMessage(second); // welcome

    expect(seen).toHaveLength(2);
    expect(seen[1]!.existingViewers).toBe(1);
    first.close();
    second.close();
  });
});

describe('onViewerJoined: veto', () => {
  it('a handler returning false stops the join: no welcome, a non-fatal policy.denied error, then a 4100 close', async () => {
    gw.connectionDeps.hooks.on('onViewerJoined', (e) => {
      e.reason = 'this operator does not allow that viewer';
      return false;
    });

    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));

    const errorMsg = await nextMessage(ws);
    expect(errorMsg['t']).toBe('error');
    expect(errorMsg['code']).toBe('bgls.error.policy.denied');
    expect(errorMsg['fatal']).toBe(false);
    expect((errorMsg['context'] as Record<string, unknown>)['reason']).toBe(
      'this operator does not allow that viewer',
    );

    const closed = await waitClose(ws);
    expect(closed.code).toBe(4100);
  });

  it('a vetoed viewer never attaches: the session viewer count stays at whatever it was before the attempt', async () => {
    gw.connectionDeps.hooks.on('onViewerJoined', () => false);

    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    await waitClose(ws);

    const managed = gw.sessionRegistry.get(gw.instanceId);
    expect(managed?.viewerCount ?? 0).toBe(0);
  });
});
