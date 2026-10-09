import { CloseCode, NEVER_RECONNECT_CODES } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FatalInfo } from '../../src/transport/types.js';
import { connectToLive, fixtureWelcome, makeTransport } from './helpers.js';

beforeEach(() => {
  // See transport.test.ts's beforeEach: jsdom's `performance` needs to be named explicitly for
  // Vitest's fake timers to advance it in lockstep with the timer queue.
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the ten permanent close codes', () => {
  // NEVER_RECONNECT_CODES is exactly {4003,4006,4100,4102,4104,4200,4202,4203,4204,4300}: ten codes.
  it('is exactly ten codes', () => {
    expect(NEVER_RECONNECT_CODES.size).toBe(10);
  });

  for (const code of NEVER_RECONNECT_CODES) {
    it(`code ${code} produces fatal and opens no further socket`, async () => {
      const { transport, harness } = makeTransport();
      await connectToLive(transport, harness);
      expect(harness.instances.length).toBe(1);

      let fatal: FatalInfo | null = null;
      transport.on('fatal', (ev) => {
        fatal = ev;
      });

      harness.latest().simulateClose(code, 'test', false);

      expect(transport.state).toBe('fatal');
      expect(fatal).not.toBeNull();
      expect((fatal as unknown as FatalInfo).code).toBe(code);

      // no reconnect attempt follows, even after a generous wait.
      await vi.advanceTimersByTimeAsync(600000);
      expect(harness.instances.length).toBe(1);
    });
  }
});

describe('4201 TokenExpired', () => {
  it('reconnects immediately after calling credentials() again, and does not reuse the expired token', async () => {
    const credentials = vi.fn().mockResolvedValue({ ticket: 'tkt_second' });
    const { transport, harness } = makeTransport({ credentials });
    await connectToLive(transport, harness);
    expect(credentials).not.toHaveBeenCalled(); // the initial connect used options.ticket, not credentials()

    harness.latest().simulateClose(CloseCode.TokenExpired, 'token_expired', false);
    expect(transport.state).toBe('reconnecting');

    // "immediate" schedule: 0 to 150ms, well inside a short generous wait.
    await vi.advanceTimersByTimeAsync(150);
    expect(credentials).toHaveBeenCalledTimes(1);
    expect(harness.instances.length).toBe(2);

    const ws2 = harness.latest();
    expect(ws2.url).toContain('ticket=tkt_second');
    expect(ws2.url).not.toContain('ticket=tkt_initial');
  });
});

describe('4301 ResumeRejected', () => {
  it('reconnects immediately as a fresh connect and discards the resume token', async () => {
    // reconnectPolicy(4301) is {sameToken:true, dropResume:true}: unlike 4201, the transport does not
    // forcibly clear the cached ticket/token credential. `credentials()` is still called on the way back
    // in, because the original ticket was already consumed at the successful upgrade that got this
    // connection to `welcome` in the first place (a ticket is single-use regardless of what closes the
    // socket afterwards) - the same as it would be for any other reconnect. What 4301 specifically buys
    // is the *resume token* being dropped: the next `hello` carries no `resume` field at all.
    const credentials = vi.fn().mockResolvedValue({ ticket: 'tkt_second' });
    const { transport, harness } = makeTransport({ credentials });
    await connectToLive(transport, harness);
    expect(transport.stats().usingResume).toBe(true);

    harness.latest().simulateClose(CloseCode.ResumeRejected, 'resume_rejected', false);
    expect(transport.state).toBe('reconnecting');

    // "immediate" schedule: 0 to 150ms.
    await vi.advanceTimersByTimeAsync(150);
    expect(credentials).toHaveBeenCalledTimes(1);

    const ws2 = harness.latest();
    ws2.simulateOpen();
    const hello2 = ws2.lastSentJson();
    expect(hello2.resume).toBeUndefined();
  });
});

describe('unknown close codes', () => {
  it('reconnects by default, per the band rule', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    harness.latest().simulateClose(4850, 'unknown', false);
    expect(transport.state).toBe('reconnecting');
  });
});

describe('host application close codes (4900 to 4999)', () => {
  it('reconnects when onAppClose returns {reconnect:true}', async () => {
    const onAppClose = vi.fn().mockReturnValue({ reconnect: true });
    const { transport, harness } = makeTransport({ onAppClose });
    await connectToLive(transport, harness);

    harness.latest().simulateClose(4950, 'app_defined', false);
    expect(onAppClose).toHaveBeenCalledTimes(1);
    expect(transport.state).toBe('reconnecting');
  });

  it('is fatal when onAppClose returns nothing (no handler behaves the same way)', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    harness.latest().simulateClose(4950, 'app_defined', false);
    expect(transport.state).toBe('fatal');
  });
});

describe('sameToken:false and dropResume codes clear the right cached credential', () => {
  it('4301 increments resumesRejected', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    harness.latest().simulateClose(CloseCode.ResumeRejected, 'resume_rejected', false);
    expect(transport.stats().resumesRejected).toBe(1);
  });
});

describe('4403 Relocate', () => {
  it('connects to goodbye.redirect.url with the redirect ticket, not the original url or ticket', async () => {
    const { transport, harness } = makeTransport();
    await connectToLive(transport, harness);
    const ws1 = harness.latest();

    ws1.simulateJson({
      v: 1,
      t: 'goodbye',
      ts: Date.now(),
      sq: 2,
      reason: 'relocate',
      code: CloseCode.Relocate,
      message: 'moving to another server',
      reconnect: true,
      redirect: { url: 'wss://other.example.test/browserglass/socket', ticket: 'tkt_redirect' },
    });
    ws1.simulateClose(CloseCode.Relocate, 'relocate', false);

    await vi.advanceTimersByTimeAsync(150);
    const ws2 = harness.latest();
    expect(ws2.url).toContain('other.example.test');
    expect(ws2.url).toContain('ticket=tkt_redirect');
  });
});

describe('resume window versus maxReconnectMs', () => {
  it('usingResume flips false once the resume window elapses, while still retrying up to maxReconnectMs', async () => {
    const credentials = vi.fn().mockResolvedValue({ ticket: 'tkt_retry' });
    const { transport, harness } = makeTransport({
      credentials,
      resumeWindowMs: 1000,
      reconnect: {
        maxReconnectMs: 60000,
        silentAttempts: 0,
        baseDelayMs: 100,
        maxDelayMs: 100,
        jitter: 0,
      },
    });
    await connectToLive(transport, harness);

    let lastReconnecting: { usingResume: boolean } | null = null;
    transport.on('reconnecting', (ev) => {
      lastReconnecting = ev;
    });

    harness.latest().simulateClose(1006, '', false);
    expect((lastReconnecting as unknown as { usingResume: boolean }).usingResume).toBe(true);

    // exhaust the resume window (1000ms) but stay well under maxReconnectMs (60000ms): keep failing.
    for (let i = 0; i < 15; i++) {
      await vi.advanceTimersByTimeAsync(100);
      const ws = harness.latest();
      if (ws.readyState !== 3) ws.simulateClose(1006, '', false);
    }

    expect((lastReconnecting as unknown as { usingResume: boolean }).usingResume).toBe(false);
    expect(transport.state).toBe('reconnecting'); // not fatal: still under maxReconnectMs
  });
});
