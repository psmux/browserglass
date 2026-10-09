import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * `page.evaluate` end to end, over a real socket, through the real
 * handshake, the real capability check, the real `ManagedSession` and a
 * real (fake) Chrome endpoint.
 *
 * Page evaluation is the largest privilege this protocol grants, so the
 * bulk of this file is REFUSALS. A happy-path-only suite for this feature
 * would prove the least interesting thing about it: what matters is that a
 * caller without the capability is refused, that a caller with it cannot
 * use it to reach a target outside its own session, that `userGesture`
 * costs an extra capability, that a page throwing is data rather than a
 * crash, and that an unbounded result is refused rather than shipped.
 */
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

function hello(): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
  };
}

/** The harness's usual default caps; deliberately WITHOUT `evaluate`, so a test has to ask for it explicitly to get it. */
const DEFAULT_CAPS = ['view', 'control', 'navigate', 'tabs.manage', 'capture', 'probe', 'admin'];

/**
 * Every socket {@link connectViewer} opens, closed by {@link withGateway}'s
 * `finally` rather than at the end of each test body.
 *
 * A failed assertion mid-test would otherwise leave the socket open, and
 * `gw.close()` waits for its viewers, so a one-line assertion failure came
 * back as an opaque five second suite timeout with the real reason nowhere
 * on screen. Found exactly that way while writing the scoping test below.
 */
const OPEN_SOCKETS: WebSocket[] = [];

async function connectViewer(
  gw: TestGateway,
  caps: string[],
  opts?: { readonly declareViewOnly?: boolean },
): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken({ caps });
  const ws = gw.connect();
  OPEN_SOCKETS.push(ws);
  await waitOpen(ws);
  const h = hello();
  if (opts?.declareViewOnly) {
    h['capabilities'] = { codecs: ['jpeg'], binaryFrames: true, input: [] };
  }
  ws.send(JSON.stringify({ ...h, auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessageSkipping(ws, UNSOLICITED);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

/**
 * Starts a gateway with one page target, runs `fn`, and always tears both
 * down. Every socket this suite opens is tracked and closed in the
 * `finally`, not at the end of each test body: a failed assertion would
 * otherwise leave the socket open and `gw.close()` would wait for it,
 * turning a one-line assertion failure into an opaque suite timeout. Found
 * exactly that way.
 */
async function withGateway(fn: (gw: TestGateway) => Promise<void>): Promise<void> {
  const gw = await startTestGateway();
  gw.addTarget({
    targetId: 'cdp-a',
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
    windowId: 1,
  });
  OPEN_SOCKETS.length = 0;
  try {
    await fn(gw);
  } finally {
    for (const ws of OPEN_SOCKETS) ws.close();
    OPEN_SOCKETS.length = 0;
    await gw.close();
  }
}

/** Sends `page.evaluate` and returns the correlated reply, whatever its type. */
async function evaluate(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendAndAwait(ws, 'page.evaluate', payload);
}

/** `page.evaluate.internal`'s counterpart to {@link evaluate}: the SDK-internal locator-bookkeeping message, never sent by a real caller directly but exercised here at the wire level like any other message type. */
async function evaluateInternal(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendAndAwait(ws, 'page.evaluate.internal', payload);
}

async function sendAndAwait(
  ws: WebSocket,
  t: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `e${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ v: 1, t, id, ts: Date.now(), ...payload }));
  for (;;) {
    const msg = await nextMessageSkipping(ws, UNSOLICITED);
    if (msg['re'] === id) return msg;
  }
}

describe('page.evaluate: the capability is real and is not implied', () => {
  it('refuses a caller holding view, control, navigate, capture, probe and admin but not evaluate', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const reply = await evaluate(ws, { targetId, expression: '1 + 1' });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('evaluate');
    });
  });

  it('refuses a caller holding devtools and automation, the two capabilities most likely to be mistaken for implying it', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools', 'automation']);
      const reply = await evaluate(ws, { targetId, expression: '1 + 1' });
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('evaluate');
    });
  });

  it('refuses a caller holding cdp: the raw passthrough capability is a sibling, not a superset', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'cdp']);
      const reply = await evaluate(ws, { targetId, expression: '1 + 1' });
      expect(reply['code']).toBe('bgls.error.cap.missing');
    });
  });

  it('admits a caller that lists evaluate explicitly', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 2 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: '1 + 1' });
      expect(reply['t']).toBe('page.evaluated');
      expect(reply['ok']).toBe(true);
      expect(reply['resultType']).toBe('value');
      expect(reply['value']).toBe(2);
    });
  });
});

describe('page.evaluate: userGesture costs control on top of evaluate', () => {
  it('refuses userGesture:true from an evaluate-only caller, naming control', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: '1', userGesture: true });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('control');
    });
  });

  it('allows the same caller without userGesture, so the extra cost is paid only when the flag is set', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 1 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: '1' });
      expect(reply['t']).toBe('page.evaluated');
    });
  });

  it('allows userGesture:true once control is also held, and forwards the flag to Chrome', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 1 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate', 'control']);
      const reply = await evaluate(ws, { targetId, expression: '1', userGesture: true });
      expect(reply['t']).toBe('page.evaluated');
      expect(gw.chrome.runtimeEvaluateCalls.at(-1)?.params['userGesture']).toBe(true);
    });
  });
});

describe('page.evaluate: a view-only connection does not get script execution', () => {
  it('withholds evaluate from a connection that declared an empty input[], even when the token carries it', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate'], {
        declareViewOnly: true,
      });
      const reply = await evaluate(ws, { targetId, expression: '1' });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      // "I will send no input" and "I may run arbitrary script in the page"
      // cannot both be true of one connection.
      expect(gw.chrome.runtimeEvaluateCalls).toHaveLength(0);
    });
  });
});

describe('page.evaluate: scoping', () => {
  it('refuses a target id this session does not hold, rather than reaching for it', async () => {
    await withGateway(async (gw) => {
      const { ws } = await connectViewer(gw, ['view', 'evaluate']);
      // A well-formed BrowserGlass target id that belongs to no target in
      // this session's registry: exactly what a caller guessing at another
      // tenant's ids would send.
      const reply = await evaluate(ws, {
        targetId: 'tgt_01JXXXXXXXXXXXXXXXXXXXXXXX',
        expression: '1',
      });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.target.not_found');
      // Nothing reached Chrome at all: the refusal happened at the registry
      // lookup, before any CDP command was composed.
      expect(gw.chrome.runtimeEvaluateCalls).toHaveLength(0);
    });
  });

  it('always attaches a page session id to the CDP command, never evaluating browser-wide', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 1 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      await evaluate(ws, { targetId, expression: '1' });
      const call = gw.chrome.runtimeEvaluateCalls.at(-1);
      // A session-less `Runtime.evaluate` runs against the BROWSER target.
      // This is the assertion that says that never happens.
      expect(call?.sessionId).toBeTruthy();
      // And the caller never got to choose an execution context.
      expect(call?.params).not.toHaveProperty('contextId');
      expect(call?.params).not.toHaveProperty('uniqueContextId');
      expect(call?.params['returnByValue']).toBe(true);
    });
  });
});

describe('page.evaluate: results', () => {
  it('returns undefined distinctly from null', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);

      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'undefined' } }));
      const undef = await evaluate(ws, { targetId, expression: 'void 0' });
      expect(undef['resultType']).toBe('undefined');
      expect(undef).not.toHaveProperty('value');

      gw.chrome.setRuntimeEvaluate(() => ({
        result: { type: 'object', subtype: 'null', value: null },
      }));
      const nul = await evaluate(ws, { targetId, expression: 'null' });
      expect(nul['resultType']).toBe('value');
      expect(nul['value']).toBe(null);
    });
  });

  it('describes a non-serialisable result and never puts an objectId on the wire', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({
        result: {
          type: 'object',
          subtype: 'node',
          className: 'HTMLBodyElement',
          description: 'body',
          objectId: '{"injectedScriptId":1,"id":3}',
        },
      }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: 'document.body' });
      expect(reply['ok']).toBe(true);
      expect(reply['resultType']).toBe('unserializable');
      expect(reply['description']).toBe('body');
      expect(JSON.stringify(reply)).not.toContain('injectedScriptId');
    });
  });

  it('reports a JSON-inexpressible primitive as its source text', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({
        result: { type: 'number', unserializableValue: 'NaN' },
      }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: '0/0' });
      expect(reply['resultType']).toBe('unserializable');
      expect(reply['unserializableValue']).toBe('NaN');
    });
  });

  it('refuses a result over the byte ceiling instead of truncating it onto the wire', async () => {
    await withGateway(async (gw) => {
      // Over MAX_EVALUATE_RESULT_BYTES (1 MiB).
      gw.chrome.setRuntimeEvaluate(() => ({
        result: { type: 'string', value: 'x'.repeat(1_100_000) },
      }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, {
        targetId,
        expression: 'document.documentElement.outerHTML',
      });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.evaluate.result_too_large');
      const context = reply['context'] as { sizeBytes: number; maxBytes: number };
      expect(context.sizeBytes).toBeGreaterThan(context.maxBytes);
      // A truncated copy would be worse than a refusal: it parses, and it
      // is wrong. Nothing of the value travels.
      expect(JSON.stringify(reply)).not.toContain('xxxxxxxxxx');
    });
  });
});

describe('page.evaluate: a page-side throw is data, not a wire error', () => {
  it('answers page.evaluated with ok:false and the page own message, name and position', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({
        exceptionDetails: {
          text: 'Uncaught',
          lineNumber: 0,
          columnNumber: 6,
          exception: {
            type: 'object',
            className: 'TypeError',
            description:
              "TypeError: Cannot read properties of null (reading 'value')\n    at <anonymous>:1:7",
          },
        },
      }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: 'x.value' });
      // Not an `error` envelope. A caller must be able to tell "your script
      // threw" apart from "the wire failed", and this is how.
      expect(reply['t']).toBe('page.evaluated');
      expect(reply['ok']).toBe(false);
      const ex = reply['exception'] as {
        message: string;
        name: string;
        stack: string;
        lineNumber: number;
      };
      expect(ex.name).toBe('TypeError');
      expect(ex.message).toContain('Cannot read properties of null');
      expect(ex.stack).toContain('at <anonymous>');
      expect(ex.lineNumber).toBe(1);
    });
  });

  it('reports a rejected promise the same way, since awaitPromise defaults on', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate((params) => {
        expect(params['awaitPromise']).toBe(true);
        return {
          exceptionDetails: {
            text: 'Uncaught (in promise)',
            exception: { type: 'object', className: 'Error', description: 'Error: fetch failed' },
          },
        };
      });
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: 'await fetch("/x")' });
      expect(reply['t']).toBe('page.evaluated');
      expect(reply['ok']).toBe(false);
      expect((reply['exception'] as { message: string }).message).toContain('fetch failed');
    });
  });
});

describe('page.evaluate: request validation', () => {
  it('refuses both expression and functionDeclaration rather than picking one', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, {
        targetId,
        expression: '1',
        functionDeclaration: '() => 2',
      });
      expect(reply['code']).toBe('bgls.error.evaluate.invalid_request');
      expect(gw.chrome.runtimeEvaluateCalls).toHaveLength(0);
    });
  });

  it('refuses neither', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId });
      expect(reply['code']).toBe('bgls.error.evaluate.invalid_request');
    });
  });

  it('refuses a source over the byte ceiling, and says by how much', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, { targetId, expression: `"${'a'.repeat(40000)}"` });
      expect(reply['code']).toBe('bgls.error.evaluate.invalid_request');
      const context = reply['context'] as { sizeBytes: number; maxBytes: number };
      expect(context.sizeBytes).toBeGreaterThan(context.maxBytes);
      expect(gw.chrome.runtimeEvaluateCalls).toHaveLength(0);
    });
  });

  it('refuses more args than the ceiling allows', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, {
        targetId,
        functionDeclaration: '(...a) => a.length',
        args: Array.from({ length: 32 }, (_, i) => i),
      });
      expect(reply['code']).toBe('bgls.error.evaluate.invalid_request');
    });
  });

  it('refuses a non-positive or non-numeric timeoutMs but clamps an over-large one', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 1 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);

      expect((await evaluate(ws, { targetId, expression: '1', timeoutMs: 0 }))['code']).toBe(
        'bgls.error.evaluate.invalid_request',
      );
      expect((await evaluate(ws, { targetId, expression: '1', timeoutMs: 'soon' }))['code']).toBe(
        'bgls.error.evaluate.invalid_request',
      );

      // Optimistic, not dangerous: answered with the maximum rather than
      // refused.
      const clamped = await evaluate(ws, { targetId, expression: '1', timeoutMs: 999_999_999 });
      expect(clamped['t']).toBe('page.evaluated');
      expect(gw.chrome.runtimeEvaluateCalls.at(-1)?.params['timeout']).toBe(120000);
    });
  });

  it('passes a function declaration and its args through as one composed expression', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'string', value: 'ab' } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluate(ws, {
        targetId,
        functionDeclaration: '(a, b) => a + b',
        args: ['a', 'b'],
      });
      expect(reply['value']).toBe('ab');
      expect(gw.chrome.runtimeEvaluateCalls.at(-1)?.params['expression']).toBe(
        '((a, b) => a + b).call(globalThis, "a", "b")',
      );
    });
  });
});

/**
 * `page.evaluate.internal`: the SDK-internal counterpart used by the
 * locator surface's own resolve/verify bookkeeping
 * (`@browserglass/protocol`'s `PageEvaluateInternal`).
 *
 * Same capability, same execution path, same scoping as `page.evaluate`
 * (asserted below): this message widens no privilege. What it changes is
 * which rate-limit bucket a call spends from, which is what the last
 * suite here proves end to end.
 */
describe('page.evaluate.internal: same capability and execution path as page.evaluate', () => {
  it('requires evaluate, exactly like page.evaluate', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const reply = await evaluateInternal(ws, { targetId, functionDeclaration: '() => 1' });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('evaluate');
    });
  });

  it('admits a caller that lists evaluate, and runs the functionDeclaration through the same CDP path', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 2 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluateInternal(ws, { targetId, functionDeclaration: '() => 1 + 1' });
      expect(reply['t']).toBe('page.evaluated');
      expect(reply['ok']).toBe(true);
      expect(reply['value']).toBe(2);
    });
  });

  it('has no expression field: sending one is refused as invalid_request rather than silently accepted', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluateInternal(ws, { targetId, expression: '1 + 1' });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.evaluate.invalid_request');
      expect(gw.chrome.runtimeEvaluateCalls).toHaveLength(0);
    });
  });

  it('refuses a target id this session does not hold, the same scoping page.evaluate enforces', async () => {
    await withGateway(async (gw) => {
      const { ws } = await connectViewer(gw, ['view', 'evaluate']);
      const reply = await evaluateInternal(ws, {
        targetId: 'tgt_not_mine',
        functionDeclaration: '() => 1',
      });
      expect(reply['code']).toBe('bgls.error.target.not_found');
    });
  });
});

/**
 * Sends `count` copies of `t` back to back, WITHOUT awaiting each reply in
 * turn, then collects all `count` replies (matched by their own `id`,
 * order not assumed). Pipelined rather than one-at-a-time
 * (`await evaluate(...)` in a loop) because a real round trip takes real
 * wall-clock time, and both buckets under test refill continuously
 * (`perSecond`, not just `burst`): a loop that awaits each reply before
 * sending the next spends enough real time per iteration that the bucket
 * partially refills between sends, so a boundary asserted against the
 * exact `burst` count is flaky by construction, found exactly that way
 * (`EVALUATE_BUCKET_DEFAULT`'s 30/sec was enough refill, across 60 awaited
 * round trips, for the 61st call to be let through unexpectedly). Sending
 * everything up front keeps the elapsed time between the first send and
 * the last at parse-and-dispatch cost only, not round-trip cost, which is
 * what makes asserting against `burst` meaningful again.
 */
async function floodAndCollect(
  ws: WebSocket,
  t: string,
  payload: Record<string, unknown>,
  count: number,
): Promise<Record<string, unknown>[]> {
  const ids = Array.from(
    { length: count },
    (_, i) => `flood${i}_${Math.random().toString(36).slice(2)}`,
  );
  for (const id of ids) {
    ws.send(JSON.stringify({ v: 1, t, id, ts: Date.now(), ...payload }));
  }
  const byId = new Map<string, Record<string, unknown>>();
  const pending = new Set(ids);
  while (pending.size > 0) {
    const msg = await nextMessageSkipping(ws, UNSOLICITED);
    const re = msg['re'];
    if (typeof re === 'string' && pending.has(re)) {
      byId.set(re, msg);
      pending.delete(re);
    }
  }
  return ids.map((id) => byId.get(id)!);
}

/**
 * The whole point of the split: SDK-internal locator bookkeeping must not
 * be able to exhaust a caller's own `page.evaluate` allowance, and a
 * caller's own evaluate flood must still be limited.
 *
 * `EVALUATE_BUCKET_DEFAULT` (`wire/rate-limit.ts`) is 30/sec, burst 60;
 * `INTERNAL_EVALUATE_BUCKET_DEFAULT` is 15/sec, burst 15. Before the
 * split, `page.evaluate.internal`'s traffic went out as `page.evaluate`
 * and drew from the exact same bucket, so draining it with `page.evaluate`
 * calls would ALSO have refused the next `page.evaluate.internal` call.
 * This suite proves that no longer holds.
 */
/**
 * Mirrors `EVALUATE_BUCKET_DEFAULT` in `src/wire/rate-limit.ts`, which is
 * module private and deliberately stays that way: it is an internal
 * tuning constant, not part of any contract worth exporting for a test.
 * Kept here so the flood assertion below can compute how much the bucket
 * refills while the flood is in flight. If the source values change and
 * these do not, the assertion goes slack rather than wrong, and the
 * neighbouring "does NOT refuse internal" test still fails loudly.
 */
const EVALUATE_PER_SECOND = 30;
const EVALUATE_BURST = 60;

describe('page.evaluate vs page.evaluate.internal: independent rate-limit budgets, end to end', () => {
  it('a caller-originated evaluate flood is still limited: well over the burst on one target gets some replies refused', async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 1 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);

      const startedAt = Date.now();
      const replies = await floodAndCollect(
        ws,
        'page.evaluate',
        { targetId, expression: '1' },
        120,
      );
      const elapsedMs = Date.now() - startedAt;
      const refused = replies.filter((r) => r['code'] === 'bgls.error.limit.rate');
      const ok = replies.filter((r) => r['t'] === 'page.evaluated');

      // 120 requests against a burst of 60: the overflow must be refused,
      // and every refused reply must be the rate-limit error specifically
      // rather than some other failure.
      //
      // The ceiling is burst PLUS whatever refilled while the flood was in
      // flight, which is the part this assertion used to ignore. The bucket
      // is 30 per second, so it hands out one more token every 33ms. In
      // isolation the whole flood lands inside one interval and exactly 60
      // are admitted. Under a full suite, with every vitest worker
      // competing for the CPU, a single token refills mid-flood, 61 are
      // admitted, 59 are refused, and a bare `>= 120 - 60` fails by one.
      // That is the limiter behaving correctly and the test being wrong, so
      // the allowance is computed from the elapsed time rather than the
      // number being nudged until it stops failing.
      const admittedCeiling = EVALUATE_BURST + Math.ceil((elapsedMs / 1000) * EVALUATE_PER_SECOND);
      expect(ok.length).toBeLessThanOrEqual(admittedCeiling);
      expect(refused.length).toBeGreaterThanOrEqual(120 - admittedCeiling);
      // Still has to prove the limiter did something: a ceiling that had
      // grown to cover all 120 would make the assertion above vacuous.
      expect(refused.length).toBeGreaterThan(0);
      expect(ok.length + refused.length).toBe(120);
      for (const r of refused) expect(r['t']).toBe('error');
    });
  });

  it("draining a target's page.evaluate budget with a flood does NOT refuse page.evaluate.internal on the same target (the regression this split fixes)", async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 1 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);

      const replies = await floodAndCollect(
        ws,
        'page.evaluate',
        { targetId, expression: '1' },
        120,
      );
      expect(replies.some((r) => r['code'] === 'bgls.error.limit.rate')).toBe(true);

      // Before the split, this next call shared the exact same bucket and
      // would have been refused too: "an agent's fill()/click() calls
      // start failing right after its own explicit evaluate() calls did",
      // the exact failure the split exists to prevent.
      const internalReply = await evaluateInternal(ws, {
        targetId,
        functionDeclaration: '() => 1',
      });
      expect(internalReply['t']).toBe('page.evaluated');
    });
  });

  it("conversely, flooding evaluateInternal (locator bookkeeping) does not refuse the caller's own page.evaluate", async () => {
    await withGateway(async (gw) => {
      gw.chrome.setRuntimeEvaluate(() => ({ result: { type: 'number', value: 1 } }));
      const { ws, targetId } = await connectViewer(gw, ['view', 'evaluate']);

      const replies = await floodAndCollect(
        ws,
        'page.evaluate.internal',
        { targetId, functionDeclaration: '() => 1' },
        60,
      );
      // 60 requests against evaluateInternal's own burst of 15: most must
      // be refused, and refusing them must not have touched Chrome.
      expect(
        replies.filter((r) => r['code'] === 'bgls.error.limit.rate').length,
      ).toBeGreaterThanOrEqual(60 - 15);

      const callerReply = await evaluate(ws, { targetId, expression: '1' });
      expect(callerReply['t']).toBe('page.evaluated');
    });
  });
});
