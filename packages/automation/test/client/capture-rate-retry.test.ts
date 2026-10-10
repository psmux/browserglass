import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationError } from '../../src/errors.js';
import { connectFakeClient, tick } from '../helpers.js';

/**
 * `screenshot()` and `pdf()` retry once when the gateway refuses them with
 * `bgls.error.limit.rate`, after the reply's own `retryAfterMs`. One retry
 * only, and only for a short wait, so a caller genuinely over the limit
 * still gets the `POLICY_DENIED`.
 */
describe('AutomationClient: capture rate limit retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('screenshot() waits retryAfterMs and retries once after a rate limit refusal', async () => {
    const { client, gateway } = await connectFakeClient();
    gateway.captureRateLimitedReplies = 1;
    gateway.captureRetryAfterMs = 200;

    const shotPromise = client.screenshot();
    await tick();
    expect(gateway.captureCalls).toHaveLength(1);
    // Not resent before the hinted wait has passed.
    await vi.advanceTimersByTimeAsync(150);
    expect(gateway.captureCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60);
    await tick();
    const shot = await shotPromise;
    expect(shot.data).toBe('ZmFrZQ==');
    expect(gateway.captureCalls).toHaveLength(2);
    client.close();
  });

  it('a second refusal surfaces POLICY_DENIED carrying retryAfterMs', async () => {
    const { client, gateway } = await connectFakeClient();
    gateway.captureRateLimitedReplies = 2;
    gateway.captureRetryAfterMs = 100;

    const shotPromise = client.screenshot();
    const settled = shotPromise.catch((e: unknown) => e);
    await tick();
    await vi.advanceTimersByTimeAsync(150);
    await tick();
    const err = await settled;
    expect(err).toBeInstanceOf(AutomationError);
    expect((err as AutomationError).code).toBe('POLICY_DENIED');
    expect((err as AutomationError).details?.['retryAfterMs']).toBe(100);
    expect(gateway.captureCalls).toHaveLength(2);
    client.close();
  });

  it('does not wait when the hinted delay is unreasonably long', async () => {
    const { client, gateway } = await connectFakeClient();
    gateway.captureRateLimitedReplies = 1;
    gateway.captureRetryAfterMs = 60_000;

    const settled = client.screenshot().catch((e: unknown) => e);
    await tick();
    const err = await settled;
    expect((err as AutomationError).code).toBe('POLICY_DENIED');
    expect(gateway.captureCalls).toHaveLength(1);
    client.close();
  });

  it('pdf() retries once too', async () => {
    const { client, gateway } = await connectFakeClient();
    let refusals = 1;
    gateway.pdfResponder = (msg) =>
      refusals-- > 0
        ? {
            t: 'error',
            code: 'bgls.error.limit.rate',
            category: 'limit',
            message: 'Rate limit exceeded for page.pdf.get.',
            fatal: false,
            retryable: true,
            retryAfterMs: 50,
          }
        : {
            t: 'page.pdf.got',
            pdfId: 'pdf_ok',
            targetId: msg['targetId'],
            sizeBytes: 4,
            gen: 1,
            data: 'ZmFrZQ==',
          };

    const pdfPromise = client.pdf();
    await tick();
    await vi.advanceTimersByTimeAsync(60);
    await tick();
    const result = await pdfPromise;
    expect(result.pdfId).toBe('pdf_ok');
    expect(gateway.pdfCalls).toHaveLength(2);
    client.close();
  });
});
