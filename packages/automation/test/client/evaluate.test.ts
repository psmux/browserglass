import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationError } from '../../src/errors.js';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/** The harness's own default granted set, plus `evaluate`. */
const GRANTED_WITH_EVALUATE = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'automation',
  'evaluate',
];

/**
 * Connects a client whose `welcome.granted` carries `evaluate`.
 *
 * Written here rather than added to `fake-gateway.ts`'s default granted
 * set on purpose: `evaluate` being ABSENT from that default is itself the
 * assertion in the first test below, and quietly adding it there would
 * have deleted the thing worth proving.
 */
async function grantedClient(opts?: { granted?: string[]; stepBudget?: number }) {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(
    fixtureOptions(harness, opts?.stepBudget !== undefined ? { stepBudget: opts.stepBudget } : {}),
  );
  await tick();
  const gateway = startScriptedGateway(harness, {
    granted: (opts?.granted ?? GRANTED_WITH_EVALUATE) as Capability[],
  });
  const client = await connectPromise;
  return { client, gateway, harness };
}

/**
 * `AutomationClient.evaluate()`, `text()`, `html()` and `waitForFunction()`
 * against the scripted fake gateway.
 *
 * The default `welcome.granted` in `fake-gateway.ts` deliberately does NOT
 * include `evaluate`, which makes the first test here the important one:
 * an `AutomationClient` built from an ordinary automation token is refused,
 * locally and before a round trip, and has to be granted the capability
 * explicitly to get anywhere.
 */
describe('AutomationClient page evaluation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses evaluate() locally when the token does not carry the capability, without a round trip', async () => {
    const { client, gateway } = await connectFakeClient();
    expect(client.granted.has('evaluate')).toBe(false);

    await expect(client.evaluate('1 + 1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'evaluate' },
    });
    // Nothing was sent: the refusal is local, so a caller lacking the
    // capability does not pay a round trip to be told so.
    expect(gateway.evaluateCalls).toHaveLength(0);
  });

  it('sends an expression as expression and a function as functionDeclaration plus args', async () => {
    const { client, gateway } = await grantedClient();

    const p1 = client.evaluate('document.title');
    await tick();
    await p1;
    expect(gateway.evaluateCalls.at(-1)).toMatchObject({
      t: 'page.evaluate',
      targetId: client.targetId,
      expression: 'document.title',
    });
    expect(gateway.evaluateCalls.at(-1)).not.toHaveProperty('functionDeclaration');

    const p2 = client.evaluate((a: never, b: never) => [a, b], 'x', 7);
    await tick();
    await p2;
    const call = gateway.evaluateCalls.at(-1)!;
    expect(call['functionDeclaration']).toContain('=>');
    expect(call['args']).toEqual(['x', 7]);
    expect(call).not.toHaveProperty('expression');
  });

  it('returns the value, and returns undefined for an undefined result rather than null', async () => {
    const { client, gateway } = await grantedClient();

    gateway.evaluateResponder = () => ({
      ok: true,
      resultType: 'value',
      value: { a: 1 },
      sizeBytes: 7,
    });
    const valuePromise = client.evaluate<{ a: number }>('x');
    await tick();
    expect(await valuePromise).toEqual({ a: 1 });

    gateway.evaluateResponder = () => ({ ok: true, resultType: 'undefined', sizeBytes: 0 });
    const undefPromise = client.evaluate('void 0');
    await tick();
    expect(await undefPromise).toBeUndefined();
  });

  it('turns a page-side throw into an AutomationError carrying the page own message and stack', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      ok: false,
      resultType: 'undefined',
      sizeBytes: 0,
      exception: {
        message: "Cannot read properties of null (reading 'value')",
        name: 'TypeError',
        stack: 'TypeError: ...\n    at <anonymous>:1:7',
        lineNumber: 1,
      },
    });
    // Handler attached before the tick that delivers the reply; see the
    // note in the non-serialisable test below.
    const settled = client.evaluate('x.value').then(
      () => null,
      (e: unknown) => e as AutomationError,
    );
    await tick();
    const err = await settled;
    expect(err).toBeInstanceOf(AutomationError);
    expect(err?.message).toContain('Cannot read properties of null');
    // `pageException` is what lets a caller tell "my script is wrong" from
    // "the wire is broken", both of which are `PROTOCOL_ERROR`.
    expect(err?.details).toMatchObject({ pageException: true, name: 'TypeError' });
    expect(err?.details?.['stack']).toContain('at <anonymous>');
  });

  it('refuses a non-serialisable result with a message naming what it was, rather than returning a handle', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      ok: true,
      resultType: 'unserializable',
      description: 'HTMLBodyElement',
      sizeBytes: 0,
    });
    // Settled BEFORE ticking, never `await expect(p).rejects` after it: the
    // reply lands inside `tick()`, so a handler attached afterwards means
    // the rejection is briefly unhandled and Node reports it as an error
    // even though the test passes.
    const settled = client.evaluate('document.body').then(
      () => null,
      (e: unknown) => e as AutomationError,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'PROTOCOL_ERROR',
      details: { unserializable: true, description: 'HTMLBodyElement' },
    });
  });

  it('maps the wire evaluate error codes onto the automation taxonomy', async () => {
    const { client, gateway } = await grantedClient();
    const cases: Array<[string, string]> = [
      ['bgls.error.evaluate.timeout', 'TIMEOUT'],
      ['bgls.error.evaluate.result_too_large', 'POLICY_DENIED'],
      ['bgls.error.evaluate.invalid_request', 'INVALID_ARGUMENT'],
      ['bgls.error.evaluate.failed', 'PROTOCOL_ERROR'],
    ];
    for (const [wireCode, expected] of cases) {
      gateway.evaluateResponder = () => ({
        t: 'error',
        code: wireCode,
        category: 'evaluate',
        message: 'nope',
        fatal: false,
        retryable: false,
      });
      const settled = client.evaluate('1').then(
        () => null,
        (e: unknown) => e as AutomationError,
      );
      await tick();
      expect(await settled).toMatchObject({ code: expected });
    }
  });

  it('requires control as well as evaluate for a userGesture call, checked locally', async () => {
    const { client, gateway } = await grantedClient();
    // The granted set below includes `control`, so this one is allowed.
    const ok = client.evaluateWith('1', [], { userGesture: true });
    await tick();
    await ok;
    expect(gateway.evaluateCalls.at(-1)?.['userGesture']).toBe(true);

    const { client: noControl } = await grantedClient({ granted: ['view', 'evaluate'] });
    await expect(noControl.evaluateWith('1', [], { userGesture: true })).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'control' },
    });
  });

  it('text() and html() are implemented on top of evaluate, not stubs', async () => {
    const { client, gateway } = await grantedClient();

    gateway.evaluateResponder = () => ({
      ok: true,
      resultType: 'value',
      value: 'Hello world',
      sizeBytes: 13,
    });
    const textPromise = client.text();
    await tick();
    expect(await textPromise).toBe('Hello world');
    expect(gateway.evaluateCalls.at(-1)?.['expression']).toContain('innerText');

    gateway.evaluateResponder = () => ({
      ok: true,
      resultType: 'value',
      value: '<html></html>',
      sizeBytes: 15,
    });
    const htmlPromise = client.html();
    await tick();
    expect(await htmlPromise).toBe('<html></html>');
    expect(gateway.evaluateCalls.at(-1)?.['expression']).toContain('outerHTML');
  });
});

describe('AutomationClient.waitForFunction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls until the predicate is truthy and returns that value', async () => {
    const { client, gateway } = await grantedClient();
    let calls = 0;
    gateway.evaluateResponder = () => {
      calls += 1;
      return calls < 3
        ? { ok: true, resultType: 'value', value: false, sizeBytes: 5 }
        : { ok: true, resultType: 'value', value: 'ready', sizeBytes: 7 };
    };

    const p = client.waitForFunction<string>(() => (globalThis as { done?: string }).done, {
      pollTimeoutMs: 5000,
      pollingMs: 100,
    });
    await tick(400);
    expect(await p).toBe('ready');
    expect(calls).toBe(3);
  });

  it('times out with the poll count, not with a bare deadline miss', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      ok: true,
      resultType: 'value',
      value: false,
      sizeBytes: 5,
    });

    const p = client.waitForFunction('window.ready', { pollTimeoutMs: 300, pollingMs: 100 });
    const settled = p.then(
      () => null,
      (e: unknown) => e as AutomationError,
    );
    await tick(1000);
    const err = await settled;
    expect(err?.code).toBe('TIMEOUT');
    expect(err?.details).toMatchObject({ pollTimeoutMs: 300 });
    expect(err?.message).toContain('polls');
  });

  it('propagates a predicate that throws instead of retrying it for the full timeout', async () => {
    const { client, gateway } = await grantedClient();
    let calls = 0;
    gateway.evaluateResponder = () => {
      calls += 1;
      return {
        ok: false,
        resultType: 'undefined',
        sizeBytes: 0,
        exception: { message: 'nope is not defined', name: 'ReferenceError' },
      };
    };

    const p = client.waitForFunction('nope.ready', { pollTimeoutMs: 5000, pollingMs: 100 });
    const settled = p.then(
      () => null,
      (e: unknown) => e as AutomationError,
    );
    await tick(50);
    const err = await settled;
    expect(err?.message).toContain('nope is not defined');
    // A predicate that throws is wrong on the first poll and is wrong on
    // the fiftieth. Reporting it immediately is what makes the cause
    // visible.
    expect(calls).toBe(1);
  });

  it('costs one step for the whole wait, not one per poll', async () => {
    const { client, gateway } = await grantedClient({ stepBudget: 2 });
    let calls = 0;
    gateway.evaluateResponder = () => {
      calls += 1;
      return calls < 5
        ? { ok: true, resultType: 'value', value: false, sizeBytes: 5 }
        : { ok: true, resultType: 'value', value: true, sizeBytes: 4 };
    };
    const p = client.waitForFunction('window.ready', { pollTimeoutMs: 5000, pollingMs: 100 });
    await tick(600);
    expect(await p).toBe(true);
    // Five polls under a two-step budget. Routing every poll through the
    // action pipeline would have exhausted the budget on the third.
    expect(calls).toBe(5);
  });
});
