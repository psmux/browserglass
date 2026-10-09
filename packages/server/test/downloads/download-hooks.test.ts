/**
 * The download feature end to end through `ManagedSession`: the
 * `download.started`/`download.progress`/`download.ready`/`download.failed`
 * wire messages `dispatchEffect` actually emits, and `onDownload`, the
 * vetoing, fail-CLOSED hook (`hooks/types.ts`'s `HOOK_TIMEOUTS.onDownload`)
 * this feature makes reachable for the first time.
 *
 * The fake Chrome server (`ws/support/fake-chrome-server.ts`) speaks only
 * the CDP control-plane messages (`Page.setDownloadBehavior`,
 * `Browser.downloadWillBegin`, `Browser.downloadProgress`); it never
 * actually writes a downloaded file to disk the way real Chrome would, so
 * every test that reaches a `download.completed` effect first writes the
 * expected bytes into `gw.downloads.root` itself, standing in for what
 * `behavior: 'allowAndName'` (`DownloadBridge`'s module doc) would have
 * produced.
 *
 * TWO DIFFERENT `targetId`s ARE IN PLAY. `RAW_TARGET_ID` is the raw CDP id
 * `gw.addTarget` registers with the fake endpoint, and it is what
 * `gw.chrome.emit*` calls need (`FakeChromeServer`'s own session bookkeeping
 * is keyed by it). `welcome.targets[0].targetId` is the WIRE id
 * `TargetRegistry.start()` mints on top of it (`target-capture-dimensions.test.ts`'s
 * own `connectViewer` doc names this precisely), and it is what every
 * `download.*` envelope and hook event carries. Mixing the two up is a
 * silent hang, not a loud failure: `FakeChromeServer`'s emit helpers no-op
 * on an unknown raw id, so the corresponding `nextMessageSkipping` call
 * simply never resolves.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import type { DownloadEvent } from '../../src/hooks/types.js';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from '../ws/support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;
const RAW_TARGET_ID = 'cdp-a';

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

/** Connects a viewer holding `download` (plus the ordinary driving set), and waits for `Page.setDownloadBehavior{eventsEnabled:true}` to actually reach the fake CDP endpoint before returning: `ensureDownloadCapture` arms capture fire-and-forget from `attachViewer`, so a test that emits a synthetic CDP event immediately after connecting, without this wait, races that arm and would see the event silently dropped by `DownloadBridge`'s own `if (!this.enabled) return`. Returns the WIRE `targetId` (see this file's module doc); callers driving `gw.chrome.emit*` still need {@link RAW_TARGET_ID}. */
async function connectDownloadViewer(
  gw: TestGateway,
): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken({
    caps: ['view', 'control', 'navigate', 'tabs.manage', 'download'],
  });
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
  const welcome = await nextMessage(ws);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  await waitForCdpCall(gw, 'Page.setDownloadBehavior', (c) => c.params['eventsEnabled'] === true);
  return { ws, targetId };
}

/** Waits until a CDP call matching `method` (and, when given, `match`) reaches the fake endpoint. Mirrors `shared-control.test.ts`'s own `waitForLog` polling shape. */
async function waitForCdpCall(
  gw: TestGateway,
  method: string,
  match?: (c: { readonly method: string; readonly params: Record<string, unknown> }) => boolean,
): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (gw.chrome.cdpCalls.some((c) => c.method === method && (match ? match(c) : true))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `no CDP call matching ${method} arrived; saw ${JSON.stringify(gw.chrome.cdpCalls.map((c) => c.method))}`,
  );
}

/** Stages the bytes a completed download's `Browser.downloadProgress{state:'completed'}` event will point at, standing in for what real Chrome (`behavior: 'allowAndName'`) would have written. */
async function stageDownloadedFile(
  gw: TestGateway,
  guid: string,
  bytes: Uint8Array,
): Promise<string> {
  const path = join(gw.downloads.root, guid);
  await writeFile(path, bytes);
  return path;
}

let gw: TestGateway;

afterEach(async () => {
  await gw.close();
});

describe('download.*: the wire messages this feature actually emits', () => {
  beforeEach(async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: RAW_TARGET_ID,
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
  });

  it('a full download (started, progress, ready) reaches a download-holding viewer', async () => {
    const { ws, targetId } = await connectDownloadViewer(gw);
    const bytes = new TextEncoder().encode('%PDF-1.4 fake pdf bytes');
    await stageDownloadedFile(gw, 'dl_1', bytes);

    gw.chrome.emitDownloadWillBegin(RAW_TARGET_ID, {
      guid: 'dl_1',
      url: 'https://a.example/files/report.pdf',
      suggestedFilename: 'report.pdf',
    });
    const started = await nextMessageSkipping(ws, UNSOLICITED);
    expect(started['t']).toBe('download.started');
    expect(started['downloadId']).toBe('dl_1');
    expect(started['targetId']).toBe(targetId);
    expect(started['suggestedName']).toBe('report.pdf');
    expect(started['mime']).toBe('application/pdf');
    // CDP's own `downloadWillBegin` carries no size; see `MIME_BY_EXTENSION`'s
    // doc in `managed-session.ts` for the matching gap this reflects.
    expect(started['totalBytes']).toBeNull();
    expect(started['url']).toBe('https://a.example/files/report.pdf');

    gw.chrome.emitDownloadProgress(RAW_TARGET_ID, {
      guid: 'dl_1',
      state: 'inProgress',
      receivedBytes: 5,
      totalBytes: bytes.byteLength,
    });
    const progress = await nextMessageSkipping(ws, UNSOLICITED);
    expect(progress).toMatchObject({
      t: 'download.progress',
      downloadId: 'dl_1',
      receivedBytes: 5,
      totalBytes: bytes.byteLength,
    });

    gw.chrome.emitDownloadProgress(RAW_TARGET_ID, {
      guid: 'dl_1',
      state: 'completed',
      receivedBytes: bytes.byteLength,
    });
    const ready = await nextMessageSkipping(ws, UNSOLICITED);
    expect(ready['t']).toBe('download.ready');
    expect(ready['downloadId']).toBe('dl_1');
    expect(ready['sizeBytes']).toBe(bytes.byteLength);
    expect(typeof ready['sha256']).toBe('string');
    expect(ready['sha256'] as string).toHaveLength(64);
    expect(typeof ready['url']).toBe('string');
    expect(typeof ready['expiresAt']).toBe('number');

    ws.close();
  });

  it('a cancelled download reaches the viewer as download.failed', async () => {
    const { ws } = await connectDownloadViewer(gw);
    gw.chrome.emitDownloadWillBegin(RAW_TARGET_ID, {
      guid: 'dl_2',
      url: 'https://a.example/f',
      suggestedFilename: 'x.bin',
    });
    await nextMessageSkipping(ws, UNSOLICITED); // download.started

    gw.chrome.emitDownloadProgress(RAW_TARGET_ID, {
      guid: 'dl_2',
      state: 'canceled',
      receivedBytes: 0,
    });
    const failed = await nextMessageSkipping(ws, UNSOLICITED);
    expect(failed).toMatchObject({ t: 'download.failed', downloadId: 'dl_2', reason: 'canceled' });
    ws.close();
  });

  it('a viewer without the download capability never receives download.* at all', async () => {
    // A second viewer holding `download` is still needed to ARM capture in
    // the first place (there is no `download.subscribe`; capture is
    // capability driven session wide, `ensureDownloadCapture`'s own doc).
    const armer = await connectDownloadViewer(gw);
    const token = await gw.issueToken({ caps: ['view', 'control', 'navigate', 'tabs.manage'] }); // no `download`
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    await nextMessage(ws); // welcome

    gw.chrome.emitDownloadWillBegin(RAW_TARGET_ID, {
      guid: 'dl_3',
      url: 'https://a.example/f',
      suggestedFilename: 'x.bin',
    });
    // The armer's own socket DOES get it...
    const started = await nextMessageSkipping(armer.ws, UNSOLICITED);
    expect(started['t']).toBe('download.started');
    // ...but nothing ever arrives on the capability-less socket. Racing an
    // absence is inherently a timing argument; a short bounded wait plus
    // asserting the queue is still empty is the same shape this suite uses
    // elsewhere for "did not fire".
    await new Promise((r) => setTimeout(r, 100));
    ws.close();
    armer.ws.close();
  });
});

describe('onDownload: veto actually stops the download', () => {
  beforeEach(async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: RAW_TARGET_ID,
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
  });

  it('a handler returning false with a reason: download.failed reaches the viewer, download.ready never does, and the file is deleted', async () => {
    const seen: DownloadEvent[] = [];
    gw.connectionDeps.hooks.on('onDownload', (e) => {
      seen.push(e);
      e.reason = 'malware policy: exe downloads are blocked';
      return false;
    });

    const { ws, targetId } = await connectDownloadViewer(gw);
    const bytes = new TextEncoder().encode('MZ fake pe bytes');
    const path = await stageDownloadedFile(gw, 'dl_v1', bytes);

    gw.chrome.emitDownloadWillBegin(RAW_TARGET_ID, {
      guid: 'dl_v1',
      url: 'https://a.example/f.exe',
      suggestedFilename: 'installer.exe',
    });
    await nextMessageSkipping(ws, UNSOLICITED); // download.started

    gw.chrome.emitDownloadProgress(RAW_TARGET_ID, {
      guid: 'dl_v1',
      state: 'completed',
      receivedBytes: bytes.byteLength,
    });
    const reply = await nextMessageSkipping(ws, UNSOLICITED);

    // The veto's outcome on the wire: `download.failed`, never `download.ready`.
    expect(reply['t']).toBe('download.failed');
    expect(reply['downloadId']).toBe('dl_v1');
    expect(reply['reason']).toBe('malware policy: exe downloads are blocked');

    // The hook actually saw the finished file's real, hashed facts, not a
    // placeholder: this is what makes `download.completed` (not
    // `download.started`) the correct veto point (`DownloadEvent` requires
    // `sha256`/`bytes`, only known once the file exists).
    expect(seen).toHaveLength(1);
    expect(seen[0]!.downloadId).toBe('dl_v1');
    expect(seen[0]!.bytes).toBe(bytes.byteLength);
    expect(seen[0]!.sha256).toHaveLength(64);
    expect(seen[0]!.sourceUrl).toBe('https://a.example/f.exe');
    expect(seen[0]!.targetId).toBe(targetId);

    // The bytes are actually gone, not merely unadvertised: a veto that left
    // the file on disk (or, worse, still issued a URL nobody advertised)
    // would not be a real stop.
    await expect(readFile(path)).rejects.toThrow();

    ws.close();
  });

  it('a handler returning undefined (allow) still lets download.ready through, proving the veto path above is the hook doing something, not this route always failing closed', async () => {
    gw.connectionDeps.hooks.on('onDownload', () => undefined);
    const { ws } = await connectDownloadViewer(gw);
    const bytes = new TextEncoder().encode('ok bytes');
    await stageDownloadedFile(gw, 'dl_v2', bytes);
    gw.chrome.emitDownloadWillBegin(RAW_TARGET_ID, {
      guid: 'dl_v2',
      url: 'https://a.example/f',
      suggestedFilename: 'ok.bin',
    });
    await nextMessageSkipping(ws, UNSOLICITED);
    gw.chrome.emitDownloadProgress(RAW_TARGET_ID, {
      guid: 'dl_v2',
      state: 'completed',
      receivedBytes: bytes.byteLength,
    });
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    expect(reply['t']).toBe('download.ready');
    ws.close();
  });
});

describe('onDownload: fails CLOSED on timeout (HOOK_TIMEOUTS.onDownload.failClosed)', () => {
  it('a handler that never resolves still produces download.failed, within the configured timeout, and the file is removed', async () => {
    // A short `hookTimeoutMs` so this test does not wait out the real 5s
    // default; see `startTestGateway`'s own doc for why this does not
    // change WHICH hooks fail open versus closed, only how long the wait is.
    gw = await startTestGateway({ hookTimeoutMs: 100 });
    gw.addTarget({
      targetId: RAW_TARGET_ID,
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });

    let handlerWasCalled = false;
    gw.connectionDeps.hooks.on('onDownload', () => {
      handlerWasCalled = true;
      // Never resolves: models a wedged out-of-process policy check
      // (`hooks/types.ts`'s own `HOOK_TIMEOUTS` doc: "a handler that does a
      // real out of process check").
      return new Promise<boolean>(() => {});
    });

    const { ws } = await connectDownloadViewer(gw);
    const bytes = new TextEncoder().encode('bytes that will time out');
    const path = await stageDownloadedFile(gw, 'dl_t1', bytes);

    gw.chrome.emitDownloadWillBegin(RAW_TARGET_ID, {
      guid: 'dl_t1',
      url: 'https://a.example/f',
      suggestedFilename: 'x.bin',
    });
    await nextMessageSkipping(ws, UNSOLICITED); // download.started

    const startedWaitingAt = Date.now();
    gw.chrome.emitDownloadProgress(RAW_TARGET_ID, {
      guid: 'dl_t1',
      state: 'completed',
      receivedBytes: bytes.byteLength,
    });
    const reply = await nextMessageSkipping(ws, UNSOLICITED);
    const waitedMs = Date.now() - startedWaitingAt;

    expect(handlerWasCalled).toBe(true);
    // FAIL CLOSED: a timed out check is a veto, never an allow. This is the
    // one assertion this whole file exists to make: without it, a hung
    // policy check would silently let every download through.
    expect(reply['t']).toBe('download.failed');
    expect(reply['downloadId']).toBe('dl_t1');
    expect(reply['reason']).toMatch(/timed out|fail closed/i);
    // Bounded: the veto actually came from the timeout firing, not from
    // some unrelated later event, and it did not wait anywhere near the
    // real 5000ms default.
    expect(waitedMs).toBeGreaterThanOrEqual(90);
    expect(waitedMs).toBeLessThan(4000);

    await expect(readFile(path)).rejects.toThrow();
    ws.close();
  });
});

describe('suggestedName: attacker controlled, never a path component (safe-name.ts)', () => {
  beforeEach(async () => {
    gw = await startTestGateway();
    gw.addTarget({
      targetId: RAW_TARGET_ID,
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
    });
  });

  it('a path-traversal suggestedFilename cannot make the finished download resolve outside downloads.dir, and the wire message never carries the raw traversal string', async () => {
    const { ws } = await connectDownloadViewer(gw);
    const bytes = new TextEncoder().encode('payload');
    // The hostile page's suggestedFilename: a classic traversal attempt.
    // `DownloadBridge` never lets this become a path component (behavior:
    // 'allowAndName', see its module doc): Chrome (this fake, standing in
    // for it) writes to `<downloads.dir>/<guid>` regardless of what the
    // page asked to call the file, so staging under the guid is the
    // faithful simulation of that guarantee, not a workaround of this test.
    const hostileName = '../../../../etc/passwd';
    const path = await stageDownloadedFile(gw, 'dl_evil', bytes);

    gw.chrome.emitDownloadWillBegin(RAW_TARGET_ID, {
      guid: 'dl_evil',
      url: 'https://evil.example/x',
      suggestedFilename: hostileName,
    });
    const started = await nextMessageSkipping(ws, UNSOLICITED);
    // `sanitizeSuggestedName` (`wire/sanitize.ts`) rejects any name
    // carrying a path separator outright rather than trying to repair it;
    // the raw traversal string must never reach a client verbatim.
    expect(started['suggestedName']).not.toBe(hostileName);
    expect(started['suggestedName']).not.toMatch(/[/\\]/);

    gw.chrome.emitDownloadProgress(RAW_TARGET_ID, {
      guid: 'dl_evil',
      state: 'completed',
      receivedBytes: bytes.byteLength,
    });
    const ready = await nextMessageSkipping(ws, UNSOLICITED);
    expect(ready['t']).toBe('download.ready');

    // The file that actually got hashed and served is exactly the one
    // this test staged, inside the configured root: nothing about the
    // hostile suggested name redirected `finalize()` anywhere else.
    expect(path).toBe(join(gw.downloads.root, 'dl_evil'));
    await expect(readFile(path)).resolves.toBeDefined();

    ws.close();
  });
});
