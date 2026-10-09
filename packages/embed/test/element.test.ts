import { MsgType, PayloadCodec, encodeBinaryHeader } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../src/index.js';
import { BrowserGlassElement } from '../src/index.js';
import { type FakeWebSocketHarness, createFakeWebSocketHarness } from './support/fake-websocket.js';
import { answerSubscribeFor, completeHandshake, flushAsync } from './support/fixtures.js';

const URL_A = 'wss://gateway.test/ws';
const TARGET_1 = 'tgt_00000000000000000000000001';
const TARGET_2 = 'tgt_00000000000000000000000002';

let harness: FakeWebSocketHarness;
const mounted: HTMLElement[] = [];

beforeEach(() => {
  harness = createFakeWebSocketHarness();
  vi.stubGlobal('WebSocket', harness.Impl);
});

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

/** Creates a `<browser-glass>`, sets its attributes, and appends it to `document.body`, tracked for automatic removal in `afterEach`. */
function mount(attrs: Record<string, string>): BrowserGlassElement {
  const el = document.createElement('browser-glass');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

/** Drives one element through connect + subscribe to becoming the live primary for `targetId`, and returns the socket it connected on. */
async function bringToPrimary(
  el: BrowserGlassElement,
  targetIds: string[],
  targetId: string,
): Promise<void> {
  await flushAsync();
  completeHandshake(harness, URL_A, targetIds);
  await flushAsync();
  const ws = harness.latestFor(URL_A);
  answerSubscribeFor(ws, targetId);
  await flushAsync();
}

describe('registration', () => {
  it('registers <browser-glass> in customElements, exactly once', () => {
    expect(customElements.get('browser-glass')).toBe(BrowserGlassElement);
  });

  it('document.createElement("browser-glass") yields a BrowserGlassElement with a closed-off shadow root', () => {
    const el = document.createElement('browser-glass');
    expect(el).toBeInstanceOf(BrowserGlassElement);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot?.mode).toBe('open');
    expect(el.shadowRoot?.querySelector('canvas')).not.toBeNull();
  });
});

describe('attribute handling', () => {
  it('reports a missing-url error and does nothing else when "url" is absent', async () => {
    // Listener attached before the element is appended: `connectedCallback`
    // fires synchronously from `appendChild`, and so does the error event
    // it leads to, so a listener added afterwards would simply miss it.
    const handler = vi.fn();
    const el = document.createElement('browser-glass');
    el.setAttribute('target-id', TARGET_1);
    el.addEventListener('bgls:error', handler);
    document.body.appendChild(el);
    mounted.push(el);
    await flushAsync();
    expect(el.getAttribute('error')).toBe('missing-url');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]![0].detail.code).toBe('missing-url');
    expect(harness.instances).toHaveLength(0);
  });

  it('reports a missing-target-id error when "target-id" is absent', async () => {
    const el = mount({ url: URL_A });
    await flushAsync();
    expect(el.getAttribute('error')).toBe('missing-target-id');
  });

  it('connects, subscribes, and becomes primary once url, token, and target-id are all present', async () => {
    const connectedHandler = vi.fn();
    const el = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    el.addEventListener('bgls:connected', connectedHandler);
    await bringToPrimary(el, [TARGET_1], TARGET_1);

    expect(connectedHandler).toHaveBeenCalledTimes(1);
    expect(el.isPrimary).toBe(true);
    expect(el.getAttribute('state')).toBe('live');
    expect(el.hasAttribute('error')).toBe(false);
  });

  it('connects cleanly when url, token, and target-id are set as three separate attribute calls on an already-connected element (the pattern examples/embed-demo/index.html actually uses)', async () => {
    const errorHandler = vi.fn();
    const el = mount({});
    el.addEventListener('bgls:error', errorHandler);
    // Exactly what a host page's own "Connect" button does: the element
    // is already in the DOM, empty, and the three identity attributes
    // arrive back to back in one synchronous burst.
    el.setAttribute('url', URL_A);
    el.setAttribute('token', 'tok');
    el.setAttribute('target-id', TARGET_1);
    await bringToPrimary(el, [TARGET_1], TARGET_1);

    expect(el.isPrimary).toBe(true);
    expect(el.hasAttribute('error')).toBe(false);
    // No transient "missing-target-id" (or any other) error along the way:
    // the three attribute changes are coalesced into one reaction.
    expect(errorHandler).not.toHaveBeenCalled();
  });

  it('rebuilds against the new target when target-id changes after connecting', async () => {
    const el = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    await bringToPrimary(el, [TARGET_1, TARGET_2], TARGET_1);
    expect(el.isPrimary).toBe(true);

    el.setAttribute('target-id', TARGET_2);
    await flushAsync();
    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_2);
    await flushAsync();

    expect(el.isPrimary).toBe(true);
    expect(el.client?.streams.find((s) => s.targetId === TARGET_2)).toBeDefined();
  });
});

describe('teardown on disconnect', () => {
  it('releases the client (and closes its socket) when the only element using it disconnects', async () => {
    const el = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    await bringToPrimary(el, [TARGET_1], TARGET_1);
    const destroySpy = vi.spyOn(el.client!, 'destroy');

    el.remove();
    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(el.client).toBeNull();
    expect(el.getAttribute('state')).toBeNull();
  });

  it('does not destroy a client still shared by another element still connected', async () => {
    const elA = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    await bringToPrimary(elA, [TARGET_1, TARGET_2], TARGET_1);
    const client = elA.client!;

    const elB = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_2 });
    await flushAsync();
    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_2);
    await flushAsync();
    expect(elB.client).toBe(client);

    const destroySpy = vi.spyOn(client, 'destroy');
    elA.remove();
    expect(destroySpy).not.toHaveBeenCalled();

    elB.remove();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('does not throw when an element that never finished connecting is removed', async () => {
    const el = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    await flushAsync(); // socket opening, no welcome yet
    expect(() => el.remove()).not.toThrow();
  });
});

describe('two elements on different targets do not interfere', () => {
  it('both become primary, each with its own stream, sharing one socket', async () => {
    const elA = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    const elB = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_2 });
    await flushAsync();
    completeHandshake(harness, URL_A, [TARGET_1, TARGET_2]);
    await flushAsync();
    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_1);
    answerSubscribeFor(ws, TARGET_2);
    await flushAsync();

    expect(elA.isPrimary).toBe(true);
    expect(elB.isPrimary).toBe(true);
    expect(elA.hasAttribute('error')).toBe(false);
    expect(elB.hasAttribute('error')).toBe(false);
    expect(elA.client).toBe(elB.client);
    expect(harness.instances.filter((i) => i.url.startsWith(URL_A))).toHaveLength(1);

    // Driving one must not touch the other: navigating A's target sends a
    // `nav.goto` naming only A's target.
    void elA.navigate('https://a.example/');
    const navMsg = ws.sentJsonMessages().findLast((m) => m.t === 'nav.goto');
    expect(navMsg?.targetId).toBe(TARGET_1);
  });
});

describe('two elements on the SAME target', () => {
  it('the second is refused (queued) rather than silently stealing the canvas, and says so loudly', async () => {
    const elPrimary = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    const elDuplicate = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    const errorHandler = vi.fn();
    elDuplicate.addEventListener('bgls:error', errorHandler);

    await flushAsync();
    completeHandshake(harness, URL_A, [TARGET_1]);
    await flushAsync();
    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_1);
    await flushAsync();

    expect(elPrimary.isPrimary).toBe(true);
    expect(elDuplicate.isPrimary).toBe(false);
    expect(elDuplicate.getAttribute('error')).toBe('duplicate-target');
    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0]![0].detail.code).toBe('duplicate-target');

    // Only one wire subscription for the one target both elements name.
    expect(
      ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe' && m.targetId === TARGET_1),
    ).toHaveLength(1);

    // The queued element cannot be driven until it owns the view.
    await expect(elDuplicate.clickAt(1, 1)).rejects.toThrow(/does not currently own the live view/);
  });

  it('promotes the queued element automatically when the primary disconnects', async () => {
    const elPrimary = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    const elDuplicate = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1 });
    await flushAsync();
    completeHandshake(harness, URL_A, [TARGET_1]);
    await flushAsync();
    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_1);
    await flushAsync();

    expect(elDuplicate.isPrimary).toBe(false);

    elPrimary.remove();
    await flushAsync();

    expect(elDuplicate.isPrimary).toBe(true);
    expect(elDuplicate.hasAttribute('error')).toBe(false);
    // Still no second stream.subscribe: the promoted element reuses the
    // wire subscription that was kept alive for it the whole time.
    expect(
      ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe' && m.targetId === TARGET_1),
    ).toHaveLength(1);
  });
});

describe('readonly', () => {
  it('blocks clickAt/type/takeControl even once primary', async () => {
    const el = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1, readonly: '' });
    await bringToPrimary(el, [TARGET_1], TARGET_1);
    expect(el.isPrimary).toBe(true);

    await expect(el.clickAt(1, 1)).rejects.toThrow(/readonly/);
    await expect(el.type('hi')).rejects.toThrow(/readonly/);
    await expect(el.takeControl()).rejects.toThrow(/readonly/);
  });

  it('still allows navigate/reload/screenshot while readonly', async () => {
    const el = mount({ url: URL_A, token: 'tok', 'target-id': TARGET_1, readonly: '' });
    await bringToPrimary(el, [TARGET_1], TARGET_1);

    const navPromise = el.navigate('https://example.com/');
    const ws = harness.latestFor(URL_A);
    const navMsg = ws.sentJsonMessages().findLast((m) => m.t === 'nav.goto');
    expect(navMsg).toBeDefined();
    ws.simulateJson({
      v: 1,
      t: 'nav.state',
      re: navMsg!.id,
      ts: Date.now(),
      targetId: TARGET_1,
      url: 'https://example.com/',
      title: '',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      securityState: 'secure',
    });
    await expect(navPromise).resolves.toBeDefined();
  });
});

describe('token refresh', () => {
  // A bearer token is capped at 900 seconds regardless of what was
  // requested (`docs/protocol/wire-spec.md`); the wire's own signal for
  // "that token is now dead" is close code 4201 (`TokenExpired`), whose
  // `reconnectPolicy` (`packages/protocol/src/wire/close-codes.ts`) sets
  // `sameToken: false` so the transport discards the expired token and
  // calls `options.credentials()` for a replacement before reconnecting.
  // These probes drive that exact close code and prove the element
  // reconnects and keeps streaming rather than dying or looping on the
  // dead token.
  const TOKEN_CLOSE = 4201;

  /** Real reconnect backoff for a `TokenExpired` close is 0-150ms, jittered (`immediate` schedule); `flushAsync`'s bare 0ms tick is not enough to let that timer fire. */
  async function waitForReconnectTimer(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flushAsync();
  }

  it('el.onTokenExpired supplies a fresh token, and the element keeps streaming across the swap', async () => {
    const el = mount({ url: URL_A, token: 'tok-old', 'target-id': TARGET_1 });
    const onTokenExpired = vi.fn(async () => 'tok-new');
    el.onTokenExpired = onTokenExpired;
    await bringToPrimary(el, [TARGET_1], TARGET_1);
    expect(el.getAttribute('state')).toBe('live');

    const firstWs = harness.latestFor(URL_A);
    firstWs.simulateClose(TOKEN_CLOSE, 'token_expired');
    await waitForReconnectTimer();

    expect(onTokenExpired).toHaveBeenCalledTimes(1);
    // A new socket, not a retry of the old one with the same dead token.
    const secondWs = harness.latest();
    expect(secondWs).not.toBe(firstWs);
    // A reconnect this fast lands well inside the resume window, so the
    // server (simulated here) resumes the same session rather than
    // starting fresh: the whole point of "keeps streaming" is that the
    // element never tears down `#handle`/`#isPrimary` across a
    // reconnect (nothing in `element.ts` does, by design; only a full
    // `target-id` or `token` ATTRIBUTE change rebuilds), so a resumed
    // reconnect needs no new `stream.subscribe` at all to keep painting.
    completeHandshake(harness, URL_A, [TARGET_1], { resumed: true });
    const secondHello = secondWs.sentJsonMessages().find((m) => m.t === 'hello');
    expect(secondHello?.['auth']).toEqual({ scheme: 'bearer', token: 'tok-new' });
    await flushAsync();
    expect(el.getAttribute('state')).toBe('resuming');

    // The first binary frame on the resumed session promotes it the rest
    // of the way to `live` (`packages/client/src/transport/transport.ts`'s
    // `promoteResumingToLive('first_frame')`); this is the actual proof
    // that frames are flowing again on the SAME subscription, not merely
    // that the socket reopened. A real, validly-encoded header (not just
    // 20 zero bytes): `BrowserGlassClient.handleBinaryFrame` decodes it
    // for real before the transport ever gets to promote the state, and
    // a bad-magic decode failure would throw synchronously instead.
    secondWs.simulateBinary(
      encodeBinaryHeader({
        version: 1,
        msgType: MsgType.FRAME,
        streamId: 999999,
        seq: 1,
        tsDeltaMs: 0,
        payloadCodec: PayloadCodec.JPEG,
        flags: 0,
        gen16: 1,
      }),
    );
    await flushAsync();

    expect(el.isPrimary).toBe(true);
    expect(el.getAttribute('state')).toBe('live');
    expect(el.hasAttribute('error')).toBe(false);
    // No fresh stream.subscribe: the existing subscription, and the
    // canvas already attached to it, carried straight through the
    // token swap and the reconnect.
    expect(secondWs.sentJsonMessages().some((m) => m.t === 'stream.subscribe')).toBe(false);
  });

  it('the token-endpoint attribute is fetched for a fresh token when onTokenExpired is not set', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'tok-from-endpoint' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const el = mount({
      url: URL_A,
      token: 'tok-old',
      'target-id': TARGET_1,
      'token-endpoint': 'https://app.example.com/api/browserglass-token',
    });
    await bringToPrimary(el, [TARGET_1], TARGET_1);

    const firstWs = harness.latestFor(URL_A);
    firstWs.simulateClose(TOKEN_CLOSE, 'token_expired');
    await waitForReconnectTimer();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://app.example.com/api/browserglass-token',
      expect.objectContaining({ credentials: 'include' }),
    );
    const secondWs = harness.latest();
    expect(secondWs).not.toBe(firstWs);
    completeHandshake(harness, URL_A, [TARGET_1]);
    const hello = secondWs.sentJsonMessages().find((m) => m.t === 'hello');
    expect(hello?.['auth']).toEqual({ scheme: 'bearer', token: 'tok-from-endpoint' });

    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', harness.Impl);
  });

  it('onTokenExpired takes precedence over token-endpoint when both are set', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'from-endpoint' }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const el = mount({
      url: URL_A,
      token: 'tok-old',
      'target-id': TARGET_1,
      'token-endpoint': 'https://app.example.com/api/browserglass-token',
    });
    el.onTokenExpired = async () => 'tok-from-property';
    await bringToPrimary(el, [TARGET_1], TARGET_1);

    const firstWs = harness.latestFor(URL_A);
    firstWs.simulateClose(TOKEN_CLOSE, 'token_expired');
    await waitForReconnectTimer();

    expect(fetchMock).not.toHaveBeenCalled();
    const secondWs = harness.latest();
    completeHandshake(harness, URL_A, [TARGET_1]);
    const hello = secondWs.sentJsonMessages().find((m) => m.t === 'hello');
    expect(hello?.['auth']).toEqual({ scheme: 'bearer', token: 'tok-from-property' });

    vi.unstubAllGlobals();
    vi.stubGlobal('WebSocket', harness.Impl);
  });

  it('with neither onTokenExpired nor token-endpoint configured, an expired token goes fatal with a clear message instead of retrying the dead token forever', async () => {
    const el = mount({ url: URL_A, token: 'tok-old', 'target-id': TARGET_1 });
    const errorHandler = vi.fn();
    el.addEventListener('bgls:error', errorHandler);
    await bringToPrimary(el, [TARGET_1], TARGET_1);

    const firstWs = harness.latestFor(URL_A);
    firstWs.simulateClose(TOKEN_CLOSE, 'token_expired');
    await waitForReconnectTimer();

    expect(el.getAttribute('state')).toBe('fatal');
    expect(el.getAttribute('error')).toBe('connection-fatal');
    const call = errorHandler.mock.calls.find((c) => c[0].detail.code === 'connection-fatal');
    expect(call?.[0].detail.message).toMatch(/onTokenExpired|token-endpoint/);
    // No second socket opened to retry the dead token with.
    expect(harness.instances.filter((i) => i.url.startsWith(URL_A))).toHaveLength(1);
  });

  it('setting a fresh "token" attribute at runtime rebuilds against a new pooled client, never reusing the one still keyed to the dead token', async () => {
    const el = mount({ url: URL_A, token: 'tok-old', 'target-id': TARGET_1 });
    await bringToPrimary(el, [TARGET_1], TARGET_1);
    const firstClient = el.client;
    const firstWs = harness.latestFor(URL_A);

    el.setAttribute('token', 'tok-fresh');
    await flushAsync();

    expect(el.client).not.toBe(firstClient);
    const secondWs = harness.latest();
    expect(secondWs).not.toBe(firstWs);
    completeHandshake(harness, URL_A, [TARGET_1]);
    const hello = secondWs.sentJsonMessages().find((m) => m.t === 'hello');
    expect(hello?.['auth']).toEqual({ scheme: 'bearer', token: 'tok-fresh' });
    await flushAsync();
    answerSubscribeFor(secondWs, TARGET_1);
    await flushAsync();
    expect(el.isPrimary).toBe(true);
  });
});
