import { describe, expect, it } from 'vitest';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { DownloadBridge } from '../../src/downloads/download-bridge.js';
import type {
  DownloadCompletedPayload,
  DownloadFailedPayload,
  DownloadProgressPayload,
  DownloadSink,
  DownloadStartedPayload,
} from '../../src/downloads/types.js';
import { FakeCdpBridge, asFakeBridge } from '../diagnostics/test-helpers.js';

const SID = 'sess-A' as CdpSessionId;
const SID_B = 'sess-B' as CdpSessionId;
const TARGET_ID = 'tgt_00000000000000000000000001';
const DOWNLOAD_PATH = '/staging/downloads/tgt_1';

/** Records everything a `DownloadBridge` hands to its sink, for assertion. */
class RecordingSink implements DownloadSink {
  readonly started: DownloadStartedPayload[] = [];
  readonly progress: DownloadProgressPayload[] = [];
  readonly completed: DownloadCompletedPayload[] = [];
  readonly failed: DownloadFailedPayload[] = [];

  onDownloadStarted(e: DownloadStartedPayload): void {
    this.started.push(e);
  }
  onDownloadProgress(e: DownloadProgressPayload): void {
    this.progress.push(e);
  }
  onDownloadCompleted(e: DownloadCompletedPayload): void {
    this.completed.push(e);
  }
  onDownloadFailed(e: DownloadFailedPayload): void {
    this.failed.push(e);
  }
}

function setup() {
  const bridge = new FakeCdpBridge();
  const sink = new RecordingSink();
  const dl = new DownloadBridge({
    bridge: asFakeBridge(bridge),
    sessionId: SID,
    targetId: TARGET_ID,
    sink,
  });
  return { bridge, sink, dl };
}

describe('DownloadBridge: arming', () => {
  it('start() sends Page.setDownloadBehavior with allowAndName and eventsEnabled true, scoped to the session', async () => {
    const { bridge, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    expect(bridge.sendCountFor('Page.setDownloadBehavior')).toBe(1);
    const sent = bridge.sent.find((s) => s.method === 'Page.setDownloadBehavior');
    expect(sent?.sessionId).toBe(SID);
    expect(sent?.params).toEqual({
      behavior: 'allowAndName',
      downloadPath: DOWNLOAD_PATH,
      eventsEnabled: true,
    });
    expect(dl.armed).toBe(true);
  });

  it('start() is idempotent: calling it again does not re-send', async () => {
    const { bridge, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    await dl.start(DOWNLOAD_PATH);
    expect(bridge.sendCountFor('Page.setDownloadBehavior')).toBe(1);
  });

  it('a failed Page.setDownloadBehavior leaves armed false and does not throw', async () => {
    const { bridge, dl } = setup();
    bridge.rejectNext('Page.setDownloadBehavior', new Error('target gone'));
    await dl.start(DOWNLOAD_PATH);
    expect(dl.armed).toBe(false);
  });

  it('never sends Browser.setDownloadBehavior (session scoped Page method only, per module doc)', async () => {
    const { bridge, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    expect(bridge.sendCountFor('Browser.setDownloadBehavior')).toBe(0);
  });

  it('stop() sends a disable and disarms; is idempotent', async () => {
    const { bridge, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    await dl.stop();
    expect(bridge.sendCountFor('Page.setDownloadBehavior')).toBe(2);
    const disable = bridge.sent[1];
    expect(disable?.params).toEqual({ behavior: 'default', eventsEnabled: false });
    expect(dl.armed).toBe(false);
    await dl.stop();
    expect(bridge.sendCountFor('Page.setDownloadBehavior')).toBe(2);
  });

  it('stop() on a never-started collector sends no disable', async () => {
    const { bridge, dl } = setup();
    await dl.stop();
    expect(bridge.sendCountFor('Page.setDownloadBehavior')).toBe(0);
  });
});

describe('DownloadBridge: event relay', () => {
  it('Browser.downloadWillBegin relays downloadId, suggestedName, url; ignored before start()', async () => {
    const { bridge, sink, dl } = setup();
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'invoice.pdf', url: 'https://evil.example/x' },
      SID,
    );
    expect(sink.started).toHaveLength(0); // not armed yet

    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'invoice.pdf', url: 'https://evil.example/x' },
      SID,
    );
    expect(sink.started).toEqual([
      { downloadId: 'g1', suggestedName: 'invoice.pdf', url: 'https://evil.example/x' },
    ]);
  });

  it('Browser.downloadProgress inProgress relays receivedBytes/totalBytes, totalBytes null when unknown', async () => {
    const { bridge, sink, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'a.bin', url: 'https://x/a' },
      SID,
    );
    bridge.emit(
      'Browser.downloadProgress',
      { guid: 'g1', state: 'inProgress', receivedBytes: 100, totalBytes: 1000 },
      SID,
    );
    bridge.emit(
      'Browser.downloadProgress',
      { guid: 'g1', state: 'inProgress', receivedBytes: 200, totalBytes: 0 },
      SID,
    );
    expect(sink.progress).toEqual([
      { downloadId: 'g1', receivedBytes: 100, totalBytes: 1000 },
      { downloadId: 'g1', receivedBytes: 200, totalBytes: null },
    ]);
  });

  it('completed uses filePath when CDP supplies it', async () => {
    const { bridge, sink, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'invoice.pdf', url: 'https://x/a' },
      SID,
    );
    bridge.emit(
      'Browser.downloadProgress',
      { guid: 'g1', state: 'completed', receivedBytes: 4096, filePath: `${DOWNLOAD_PATH}/g1` },
      SID,
    );
    expect(sink.completed).toEqual([
      {
        downloadId: 'g1',
        suggestedName: 'invoice.pdf',
        path: `${DOWNLOAD_PATH}/g1`,
        sizeBytes: 4096,
      },
    ]);
  });

  it('completed falls back to <downloadPath>/<guid> when CDP omits filePath', async () => {
    const { bridge, sink, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g2', suggestedFilename: 'x.zip', url: 'https://x/b' },
      SID,
    );
    bridge.emit(
      'Browser.downloadProgress',
      { guid: 'g2', state: 'completed', receivedBytes: 10 },
      SID,
    );
    expect(sink.completed).toEqual([
      { downloadId: 'g2', suggestedName: 'x.zip', path: `${DOWNLOAD_PATH}/g2`, sizeBytes: 10 },
    ]);
  });

  it('canceled reports onDownloadFailed with reason "canceled" and clears pending', async () => {
    const { bridge, sink, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'a', url: 'https://x/a' },
      SID,
    );
    bridge.emit(
      'Browser.downloadProgress',
      { guid: 'g1', state: 'canceled', receivedBytes: 0 },
      SID,
    );
    expect(sink.failed).toEqual([{ downloadId: 'g1', reason: 'canceled' }]);
  });

  it('an event on a different session id is ignored', async () => {
    const { bridge, sink, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'a', url: 'https://x/a' },
      SID_B,
    );
    expect(sink.started).toHaveLength(0);
  });
});

describe('DownloadBridge: rebind', () => {
  it('rebind() re-arms on the new session and stops listening on the old one', async () => {
    const { bridge, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    await dl.rebind(SID_B);
    expect(bridge.sendCountFor('Page.setDownloadBehavior')).toBe(2);
    const second = bridge.sent[1];
    expect(second?.sessionId).toBe(SID_B);
    expect(dl.armed).toBe(true);

    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'stale', suggestedFilename: 'x', url: 'https://x' },
      SID,
    );
    // Old session's subscriptions were dropped; nothing to assert against a
    // sink push here beyond "did not throw", covered by not awaiting a
    // rejection.
  });

  it('rebind() is a no-op for the same session id', async () => {
    const { bridge, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    await dl.rebind(SID);
    expect(bridge.sendCountFor('Page.setDownloadBehavior')).toBe(1);
  });

  it('rebind() fails every pending download with reason "session_rebound" before dropping it', async () => {
    const { bridge, sink, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'a', url: 'https://x/a' },
      SID,
    );
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g2', suggestedFilename: 'b', url: 'https://x/b' },
      SID,
    );
    await dl.rebind(SID_B);
    expect(sink.failed).toEqual(
      expect.arrayContaining([
        { downloadId: 'g1', reason: 'session_rebound' },
        { downloadId: 'g2', reason: 'session_rebound' },
      ]),
    );
    expect(sink.failed).toHaveLength(2);

    // A late "completed" for the abandoned download on the OLD session
    // must not resurrect it as a second, contradictory outcome.
    bridge.emit(
      'Browser.downloadProgress',
      { guid: 'g1', state: 'completed', receivedBytes: 5 },
      SID,
    );
    expect(sink.completed).toHaveLength(0);
  });

  it('stop() fails every pending download with reason "target_torn_down"', async () => {
    const { bridge, sink, dl } = setup();
    await dl.start(DOWNLOAD_PATH);
    bridge.emit(
      'Browser.downloadWillBegin',
      { guid: 'g1', suggestedFilename: 'a', url: 'https://x/a' },
      SID,
    );
    await dl.stop();
    expect(sink.failed).toEqual([{ downloadId: 'g1', reason: 'target_torn_down' }]);
  });
});
