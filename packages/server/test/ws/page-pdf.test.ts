/**
 * `page.pdf.get` end to end over a real socket: capability gating,
 * request validation, and both delivery shapes `page.pdf.got` can take
 * (`@browserglass/protocol`'s `wire/messages/pdf.ts` module doc, "the two
 * delivery shapes"). Mirrors `target-capture-dimensions.test.ts`'s own
 * harness usage.
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import { MAX_INLINE_PDF_BYTES } from '@browserglass/protocol';
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
    capabilities: { codecs: ['jpeg', 'png'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
  };
}

/** Connects and returns the WIRE target id, mirroring `target-capture-dimensions.test.ts`'s own `connectViewer`. */
async function connectViewer(
  gw: TestGateway,
  caps?: string[],
): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken(caps ? { caps } : undefined);
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessageSkipping(ws, UNSOLICITED);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

/** A base64 payload of a given raw byte length, distinct bytes so a size assertion cannot pass by accident on an all-zero buffer. */
function base64OfLength(rawBytes: number): string {
  const bytes = new Uint8Array(rawBytes);
  for (let i = 0; i < rawBytes; i++) bytes[i] = i % 256;
  return Buffer.from(bytes).toString('base64');
}

describe('page.pdf.get: inline delivery', () => {
  it('returns the PDF inline as base64 data when it fits under MAX_INLINE_PDF_BYTES, with no downloadId', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    const pdfB64 = base64OfLength(1024);
    gw.chrome.setPrintToPdf(pdfB64);
    try {
      const { ws, targetId } = await connectViewer(gw);
      ws.send(JSON.stringify({ v: 1, t: 'page.pdf.get', ts: Date.now(), targetId }));
      const got = await nextMessageSkipping(ws, UNSOLICITED);
      expect(got['t']).toBe('page.pdf.got');
      expect(got['targetId']).toBe(targetId);
      expect(got['sizeBytes']).toBe(1024);
      expect(got['data']).toBe(pdfB64);
      expect(got['downloadId']).toBeUndefined();
      expect(got['url']).toBeUndefined();
      expect(typeof got['pdfId']).toBe('string');
      expect(typeof got['gen']).toBe('number');
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('forwards paper format, landscape, scale, and header/footer templates to Page.printToPDF', async () => {
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
        JSON.stringify({
          v: 1,
          t: 'page.pdf.get',
          ts: Date.now(),
          targetId,
          format: 'A4',
          landscape: true,
          scale: 0.8,
          headerTemplate: '<span class="date"></span>',
        }),
      );
      await nextMessageSkipping(ws, UNSOLICITED);
      const call = gw.chrome.cdpCalls.find((c) => c.method === 'Page.printToPDF');
      expect(call).toBeDefined();
      expect(call?.params['paperWidth']).toBe(8.27);
      expect(call?.params['paperHeight']).toBe(11.7);
      expect(call?.params['landscape']).toBe(true);
      expect(call?.params['scale']).toBe(0.8);
      expect(call?.params['displayHeaderFooter']).toBe(true);
      expect(call?.params['headerTemplate']).toBe('<span class="date"></span>');
      ws.close();
    } finally {
      await gw.close();
    }
  });
});

describe('page.pdf.get: download delivery for anything over the inline ceiling', () => {
  it('writes the PDF to the download store and replies with downloadId/url/expiresAt/sha256, no data', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    const bigSize = MAX_INLINE_PDF_BYTES + 5000;
    gw.chrome.setPrintToPdf(base64OfLength(bigSize));
    try {
      const { ws, targetId } = await connectViewer(gw);
      ws.send(JSON.stringify({ v: 1, t: 'page.pdf.get', ts: Date.now(), targetId }));
      const got = await nextMessageSkipping(ws, UNSOLICITED);
      expect(got['t']).toBe('page.pdf.got');
      expect(got['sizeBytes']).toBe(bigSize);
      expect(got['data']).toBeUndefined();
      expect(typeof got['downloadId']).toBe('string');
      expect(typeof got['url']).toBe('string');
      expect(typeof got['expiresAt']).toBe('number');
      expect(typeof got['sha256']).toBe('string');
      expect(got['sha256'] as string).toHaveLength(64);

      // The signed URL actually resolves to the real bytes through the
      // same `DownloadStore` the REST route reads, verified directly
      // against the store rather than through an HTTP fetch: this WS-only
      // harness (`support/test-gateway.ts`) never mounts the REST routes.
      const token = (got['url'] as string).split('/').pop() as string;
      const taken = gw.downloads.takeToken(token);
      expect(taken).not.toBeNull();
      expect(taken?.sizeBytes).toBe(bigSize);
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it("is refused as bgls.error.capture.too_large when the finished file exceeds the download store's own ceiling", async () => {
    const gw = await startTestGateway({ downloadMaxBytes: MAX_INLINE_PDF_BYTES + 100 });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    gw.chrome.setPrintToPdf(base64OfLength(MAX_INLINE_PDF_BYTES + 5000));
    try {
      const { ws, targetId } = await connectViewer(gw);
      ws.send(JSON.stringify({ v: 1, t: 'page.pdf.get', ts: Date.now(), targetId }));
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.capture.too_large');
      ws.close();
    } finally {
      await gw.close();
    }
  });
});

describe('page.pdf.get: capability gating', () => {
  it('is refused as bgls.error.cap.missing without the capture capability', async () => {
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
      const { ws, targetId } = await connectViewer(gw, [
        'view',
        'control',
        'navigate',
        'tabs.manage',
        'probe',
      ]);
      ws.send(JSON.stringify({ v: 1, t: 'page.pdf.get', ts: Date.now(), targetId }));
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required?: string } | undefined)?.required).toBe('capture');
      ws.close();
    } finally {
      await gw.close();
    }
  });
});

describe('page.pdf.get: request validation', () => {
  it('rejects a missing targetId as bgls.error.protocol.bad_envelope', async () => {
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
      const { ws } = await connectViewer(gw);
      ws.send(JSON.stringify({ v: 1, t: 'page.pdf.get', ts: Date.now() }));
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.protocol.bad_envelope');
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('rejects format together with widthInches/heightInches as bgls.error.protocol.bad_envelope', async () => {
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
        JSON.stringify({
          v: 1,
          t: 'page.pdf.get',
          ts: Date.now(),
          targetId,
          format: 'A4',
          widthInches: 4,
          heightInches: 6,
        }),
      );
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.protocol.bad_envelope');
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('rejects a scale outside 0.1 to 2 as bgls.error.protocol.bad_envelope', async () => {
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
      ws.send(JSON.stringify({ v: 1, t: 'page.pdf.get', ts: Date.now(), targetId, scale: 5 }));
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.protocol.bad_envelope');
      ws.close();
    } finally {
      await gw.close();
    }
  });
});
