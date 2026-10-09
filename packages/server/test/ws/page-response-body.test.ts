import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * `page.responsebody.get` end to end, over a real socket, through the
 * real handshake, the real capability check, a real `ManagedSession` and a
 * real (fake) Chrome endpoint.
 *
 * The interesting property of this feature is not "it can read a body",
 * it is the BOUND: a caller must not be able to read a body for a
 * `requestId` it was not itself shown as a `network.request`, even when it
 * holds `devtools`, even when the id is real and belongs to the very same
 * target, and even when another viewer on the SAME target was shown it.
 * The bulk of this file is therefore refusals, mirroring
 * `page-evaluate.test.ts`'s own reasoning for why: a happy-path-only suite
 * would prove the least interesting thing about a scoped door.
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

/** The harness's usual default caps; deliberately WITHOUT `devtools`, so a test has to ask for it explicitly to get it. */
const DEFAULT_CAPS = ['view', 'control', 'navigate', 'tabs.manage', 'capture', 'probe', 'admin'];

/**
 * TWO DIFFERENT `targetId`s ARE IN PLAY, mirroring `download-hooks.test.ts`'s
 * own module doc on the same trap. `RAW_TARGET_ID` is the raw CDP id
 * `gw.addTarget` registers with the fake endpoint, and it is what every
 * `gw.chrome.emitNetwork*` call below must be given (the fake endpoint's
 * `sessionsByTargetId` map is keyed by it, not by the wire id).
 * `welcome.targets[0].targetId` is the WIRE `tgt_*` id every `page.responsebody.get`/
 * `diagnostics.subscribe` call uses instead. Passing the wrong one to
 * either side silently no-ops (the emit finds no socket, or the server
 * refuses a target id it does not hold), which is exactly the shape of
 * bug a test relying on only one of the two ids would never catch.
 */
const RAW_TARGET_ID = 'cdp-a';

const OPEN_SOCKETS: WebSocket[] = [];

async function connectViewer(
  gw: TestGateway,
  caps: string[],
): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken({ caps });
  const ws = gw.connect();
  OPEN_SOCKETS.push(ws);
  await waitOpen(ws);
  ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessageSkipping(ws, UNSOLICITED);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

async function withGateway(fn: (gw: TestGateway) => Promise<void>): Promise<void> {
  const gw = await startTestGateway();
  gw.addTarget({
    targetId: RAW_TARGET_ID,
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
    windowId: 1,
  });
  OPEN_SOCKETS.length = 0;
  try {
    await fn(gw);
  } finally {
    for (const ws of OPEN_SOCKETS) ws.close();
    OPEN_SOCKETS.length = 0;
    await gw.close();
  }
}

/** Sends `diagnostics.subscribe({ network: true })` and waits for the reply. */
async function subscribeNetwork(ws: WebSocket, targetId: string): Promise<void> {
  const id = `s${Math.random().toString(36).slice(2)}`;
  ws.send(
    JSON.stringify({
      v: 1,
      t: 'diagnostics.subscribe',
      id,
      ts: Date.now(),
      targetId,
      network: true,
    }),
  );
  for (;;) {
    const msg = await nextMessageSkipping(ws, UNSOLICITED);
    if (msg['re'] === id) {
      expect(msg['t']).toBe('diagnostics.subscribed');
      expect(msg['network']).toBe(true);
      return;
    }
  }
}

/** Waits for the next `network.request` envelope on `ws` and returns its `requestId`. */
async function nextNetworkRequestId(ws: WebSocket): Promise<string> {
  for (;;) {
    const msg = await nextMessageSkipping(ws, UNSOLICITED);
    if (msg['t'] === 'network.request') return msg['requestId'] as string;
  }
}

/** Drives the fake Chrome endpoint through one complete request/response cycle, on {@link RAW_TARGET_ID}, so `TargetDiagnostics` emits a terminal `network.request`. */
function fireOneRequest(gw: TestGateway, requestId: string, url: string): void {
  gw.chrome.emitNetworkRequestWillBeSent(RAW_TARGET_ID, { requestId, url });
  gw.chrome.emitNetworkResponseReceived(RAW_TARGET_ID, { requestId, status: 200 });
  gw.chrome.emitNetworkLoadingFinished(RAW_TARGET_ID, { requestId });
}

/** Sends `page.responsebody.get` and returns the correlated reply, whatever its type. */
async function getResponseBody(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `r${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ v: 1, t: 'page.responsebody.get', id, ts: Date.now(), ...payload }));
  for (;;) {
    const msg = await nextMessageSkipping(ws, UNSOLICITED);
    if (msg['re'] === id) return msg;
  }
}

describe('page.responsebody.get: the capability is real', () => {
  it('refuses a caller holding view, control, navigate, capture, probe and admin but not devtools', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const reply = await getResponseBody(ws, { targetId, requestId: 'anything' });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('devtools');
    });
  });

  it('refuses a caller holding cdp: the raw passthrough capability is a sibling, not a superset, and grants nothing here', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'cdp']);
      const reply = await getResponseBody(ws, { targetId, requestId: 'anything' });
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('devtools');
    });
  });
});

describe('page.responsebody.get: validation', () => {
  it('refuses an empty targetId or requestId as bgls.error.responsebody.invalid_request', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      const missingRequestId = await getResponseBody(ws, { targetId, requestId: '' });
      expect(missingRequestId['code']).toBe('bgls.error.responsebody.invalid_request');
      const missingTargetId = await getResponseBody(ws, { targetId: '', requestId: 'r1' });
      expect(missingTargetId['code']).toBe('bgls.error.responsebody.invalid_request');
    });
  });
});

describe('page.responsebody.get: the scoping bound is enforced server side', () => {
  it('refuses a requestId that was never sent to this viewer, even though the viewer holds devtools and is subscribed to this exact target', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      await subscribeNetwork(ws, targetId);
      // Never fired through the fake endpoint at all: a pure guess.
      const reply = await getResponseBody(ws, { targetId, requestId: 'guessed-request-id' });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.responsebody.unknown_request');
    });
  });

  it('refuses a REAL requestId, on the SAME target, that a DIFFERENT viewer was shown but this one was not', async () => {
    await withGateway(async (gw) => {
      // Both viewers hold devtools and look at the same one target this
      // harness registers. Only `a` ever subscribes to the network feed;
      // `b` deliberately does not, so `b` never receives a single
      // network.request for this target, real or otherwise, however long
      // it waits.
      const a = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      const b = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      await subscribeNetwork(a.ws, a.targetId);

      gw.chrome.setNetworkGetResponseBody(() => ({ body: 'ok', base64Encoded: false }));

      fireOneRequest(gw, 'req-a-only', 'https://a.example/submit');
      const requestId = await nextNetworkRequestId(a.ws);
      expect(requestId).toBe('req-a-only');

      // `a`, who was shown it, succeeds.
      const okReply = await getResponseBody(a.ws, { targetId: a.targetId, requestId });
      expect(okReply['t']).toBe('page.responsebody.got');

      // `b` holds the identical capability, looks at the identical target,
      // and is handed the REAL, currently valid requestId `a` was just
      // shown succeeding with. It is still refused: the bound is "was
      // THIS viewer shown it", not "does this id exist" or "is devtools
      // held".
      const refused = await getResponseBody(b.ws, { targetId: b.targetId, requestId });
      expect(refused['t']).toBe('error');
      expect(refused['code']).toBe('bgls.error.responsebody.unknown_request');
    });
  });
});

describe('page.responsebody.get: the happy path', () => {
  it('reads back the body Chrome had buffered for a requestId this viewer was actually shown', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      await subscribeNetwork(ws, targetId);

      fireOneRequest(gw, 'req-happy', 'https://a.example/submit');
      const requestId = await nextNetworkRequestId(ws);
      expect(requestId).toBe('req-happy');

      gw.chrome.setNetworkGetResponseBody((params) => {
        expect(params.requestId).toBe('req-happy');
        return { body: '{"ok":true}', base64Encoded: false };
      });

      const reply = await getResponseBody(ws, { targetId, requestId });
      expect(reply['t']).toBe('page.responsebody.got');
      expect(reply['body']).toBe('{"ok":true}');
      expect(reply['base64Encoded']).toBe(false);
      expect(reply['sizeBytes']).toBe(Buffer.byteLength('{"ok":true}', 'utf8'));
    });
  });

  it('reports a genuinely empty body as sizeBytes: 0, not as an error', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      await subscribeNetwork(ws, targetId);
      fireOneRequest(gw, 'req-empty', 'https://a.example/204');
      const requestId = await nextNetworkRequestId(ws);
      gw.chrome.setNetworkGetResponseBody(() => ({ body: '', base64Encoded: false }));
      const reply = await getResponseBody(ws, { targetId, requestId });
      expect(reply['t']).toBe('page.responsebody.got');
      expect(reply['sizeBytes']).toBe(0);
      expect(reply['body']).toBe('');
    });
  });
});

describe('page.responsebody.get: bodies are not durable', () => {
  it("answers Chrome's -32000 'no resource' error as bgls.error.responsebody.unavailable, never as an empty body", async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      await subscribeNetwork(ws, targetId);
      fireOneRequest(gw, 'req-gone', 'https://a.example/submit');
      const requestId = await nextNetworkRequestId(ws);

      gw.chrome.setNetworkGetResponseBody(() => ({
        error: { code: -32000, message: 'No resource with given identifier found' },
      }));

      const reply = await getResponseBody(ws, { targetId, requestId });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.responsebody.unavailable');
      // The whole point: this must not be confusable with a real, empty
      // successful reply.
      expect(reply['t']).not.toBe('page.responsebody.got');
    });
  });
});

describe('page.responsebody.get: bounded, and refused rather than cut', () => {
  it('refuses a body over MAX_RESPONSE_BODY_BYTES rather than truncating it', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, [...DEFAULT_CAPS, 'devtools']);
      await subscribeNetwork(ws, targetId);
      fireOneRequest(gw, 'req-big', 'https://a.example/huge.json');
      const requestId = await nextNetworkRequestId(ws);

      // One byte over the 4 MiB ceiling.
      const huge = 'x'.repeat(4194304 + 1);
      gw.chrome.setNetworkGetResponseBody(() => ({ body: huge, base64Encoded: false }));

      const reply = await getResponseBody(ws, { targetId, requestId });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.responsebody.too_large');
      const context = reply['context'] as { sizeBytes: number; maxBytes: number };
      expect(context.maxBytes).toBe(4194304);
      expect(context.sizeBytes).toBe(huge.length);
    });
  });
});
