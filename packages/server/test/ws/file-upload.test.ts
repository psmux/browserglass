/**
 * File upload end to end over a real socket: the real handshake, the real
 * capability check, real `UPLOAD_CHUNK` binary frames, a real
 * `UploadStore` on a real temp directory, the real `ManagedSession`, and a
 * fake Chrome endpoint that records what `DOM.setFileInputFiles` was
 * actually given.
 *
 * The assertion that matters most in this file is the last kind: what
 * reaches Chrome is a path inside the gateway's own staging root, derived
 * from an id, never anything a caller named. Everything else here is the
 * transfer working; that one is the transfer being safe.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { setTier1EncoderFactory } from '@browserglass/core';
import {
  MsgType,
  PayloadCodec,
  encodeBinaryHeader,
  encodeUploadChunkPayload,
} from '@browserglass/protocol';
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

/** The harness's usual default caps, deliberately WITHOUT `upload`. */
const DEFAULT_CAPS = ['view', 'control', 'navigate', 'tabs.manage', 'capture', 'probe', 'admin'];
const UPLOAD_CAPS = [...DEFAULT_CAPS, 'upload'];

const OPEN_SOCKETS: WebSocket[] = [];

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
    targetId: 'cdp-a',
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
    windowId: 1,
  });
  // One ordinary file input and one that accepts several.
  gw.chrome.addElement('#attachment', 'INPUT', ['type', 'file']);
  gw.chrome.addElement('#many', 'INPUT', ['type', 'file', 'multiple', '']);
  gw.chrome.addElement('#name', 'INPUT', ['type', 'text']);
  OPEN_SOCKETS.length = 0;
  try {
    await fn(gw);
  } finally {
    for (const ws of OPEN_SOCKETS) ws.close();
    OPEN_SOCKETS.length = 0;
    await gw.close();
  }
}

/** Sends `t` with a fresh correlation id and returns the correlated reply, whatever its type. */
async function request(
  ws: WebSocket,
  t: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `q${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ v: 1, t, id, ts: Date.now(), ...payload }));
  for (;;) {
    const msg = await nextMessageSkipping(ws, [...UNSOLICITED, 'upload.progress']);
    if (msg['re'] === id) return msg;
  }
}

/** Frames and sends one `UPLOAD_CHUNK`, exactly as `AutomationClient` does. */
function sendChunk(ws: WebSocket, binaryIdHex: string, seq: number, chunk: Uint8Array): void {
  const header = encodeBinaryHeader({
    version: 1,
    msgType: MsgType.UPLOAD_CHUNK,
    streamId: 0,
    seq,
    tsDeltaMs: 0,
    payloadCodec: PayloadCodec.NONE,
    flags: 0,
    gen16: 0,
  });
  const payload = encodeUploadChunkPayload(Uint8Array.from(Buffer.from(binaryIdHex, 'hex')), chunk);
  const frame = new Uint8Array(header.byteLength + payload.byteLength);
  frame.set(header, 0);
  frame.set(payload, header.byteLength);
  ws.send(frame);
}

/** The whole staging handshake for one file, returning its `uploadId`. */
async function stage(
  ws: WebSocket,
  targetId: string,
  name: string,
  data: Uint8Array,
): Promise<string> {
  const uploadId = `up_${Math.random().toString(36).slice(2)}`;
  const accepted = await request(ws, 'upload.begin', {
    uploadId,
    targetId,
    name,
    sizeBytes: data.byteLength,
    mime: 'application/octet-stream',
    purpose: 'input',
  });
  expect(accepted['t']).toBe('upload.accepted');
  const binaryId = accepted['binaryId'] as string;
  const chunkBytes = accepted['chunkBytes'] as number;
  for (let offset = 0, seq = 0; offset < data.byteLength; offset += chunkBytes, seq += 1) {
    sendChunk(
      ws,
      binaryId,
      seq,
      data.subarray(offset, Math.min(offset + chunkBytes, data.byteLength)),
    );
  }
  const done = await request(ws, 'upload.complete', { uploadId });
  expect(done['t']).toBe('upload.done');
  return uploadId;
}

describe('upload: the capability is real and is not implied', () => {
  it('refuses upload.begin from a caller holding view, control, navigate, capture, probe and admin', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const reply = await request(ws, 'upload.begin', {
        uploadId: 'up_1',
        targetId,
        name: 'a.txt',
        sizeBytes: 1,
        mime: 'text/plain',
        purpose: 'input',
      });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect(reply['context']).toMatchObject({ required: 'upload' });
    });
  });

  it('refuses files.set on the same capability, so driving a mouse does not imply attaching a file', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const reply = await request(ws, 'files.set', {
        targetId,
        selector: '#attachment',
        uploadIds: ['up_1'],
      });
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect(reply['context']).toMatchObject({ required: 'upload' });
    });
  });
});

describe('upload: the transfer', () => {
  it('carries bytes over the binary channel and attaches them by id', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const data = new Uint8Array(700).map((_, i) => (i * 13) % 251);
      const uploadId = await stage(ws, targetId, 'invoice.pdf', data);

      const set = await request(ws, 'files.set', {
        targetId,
        selector: '#attachment',
        uploadIds: [uploadId],
      });
      expect(set['t']).toBe('files.set.result');
      expect(set['files']).toEqual(['invoice.pdf']);

      // What actually reached Chrome.
      expect(gw.chrome.setFileInputFilesCalls).toHaveLength(1);
      const attached = gw.chrome.setFileInputFilesCalls[0]!;
      expect(attached.files).toHaveLength(1);
      // And the bytes at that path are the bytes that were sent, all 700
      // of them, in order. A chunking bug shows up here and nowhere else.
      expect(new Uint8Array(readFileSync(attached.files[0] as string))).toEqual(data);
    });
  });

  it('reports the received count as chunks arrive', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const accepted = await request(ws, 'upload.begin', {
        uploadId: 'up_prog',
        targetId,
        name: 'a.bin',
        sizeBytes: 6,
        mime: 'application/octet-stream',
        purpose: 'input',
      });
      sendChunk(ws, accepted['binaryId'] as string, 0, new Uint8Array([1, 2, 3]));
      const progress = await nextMessageSkipping(ws, UNSOLICITED);
      expect(progress['t']).toBe('upload.progress');
      expect(progress).toMatchObject({ uploadId: 'up_prog', receivedBytes: 3 });
    });
  });

  it('computes a digest and honours one the caller declares', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const data = new Uint8Array([9, 8, 7, 6]);
      const sha256 = createHash('sha256').update(data).digest('hex');
      const accepted = await request(ws, 'upload.begin', {
        uploadId: 'up_hash',
        targetId,
        name: 'a.bin',
        sizeBytes: 4,
        mime: 'application/octet-stream',
        purpose: 'input',
      });
      sendChunk(ws, accepted['binaryId'] as string, 0, data);
      const done = await request(ws, 'upload.complete', { uploadId: 'up_hash', sha256 });
      expect(done['t']).toBe('upload.done');
      expect(done['sha256']).toBe(sha256);
    });
  });

  it('refuses a completion whose declared digest does not match', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const accepted = await request(ws, 'upload.begin', {
        uploadId: 'up_bad',
        targetId,
        name: 'a.bin',
        sizeBytes: 2,
        mime: 'application/octet-stream',
        purpose: 'input',
      });
      sendChunk(ws, accepted['binaryId'] as string, 0, new Uint8Array([1, 2]));
      const reply = await request(ws, 'upload.complete', {
        uploadId: 'up_bad',
        sha256: 'f'.repeat(64),
      });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.upload.hash_mismatch');
    });
  });

  it('attaches several files to a multiple input, in order', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const a = await stage(ws, targetId, 'first.txt', new Uint8Array([1]));
      const b = await stage(ws, targetId, 'second.txt', new Uint8Array([2]));
      const set = await request(ws, 'files.set', {
        targetId,
        selector: '#many',
        uploadIds: [a, b],
      });
      expect(set['files']).toEqual(['first.txt', 'second.txt']);
      expect(gw.chrome.setFileInputFilesCalls[0]?.files).toHaveLength(2);
    });
  });

  it('refuses several files for an input without multiple, before touching Chrome', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const a = await stage(ws, targetId, 'first.txt', new Uint8Array([1]));
      const b = await stage(ws, targetId, 'second.txt', new Uint8Array([2]));
      const reply = await request(ws, 'files.set', {
        targetId,
        selector: '#attachment',
        uploadIds: [a, b],
      });
      expect(reply['t']).toBe('error');
      expect(gw.chrome.setFileInputFilesCalls).toHaveLength(0);
    });
  });

  it('refuses a selector that matched nothing, and one that matched the wrong element', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const id = await stage(ws, targetId, 'a.txt', new Uint8Array([1]));

      const missing = await request(ws, 'files.set', {
        targetId,
        selector: '#nope',
        uploadIds: [id],
      });
      expect(missing['t']).toBe('error');
      expect(missing['code']).toBe('bgls.error.capture.no_match');

      const wrong = await request(ws, 'files.set', {
        targetId,
        selector: '#name',
        uploadIds: [id],
      });
      expect(wrong['t']).toBe('error');
      expect(gw.chrome.setFileInputFilesCalls).toHaveLength(0);
    });
  });

  it('refuses to attach an upload that was never completed', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      await request(ws, 'upload.begin', {
        uploadId: 'up_open',
        targetId,
        name: 'a.bin',
        sizeBytes: 10,
        mime: 'application/octet-stream',
        purpose: 'input',
      });
      const reply = await request(ws, 'files.set', {
        targetId,
        selector: '#attachment',
        uploadIds: ['up_open'],
      });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.upload.not_found');
    });
  });
});

describe('upload: path safety at the wire boundary', () => {
  it('hands Chrome a path inside the gateway staging root, never anything the caller named', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      // A filename that is a traversal attempt, an absolute Windows path,
      // and a UNC path in turn. Each must end up as one inert component
      // under the staging root.
      for (const hostile of [
        '../../../../etc/cron.d/evil',
        'C:\\Windows\\System32\\drivers\\etc\\hosts',
        '\\\\attacker\\share\\payload.exe',
      ]) {
        const id = await stage(ws, targetId, hostile, new Uint8Array([1]));
        await request(ws, 'files.set', { targetId, selector: '#attachment', uploadIds: [id] });
      }
      expect(gw.chrome.setFileInputFilesCalls).toHaveLength(3);
      const attachedNames = gw.chrome.setFileInputFilesCalls.map((c) =>
        (c.files[0] as string).split(/[\\/]/).pop(),
      );
      expect(attachedNames).toEqual(['evil', 'hosts', 'payload.exe']);
      for (const call of gw.chrome.setFileInputFilesCalls) {
        const path = call.files[0] as string;
        expect(path).not.toContain('..');
        expect(path.startsWith('\\\\')).toBe(false);
      }
    });
  });

  it('never returns a filesystem path in upload.done', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const accepted = await request(ws, 'upload.begin', {
        uploadId: 'up_p',
        targetId,
        name: 'a.txt',
        sizeBytes: 1,
        mime: 'text/plain',
        purpose: 'input',
      });
      sendChunk(ws, accepted['binaryId'] as string, 0, new Uint8Array([1]));
      const done = await request(ws, 'upload.complete', { uploadId: 'up_p' });
      // The opaque handle form documented on `UploadDone.path`, not a
      // location: nothing accepts a path back, and disclosing the staging
      // root is free reconnaissance.
      expect(done['path']).toBe('bgls-upload://up_p/a.txt');
    });
  });

  it('refuses an uploadId this connection did not open, even for a well-formed chunk', async () => {
    // The binary channel carries 16 bytes and no identity, so the
    // connection's own open-upload set is the only thing standing between
    // one viewer's frames and another viewer's staged file.
    await withGateway(async (gw) => {
      const a = await connectViewer(gw, UPLOAD_CAPS);
      const b = await connectViewer(gw, UPLOAD_CAPS);

      const accepted = await request(a.ws, 'upload.begin', {
        uploadId: 'up_victim',
        targetId: a.targetId,
        name: 'a.bin',
        sizeBytes: 4,
        mime: 'application/octet-stream',
        purpose: 'input',
      });
      const binaryId = accepted['binaryId'] as string;

      // B sends a perfectly well-formed chunk under A's binary id.
      sendChunk(b.ws, binaryId, 0, new Uint8Array([9, 9, 9, 9]));
      // Then A completes with its OWN bytes. If B's frame had landed, the
      // size check would trip and this would fail; more importantly the
      // file would contain B's bytes.
      sendChunk(a.ws, binaryId, 0, new Uint8Array([1, 2, 3, 4]));
      const done = await request(a.ws, 'upload.complete', { uploadId: 'up_victim' });
      expect(done['t']).toBe('upload.done');
      expect(done['sizeBytes']).toBe(4);

      const set = await request(a.ws, 'files.set', {
        targetId: a.targetId,
        selector: '#attachment',
        uploadIds: ['up_victim'],
      });
      expect(set['t']).toBe('files.set.result');
      const path = gw.chrome.setFileInputFilesCalls[0]?.files[0] as string;
      expect(new Uint8Array(readFileSync(path))).toEqual(new Uint8Array([1, 2, 3, 4]));
    });
  });

  it('drops a malformed binary frame without closing the socket', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      // Too short to be a header at all, then a valid header with an
      // unknown msgType. Both are dropped in silence, per the v1 rule for
      // an unknown binary type, and the session survives.
      ws.send(new Uint8Array([1, 2, 3]));
      ws.send(
        encodeBinaryHeader({
          version: 1,
          msgType: 0x7f,
          streamId: 0,
          seq: 0,
          tsDeltaMs: 0,
          payloadCodec: PayloadCodec.NONE,
          flags: 0,
          gen16: 0,
        }),
      );
      const id = await stage(ws, targetId, 'still-works.txt', new Uint8Array([1]));
      const set = await request(ws, 'files.set', {
        targetId,
        selector: '#attachment',
        uploadIds: [id],
      });
      expect(set['t']).toBe('files.set.result');
    });
  });
});

describe('upload: cleanup', () => {
  it('discards an incomplete upload when the caller disconnects', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      await request(ws, 'upload.begin', {
        uploadId: 'up_abandoned',
        targetId,
        name: 'a.bin',
        sizeBytes: 100,
        mime: 'application/octet-stream',
        purpose: 'input',
      });
      expect(gw.uploads.status('up_abandoned', gw.tenantId).status).toBe('staging');

      ws.close();
      // The close handler runs on the socket's own close event, so give
      // the event loop a turn rather than a fixed sleep.
      for (let i = 0; i < 50; i += 1) {
        await new Promise((r) => setImmediate(r));
        try {
          gw.uploads.status('up_abandoned', gw.tenantId);
        } catch {
          return; // Gone, which is the assertion.
        }
      }
      throw new Error('the abandoned upload was still staged after the socket closed');
    });
  });

  it('keeps a COMPLETED upload after a disconnect, because Chrome reads it lazily', async () => {
    // The case this protects: an agent stages a file, attaches it, and
    // disconnects while the human finishes the form. Chrome opens the file
    // at submit time, minutes later. Discarding on disconnect would break
    // exactly the workflow the feature exists for.
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      const id = await stage(ws, targetId, 'invoice.pdf', new Uint8Array([1, 2, 3]));
      await request(ws, 'files.set', { targetId, selector: '#attachment', uploadIds: [id] });
      ws.close();
      for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
      expect(gw.uploads.status(id, gw.tenantId).status).toBe('ready');
    });
  });

  it('cancels on request, idempotently', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, UPLOAD_CAPS);
      await request(ws, 'upload.begin', {
        uploadId: 'up_cancel',
        targetId,
        name: 'a.bin',
        sizeBytes: 100,
        mime: 'application/octet-stream',
        purpose: 'input',
      });
      ws.send(JSON.stringify({ v: 1, t: 'upload.cancel', ts: Date.now(), uploadId: 'up_cancel' }));
      // A second cancel for an id already gone must not produce an error
      // reply, so the next correlated request still answers normally.
      ws.send(JSON.stringify({ v: 1, t: 'upload.cancel', ts: Date.now(), uploadId: 'up_cancel' }));
      const listed = await request(ws, 'target.list', {});
      expect(listed['t']).toBe('target.listed');
      expect(() => gw.uploads.status('up_cancel', gw.tenantId)).toThrow();
    });
  });
});
