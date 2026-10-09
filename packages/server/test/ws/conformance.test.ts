import { createServer } from 'node:http';
import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { BrowserGlass } from '../../src/index.js';
import { createBrowserGlass } from '../../src/index.js';
import {
  type TestGateway,
  nextMessage,
  startTestGateway,
  waitClose,
  waitOpen,
} from './support/test-gateway.js';

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

async function connectAndWelcome(caps?: string[]): Promise<{
  ws: WebSocket;
  welcome: Record<string, unknown>;
  presenceState: Record<string, unknown>;
}> {
  const token = await gw.issueToken(caps ? { caps } : undefined);
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
  const welcome = await nextMessage(ws);
  // Every fresh attach is immediately followed by an unprompted
  // presence.state (ManagedSession.broadcastPresence()). Read it here, once, so every caller of this
  // helper can keep assuming "the next message is whatever I asked for
  // next", the same contract this helper already gives them for welcome;
  // returned rather than silently discarded, since it is a real message
  // this connection received and a caller checking `sq` gaplessness needs
  // it in the sequence.
  const presenceState = await nextMessage(ws);
  if (presenceState['t'] !== 'presence.state') {
    throw new Error(
      `connectAndWelcome(): expected presence.state right after welcome, got "${String(presenceState['t'])}"`,
    );
  }
  return { ws, welcome, presenceState };
}

describe('bgls.v1 conformance', () => {
  it('sq is gapless across a 1000-message session', async () => {
    const { ws, welcome, presenceState } = await connectAndWelcome();
    expect(welcome['sq']).toBe(1);
    const seen: number[] = [welcome['sq'] as number, presenceState['sq'] as number];

    for (let i = 0; i < 1000; i += 1) {
      ws.send(JSON.stringify({ v: 1, t: 'ping', cts: Date.now() }));
      const pong = await nextMessage(ws);
      expect(pong['t']).toBe('pong');
      seen.push(pong['sq'] as number);
    }

    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i]).toBe((seen[i - 1] as number) + 1);
    }
    ws.close();
  }, 30000);

  it('a resume restores subscriptions with a bumped sidEpoch, a keyframe first, and zeroed backlogs; the replayed token then closes 4301', async () => {
    const { ws, welcome } = await connectAndWelcome();
    const viewerId = welcome['viewerId'] as string;
    const sessionId = welcome['sessionId'] as string;
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
    const subscribed = await nextMessage(ws);
    expect(subscribed['t']).toBe('stream.subscribed');
    const originalSidEpoch = subscribed['sidEpoch'] as number;

    const managed = gw.sessionRegistry.get(gw.instanceId);
    expect(managed).toBeDefined();

    ws.close();
    await waitClose(ws);
    await new Promise((r) => setTimeout(r, 20)); // let the server's close handler run

    // Reconnect and resume. The resume token used here is minted fresh by
    // this test via a second connect/hello (mirroring welcome's own mint),
    // since disconnecting invalidates nothing about the *token* itself
    // (only the socket); this exercises the actual restore path.
    const secondToken = await gw.issueToken({ viewerId });
    const ws2 = gw.connect();
    await waitOpen(ws2);
    ws2.send(
      JSON.stringify(
        hello({
          auth: { scheme: 'bearer', token: secondToken },
          resume: {
            token: welcome['resume'] ? (welcome['resume'] as { token: string }).token : '',
            sessionId,
            viewerId,
            lastSeq: {},
            lastControlSq: 0,
          },
        }),
      ),
    );
    const welcome2 = await nextMessage(ws2);
    expect(welcome2['t']).toBe('welcome');
    expect(welcome2['resumed']).toBe(true);
    const resumed = await nextMessage(ws2);
    expect(resumed['t']).toBe('resumed');
    const restoredStreams = resumed['streams'] as Array<{
      targetId: string;
      keyframePending: boolean;
    }>;
    expect(restoredStreams.length).toBe(1);
    expect(restoredStreams[0]!.targetId).toBe(targetId);
    expect(restoredStreams[0]!.keyframePending).toBe(true);

    const newHandle = managed!.coreSession.streamHandleFor(targetId);
    expect(newHandle!.stream.sidEpoch).toBeGreaterThan(originalSidEpoch);

    const usedToken = (welcome['resume'] as { token: string }).token;
    ws2.close();

    // Replaying the SAME (now-consumed) resume token closes 4301.
    const thirdToken = await gw.issueToken({ viewerId });
    const ws3 = gw.connect();
    await waitOpen(ws3);
    ws3.send(
      JSON.stringify(
        hello({
          auth: { scheme: 'bearer', token: thirdToken },
          resume: { token: usedToken, sessionId, viewerId, lastSeq: {}, lastControlSq: 0 },
        }),
      ),
    );
    const closed = await waitClose(ws3);
    expect(closed.code).toBe(4301);
  }, 15000);

  it('a capability shrink revokes a held lease in the same tick', async () => {
    const { ws, welcome } = await connectAndWelcome();
    const viewerId = welcome['viewerId'] as string;
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    ws.send(JSON.stringify({ v: 1, t: 'control.request', ts: Date.now(), targetId }));
    const granted = await nextMessage(ws);
    expect(granted['t']).toBe('control.granted');

    const managed = gw.sessionRegistry.get(gw.instanceId);
    const before = managed!.coreSession.leaseEngineFor(targetId).getSnapshot();
    expect(before.holder?.viewerId).toBe(viewerId);

    // Reauth with a narrower capability set that drops 'control'.
    const narrowToken = await gw.issueToken({ viewerId, caps: ['view'] });
    ws.send(
      JSON.stringify(hello({ auth: { scheme: 'bearer', token: narrowToken }, reauth: true })),
    );

    // The reauth fans out several messages (the revoked holder's
    // `control.revoked`, a broadcast `control.state`, the `presence.state`
    // ManagedSession.broadcastPresence() sends after the lease effect that
    // revoke produces, `capabilities.updated`, and a fresh
    // `welcome{reauth:true}`); drain until `capabilities.updated` is seen.
    // A real WS round trip cannot observe mid-tick server state directly,
    // so waiting for that reply (well past the bounded handoff drain
    // capped at `control.handoverDrainMs`) is what makes the
    // black-box-visible outcome below meaningful. Bounded at 8, not the 5
    // messages actually expected, so one extra unrelated broadcast never
    // turns into a flaky timeout here.
    const seenTypes: string[] = [];
    for (let i = 0; i < 8 && !seenTypes.includes('capabilities.updated'); i += 1) {
      const msg = await nextMessage(ws);
      seenTypes.push(msg['t'] as string);
    }
    expect(seenTypes).toContain('capabilities.updated');
    const settled = managed!.coreSession.leaseEngineFor(targetId).getSnapshot();
    expect(settled.holder).toBeNull();
    ws.close();
  });
});

describe('attachUpgrade path isolation', () => {
  it('attaching /browserglass/socket leaves an existing /ws listener untouched and vice versa', async () => {
    const bg: BrowserGlass = createBrowserGlass({
      mode: 'embedded',
      tenantId: 'ten_isolation_test' as never,
      appId: 'app_isolation_test' as never,
      store: {} as never,
      runtime: {} as never,
      profiles: { fs: {} as never },
    });

    const httpServer = createServer((req, res) => res.writeHead(404).end());
    let otherUpgradeFired = 0;
    httpServer.on('upgrade', (req, socket) => {
      if (req.url === '/ws') {
        otherUpgradeFired += 1;
        socket.destroy();
      }
    });

    bg.attachUpgrade(httpServer);

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    // A request to the OTHER path must reach the pre-existing /ws listener,
    // not bgls's.
    const otherWs = new WebSocket(`ws://127.0.0.1:${port}/ws`, ['bgls.v1']);
    await new Promise<void>((resolve) => {
      otherWs.once('close', () => resolve());
      otherWs.once('error', () => resolve());
    });
    expect(otherUpgradeFired).toBe(1);

    // A request to bgls's own path must be handled by bgls (missing
    // subprotocol -> the connection never opens; presence of a response at
    // all, distinct from the /ws path, is what this test checks).
    const bglsWs = new WebSocket(`ws://127.0.0.1:${port}/browserglass/socket`);
    let bglsRejected = false;
    await new Promise<void>((resolve) => {
      bglsWs.once('unexpected-response', () => {
        bglsRejected = true;
        resolve();
      });
      bglsWs.once('error', () => resolve());
      bglsWs.once('close', () => resolve());
    });
    expect(bglsRejected).toBe(true);

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
