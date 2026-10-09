import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * `presence.cursor` relay.
 *
 * This message type existed on the wire and on BOTH client halves and
 * nowhere in between, which is why it went unnoticed for so long.
 * `packages/client/src/client/BrowserGlassClient.ts` sends it (throttled to
 * one per 40ms alongside a mouse move) and handles receiving one, reading
 * the owner from the envelope's `vid`. `packages/server/src/ws/connection.ts`
 * even mapped the type to its own `cursor` rate limit bucket, so the server
 * plainly intended to accept it. There was simply no handler, so every
 * cursor a viewer sent came back as `bgls.error.protocol.unknown_type` and
 * shared cursor presence was dead, while a viewer moving the mouse produced
 * a steady stream of errors rather than one.
 *
 * Found by auditing which message types are genuinely wired by grepping the
 * server rather than trusting protocol's own doc comments, several of which
 * turned out to be wrong in both directions.
 */
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

function hello(): Record<string, unknown> {
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
  };
}

/** Connects one viewer and drains through its `welcome`, returning the socket and the viewer id the server assigned. */
async function connectViewer(gw: TestGateway): Promise<{ ws: WebSocket; viewerId: string }> {
  const token = await gw.issueToken();
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessage(ws);
  return { ws, viewerId: String(welcome['vid'] ?? welcome['viewerId'] ?? '') };
}

describe('presence.cursor', () => {
  it('relays one viewer cursor to the other viewer, stamped with the sender vid, and never echoes it back', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const alice = await connectViewer(gw);
      const bob = await connectViewer(gw);

      const targets = await (async () => {
        alice.ws.send(JSON.stringify({ v: 1, t: 'target.list', ts: Date.now() }));
        const reply = await nextMessageSkipping(alice.ws, UNSOLICITED);
        return reply['targets'] as Array<{ targetId: string }>;
      })();
      const targetId = targets[0]!.targetId;

      alice.ws.send(
        JSON.stringify({
          v: 1,
          t: 'presence.cursor',
          ts: Date.now(),
          targetId,
          x: 12,
          y: 34,
          fw: 800,
          fh: 600,
          action: 'move',
        }),
      );

      // Bob sees it, carrying Alice as the owner.
      const seen = await nextMessageSkipping(bob.ws, UNSOLICITED);
      expect(seen['t']).toBe('presence.cursor');
      expect(seen['x']).toBe(12);
      expect(seen['y']).toBe(34);
      expect(seen['vid']).toBe(alice.viewerId);

      // And Alice does NOT: she already knows where her own pointer is, and
      // an echo would fight her local rendering. The old behaviour was an
      // `error` back to her, which this also rules out.
      alice.ws.send(JSON.stringify({ v: 1, t: 'ping', cts: Date.now() }));
      let next = await nextMessageSkipping(alice.ws, UNSOLICITED);
      while (next['t'] !== 'pong') {
        expect(
          next['t'],
          'alice received her own cursor back, or an error for sending it',
        ).not.toBe('presence.cursor');
        expect(
          next['t'],
          `alice got an error for a valid presence.cursor: ${JSON.stringify(next)}`,
        ).not.toBe('error');
        next = await nextMessageSkipping(alice.ws, UNSOLICITED);
      }

      alice.ws.close();
      bob.ws.close();
    } finally {
      await gw.close();
    }
  });
});
