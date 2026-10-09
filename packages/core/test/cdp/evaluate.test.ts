/**
 * `evaluateInSession` (`src/cdp/evaluate.ts`): the CDP half of page
 * evaluation.
 *
 * These tests are deliberately weighted towards the REFUSALS and the odd
 * results rather than the happy path. The happy path of "run an expression,
 * get a number back" is one assertion; what actually decides whether this
 * surface is safe and usable is what comes back for a live object, a
 * thrown Error, a rejected promise, a value nobody can afford to send, and
 * a socket that died mid-call, because each of those is a case where a
 * plausible implementation crashes, hangs, or quietly hands out a handle
 * into the page.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import { CdpError } from '../../src/cdp/errors.js';
import { evaluateInSession } from '../../src/cdp/evaluate.js';
import type { CdpSessionId } from '../../src/cdp/types.js';

const SESSION = 'S_page_1' as CdpSessionId;

/** A `CdpBridge` stub whose `send` returns whatever the test scripted, recording the params it was called with. */
function bridgeReturning(result: unknown): { bridge: CdpBridge; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => result);
  return { bridge: { send } as unknown as CdpBridge, send };
}

function bridgeThrowing(err: unknown): { bridge: CdpBridge; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn(async () => {
    throw err;
  });
  return { bridge: { send } as unknown as CdpBridge, send };
}

const BASE = { timeoutMs: 5000, maxResultBytes: 1024 } as const;

describe('evaluateInSession: the CDP params it sends', () => {
  it('always sends Runtime.evaluate with returnByValue, on the given session, and never a context selector', async () => {
    const { bridge, send } = bridgeReturning({ result: { type: 'number', value: 42 } });
    await evaluateInSession(bridge, SESSION, { expression: '40 + 2', ...BASE });

    expect(send).toHaveBeenCalledTimes(1);
    const [method, params, sessionId] = send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      CdpSessionId,
    ];
    expect(method).toBe('Runtime.evaluate');
    // The session id is always attached. A session-less `Runtime.evaluate`
    // runs against the BROWSER target, which is escalation path 4 in
    // `PageEvaluate`'s module doc.
    expect(sessionId).toBe(SESSION);
    // `returnByValue` is what stops Chrome handing back an `objectId`, the
    // live handle escalation path 5 refuses.
    expect(params['returnByValue']).toBe(true);
    // No way to name another execution context.
    expect(params).not.toHaveProperty('contextId');
    expect(params).not.toHaveProperty('uniqueContextId');
    expect(params).not.toHaveProperty('objectId');
    // Exactly one CDP method is ever sent. This is not a `Runtime` domain
    // passthrough.
    expect(send.mock.calls.every((c) => c[0] === 'Runtime.evaluate')).toBe(true);
  });

  it('defaults awaitPromise to true, unlike raw CDP, and honours an explicit false', async () => {
    const { bridge, send } = bridgeReturning({ result: { type: 'number', value: 1 } });
    await evaluateInSession(bridge, SESSION, { expression: '1', ...BASE });
    expect((send.mock.calls[0] as [string, Record<string, unknown>])[1]['awaitPromise']).toBe(true);

    const second = bridgeReturning({ result: { type: 'number', value: 1 } });
    await evaluateInSession(second.bridge, SESSION, {
      expression: '1',
      awaitPromise: false,
      ...BASE,
    });
    expect(
      (second.send.mock.calls[0] as [string, Record<string, unknown>])[1]['awaitPromise'],
    ).toBe(false);
  });

  it('arms the in-page timeout at timeoutMs and the socket timeout strictly above it', async () => {
    const { bridge, send } = bridgeReturning({ result: { type: 'number', value: 1 } });
    await evaluateInSession(bridge, SESSION, {
      expression: '1',
      timeoutMs: 5000,
      maxResultBytes: 1024,
    });
    const [, params, , opts] = send.mock.calls[0] as [
      string,
      Record<string, unknown>,
      CdpSessionId,
      { timeoutMs: number },
    ];
    // V8 terminates the script at this deadline. Without it, `while (true) {}`
    // pins a renderer thread forever no matter what the socket does.
    expect(params['timeout']).toBe(5000);
    // The socket deadline is the backstop for an endpoint that ignores the
    // experimental `timeout` param, so it must be later, never equal.
    expect(opts.timeoutMs).toBeGreaterThan(5000);
  });

  it('composes functionDeclaration and JSON args into one expression rather than a second round trip', async () => {
    const { bridge, send } = bridgeReturning({ result: { type: 'string', value: 'hi' } });
    await evaluateInSession(bridge, SESSION, {
      functionDeclaration: '(a, b) => a + b',
      args: ['h', { nested: [1, 2] }],
      ...BASE,
    });
    expect(send).toHaveBeenCalledTimes(1);
    const expression = (send.mock.calls[0] as [string, Record<string, unknown>])[1][
      'expression'
    ] as string;
    expect(expression).toBe('((a, b) => a + b).call(globalThis, "h", {"nested":[1,2]})');
  });

  it('composes a zero-argument function without a stray comma', async () => {
    const { bridge, send } = bridgeReturning({ result: { type: 'number', value: 1 } });
    await evaluateInSession(bridge, SESSION, { functionDeclaration: '() => 1', ...BASE });
    expect((send.mock.calls[0] as [string, Record<string, unknown>])[1]['expression']).toBe(
      '(() => 1).call(globalThis)',
    );
  });

  it('escapes U+2028 and U+2029 inside a string argument', async () => {
    const SEP = '\u2028';
    const PARA = '\u2029';
    const { bridge, send } = bridgeReturning({ result: { type: 'number', value: 1 } });
    await evaluateInSession(bridge, SESSION, {
      functionDeclaration: '(s) => s.length',
      args: [`a${SEP}b${PARA}c`],
      ...BASE,
    });
    const expression = (send.mock.calls[0] as [string, Record<string, unknown>])[1][
      'expression'
    ] as string;
    // The raw characters must not survive into the composed source: both
    // are legal inside a JSON string and were illegal inside a JavaScript
    // string literal before ES2019.
    expect(expression.includes(SEP)).toBe(false);
    expect(expression.includes(PARA)).toBe(false);
    expect(expression).toContain('\\u2028');
    expect(expression).toContain('\\u2029');
  });
});

describe('evaluateInSession: outcomes', () => {
  it('returns a JSON value with its measured byte size', async () => {
    const { bridge } = bridgeReturning({ result: { type: 'object', value: { a: 1, b: 'two' } } });
    const outcome = await evaluateInSession(bridge, SESSION, { expression: 'x', ...BASE });
    // `{"a":1,"b":"two"}` is 17 UTF-8 bytes.
    expect(outcome).toEqual({ kind: 'value', value: { a: 1, b: 'two' }, sizeBytes: 17 });
  });

  it('measures multi-byte and astral characters as UTF-8 bytes, not UTF-16 units', async () => {
    // One 2-byte char, one 3-byte char, one 4-byte astral char (a
    // surrogate pair in UTF-16), plus the two JSON quotes: 2 + 3 + 4 + 2.
    const text = '\u00e9\u4e2d\u{1f600}';
    const { bridge } = bridgeReturning({ result: { type: 'string', value: text } });
    const outcome = await evaluateInSession(bridge, SESSION, { expression: 'x', ...BASE });
    expect(outcome).toEqual({ kind: 'value', value: text, sizeBytes: 11 });
  });

  it('keeps undefined distinct from null', async () => {
    const undef = bridgeReturning({ result: { type: 'undefined' } });
    expect(
      await evaluateInSession(undef.bridge, SESSION, { expression: 'void 0', ...BASE }),
    ).toEqual({
      kind: 'undefined',
    });

    const nul = bridgeReturning({ result: { type: 'object', subtype: 'null', value: null } });
    expect(await evaluateInSession(nul.bridge, SESSION, { expression: 'null', ...BASE })).toEqual({
      kind: 'value',
      value: null,
      sizeBytes: 4,
    });
  });

  it('reports a JSON-inexpressible primitive as its source text rather than as null', async () => {
    for (const text of ['NaN', 'Infinity', '-0', '9007199254740993n']) {
      const { bridge } = bridgeReturning({ result: { type: 'number', unserializableValue: text } });
      expect(await evaluateInSession(bridge, SESSION, { expression: text, ...BASE })).toEqual({
        kind: 'unserializable',
        unserializableValue: text,
      });
    }
  });

  it('describes a live object and NEVER returns the objectId Chrome offered', async () => {
    const { bridge } = bridgeReturning({
      result: {
        type: 'object',
        subtype: 'node',
        className: 'HTMLDivElement',
        description: 'div#main',
        // Chrome really does still send this alongside a failed
        // by-value serialisation. Returning it would hand the caller a
        // live handle into the page, which is the whole escalation this
        // module refuses.
        objectId: '{"injectedScriptId":1,"id":7}',
      },
    });
    const outcome = await evaluateInSession(bridge, SESSION, {
      expression: 'document.body',
      ...BASE,
    });
    expect(outcome).toEqual({ kind: 'unserializable', description: 'div#main' });
    expect(JSON.stringify(outcome)).not.toContain('injectedScriptId');
  });

  it('falls back through className and type when a live object has no description', async () => {
    const { bridge } = bridgeReturning({ result: { type: 'function', className: 'Function' } });
    expect(await evaluateInSession(bridge, SESSION, { expression: 'f', ...BASE })).toEqual({
      kind: 'unserializable',
      description: 'Function',
    });
  });
});

describe('evaluateInSession: a page-side throw is data, not a rejection', () => {
  it('returns the page own message, name, stack and 1-based position', async () => {
    const { bridge } = bridgeReturning({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 3,
        columnNumber: 11,
        exception: {
          type: 'object',
          subtype: 'error',
          className: 'TypeError',
          description:
            "TypeError: Cannot read properties of null (reading 'value')\n    at <anonymous>:4:12",
        },
      },
    });
    const outcome = await evaluateInSession(bridge, SESSION, { expression: 'x.value', ...BASE });
    expect(outcome.kind).toBe('exception');
    if (outcome.kind !== 'exception') throw new Error('unreachable');
    expect(outcome.exception.name).toBe('TypeError');
    expect(outcome.exception.message).toContain('Cannot read properties of null');
    expect(outcome.exception.stack).toContain('at <anonymous>');
    // CDP counts from 0; every editor and every stack trace a developer
    // reads counts from 1.
    expect(outcome.exception.lineNumber).toBe(4);
    expect(outcome.exception.columnNumber).toBe(12);
  });

  it('handles a thrown non-Error (throw "nope") without inventing an Error shape', async () => {
    const { bridge } = bridgeReturning({
      exceptionDetails: { text: 'Uncaught', exception: { type: 'string', value: 'nope' } },
    });
    const outcome = await evaluateInSession(bridge, SESSION, {
      expression: "throw 'nope'",
      ...BASE,
    });
    expect(outcome).toEqual({ kind: 'exception', exception: { message: 'nope' } });
  });

  it('reports an unhandled promise rejection the same way a synchronous throw is reported', async () => {
    // With `awaitPromise: true` Chrome reports a rejection through the same
    // `exceptionDetails` channel, which is what makes one code path enough.
    const { bridge } = bridgeReturning({
      exceptionDetails: {
        text: 'Uncaught (in promise)',
        exception: { type: 'object', className: 'Error', description: 'Error: fetch failed' },
      },
    });
    const outcome = await evaluateInSession(bridge, SESSION, {
      expression: 'Promise.reject(new Error("fetch failed"))',
      ...BASE,
    });
    expect(outcome.kind).toBe('exception');
    if (outcome.kind !== 'exception') throw new Error('unreachable');
    expect(outcome.exception.message).toContain('fetch failed');
  });

  it('never returns a value alongside an exception', async () => {
    const { bridge } = bridgeReturning({
      result: { type: 'string', value: 'leftover' },
      exceptionDetails: { text: 'Uncaught', exception: { type: 'string', value: 'boom' } },
    });
    const outcome = await evaluateInSession(bridge, SESSION, { expression: 'x', ...BASE });
    expect(outcome.kind).toBe('exception');
    expect(JSON.stringify(outcome)).not.toContain('leftover');
  });
});

describe('evaluateInSession: a result too large', () => {
  it('refuses over the cap and discards the value rather than truncating it', async () => {
    const big = 'x'.repeat(2000);
    const { bridge } = bridgeReturning({ result: { type: 'string', value: big } });
    const outcome = await evaluateInSession(bridge, SESSION, {
      expression: 'huge',
      timeoutMs: 5000,
      maxResultBytes: 1024,
    });
    expect(outcome).toEqual({ kind: 'too_large', sizeBytes: 2002, maxBytes: 1024 });
    // The value must not travel with the refusal: a caller that ignores
    // `kind` must not accidentally get a truncated or full copy anyway.
    expect(JSON.stringify(outcome)).not.toContain('xxxx');
  });

  it('admits a result exactly at the cap', async () => {
    const { bridge } = bridgeReturning({ result: { type: 'string', value: 'y'.repeat(1022) } });
    const outcome = await evaluateInSession(bridge, SESSION, {
      expression: 'edge',
      timeoutMs: 5000,
      maxResultBytes: 1024,
    });
    expect(outcome.kind).toBe('value');
    if (outcome.kind !== 'value') throw new Error('unreachable');
    expect(outcome.sizeBytes).toBe(1024);
  });
});

describe('evaluateInSession: transport failures stay failures', () => {
  it('propagates a CdpError unchanged so the caller can tell a timeout from a dead session', async () => {
    const timeout = new CdpError('E_CDP_TIMEOUT', {
      kind: 'timeout',
      method: 'Runtime.evaluate',
      retryable: true,
    });
    const { bridge } = bridgeThrowing(timeout);
    await expect(evaluateInSession(bridge, SESSION, { expression: '1', ...BASE })).rejects.toBe(
      timeout,
    );
  });

  it('wraps a non-CdpError throw so a caller never has to handle a bare unknown', async () => {
    const { bridge } = bridgeThrowing(new Error('socket exploded'));
    await expect(
      evaluateInSession(bridge, SESSION, { expression: '1', ...BASE }),
    ).rejects.toBeInstanceOf(CdpError);
  });

  it('does not crash on a malformed CDP response with neither result nor exceptionDetails', async () => {
    const { bridge } = bridgeReturning({});
    expect(await evaluateInSession(bridge, SESSION, { expression: '1', ...BASE })).toEqual({
      kind: 'unserializable',
    });
  });
});

/**
 * `world: 'isolated'`.
 *
 * The isolated world exists so a page cannot watch the automation driving
 * it: it shares the DOM and nothing else. These tests cover the three
 * things that decide whether it is real. That the default is untouched,
 * because every existing caller depends on the main world. That a stale
 * world is repaired rather than surfaced, because the context dies on every
 * navigation and `Runtime` is deliberately never enabled to hear about it.
 * And that a caller still cannot NAME a context, which is the whole reason
 * the wire carries an enum.
 */
describe('evaluateInSession: world', () => {
  const ISO = { ...BASE, world: 'isolated' as const, frameId: 'FRAME_1' };

  /** A bridge that answers `Page.createIsolatedWorld` and scripts the evaluates that follow. */
  function isolatedBridge(contextId: number, ...evaluates: Array<unknown | Error>) {
    const queue = [...evaluates];
    const send = vi.fn(async (method: string) => {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: contextId };
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    });
    return { bridge: { send } as unknown as CdpBridge, send };
  }

  const staleError = () =>
    new CdpError('E_CDP_PROTOCOL', {
      kind: 'protocol',
      message: 'Cannot find context with specified id',
    });

  it('creates the world once and evaluates inside it', async () => {
    const { bridge, send } = isolatedBridge(7, { result: { type: 'number', value: 1 } });
    // A frame id nothing else in the suite uses, so the module-level cache
    // cannot hand this test a world another test created.
    await evaluateInSession(bridge, SESSION, { ...ISO, frameId: 'FRAME_CREATE', expression: '1' });

    const created = send.mock.calls.find((c) => c[0] === 'Page.createIsolatedWorld');
    expect(created).toBeDefined();
    // Never universal access: that would let the isolated world reach across
    // origins, a reach the main world does not have.
    expect((created?.[1] as Record<string, unknown>)['grantUniveralAccess']).toBe(false);

    const evaluated = send.mock.calls.find((c) => c[0] === 'Runtime.evaluate');
    expect((evaluated?.[1] as Record<string, unknown>)['contextId']).toBe(7);
  });

  it('leaves the main world alone by default, sending no contextId at all', async () => {
    const { send } = bridgeReturning({ result: { type: 'number', value: 1 } });
    const bridge = { send } as unknown as CdpBridge;
    await evaluateInSession(bridge, SESSION, { ...BASE, expression: '1' });
    const params = send.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params).not.toHaveProperty('contextId');
  });

  it('rebuilds the world and retries once when the cached context has died', async () => {
    const { bridge, send } = isolatedBridge(9, staleError(), {
      result: { type: 'number', value: 5 },
    });
    const out = await evaluateInSession(bridge, SESSION, {
      ...ISO,
      frameId: 'FRAME_STALE',
      expression: '5',
    });

    expect(out).toMatchObject({ kind: 'value', value: 5 });
    // Two worlds created (the first, then the repair) and two evaluates.
    expect(send.mock.calls.filter((c) => c[0] === 'Page.createIsolatedWorld')).toHaveLength(2);
    expect(send.mock.calls.filter((c) => c[0] === 'Runtime.evaluate')).toHaveLength(2);
  });

  it('gives up rather than looping when the rebuilt world is stale too', async () => {
    const { bridge, send } = isolatedBridge(11, staleError(), staleError());
    await expect(
      evaluateInSession(bridge, SESSION, { ...ISO, frameId: 'FRAME_TWICE', expression: '1' }),
    ).rejects.toThrow(/cannot find context/i);
    // Exactly one repair. A retry loop here would hammer a page that is
    // navigating in a tight loop and never terminate.
    expect(send.mock.calls.filter((c) => c[0] === 'Runtime.evaluate')).toHaveLength(2);
  });

  it('does not retry a failure that is not a dead context', async () => {
    const { bridge, send } = isolatedBridge(
      13,
      new CdpError('E_CDP_DETACHED', {
        kind: 'detached',
        message: 'Session with given id not found',
      }),
    );
    await expect(
      evaluateInSession(bridge, SESSION, { ...ISO, frameId: 'FRAME_DETACHED', expression: '1' }),
    ).rejects.toThrow(/session with given id/i);
    expect(send.mock.calls.filter((c) => c[0] === 'Runtime.evaluate')).toHaveLength(1);
  });

  it("refuses world 'isolated' with no frameId, rather than silently using the main world", async () => {
    const { bridge } = isolatedBridge(15, { result: { type: 'number', value: 1 } });
    await expect(
      evaluateInSession(bridge, SESSION, { ...BASE, world: 'isolated', expression: '1' }),
    ).rejects.toThrow(/frameId/);
  });
});
