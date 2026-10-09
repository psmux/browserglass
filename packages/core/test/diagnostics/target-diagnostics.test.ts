import { beforeEach, describe, expect, it } from 'vitest';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { createManualClock } from '../../src/control/clock.js';
import { TargetDiagnostics } from '../../src/diagnostics/target-diagnostics.js';
import type {
  DiagnosticsSink,
  NetworkRequestEntryPayload,
  NetworkSummaryPayload,
  PageErrorPayload,
} from '../../src/diagnostics/types.js';
import { FakeCdpBridge, asFakeBridge } from './test-helpers.js';

const SID = 'sess-A' as CdpSessionId;
const SID_B = 'sess-B' as CdpSessionId;
const TARGET_ID = 'tgt_00000000000000000000000001';

/** Records everything a `TargetDiagnostics` hands to its sink, for assertion. */
class RecordingSink implements DiagnosticsSink {
  readonly console: Array<{ level: string; text: string; count: number }> = [];
  readonly pageErrors: PageErrorPayload[] = [];
  readonly networkRequests: NetworkRequestEntryPayload[] = [];
  readonly networkSummaries: NetworkSummaryPayload[] = [];

  onConsole(e: { level: string; text: string; count: number }): void {
    this.console.push(e);
  }
  onPageError(e: PageErrorPayload): void {
    this.pageErrors.push(e);
  }
  onNetworkRequest(e: NetworkRequestEntryPayload): void {
    this.networkRequests.push(e);
  }
  onNetworkSummary(e: NetworkSummaryPayload): void {
    this.networkSummaries.push(e);
  }
}

function setup(feeds: { console?: boolean; errors?: boolean; network?: boolean } = {}) {
  const bridge = new FakeCdpBridge();
  const sink = new RecordingSink();
  const clock = createManualClock();
  const diag = new TargetDiagnostics({
    bridge: asFakeBridge(bridge),
    sessionId: SID,
    targetId: TARGET_ID,
    sink,
    clock,
  });
  return {
    bridge,
    sink,
    clock,
    diag,
    feeds: { console: false, errors: false, network: false, ...feeds },
  };
}

describe('TargetDiagnostics: domain enable/disable', () => {
  it('start() with console+errors enables Runtime and Log, not Network', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: true, network: false });
    expect(bridge.sendCountFor('Runtime.enable')).toBe(1);
    expect(bridge.sendCountFor('Log.enable')).toBe(1);
    expect(bridge.sendCountFor('Network.enable')).toBe(0);
    expect(diag.feeds).toEqual({ console: true, errors: true, network: false });
  });

  it('start() with only network enables only Network', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });
    expect(bridge.sendCountFor('Runtime.enable')).toBe(0);
    expect(bridge.sendCountFor('Log.enable')).toBe(0);
    expect(bridge.sendCountFor('Network.enable')).toBe(1);
    expect(diag.feeds).toEqual({ console: false, errors: false, network: true });
  });

  it('errors alone enables Runtime but not Log (Log only serves console)', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: false, errors: true, network: false });
    expect(bridge.sendCountFor('Runtime.enable')).toBe(1);
    expect(bridge.sendCountFor('Log.enable')).toBe(0);
    expect(diag.feeds).toEqual({ console: false, errors: true, network: false });
  });

  it('start() is idempotent: calling it again with the same feeds does not re-send enable', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    await diag.start({ console: true, errors: false, network: false });
    expect(bridge.sendCountFor('Runtime.enable')).toBe(1);
    expect(bridge.sendCountFor('Log.enable')).toBe(1);
  });

  it('reconfigure() turning off console but keeping errors disables Log, keeps Runtime enabled (shared by errors)', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: true, network: false });
    await diag.reconfigure({ console: false, errors: true, network: false });
    expect(bridge.sendCountFor('Log.disable')).toBe(1);
    expect(bridge.sendCountFor('Runtime.disable')).toBe(0);
    expect(diag.feeds).toEqual({ console: false, errors: true, network: false });
  });

  it('reconfigure() turning off the last feed needing Runtime disables it', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: false, errors: true, network: false });
    await diag.reconfigure({ console: false, errors: false, network: false });
    expect(bridge.sendCountFor('Runtime.disable')).toBe(1);
    expect(diag.feeds).toEqual({ console: false, errors: false, network: false });
  });

  it('stop() disables exactly what it enabled, and nothing else', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: false, network: true });
    await diag.stop();
    expect(bridge.sendCountFor('Runtime.disable')).toBe(1);
    expect(bridge.sendCountFor('Log.disable')).toBe(1);
    expect(bridge.sendCountFor('Network.disable')).toBe(1);
    expect(diag.feeds).toEqual({ console: false, errors: false, network: false });
  });

  it('a domain that failed to enable is reported off and never disabled by stop()', async () => {
    const { bridge, diag } = setup();
    bridge.rejectNext('Runtime.enable', new Error('target gone'));
    await diag.start({ console: true, errors: false, network: false });
    // console needs both Runtime and Log; Runtime failed, so console is honestly off.
    expect(diag.feeds).toEqual({ console: false, errors: false, network: false });
    await diag.stop();
    expect(bridge.sendCountFor('Runtime.disable')).toBe(0);
  });
});

describe('TargetDiagnostics: fingerprintActive (point 1, surfacing)', () => {
  it('is false before start() is ever called: quiet by default', () => {
    const { diag } = setup();
    expect(diag.fingerprintActive).toBe(false);
  });

  it('stays false for a network-only subscription: Network.enable never touches Runtime', async () => {
    const { diag } = setup();
    await diag.start({ console: false, errors: false, network: true });
    expect(diag.fingerprintActive).toBe(false);
  });

  it('becomes true the moment console is requested (quiet -> loud)', async () => {
    const { diag } = setup();
    expect(diag.fingerprintActive).toBe(false);
    await diag.start({ console: true, errors: false, network: false });
    expect(diag.fingerprintActive).toBe(true);
  });

  it('becomes true for errors alone too, since errors also needs Runtime', async () => {
    const { diag } = setup();
    await diag.start({ console: false, errors: true, network: false });
    expect(diag.fingerprintActive).toBe(true);
  });

  it('goes back to false once reconfigure() drops every feed that needed Runtime', async () => {
    const { diag } = setup();
    await diag.start({ console: true, errors: true, network: false });
    expect(diag.fingerprintActive).toBe(true);
    await diag.reconfigure({ console: false, errors: false, network: false });
    expect(diag.fingerprintActive).toBe(false);
  });

  it('stays true across reconfigure() while ANY Runtime-needing feed is still on (console off, errors still on)', async () => {
    const { diag } = setup();
    await diag.start({ console: true, errors: true, network: false });
    await diag.reconfigure({ console: false, errors: true, network: false });
    expect(diag.fingerprintActive).toBe(true);
  });

  it('goes back to false after stop()', async () => {
    const { diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    await diag.stop();
    expect(diag.fingerprintActive).toBe(false);
  });

  it('reports false, not true, when Runtime.enable itself failed to land', async () => {
    const { bridge, diag } = setup();
    bridge.rejectNext('Runtime.enable', new Error('target gone'));
    await diag.start({ console: true, errors: false, network: false });
    expect(diag.fingerprintActive).toBe(false);
  });

  it('survives rebind(): a fresh session re-requests the same feeds and the fingerprint stays true', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    expect(diag.fingerprintActive).toBe(true);
    await diag.rebind(SID_B);
    expect(diag.fingerprintActive).toBe(true);
    expect(
      bridge.sent.filter((s) => s.method === 'Runtime.enable' && s.sessionId === SID_B),
    ).toHaveLength(1);
  });
});

describe('TargetDiagnostics: console coalescing', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(async () => {
    ctx = setup();
    await ctx.diag.start({ console: true, errors: false, network: false });
  });

  it('coalesces identical (level, text) within the 1s window into one emission with count', async () => {
    const { bridge, sink, clock } = ctx;
    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'hi' }] },
      SID,
    );
    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'hi' }] },
      SID,
    );
    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'hi' }] },
      SID,
    );
    expect(sink.console).toHaveLength(0); // not flushed yet
    await clock.advance(1000);
    expect(sink.console).toHaveLength(1);
    expect(sink.console[0]).toMatchObject({ level: 'log', text: 'hi', count: 3 });
  });

  it('does not coalesce different text', async () => {
    const { bridge, sink, clock } = ctx;
    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'one' }] },
      SID,
    );
    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'two' }] },
      SID,
    );
    await clock.advance(1000);
    expect(sink.console).toHaveLength(2);
    expect(sink.console.map((c) => c.count)).toEqual([1, 1]);
  });

  it('maps Runtime.consoleAPICalled "warning" type to wire level "warn"', async () => {
    const { bridge, sink, clock } = ctx;
    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'warning', args: [{ type: 'string', value: 'careful' }] },
      SID,
    );
    await clock.advance(1000);
    expect(sink.console[0]?.level).toBe('warn');
  });

  it('Log.entryAdded also feeds onConsole, mapping "verbose" to "debug"', async () => {
    const { bridge, sink, clock } = ctx;
    bridge.emit('Log.entryAdded', { entry: { level: 'verbose', text: 'browser level line' } }, SID);
    await clock.advance(1000);
    expect(sink.console).toHaveLength(1);
    expect(sink.console[0]).toMatchObject({ level: 'debug', text: 'browser level line', count: 1 });
  });
});

describe('TargetDiagnostics: emission cap', () => {
  it('drops emissions past the per-second cap rather than buffering them', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    // 60 DISTINCT messages so none coalesce; each schedules its own 1s flush timer.
    for (let i = 0; i < 60; i++) {
      bridge.emit(
        'Runtime.consoleAPICalled',
        { type: 'log', args: [{ type: 'string', value: `msg-${i}` }] },
        SID,
      );
    }
    await clock.advance(1000);
    expect(sink.console.length).toBe(50);
  });
});

describe('TargetDiagnostics: page errors', () => {
  it('Runtime.exceptionThrown feeds onPageError, gated on the errors feed', async () => {
    const { bridge, sink, diag } = setup();
    await diag.start({ console: false, errors: true, network: false });
    bridge.emit(
      'Runtime.exceptionThrown',
      {
        exceptionDetails: {
          text: 'Uncaught',
          url: 'https://example.test/app.js',
          exception: { className: 'TypeError', description: 'TypeError: boom' },
          stackTrace: {
            callFrames: [
              {
                functionName: 'f',
                url: 'https://example.test/app.js',
                lineNumber: 9,
                columnNumber: 4,
              },
            ],
          },
        },
      },
      SID,
    );
    expect(sink.pageErrors).toHaveLength(1);
    expect(sink.pageErrors[0]).toMatchObject({
      name: 'TypeError',
      message: 'TypeError: boom',
      url: 'https://example.test/app.js',
    });
    expect(sink.pageErrors[0]?.stack).toContain('at f (https://example.test/app.js:10:5)');
  });

  it('is a no-op when the errors feed is off', async () => {
    const { bridge, sink, diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    bridge.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'boom' } }, SID);
    expect(sink.pageErrors).toHaveLength(0);
  });
});

describe('TargetDiagnostics: network', () => {
  it('a finished request emits network.request and rolls into the next network.summary', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'r1',
        request: { method: 'GET', url: 'https://example.test/a' },
        type: 'Document',
        wallTime: 1000,
        timestamp: 10,
      },
      SID,
    );
    bridge.emit('Network.responseReceived', { requestId: 'r1', response: { status: 200 } }, SID);
    bridge.emit(
      'Network.loadingFinished',
      { requestId: 'r1', timestamp: 10.25, encodedDataLength: 512 },
      SID,
    );

    expect(sink.networkRequests).toHaveLength(1);
    expect(sink.networkRequests[0]).toMatchObject({
      requestId: 'r1',
      method: 'GET',
      url: 'https://example.test/a',
      status: 200,
      errorText: null,
      durationMs: 250,
      encodedBytes: 512,
    });

    // `r1` finishing drops the in-flight count to zero, which triggers an
    // out-of-cycle `network.summary` immediately (see `flushIfNowIdle`'s
    // own doc), so this is already visible without advancing the clock.
    expect(sink.networkSummaries).toHaveLength(1);
    expect(sink.networkSummaries[0]).toMatchObject({
      requests: 1,
      failed: 0,
      bytesIn: 512,
      inFlight: 0,
    });

    // The periodic timer re-arms from that early flush rather than firing
    // again almost immediately: advancing one full window produces one
    // more (now empty) summary, not a second one for the same request.
    await clock.advance(5000);
    expect(sink.networkSummaries).toHaveLength(2);
  });

  it('a failed request emits errorText and counts toward summary.failed', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'r2',
        request: { method: 'GET', url: 'https://example.test/b' },
        type: 'Fetch',
        wallTime: 1000,
        timestamp: 10,
      },
      SID,
    );
    bridge.emit(
      'Network.loadingFailed',
      { requestId: 'r2', timestamp: 10.1, errorText: 'net::ERR_FAILED' },
      SID,
    );

    expect(sink.networkRequests).toHaveLength(1);
    expect(sink.networkRequests[0]).toMatchObject({
      requestId: 'r2',
      errorText: 'net::ERR_FAILED',
      status: null,
    });

    await clock.advance(5000);
    expect(sink.networkSummaries[0]).toMatchObject({ requests: 1, failed: 1 });
  });

  it('is a no-op when the network feed is off', async () => {
    const { bridge, sink, diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    bridge.emit(
      'Network.requestWillBeSent',
      { requestId: 'r3', request: { method: 'GET', url: 'https://x/' }, type: 'Document' },
      SID,
    );
    bridge.emit('Network.loadingFinished', { requestId: 'r3', timestamp: 1 }, SID);
    expect(sink.networkRequests).toHaveLength(0);
  });

  /**
   * Confirmed directly against real Chrome 151.0.7922.174 (see
   * `target-diagnostics.ts`'s `RESPONSE_FALLBACK_MS` doc): a `fetch()`
   * whose caller never reads the response body gets `Network.dataReceived`
   * and `Network.responseReceived` like any other request, but Chrome
   * never sends `Network.loadingFinished` (or `Network.loadingFailed`) for
   * it. Before `RESPONSE_FALLBACK_MS` existed, every one of this describe
   * block's other tests scripted a complete requestWillBeSent -> ...
   * -> loadingFinished/loadingFailed sequence, which is exactly the
   * idealized completion real fire-and-forget fetches never receive; that
   * gap is why the full unit suite passed while `packages/conformance`'s
   * real-Chrome `parallel-diagnostics` suite saw zero network rows on
   * every target. This test scripts the real, incomplete sequence instead.
   */
  it('completes a request from responseReceived alone when no terminal event ever arrives', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'r4',
        request: { method: 'GET', url: 'https://example.test/beacon' },
        type: 'Fetch',
        wallTime: 1000,
        timestamp: 10,
      },
      SID,
    );
    bridge.emit('Network.responseReceived', { requestId: 'r4', response: { status: 200 } }, SID);
    // No Network.loadingFinished, no Network.loadingFailed: exactly what
    // real Chrome sends for an unconsumed fetch() response body.
    expect(sink.networkRequests).toHaveLength(0); // not completed yet

    await clock.advance(1499);
    expect(sink.networkRequests).toHaveLength(0); // fallback not due yet

    await clock.advance(1);
    expect(sink.networkRequests).toHaveLength(1);
    expect(sink.networkRequests[0]).toMatchObject({
      requestId: 'r4',
      url: 'https://example.test/beacon',
      status: 200,
      errorText: null,
      durationMs: null,
      encodedBytes: null,
    });
  });

  it('a 404 response with no terminal event still completes via the fallback, carrying the status', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'r5',
        request: { method: 'GET', url: 'https://example.test/missing' },
        type: 'Fetch',
        wallTime: 1000,
        timestamp: 10,
      },
      SID,
    );
    bridge.emit('Network.responseReceived', { requestId: 'r5', response: { status: 404 } }, SID);
    await clock.advance(1500);

    expect(sink.networkRequests).toHaveLength(1);
    expect(sink.networkRequests[0]).toMatchObject({
      requestId: 'r5',
      status: 404,
      errorText: null,
    });
  });

  it('does not double-emit when loadingFinished arrives before the fallback would fire', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'r6',
        request: { method: 'GET', url: 'https://example.test/c' },
        type: 'Document',
        wallTime: 1000,
        timestamp: 10,
      },
      SID,
    );
    bridge.emit('Network.responseReceived', { requestId: 'r6', response: { status: 200 } }, SID);
    bridge.emit(
      'Network.loadingFinished',
      { requestId: 'r6', timestamp: 10.05, encodedDataLength: 64 },
      SID,
    );
    expect(sink.networkRequests).toHaveLength(1);

    // The armed fallback timer must have been cancelled by loadingFinished;
    // advancing well past RESPONSE_FALLBACK_MS must not produce a second row.
    await clock.advance(5000);
    expect(sink.networkRequests).toHaveLength(1);
  });

  it('does not double-emit when loadingFailed arrives after the fallback already completed the request', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'r7',
        request: { method: 'GET', url: 'https://example.test/d' },
        type: 'Fetch',
        wallTime: 1000,
        timestamp: 10,
      },
      SID,
    );
    bridge.emit('Network.responseReceived', { requestId: 'r7', response: { status: 200 } }, SID);
    await clock.advance(1500);
    expect(sink.networkRequests).toHaveLength(1); // completed by the fallback

    // A late loadingFailed for the same requestId (e.g. the connection
    // dropped after the fallback already gave up waiting) must not add a
    // second, worse row built from an empty pending entry.
    bridge.emit(
      'Network.loadingFailed',
      { requestId: 'r7', timestamp: 11, errorText: 'net::ERR_CONNECTION_RESET' },
      SID,
    );
    expect(sink.networkRequests).toHaveLength(1);
  });

  it('network.summary reports inFlight as the current outstanding count, a gauge rather than a window total', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'a',
        request: { method: 'GET', url: 'https://example.test/a' },
        type: 'Document',
        timestamp: 10,
      },
      SID,
    );
    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'b',
        request: { method: 'GET', url: 'https://example.test/b' },
        type: 'Document',
        timestamp: 10,
      },
      SID,
    );
    bridge.emit('Network.responseReceived', { requestId: 'a', response: { status: 200 } }, SID);
    bridge.emit(
      'Network.loadingFinished',
      { requestId: 'a', timestamp: 10.1, encodedDataLength: 10 },
      SID,
    );

    // 'a' finished but 'b' is still outstanding, so the in-flight count
    // has not reached zero: `flushIfNowIdle()` stays quiet and this reads
    // the next scheduled window instead of an early one.
    await clock.advance(5000);
    expect(sink.networkSummaries).toHaveLength(1);
    expect(sink.networkSummaries[0]).toMatchObject({ requests: 1, inFlight: 1 });
  });

  it('emits an out-of-cycle network.summary the instant the last outstanding request finishes', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'c',
        request: { method: 'GET', url: 'https://example.test/c' },
        type: 'Document',
        timestamp: 10,
      },
      SID,
    );
    bridge.emit('Network.responseReceived', { requestId: 'c', response: { status: 200 } }, SID);
    bridge.emit(
      'Network.loadingFinished',
      { requestId: 'c', timestamp: 10.1, encodedDataLength: 10 },
      SID,
    );

    // No `clock.advance()` at all: this must already have fired, well
    // inside the 5000ms window, because the in-flight count just reached
    // zero. Without it, a `waitForNetworkIdle`-style caller watching this
    // feed would only learn the target went idle on the next scheduled
    // tick, up to NETWORK_SUMMARY_WINDOW_MS (5000ms) late.
    expect(sink.networkSummaries).toHaveLength(1);
    expect(sink.networkSummaries[0]).toMatchObject({ inFlight: 0, requests: 1 });

    // And the periodic timer was re-armed from the moment of that early
    // flush, not left to fire again almost immediately: advancing exactly
    // one more full window produces exactly one more summary, not two.
    await clock.advance(5000);
    expect(sink.networkSummaries).toHaveLength(2);
  });
});

describe('TargetDiagnostics: malformed CDP payloads never throw', () => {
  it('a payload that throws on property access is swallowed by the dispatch guard', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: true, network: true });
    const throwing = new Proxy(
      {},
      {
        get() {
          throw new Error('boom');
        },
      },
    ) as Record<string, unknown>;

    expect(() => bridge.emit('Runtime.consoleAPICalled', throwing, SID)).not.toThrow();
    expect(() => bridge.emit('Log.entryAdded', throwing, SID)).not.toThrow();
    expect(() => bridge.emit('Runtime.exceptionThrown', throwing, SID)).not.toThrow();
    expect(() => bridge.emit('Network.requestWillBeSent', throwing, SID)).not.toThrow();
    expect(() => bridge.emit('Network.loadingFinished', throwing, SID)).not.toThrow();
  });

  it('missing/wrong-typed fields are tolerated, not thrown', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: true, network: true });
    expect(() => bridge.emit('Runtime.consoleAPICalled', {}, SID)).not.toThrow();
    expect(() => bridge.emit('Log.entryAdded', { entry: 'not an object' }, SID)).not.toThrow();
    expect(() =>
      bridge.emit('Runtime.exceptionThrown', { exceptionDetails: 'not an object' }, SID),
    ).not.toThrow();
    expect(() => bridge.emit('Network.responseReceived', { requestId: 42 }, SID)).not.toThrow();
  });
});

describe('TargetDiagnostics: rebind', () => {
  it('re-enables the requested feeds against the new session, and the old session stops delivering while the new one works', async () => {
    const { bridge, sink, clock, diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    expect(bridge.sendCountFor('Runtime.enable')).toBe(1);

    await diag.rebind(SID_B);
    // Domain state lives on the session: re-enabling against the new session id is expected, not a bug.
    expect(
      bridge.sent.filter((s) => s.method === 'Runtime.enable' && s.sessionId === SID_B),
    ).toHaveLength(1);

    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'old session' }] },
      SID,
    );
    bridge.emit(
      'Runtime.consoleAPICalled',
      { type: 'log', args: [{ type: 'string', value: 'new session' }] },
      SID_B,
    );
    await clock.advance(1000);

    expect(sink.console).toHaveLength(1); // only the new session's event survived
    expect(sink.console[0]).toMatchObject({ text: 'new session', count: 1 });
  });

  it('drops in-flight network correlation state on rebind: a request started on the old session never completes', async () => {
    const bridge = new FakeCdpBridge();
    const sink = new RecordingSink();
    const clock = createManualClock();
    const diag = new TargetDiagnostics({
      bridge: asFakeBridge(bridge),
      sessionId: SID,
      targetId: TARGET_ID,
      sink,
      clock,
    });
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'stale',
        request: { method: 'GET', url: 'https://x/' },
        type: 'Document',
        timestamp: 1,
      },
      SID,
    );
    await diag.rebind(SID_B);

    // The old session's Network.loadingFinished for that requestId can no longer reach a live handler.
    bridge.emit(
      'Network.loadingFinished',
      { requestId: 'stale', timestamp: 1.1, encodedDataLength: 1 },
      SID,
    );
    expect(sink.networkRequests).toHaveLength(0);
  });

  /**
   * The failure this test exists to catch: a `waitForNetworkIdle`-style
   * caller (`packages/automation`'s `AutomationClient`) watches
   * `NetworkSummaryPayload.inFlight` and waits for it to reach zero. If a
   * `rebind()` did not clear `pendingRequests`, two requests started on a
   * renderer that no longer exists would sit in that map forever (their
   * terminal events can never arrive, per the sibling test above), so
   * every `network.summary` from then on would report `inFlight: 2`
   * indefinitely and that caller would wait past its own deadline on
   * every single call, on a target that is, in reality, perfectly idle.
   */
  it('resets the published inFlight count to 0 after rebind clears stale pending requests', async () => {
    const bridge = new FakeCdpBridge();
    const sink = new RecordingSink();
    const clock = createManualClock();
    const diag = new TargetDiagnostics({
      bridge: asFakeBridge(bridge),
      sessionId: SID,
      targetId: TARGET_ID,
      sink,
      clock,
    });
    await diag.start({ console: false, errors: false, network: true });

    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'stale-1',
        request: { method: 'GET', url: 'https://x/1' },
        type: 'Document',
        timestamp: 1,
      },
      SID,
    );
    bridge.emit(
      'Network.requestWillBeSent',
      {
        requestId: 'stale-2',
        request: { method: 'GET', url: 'https://x/2' },
        type: 'Document',
        timestamp: 1,
      },
      SID,
    );

    await diag.rebind(SID_B);

    await clock.advance(5000);
    expect(sink.networkSummaries).toHaveLength(1);
    expect(sink.networkSummaries[0]).toMatchObject({ inFlight: 0 });
  });

  it('guards a handler reference captured before rebind: invoking it directly after rebind is a no-op', async () => {
    const bridge = new FakeCdpBridge();
    const sink = new RecordingSink();
    const clock = createManualClock();
    const diag = new TargetDiagnostics({
      bridge: asFakeBridge(bridge),
      sessionId: SID,
      targetId: TARGET_ID,
      sink,
      clock,
    });
    await diag.start({ console: true, errors: false, network: false });

    // Simulate an event that was already in flight (handler reference already
    // read out of the bridge's dispatch table) at the moment rebind() ran.
    const staleHandler = bridge.firstRegistration('Runtime.consoleAPICalled', SID);
    await diag.rebind(SID_B);

    expect(() =>
      staleHandler({ type: 'log', args: [{ type: 'string', value: 'stale' }] }, SID),
    ).not.toThrow();
    expect(sink.console).toHaveLength(0);
  });

  it('is a no-op when rebinding to the session it is already on', async () => {
    const { bridge, diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    const before = bridge.sendCountFor('Runtime.enable');
    await diag.rebind(SID);
    expect(bridge.sendCountFor('Runtime.enable')).toBe(before);
  });
});

describe('TargetDiagnostics: stop', () => {
  it('is idempotent and further start()/reconfigure() calls throw', async () => {
    const { diag } = setup();
    await diag.start({ console: true, errors: false, network: false });
    await diag.stop();
    await expect(diag.stop()).resolves.toBeUndefined();
    await expect(diag.start({ console: true, errors: false, network: false })).rejects.toThrow();
  });
});
