/**
 * `AutomationClient.setInputFiles`, driven against `ScriptedGateway`.
 *
 * The point of testing this at the client rather than only at the server
 * is the transfer itself: the bytes go out on the BINARY channel as
 * `UPLOAD_CHUNK` frames, framed by the client, keyed by an id the server
 * mints. Every one of those is a place to get it wrong silently, and a
 * silently wrong upload submits an empty file rather than failing.
 */

import type { Capability } from '@browserglass/protocol';
import {
  MsgType,
  PayloadCodec,
  decodeBinaryHeader,
  decodeUploadChunkPayload,
} from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationClient, AutomationError } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { fixtureOptions, tick } from '../helpers.js';

/**
 * `fixtureWelcome`'s default grants deliberately omit `upload`, which is
 * the gating working: an automation token carries `automation`, `control`
 * and `navigate`, and none of those implies the right to put a document
 * into a form. Tests that want the feature ask for the capability
 * explicitly; one test below asserts what happens without it.
 */
const WITH_UPLOAD: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'automation',
  'upload',
];

/** Connects a client whose `welcome.granted` is `granted`. */
async function connect(granted: readonly Capability[] = WITH_UPLOAD) {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const gateway = startScriptedGateway(harness, { granted: [...granted] });
  const client = await connectPromise;
  return { client, gateway, harness };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('setInputFiles', () => {
  it('stages the bytes and attaches them in one files.set', async () => {
    const { client, gateway } = await connect();

    const data = new Uint8Array(200).map((_, i) => (i * 7) % 251);
    const promise = client.setInputFiles('#attachment', {
      name: 'invoice.pdf',
      data,
      mime: 'application/pdf',
    });
    await vi.advanceTimersByTimeAsync(0);
    const names = await promise;

    expect(names).toEqual(['invoice.pdf']);
    expect(gateway.filesSetCalls).toHaveLength(1);
    expect(gateway.filesSetCalls[0]?.['selector']).toBe('#attachment');

    // The bytes the gateway reassembled from the binary frames are the
    // bytes handed in, unchanged and in order.
    const uploadId = (gateway.filesSetCalls[0]?.['uploadIds'] as string[])[0] as string;
    expect(gateway.bytesFor(uploadId)).toEqual(data);
  });

  it('splits into UPLOAD_CHUNK frames at the server-dictated chunk size, with seq as the chunk index', async () => {
    const { client, gateway } = await connect();

    // The fake dictates `chunkBytes: 64`, so 200 bytes is four frames
    // (64, 64, 64, 8).
    const data = new Uint8Array(200);
    const promise = client.setInputFiles('#f', { name: 'a.bin', data });
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const frames = gateway.ws.sent.filter((d): d is Uint8Array => typeof d !== 'string');
    expect(frames).toHaveLength(4);

    const decoded = frames.map((f) => decodeBinaryHeader(f));
    expect(decoded.map((d) => d.msgType)).toEqual([
      MsgType.UPLOAD_CHUNK,
      MsgType.UPLOAD_CHUNK,
      MsgType.UPLOAD_CHUNK,
      MsgType.UPLOAD_CHUNK,
    ]);
    // Zero based, one per chunk. For `UPLOAD_CHUNK` `seq` is the chunk
    // index (byte offset is `seq * chunkBytes`), not the from-one
    // per-stream counter it is for a frame.
    expect(decoded.map((d) => d.seq)).toEqual([0, 1, 2, 3]);
    // Session scoped, so no stream handle, and raw bytes.
    expect(decoded.every((d) => d.streamId === 0)).toBe(true);
    expect(decoded.every((d) => d.payloadCodec === PayloadCodec.NONE)).toBe(true);
    expect(decoded.map((d) => decodeUploadChunkPayload(d.payload).chunk.byteLength)).toEqual([
      64, 64, 64, 8,
    ]);
  });

  it("keys every chunk with the binaryId the server minted, not the caller's uploadId", async () => {
    // The binary header spends a fixed 16 bytes on the id, so it cannot
    // carry the caller-chosen string. A client that framed its own id here
    // would send bytes nothing ever reads, and the upload would complete
    // as empty.
    const { client, gateway } = await connect();
    const promise = client.setInputFiles('#f', { name: 'a.bin', data: new Uint8Array([1, 2, 3]) });
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const accepted = gateway.ws.sentJsonMessages().find((m) => m['t'] === 'upload.begin');
    const uploadId = accepted?.['uploadId'] as string;
    const rec = gateway.uploadsById.get(uploadId);
    expect(rec).toBeDefined();

    const frame = gateway.ws.sent.find((d): d is Uint8Array => typeof d !== 'string') as Uint8Array;
    const sentId = [...decodeUploadChunkPayload(decodeBinaryHeader(frame).payload).uploadId]
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    expect(sentId).toBe(rec?.binaryId);
  });

  it('sends purpose "input" and the declared size, so the server can enforce both', async () => {
    const { client, gateway } = await connect();
    const promise = client.setInputFiles('#f', {
      name: 'a.bin',
      data: new Uint8Array(9),
      mime: 'text/plain',
    });
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    const begin = gateway.ws.sentJsonMessages().find((m) => m['t'] === 'upload.begin');
    expect(begin).toMatchObject({
      purpose: 'input',
      sizeBytes: 9,
      name: 'a.bin',
      mime: 'text/plain',
    });
  });

  it('handles a zero-byte file, which sends no frames and still completes', async () => {
    const { client, gateway } = await connect();
    const promise = client.setInputFiles('#f', { name: 'empty.txt', data: new Uint8Array(0) });
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toEqual(['empty.txt']);
    expect(gateway.ws.sent.filter((d) => typeof d !== 'string')).toHaveLength(0);
  });

  it('stages several files and names them all in one files.set, in order', async () => {
    const { client, gateway } = await connect();
    const promise = client.setInputFiles('#many', [
      { name: 'first.txt', data: new Uint8Array([1]) },
      { name: 'second.txt', data: new Uint8Array([2]) },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    await expect(promise).resolves.toEqual(['first.txt', 'second.txt']);
    expect(gateway.filesSetCalls).toHaveLength(1);
    expect((gateway.filesSetCalls[0]?.['uploadIds'] as string[]).length).toBe(2);
  });

  it('cancels everything it staged when the attach fails', async () => {
    // A bad selector is the commonest failure there is, and an agent
    // retrying in a loop would otherwise leave a copy of the file on the
    // gateway's disk on every attempt.
    const { client, gateway } = await connect();
    gateway.filesSetError = 'bgls.error.capture.no_match';

    // Settled BEFORE the timers are advanced: the rejection happens inside
    // `advanceTimersByTimeAsync`, and attaching the handler afterwards
    // makes Node report a spurious unhandled rejection.
    const settled = client
      .setInputFiles('#nope', [
        { name: 'a.txt', data: new Uint8Array([1]) },
        { name: 'b.txt', data: new Uint8Array([2]) },
      ])
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toBeInstanceOf(AutomationError);
    expect(gateway.cancelledUploads).toHaveLength(2);
  });

  it('needs the upload capability, and says so before sending anything', async () => {
    // Everything except `upload`.
    const { client, gateway } = await connect(WITH_UPLOAD.filter((c) => c !== 'upload'));
    const err = await client
      .setInputFiles('#f', { name: 'a.txt', data: new Uint8Array([1]) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AutomationError);
    expect((err as AutomationError).code).toBe('POLICY_DENIED');
    // Nothing was staged: the gate runs before the first round trip.
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'upload.begin')).toBe(false);
  });

  it('refuses an empty file list rather than clearing the input', async () => {
    const { client } = await connect();
    await expect(client.setInputFiles('#f', [])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('surfaces a size mismatch from the server rather than reporting success', async () => {
    const { client, gateway } = await connect();
    // Drop every chunk on the floor server side, simulating a transfer
    // that silently lost its bytes. The completion check is what catches
    // it, and it must not be reported as a successful attach.
    gateway.ws.send = ((data: unknown) => {
      if (typeof data === 'string') {
        const msg = JSON.parse(data as string) as Record<string, unknown>;
        gateway.ws.sent.push(data as string);
        (gateway as unknown as { handle: (m: Record<string, unknown>) => void }).handle(msg);
      }
      // Binary frames are discarded.
    }) as typeof gateway.ws.send;

    const settled = client
      .setInputFiles('#f', { name: 'a.bin', data: new Uint8Array(100) })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0);
    expect(await settled).toBeInstanceOf(AutomationError);
  });
});
