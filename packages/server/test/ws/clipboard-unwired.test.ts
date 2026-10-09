import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * `clipboard.read`/`clipboard.write` used to be offered by
 * `BrowserGlassClient` (`packages/client/src/client/BrowserGlassClient.ts`)
 * with NO handler anywhere in `connection.ts`'s dispatch table, only a
 * capability entry in `wire/capability-check.ts`: the same class of defect
 * as `presence.cursor` (see `presence-cursor.test.ts`), a message one half
 * of the wire offers and the other half refuses.
 *
 * Unlike `presence.cursor`, this one is not fixed by adding a handler.
 * There is no CDP path to a real clipboard read/write that does not go
 * through `Runtime.evaluate`: reading back what a paste produced needs a
 * focused element's live `.value`, which never syncs to anything
 * `DOM.getOuterHTML`/`DOM.getAttributes` can see, and `Runtime` is refused
 * outright by the CDP passthrough allowlist
 * (`packages/server/src/rest/cdp-passthrough-allowlist.ts`) as arbitrary
 * script execution. Writing could only be faked by inserting text into
 * whatever element happens to be focused and issuing a native Copy
 * command, corrupting that element's content as a side effect rather than
 * providing a real "write to clipboard" primitive.
 *
 * So the client's `clipboard` property was removed instead of wired
 * (`BrowserGlassClient.ts`'s "Clipboard" section). This test proves the
 * server side of that agreement: nobody, client SDK or otherwise, can call
 * `clipboard.read`/`clipboard.write` and get anything other than the same
 * `unknown_type` error the client used to silently eat, so a caller
 * bypassing the SDK and sending the wire message by hand is refused
 * honestly rather than hanging or partially succeeding. Real copy/paste
 * via Ctrl+C/Ctrl+V keyboard chords goes through `input.key` and is
 * unaffected: see that handler's own tests.
 */
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
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

/**
 * Grants `clipboard.read`/`clipboard.write` explicitly, on top of the
 * harness's usual default set (`issueToken`'s own doc), so this test
 * proves the "no handler" gap directly rather than getting the correct
 * `unknown_type` answer for the wrong reason (`bgls.error.cap.missing`,
 * which a default-scoped token would hit first and which is not what this
 * test is about: even a caller WITH the capability still finds nobody
 * home).
 */
async function connectViewer(gw: TestGateway): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken({
    caps: [
      'view',
      'control',
      'navigate',
      'tabs.manage',
      'capture',
      'probe',
      'admin',
      'clipboard.read',
      'clipboard.write',
    ],
  });
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessageSkipping(ws, UNSOLICITED);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

describe('clipboard.read / clipboard.write', () => {
  it('clipboard.read is refused with unknown_type, not silently accepted', async () => {
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
      const { ws, targetId } = await connectViewer(gw);
      ws.send(JSON.stringify({ v: 1, t: 'clipboard.read', ts: Date.now(), targetId }));
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.protocol.unknown_type');
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('clipboard.write is refused with unknown_type, not silently accepted', async () => {
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
      const { ws, targetId } = await connectViewer(gw);
      ws.send(
        JSON.stringify({ v: 1, t: 'clipboard.write', ts: Date.now(), targetId, text: 'hello' }),
      );
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.protocol.unknown_type');
      ws.close();
    } finally {
      await gw.close();
    }
  });
});
