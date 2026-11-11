import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectToLive, makeTransport } from './helpers.js';

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const helloToken = (msg: Record<string, unknown>) => (msg['auth'] as { token?: string } | undefined)?.token;

describe('a token from credentials() is presented once', () => {
  it('asks credentials() again after a dropped socket instead of presenting the same token twice', async () => {
    const credentials = vi.fn().mockResolvedValueOnce({ token: 'tok_1' }).mockResolvedValueOnce({ token: 'tok_2' });
    const { transport, harness } = makeTransport({ noDefaultTicket: true, credentials });
    await connectToLive(transport, harness);
    expect(credentials).toHaveBeenCalledTimes(1);
    expect(helloToken(harness.latest().sentJsonMessages().find((m) => m['t'] === 'hello') ?? {})).toBe('tok_1');

    harness.latest().simulateClose(1006, 'dropped', false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(credentials).toHaveBeenCalledTimes(2);
    const ws2 = harness.latest();
    ws2.simulateOpen();
    expect(helloToken(ws2.lastSentJson())).toBe('tok_2');
  });

  it('keeps a token given in options.token for reconnects, without calling credentials()', async () => {
    const credentials = vi.fn().mockResolvedValue({ token: 'tok_cb' });
    const { transport, harness } = makeTransport({ noDefaultTicket: true, token: 'tok_opt', credentials });
    await connectToLive(transport, harness);
    harness.latest().simulateClose(1006, 'dropped', false);
    await vi.advanceTimersByTimeAsync(30_000);
    const ws2 = harness.latest();
    ws2.simulateOpen();
    expect(helloToken(ws2.lastSentJson())).toBe('tok_opt');
    expect(credentials).not.toHaveBeenCalled();
  });
});
