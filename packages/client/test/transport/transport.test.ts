import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  connectToLive,
  fixturePong,
  fixtureWelcome,
  flushMicrotasks,
  lastPingCts,
  makeTransport,
  sqCounter,
} from './helpers.js';

beforeEach(() => {
  // `performance.now()` must be included explicitly: jsdom (this package's configured Vitest
  // environment) provides its own `performance`, and Vitest's default fake-timer set does not
  // patch it unless asked, which would otherwise leave `env.ts`'s monotonic clock reading real
  // wall-clock time while every timer runs on the fake one.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('handshake and connect()', () => {
  it('walks idle -> connecting -> handshaking -> live on a plain welcome', async () => {
    const { transport, harness } = makeTransport();
    const states: string[] = [transport.state];
    transport.on('state', (ev) => states.push(ev.to));

    const connectPromise = transport.connect();
    expect(transport.state).toBe('connecting');
    await flushMicrotasks();

    const ws = harness.latest();
    ws.simulateOpen();
    expect(transport.state).toBe('handshaking');

    const hello = ws.lastSentJson();
    expect(hello.t).toBe('hello');
    expect(typeof hello.id).toBe('string');

    ws.simulateJson(fixtureWelcome({}, hello.id as string));
    await connectPromise;

    expect(transport.state).toBe('live');
    expect(states).toEqual(['idle', 'connecting', 'handshaking', 'live']);
  });

  it('sends the ticket as a URL query param and consumes it on open', async () => {
    const { transport, harness } = makeTransport({ ticket: 'tkt_abc123' });
    void transport.connect();
    await flushMicrotasks();
    const ws = harness.latest();
    expect(ws.url).toContain('ticket=tkt_abc123');
    ws.simulateOpen();
    // once consumed, a second connection attempt must not reuse it; verified in the credentials tests below.
  });

  it('folds a token into hello.auth when using mode B', async () => {
    const { transport, harness } = makeTransport({ noDefaultTicket: true, token: 'jwt-token' });
    void transport.connect();
    await flushMicrotasks();
    const ws = harness.latest();
    ws.simulateOpen();
    const hello = ws.lastSentJson();
    expect(hello.auth).toEqual({ scheme: 'bearer', token: 'jwt-token' });
  });

  it('connect() while already connecting returns the same promise (StrictMode double-mount safe)', async () => {
    const { transport } = makeTransport();
    const p1 = transport.connect();
    const p2 = transport.connect();
    expect(p1).toBe(p2);
  });

  it('connect() while already live resolves immediately without a new socket', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    expect(harness.instances.length).toBe(1);
    await expect(transport.connect()).resolves.toBeUndefined();
    expect(harness.instances.length).toBe(1);
  });

  it('rejects connect() when it reaches fatal (no usable credentials)', async () => {
    const { transport } = makeTransport({ noDefaultTicket: true });
    await expect(transport.connect()).rejects.toThrow();
    expect(transport.state).toBe('fatal');
  });

  it('a handshake that never gets a welcome times out and reconnects', async () => {
    const { transport, harness } = makeTransport({ transport: { handshakeTimeoutMs: 1000 } });
    void transport.connect();
    await flushMicrotasks();
    harness.latest().simulateOpen();
    expect(transport.state).toBe('handshaking');
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.state).toBe('reconnecting');
  });
});

/**
 * A bearer token short lived enough to be jti replay checked
 * (`packages/server/src/auth/verify.ts`) is single use: the server's
 * `jtiCache.admit()` accepts it exactly once. `hello` is sent the moment
 * `ws.onopen` fires (before `armHandshakeTimer`'s wait for `welcome` ever
 * resolves), so once the state machine has reached `handshaking`, the
 * server may already have admitted this token's jti even though the
 * client is still waiting and eventually gives up.
 *
 * Reproduces, with fake timers, the failure measured directly against the
 * running demo under several concurrent `AutomationClient.connect()`
 * calls: a handshake timed out, the reconnect it triggered resent the
 * identical bearer token, and the server closed that second attempt with
 * `bgls.error.auth.token_invalid` ("jti ... was already presented and is
 * still within its window") because the FIRST attempt's hello had, in
 * fact, already been admitted. Before the fix, `resolveCredential()`
 * always found `this.token` still set and returned it unchanged, so the
 * reconnect never called `credentials()` at all.
 */
describe('handshake timeout does not resend a possibly-consumed bearer token', () => {
  it('discards the token and calls credentials() for a fresh one once hello has actually been sent', async () => {
    const credentials = vi.fn().mockResolvedValue({ token: 'jwt-fresh' });
    const { transport, harness } = makeTransport({
      noDefaultTicket: true,
      token: 'jwt-stale',
      credentials,
      transport: { handshakeTimeoutMs: 1000 },
    });

    const connectPromise = transport.connect();
    await flushMicrotasks();
    const ws1 = harness.latest();
    ws1.simulateOpen();
    expect(transport.state).toBe('handshaking');
    const hello1 = ws1.lastSentJson();
    expect(hello1.auth).toEqual({ scheme: 'bearer', token: 'jwt-stale' });

    // The welcome never arrives; the handshake timer gives up.
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.state).toBe('reconnecting');
    // credentials() must not have been called yet: the reconnect backoff
    // has not fired, so no new attempt has asked for a credential.
    expect(credentials).not.toHaveBeenCalled();

    // Let the reconnect backoff (a flat ~200-250ms silent retry delay for
    // this early an attempt) fire and the next attempt begin. Advancing
    // much further than that would let the SECOND socket's own handshake
    // timer expire too, since nothing has opened it yet.
    await vi.advanceTimersByTimeAsync(300);
    expect(credentials).toHaveBeenCalledTimes(1); // the stale token alone was no longer usable

    const ws2 = harness.latest();
    expect(harness.instances.length).toBe(2);
    ws2.simulateOpen();
    const hello2 = ws2.lastSentJson();
    // The reconnect used the FRESH token from credentials(), never the stale one.
    expect(hello2.auth).toEqual({ scheme: 'bearer', token: 'jwt-fresh' });

    ws2.simulateJson(fixtureWelcome({}, hello2.id as string));
    await connectPromise;
    expect(transport.state).toBe('live');
  });

  it('with no credentials() to fall back on, fails cleanly instead of resending the token that timed out', async () => {
    const { transport, harness } = makeTransport({
      noDefaultTicket: true,
      token: 'jwt-stale',
      transport: { handshakeTimeoutMs: 1000 },
    });

    const connectPromise = transport.connect();
    const rejection = connectPromise.catch((err: unknown) => err);
    await flushMicrotasks();
    const ws1 = harness.latest();
    ws1.simulateOpen();
    expect(transport.state).toBe('handshaking');

    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(300);

    // No second socket was ever opened with the stale token: the missing
    // credential surfaces as an honest failure instead.
    expect(transport.state).toBe('fatal');
    const err = await rejection;
    expect(String((err as Error).message)).toMatch(/no credentials available/);
  });
});

describe('sq gap detection', () => {
  it('a synthesised sq gap closes 1002 and reconnects with resume', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws = harness.latest();

    let disconnected: { code: number } | null = null;
    transport.on('disconnected', (ev) => {
      disconnected = ev;
    });

    // welcome carried sq:1; jumping straight to sq:5 is a gap.
    ws.simulateJson({ v: 1, t: 'target.listed', ts: Date.now(), sq: 5, targets: [] });

    expect(ws.closeCalls[ws.closeCalls.length - 1]).toEqual({ code: 1002, reason: 'sq_gap' });
    // the fake's close() synchronously fires onclose, driving the normal (transient, same-token) reconnect path.
    expect(transport.state).toBe('reconnecting');
    expect(disconnected).not.toBeNull();
    expect((disconnected as unknown as { code: number }).code).toBe(1002);
  });
});

describe('the 4200 ticket_consumed exception', () => {
  it('retries exactly once, silently, without touching the state machine, then succeeds', async () => {
    const credentials = vi.fn().mockResolvedValue({ ticket: 'tkt_fresh' });
    const { transport, harness } = makeTransport({ credentials });

    const stateEvents: string[] = [];
    transport.on('state', (ev) => stateEvents.push(`${ev.from}->${ev.to}`));

    const connectPromise = transport.connect();
    await flushMicrotasks();
    const ws1 = harness.latest();
    ws1.simulateOpen();
    expect(transport.state).toBe('handshaking');

    ws1.simulateJson({
      v: 1,
      t: 'error',
      ts: Date.now(),
      sq: 1,
      code: 'bgls.error.auth.ticket_consumed',
      category: 'auth',
      message: 'ticket already used',
      fatal: true,
      retryable: false,
    });
    ws1.simulateClose(4200, 'invalid_auth', false);

    // no state transition happened: still handshaking the whole time.
    expect(transport.state).toBe('handshaking');
    expect(stateEvents).toEqual(['idle->connecting', 'connecting->handshaking']);

    await flushMicrotasks(); // flush the silent retry's credentials() await
    expect(credentials).toHaveBeenCalledTimes(1);
    expect(harness.instances.length).toBe(2); // the silent retry opened a second socket

    const ws2 = harness.latest();
    ws2.simulateOpen();
    const hello2 = ws2.lastSentJson();
    expect(hello2.subscribe).toBeUndefined();
    ws2.simulateJson(fixtureWelcome({}, hello2.id as string));
    await connectPromise;

    expect(transport.state).toBe('live');
  });

  it('a second ticket_consumed close on the same instance is fatal', async () => {
    const credentials = vi.fn().mockResolvedValue({ ticket: 'tkt_fresh' });
    const { transport, harness } = makeTransport({ credentials });

    const connectPromise = transport.connect();
    // the eventual fatal rejects this promise; catch it here so it never surfaces as an unhandled
    // rejection regardless of exactly when, relative to the assertions below, it settles.
    const rejection = connectPromise.catch((err: unknown) => err);
    await flushMicrotasks();
    const ws1 = harness.latest();
    ws1.simulateOpen();
    ws1.simulateJson({
      v: 1,
      t: 'error',
      ts: Date.now(),
      sq: 1,
      code: 'bgls.error.auth.ticket_consumed',
      category: 'auth',
      message: 'm',
      fatal: true,
      retryable: false,
    });
    ws1.simulateClose(4200, 'invalid_auth', false);
    await flushMicrotasks();

    const ws2 = harness.latest();
    ws2.simulateOpen();
    ws2.simulateJson({
      v: 1,
      t: 'error',
      ts: Date.now(),
      sq: 1,
      code: 'bgls.error.auth.ticket_consumed',
      category: 'auth',
      message: 'm',
      fatal: true,
      retryable: false,
    });
    ws2.simulateClose(4200, 'invalid_auth', false);

    expect(transport.state).toBe('fatal');
    await expect(rejection).resolves.toBeInstanceOf(Error);
  });
});

describe('resume', () => {
  it('welcome.resumed:true enters resuming; the first binary frame promotes it to live', async () => {
    const { transport, harness } = makeTransport();
    const connectPromise = transport.connect();
    await flushMicrotasks();
    const ws = harness.latest();
    ws.simulateOpen();
    const hello = ws.lastSentJson();
    ws.simulateJson(fixtureWelcome({ resumed: true }, hello.id as string));
    await connectPromise;
    expect(transport.state).toBe('resuming');

    ws.simulateBinary(new Uint8Array(20));
    expect(transport.state).toBe('live');
  });

  it('welcome.resumed:true enters resuming; a 2000ms timeout promotes it to live with no frame', async () => {
    const { transport, harness } = makeTransport();
    const connectPromise = transport.connect();
    await flushMicrotasks();
    const ws = harness.latest();
    ws.simulateOpen();
    const hello = ws.lastSentJson();
    ws.simulateJson(fixtureWelcome({ resumed: true }, hello.id as string));
    await connectPromise;
    expect(transport.state).toBe('resuming');

    await vi.advanceTimersByTimeAsync(2000);
    expect(transport.state).toBe('live');
  });

  it('folds a live ResumeRecord into hello.resume on the next connection attempt', async () => {
    // a ticket is single-use, consumed at the upgrade that reached `welcome`; every reconnect after
    // that, transient or not, needs a fresh one from credentials() the same way 4201's case does.
    const credentials = vi.fn().mockResolvedValue({ ticket: 'tkt_second' });
    const { transport, harness } = makeTransport({ credentials });
    await connectToLive(transport, harness);

    // a transient close should trigger a reconnect that requests resume.
    harness.latest().simulateClose(1006, '', false);
    expect(transport.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10000); // clear every backoff attempt scheduled so far

    const ws2 = harness.latest();
    ws2.simulateOpen();
    const hello2 = ws2.lastSentJson();
    expect(hello2.resume).toMatchObject({
      token: 'rsm_initial',
      sessionId: 'sess_0000000000000000000000001',
    });
  });

  it('emits the resumed event with leaseRestored from the server', async () => {
    const { transport, harness } = makeTransport();
    const connectPromise = transport.connect();
    await flushMicrotasks();
    const ws = harness.latest();
    ws.simulateOpen();
    const hello = ws.lastSentJson();
    ws.simulateJson(fixtureWelcome({ resumed: true }, hello.id as string));
    await connectPromise;

    let resumedEvent: { leaseRestored: boolean } | null = null;
    transport.on('resumed', (ev) => {
      resumedEvent = ev;
    });
    ws.simulateJson({
      v: 1,
      t: 'resumed',
      ts: Date.now(),
      sq: 2,
      sessionId: 'sess_0000000000000000000000001',
      viewerId: 'vwr_00000000000000000000000001',
      streams: [],
      lease: null,
      leaseRestored: false,
      missedControl: 0,
      targets: [],
      resume: { token: 'rsm_initial', windowMs: 120000, issuedAt: Date.now() },
    });
    expect(resumedEvent).not.toBeNull();
    expect((resumedEvent as unknown as { leaseRestored: boolean }).leaseRestored).toBe(false);
  });
});

describe('keepalive', () => {
  it('sends an application ping immediately on reaching live, then every pingIntervalMs', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws = harness.latest();

    expect(ws.sentJsonMessages().filter((m) => m.t === 'ping').length).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ws.sentJsonMessages().filter((m) => m.t === 'ping').length).toBe(2);
  });

  it('degrades only once BOTH pong and frame have been silent for healthTimeoutMs, reporting whichever crossed last', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws = harness.latest();
    const sq = sqCounter(1);

    let degraded: { reason: string } | null = null;
    transport.on('degraded', (ev) => {
      degraded = ev;
    });

    // reset the pong watchdog 1s in; the frame watchdog is untouched since start().
    await vi.advanceTimersByTimeAsync(1000);
    ws.simulateJson(fixturePong(lastPingCts(ws), sq()));
    expect(degraded).toBeNull();

    // t=5000 total: the frame watchdog (armed at t=0) fires. Still not degraded: pong watchdog isn't due until t=6000.
    await vi.advanceTimersByTimeAsync(4000);
    expect(transport.state).toBe('live');
    expect(degraded).toBeNull();

    // t=6000 total: the pong watchdog (armed at t=1000) fires too. Now both are stale: degrade, reason 'no-pong'.
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.state).toBe('degraded');
    expect(degraded).not.toBeNull();
    expect((degraded as unknown as { reason: string }).reason).toBe('no-pong');
  });

  it('a pong recovers from degraded', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws = harness.latest();
    const sq = sqCounter(1);

    await vi.advanceTimersByTimeAsync(5000); // both watchdogs silent since start(): degraded
    expect(transport.state).toBe('degraded');

    ws.simulateJson(fixturePong(lastPingCts(ws), sq()));
    expect(transport.state).toBe('live');
  });

  it('a binary frame recovers from degraded', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws = harness.latest();

    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.state).toBe('degraded');

    ws.simulateBinary(new Uint8Array(20));
    expect(transport.state).toBe('live');
  });

  it('a control-channel message recovers from degraded even though it does not reset the watchdogs', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws = harness.latest();
    const sq = sqCounter(1);

    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.state).toBe('degraded');

    ws.simulateJson({ v: 1, t: 'presence.state', ts: Date.now(), sq: sq(), viewers: [] });
    expect(transport.state).toBe('live');
  });
});

describe('disconnect() and destroy()', () => {
  it('disconnect() closes 1000 and does not reconnect', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws = harness.latest();

    await transport.disconnect();
    expect(ws.closeCalls[ws.closeCalls.length - 1]).toMatchObject({ code: 1000 });
    expect(transport.state).toBe('idle');

    await vi.advanceTimersByTimeAsync(60000);
    expect(harness.instances.length).toBe(1); // no reconnect attempt was made
  });

  it('destroy() tears down and further events never fire', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);

    const fn = vi.fn();
    transport.on('state', fn);
    transport.destroy();
    expect(fn).not.toHaveBeenCalled();

    // a stray close on the now-detached socket must not resurrect anything.
    harness.latest().simulateClose(1006, '', false);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('send()', () => {
  it('throws when not connected', () => {
    const { transport } = makeTransport();
    expect(() => transport.send({ v: 1, t: 'ping', ts: Date.now() })).toThrow();
  });

  it('sends once live', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    transport.send({ v: 1, t: 'target.list', ts: Date.now() });
    const ws = harness.latest();
    expect(ws.sentJsonMessages().some((m) => m.t === 'target.list')).toBe(true);
  });
});
