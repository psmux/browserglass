/**
 * `recording.start`/`.stop`/`.list` end to end: real WS handshake, real
 * `ManagedSession.startRecording`/`stopRecording`/`listRecordings`, and a
 * real `DiskRecordingSink` writing under `gw.recordingsDir`. Pins three
 * things explicitly: the dual
 * `capture`+`download` capability gate (`wire/capability-check.ts`'s
 * `recording.*` entries plus `ws/connection.ts`'s `requireDownloadCapability`),
 * that a recording actually reaches disk through the ordinary fan-out
 * path, and that `recording.stop`/`recording.list` report real state.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

let gw: TestGateway;

afterEach(async () => {
  await gw?.close();
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

async function connectWithCaps(
  gwArg: TestGateway,
  caps: string[],
): Promise<{ ws: import('ws'); targetId: string }> {
  const token = await gwArg.issueToken({ caps });
  const ws = gwArg.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
  const welcome = await nextMessage(ws);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

/** Polls `recording.list` until `recordingId` reports at least `minFrames`, or throws. */
async function waitForFramesWritten(
  ws: import('ws'),
  recordingId: string,
  minFrames: number,
): Promise<Record<string, unknown>> {
  for (let i = 0; i < 200; i++) {
    ws.send(JSON.stringify({ v: 1, t: 'recording.list', ts: Date.now() }));
    const listed = await nextMessageSkipping(ws, ['presence.state', 'stream.stats']);
    const rec = (listed['recordings'] as Array<Record<string, unknown>>).find(
      (r) => r['recordingId'] === recordingId,
    );
    if (rec && (rec['framesWritten'] as number) >= minFrames) return rec;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`recording ${recordingId} never reached ${minFrames} frames written`);
}

describe('recording.start / .stop / .list: capability gate', () => {
  it('refuses recording.start without capture (the generic checkCapability gate)', async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    const { ws, targetId } = await connectWithCaps(gw, ['view', 'download']);

    ws.send(JSON.stringify({ v: 1, t: 'recording.start', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, ['presence.state']);
    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.cap.missing');
    expect((reply['context'] as Record<string, unknown>)['required']).toBe('capture');
    ws.close();
  });

  it('refuses recording.start with capture but no download (the handler-level second gate)', async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    const { ws, targetId } = await connectWithCaps(gw, ['view', 'capture']);

    ws.send(JSON.stringify({ v: 1, t: 'recording.start', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, ['presence.state']);
    expect(reply['t']).toBe('error');
    expect(reply['code']).toBe('bgls.error.cap.missing');
    expect((reply['context'] as Record<string, unknown>)['required']).toBe('download');
    ws.close();
  });

  it('does not widen target.capture: capture alone is enough for it, with no download required', async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    const { ws, targetId } = await connectWithCaps(gw, ['view', 'capture']);

    ws.send(JSON.stringify({ v: 1, t: 'target.capture', ts: Date.now(), targetId }));
    const reply = await nextMessageSkipping(ws, ['presence.state']);
    expect(reply['t']).toBe('target.captured');
    ws.close();
  });
});

describe('recording.start / .stop / .list: real disk output', () => {
  it('starts, writes at least one frame to disk, stops, and lists a stopped, non-failed summary', async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    const { ws, targetId } = await connectWithCaps(gw, ['view', 'capture', 'download']);

    ws.send(JSON.stringify({ v: 1, t: 'recording.start', ts: Date.now(), targetId }));
    const started = await nextMessageSkipping(ws, ['presence.state']);
    expect(started['t']).toBe('recording.started');
    const recordingId = started['recordingId'] as string;
    expect(recordingId).toMatch(/^rec_/);
    expect(started['targetId']).toBe(targetId);
    expect(started['mode']).toBe('live');

    // `startRecording` already forced one frame; wait for it to actually
    // land (the write itself is fire-and-forget relative to the reply,
    // see `frame-recorder.ts`'s own `handleSend`).
    await waitForFramesWritten(ws, recordingId, 1);

    ws.send(JSON.stringify({ v: 1, t: 'recording.stop', ts: Date.now(), recordingId }));
    const stopped = await nextMessageSkipping(ws, ['presence.state', 'stream.stats']);
    expect(stopped['t']).toBe('recording.stopped');
    expect(stopped['recordingId']).toBe(recordingId);
    expect(stopped['failed']).toBe(false);
    expect(stopped['framesWritten'] as number).toBeGreaterThanOrEqual(1);

    ws.send(JSON.stringify({ v: 1, t: 'recording.list', ts: Date.now() }));
    const listed = await nextMessageSkipping(ws, ['presence.state']);
    const recordings = listed['recordings'] as Array<Record<string, unknown>>;
    const rec = recordings.find((r) => r['recordingId'] === recordingId);
    expect(rec).toBeDefined();
    expect(rec?.['stoppedAtMs']).toBeTypeOf('number');
    expect(rec?.['failed']).toBe(false);

    // Real bytes, on real disk, under the configured root -- not merely a
    // wire-level claim.
    const frameFiles = await readdir(join(gw.recordingsDir, recordingId, 'frames'));
    expect(frameFiles.length).toBeGreaterThanOrEqual(1);
    const meta = JSON.parse(
      await readFile(join(gw.recordingsDir, recordingId, 'meta.json'), 'utf8'),
    );
    expect(meta.recordingId).toBe(recordingId);
    expect(meta.targetId).toBe(targetId);
    const completion = JSON.parse(
      await readFile(join(gw.recordingsDir, recordingId, 'complete.json'), 'utf8'),
    );
    expect(completion.failed).toBe(false);

    ws.close();
  });

  it('recording.stop on an unknown recordingId is refused, not silently accepted', async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
    const { ws } = await connectWithCaps(gw, ['view', 'capture', 'download']);

    ws.send(
      JSON.stringify({
        v: 1,
        t: 'recording.stop',
        ts: Date.now(),
        recordingId: 'rec_01ARZ3NDEKTSV4RRFFQ69G5FAV',
      }),
    );
    const reply = await nextMessageSkipping(ws, ['presence.state']);
    expect(reply['t']).toBe('error');
    expect(reply['category']).toBe('target');
    ws.close();
  });
});
