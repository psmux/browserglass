import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TargetStreamSubscriber,
  acquireClient,
  acquireTargetStream,
} from '../src/client-pool.js';
import { type FakeWebSocketHarness, createFakeWebSocketHarness } from './support/fake-websocket.js';
import { answerSubscribeFor, completeHandshake, flushAsync } from './support/fixtures.js';

const URL_A = 'wss://gateway.test/ws';
const TARGET_1 = 'tgt_00000000000000000000000001';
const TARGET_2 = 'tgt_00000000000000000000000002';

let harness: FakeWebSocketHarness;

beforeEach(() => {
  harness = createFakeWebSocketHarness();
  vi.stubGlobal('WebSocket', harness.Impl);
});

function makeSubscriber(): TargetStreamSubscriber & {
  onPrimary: ReturnType<typeof vi.fn>;
  onQueued: ReturnType<typeof vi.fn>;
} {
  return { onPrimary: vi.fn(), onQueued: vi.fn() };
}

describe('acquireClient', () => {
  // Every test here awaits `flushAsync()` once before inspecting
  // `harness.instances`: `BrowserGlassClient.connect()` (called
  // internally by `acquireClient`) does not construct its `WebSocket`
  // synchronously, confirmed directly by observation. It is also what
  // makes this file's own hygiene work: `clientsByKey` in
  // `client-pool.ts` is a module-level singleton, so a test whose
  // assertion throws before it reaches its own `release()` calls leaks a
  // pool entry into every test that runs after it in this same file.
  //
  // `harness.instances` is filtered with `startsWith`, not `===`:
  // `Transport.buildUrl()` always appends at least `?v=1` to the url a
  // client was constructed with (see `./support/fake-websocket.ts`'s own
  // doc comment), so the socket actually opened for `URL_A` is never
  // exactly `URL_A`.
  it('shares one client, and one socket, across two acquisitions with the same url and token', async () => {
    const a = acquireClient(URL_A, 'tok');
    const b = acquireClient(URL_A, 'tok');
    expect(a.client).toBe(b.client);
    await flushAsync();
    expect(harness.instances.filter((i) => i.url.startsWith(URL_A))).toHaveLength(1);
    a.release();
    b.release();
  });

  it('opens a second client and socket for a different token on the same url', async () => {
    const a = acquireClient(URL_A, 'tok-1');
    const b = acquireClient(URL_A, 'tok-2');
    expect(a.client).not.toBe(b.client);
    await flushAsync();
    expect(harness.instances.filter((i) => i.url.startsWith(URL_A))).toHaveLength(2);
    a.release();
    b.release();
  });

  it('does not destroy the shared client while any acquirer still holds it, and does once the last one releases', async () => {
    const a = acquireClient(URL_A, 'tok');
    const b = acquireClient(URL_A, 'tok');
    await flushAsync();
    const destroySpy = vi.spyOn(a.client, 'destroy');
    a.release();
    expect(destroySpy).not.toHaveBeenCalled();
    b.release();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('constructs a fresh client after the previous one for that key was fully released', async () => {
    const a = acquireClient(URL_A, 'tok');
    await flushAsync();
    a.release();
    const b = acquireClient(URL_A, 'tok');
    expect(b.client).not.toBe(a.client);
    await flushAsync();
    b.release();
  });

  it('threads opts.credentials into the constructed client, used by the client itself once its static token expires', async () => {
    const credentials = vi.fn().mockResolvedValue({ token: 'tok-refreshed' });
    const a = acquireClient(URL_A, 'tok-initial', { credentials });
    await flushAsync();
    completeHandshake(harness, URL_A, []);
    await flushAsync();

    harness.latestFor(URL_A).simulateClose(4201, 'token_expired');
    // `immediate` reconnect backoff is 0-150ms; give it real time to fire.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flushAsync();

    expect(credentials).toHaveBeenCalledTimes(1);
    a.release();
  });

  it('only the FIRST acquirer for a (url, token) key supplies credentials: a later acquirer sharing that key cannot add one after construction', async () => {
    const credentials = vi.fn().mockResolvedValue({ token: 'tok-refreshed' });
    // First acquirer supplies nothing.
    const a = acquireClient(URL_A, 'tok-initial');
    // Second acquirer, same (url, token) key, supplies credentials: too
    // late, the client already exists.
    const b = acquireClient(URL_A, 'tok-initial', { credentials });
    expect(a.client).toBe(b.client);
    await flushAsync();
    completeHandshake(harness, URL_A, []);
    await flushAsync();

    harness.latestFor(URL_A).simulateClose(4201, 'token_expired');
    await new Promise((resolve) => setTimeout(resolve, 250));
    await flushAsync();

    // Not called: the shared client was built without a credentials
    // callback, so its own resolveCredential() has nothing to call and
    // goes fatal instead of ever reaching `b`'s.
    expect(credentials).not.toHaveBeenCalled();
    a.release();
    b.release();
  });
});

describe('acquireTargetStream: two different targets on one client', () => {
  it('both become primary independently, with one stream.subscribe each', async () => {
    const { client, release: releaseClient } = acquireClient(URL_A, 'tok');
    await flushAsync();
    completeHandshake(harness, URL_A, [TARGET_1, TARGET_2]);
    await flushAsync();

    const sub1 = makeSubscriber();
    const sub2 = makeSubscriber();
    const s1 = acquireTargetStream(client, TARGET_1, { quality: 'auto' }, sub1);
    const s2 = acquireTargetStream(client, TARGET_2, { quality: 'auto' }, sub2);

    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_1);
    answerSubscribeFor(ws, TARGET_2);
    await flushAsync();

    expect(sub1.onPrimary).toHaveBeenCalledTimes(1);
    expect(sub2.onPrimary).toHaveBeenCalledTimes(1);
    expect(sub1.onQueued).not.toHaveBeenCalled();
    expect(sub2.onQueued).not.toHaveBeenCalled();
    // Distinct handles: neither target's picture is the other's.
    expect(sub1.onPrimary.mock.calls[0]![0].targetId).toBe(TARGET_1);
    expect(sub2.onPrimary.mock.calls[0]![0].targetId).toBe(TARGET_2);

    const subscribeMsgs = ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe');
    expect(subscribeMsgs).toHaveLength(2);

    s1.release();
    s2.release();
    releaseClient();
  });
});

describe('acquireTargetStream: two subscribers on the SAME target', () => {
  it('sends exactly one stream.subscribe, and the second subscriber is queued rather than silently overwriting the first', async () => {
    const { client, release: releaseClient } = acquireClient(URL_A, 'tok');
    await flushAsync();
    completeHandshake(harness, URL_A, [TARGET_1]);
    await flushAsync();

    const primary = makeSubscriber();
    const duplicate = makeSubscriber();
    const s1 = acquireTargetStream(client, TARGET_1, { quality: 'auto' }, primary);
    const s2 = acquireTargetStream(client, TARGET_1, { quality: 'auto' }, duplicate);

    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_1);
    await flushAsync();

    expect(primary.onPrimary).toHaveBeenCalledTimes(1);
    expect(duplicate.onPrimary).not.toHaveBeenCalled();
    expect(duplicate.onQueued).toHaveBeenCalledWith(1);

    // The dedupe hazard this module exists to close: a second subscribe()
    // for a target already subscribed must never reach the wire again.
    expect(
      ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe' && m.targetId === TARGET_1),
    ).toHaveLength(1);

    s1.release();
    s2.release();
    releaseClient();
  });

  it('promotes the queued subscriber when the primary releases, with no second stream.subscribe and no stream.unsubscribe (someone still wants the stream)', async () => {
    const { client, release: releaseClient } = acquireClient(URL_A, 'tok');
    await flushAsync();
    completeHandshake(harness, URL_A, [TARGET_1]);
    await flushAsync();

    const primary = makeSubscriber();
    const duplicate = makeSubscriber();
    const s1 = acquireTargetStream(client, TARGET_1, { quality: 'auto' }, primary);
    const s2 = acquireTargetStream(client, TARGET_1, { quality: 'auto' }, duplicate);

    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_1);
    await flushAsync();

    const primaryHandle = primary.onPrimary.mock.calls[0]![0];

    // The hazard this module exists to close, the other half:
    // `unsubscribe()` is not reference counted on the client itself, so
    // the first subscriber releasing must not tear the stream down out
    // from under the one still queued behind it.
    s1.release();
    expect(ws.sentJsonMessages().some((m) => m.t === 'stream.unsubscribe')).toBe(false);

    expect(duplicate.onPrimary).toHaveBeenCalledTimes(1);
    expect(duplicate.onPrimary.mock.calls[0]![0]).toBe(primaryHandle);

    s2.release();
    // `handlePromise` is already resolved by this point, so the
    // `.then()` `acquireTargetStream`'s `release()` chains its
    // `client.unsubscribe()` call off is a microtask away, not
    // synchronous; one more flush is what actually sends it.
    await flushAsync();
    // Now nobody wants it: this is the point unsubscribe() should fire.
    expect(ws.sentJsonMessages().some((m) => m.t === 'stream.unsubscribe')).toBe(true);

    releaseClient();
  });

  it('sends stream.unsubscribe only after every subscriber of a target has released, not on the first one', async () => {
    const { client, release: releaseClient } = acquireClient(URL_A, 'tok');
    await flushAsync();
    completeHandshake(harness, URL_A, [TARGET_1]);
    await flushAsync();

    const a = makeSubscriber();
    const b = makeSubscriber();
    const sa = acquireTargetStream(client, TARGET_1, { quality: 'auto' }, a);
    const sb = acquireTargetStream(client, TARGET_1, { quality: 'auto' }, b);

    const ws = harness.latestFor(URL_A);
    answerSubscribeFor(ws, TARGET_1);
    await flushAsync();

    sb.release();
    expect(ws.sentJsonMessages().some((m) => m.t === 'stream.unsubscribe')).toBe(false);

    sa.release();
    await flushAsync();
    expect(ws.sentJsonMessages().filter((m) => m.t === 'stream.unsubscribe')).toHaveLength(1);

    releaseClient();
  });
});
