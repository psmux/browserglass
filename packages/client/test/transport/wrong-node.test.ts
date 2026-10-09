import { CloseCode } from '@browserglass/protocol';
/**
 * `Transport.goFatal()` used to reject `connect()` with a bare
 * `new Error(message)`, discarding the wire `error` envelope's `code`/
 * `category`/`context` even though `closeInfo.error` (and the `'fatal'`
 * event built from it) already carried the real `ErrorMsg`. That mattered
 * least for most fatal closes, where the close code alone says enough, but
 * it mattered a lot for `bgls.error.instance.wrong_node`
 * (`packages/server/src/ws/connection.ts`'s `processHello`, sent when this
 * gateway is not the node driving the instance): the one piece of useful
 * information, `context.nodeId`, lived only on the message the rejection
 * threw away, forcing a caller to abandon `await client.connect()` and go
 * listen for the separate `'fatal'` event instead just to read it.
 *
 * `goFatal` now rejects with `BrowserGlassError.fromErrorMsg(error)` when a
 * real wire error preceded the close, so `context.nodeId` is available
 * directly off the `connect()` rejection. This test proves that for the
 * cross-node case specifically, matching `packages/server/test/ws/attach-wrong-node.test.ts`'s
 * server-side half of the same fix.
 */
import { describe, expect, it, vi } from 'vitest';
import { BrowserGlassError } from '../../src/client/errors.js';
import { flushMicrotasks, makeTransport } from './helpers.js';

describe('connect() rejects with the wire error, not a bare Error', () => {
  it('bgls.error.instance.wrong_node: rejection carries code and context.nodeId', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    });
    try {
      const { transport, harness } = makeTransport();
      const connectPromise = transport.connect();
      await flushMicrotasks();
      const ws = harness.latest();
      ws.simulateOpen();

      // Mirrors `sendErrorAndClose()`: an `error` envelope, then the
      // socket closes with a permanent code (`processHello`'s real reply
      // also sends `goodbye` in between, irrelevant to this test).
      ws.simulateJson({
        v: 1,
        t: 'error',
        ts: Date.now(),
        sq: 1,
        code: 'bgls.error.instance.wrong_node',
        category: 'instance',
        message: 'instance inst_x is driven by node nod_other, not this gateway',
        fatal: true,
        retryable: false,
        context: { nodeId: 'nod_other' },
      });
      ws.simulateClose(CloseCode.PolicyViolation, 'policy_violation', false);

      await expect(connectPromise).rejects.toBeInstanceOf(BrowserGlassError);
      await connectPromise.catch((err: BrowserGlassError) => {
        expect(err.code).toBe('bgls.error.instance.wrong_node');
        expect(err.context).toEqual({ nodeId: 'nod_other' });
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
