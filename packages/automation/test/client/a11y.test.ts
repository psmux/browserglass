import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/** The harness's own default granted set, plus `devtools`, the same pattern `./response-body.test.ts`'s `grantedClient()` uses. */
const GRANTED_WITH_DEVTOOLS = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'automation',
  'devtools',
];
/** `devtools` AND `evaluate`: what a `role=` selector actually needs, since it is `devtools` for the AX query underneath `resolve()`'s own `evaluate` gate. */
const GRANTED_WITH_DEVTOOLS_AND_EVALUATE = [...GRANTED_WITH_DEVTOOLS, 'evaluate'];

async function grantedClient(opts?: { granted?: string[] }) {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const gateway = startScriptedGateway(harness, {
    granted: (opts?.granted ?? GRANTED_WITH_DEVTOOLS) as Capability[],
  });
  const client = await connectPromise;
  return { client, gateway, harness };
}

function a11yNode(over: Record<string, unknown> = {}) {
  return {
    role: 'button',
    name: 'Submit',
    backendNodeId: 42,
    ignored: false,
    focusable: true,
    disabled: false,
    hidden: null,
    expanded: null,
    checked: null,
    pressed: null,
    selected: null,
    required: null,
    readonly: null,
    invalid: null,
    level: null,
    ...over,
  };
}

/**
 * `AutomationClient.a11y()` against the scripted fake gateway.
 *
 * As with `./response-body.test.ts`, the harness's default granted set
 * deliberately omits `devtools`, so the local refusal is the first thing
 * this suite proves: `a11y()` runs no page script (no `evaluate()` call
 * anywhere in it), so it is gated on `devtools`, not `evaluate`, and that
 * distinction is exactly what the first test checks.
 */
describe('AutomationClient.a11y', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses locally on the missing devtools capability, without a round trip', async () => {
    const { client, gateway } = await connectFakeClient();
    const before = gateway.ws.sentJsonMessages().length;

    await expect(client.a11y()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    expect(gateway.ws.sentJsonMessages().length).toBe(before);
    expect(gateway.a11yCalls).toHaveLength(0);

    client.close();
  });

  it('holding evaluate alone is not enough: a11y() needs devtools specifically, not the page-script capability', async () => {
    const { client, gateway } = await grantedClient({
      granted: [
        'view',
        'control',
        'navigate',
        'tabs.manage',
        'capture',
        'probe',
        'automation',
        'evaluate',
      ],
    });
    await expect(client.a11y()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    expect(gateway.a11yCalls).toHaveLength(0);
    client.close();
  });

  it('sends targetId, and role/name/maxNodes only when given, and resolves nodes/total/truncated from the reply', async () => {
    const { client, gateway } = await grantedClient();
    gateway.a11yResponder = (msg) => ({
      t: 'page.a11y.got',
      targetId: msg['targetId'],
      nodes: [a11yNode()],
      total: 1,
      truncated: false,
      marker: null,
    });

    const p = client.a11y({ role: 'button', name: 'Submit', maxNodes: 50 });
    await tick();
    const result = await p;

    expect(gateway.a11yCalls.at(-1)).toMatchObject({
      t: 'page.a11y.get',
      targetId: client.targetId,
      role: 'button',
      name: 'Submit',
      maxNodes: 50,
    });
    // Never a stamp request: reading is not writing.
    expect(gateway.a11yCalls.at(-1)).not.toHaveProperty('stamp');
    expect(result).toEqual({ nodes: [a11yNode()], total: 1, truncated: false });

    client.close();
  });

  it('omits role/name/maxNodes on the wire when the caller omits them', async () => {
    const { client, gateway } = await grantedClient();
    gateway.a11yResponder = (msg) => ({
      t: 'page.a11y.got',
      targetId: msg['targetId'],
      nodes: [],
      total: 0,
      truncated: false,
      marker: null,
    });

    const p = client.a11y();
    await tick();
    await p;

    const call = gateway.a11yCalls.at(-1) as Record<string, unknown>;
    expect('role' in call).toBe(false);
    expect('name' in call).toBe(false);
    expect('maxNodes' in call).toBe(false);

    client.close();
  });

  it('reports truncated: true honestly, as data, never as a thrown error', async () => {
    const { client, gateway } = await grantedClient();
    gateway.a11yResponder = (msg) => ({
      t: 'page.a11y.got',
      targetId: msg['targetId'],
      nodes: [a11yNode()],
      total: 500,
      truncated: true,
      marker: null,
    });

    const result = await (async () => {
      const p = client.a11y();
      await tick();
      return p;
    })();
    expect(result.total).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.nodes).toHaveLength(1);

    client.close();
  });

  it('an empty result is an ordinary answer, never an error', async () => {
    const { client, gateway } = await grantedClient();
    gateway.a11yResponder = (msg) => ({
      t: 'page.a11y.got',
      targetId: msg['targetId'],
      nodes: [],
      total: 0,
      truncated: false,
      marker: null,
    });

    const result = await (async () => {
      const p = client.a11y({ role: 'marquee' });
      await tick();
      return p;
    })();
    expect(result).toEqual({ nodes: [], total: 0, truncated: false });

    client.close();
  });

  it('surfaces bgls.error.a11y.timeout as TIMEOUT', async () => {
    const { client, gateway } = await grantedClient();
    gateway.a11yResponder = () => ({
      t: 'error',
      code: 'bgls.error.a11y.timeout',
      category: 'a11y',
      message: 'Accessibility.queryAXTree did not complete in time.',
      fatal: false,
      retryable: true,
    });

    const settled = client.a11y().then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'TIMEOUT',
      details: { wireCode: 'bgls.error.a11y.timeout' },
    });

    client.close();
  });

  it('surfaces bgls.error.a11y.failed as PROTOCOL_ERROR', async () => {
    const { client, gateway } = await grantedClient();
    gateway.a11yResponder = () => ({
      t: 'error',
      code: 'bgls.error.a11y.failed',
      category: 'a11y',
      message: 'the CDP command itself did not complete',
      fatal: false,
      retryable: true,
    });

    const settled = client.a11y().then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'PROTOCOL_ERROR',
      details: { wireCode: 'bgls.error.a11y.failed' },
    });

    client.close();
  });
});

/**
 * `role=`'s wire half: `LocatorEngine`'s own unit tests
 * (`./locator.test.ts`'s `describe('role= on top of resolve/waitFor', ...)`)
 * cover the rewrite mechanics against a fake `LocatorRuntime`; this suite
 * is the one level up, proving `AutomationClient` actually sends
 * `page.a11y.get` with `stamp: true` and turns the reply's `marker` into
 * the resolved selector, over the real socket plumbing.
 */
describe('role= selector, over the socket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses locally on the missing devtools capability, even though evaluate alone is enough for other selectors', async () => {
    const { client, gateway } = await grantedClient({
      granted: [
        'view',
        'control',
        'navigate',
        'tabs.manage',
        'capture',
        'probe',
        'automation',
        'evaluate',
      ],
    });

    await expect(client.resolve('role=button')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    // Never reaches page.evaluate: the refusal is in queryAndStampByRole,
    // before RESOLVE_SCRIPT would have been sent.
    expect(gateway.evaluateCalls).toHaveLength(0);

    client.close();
  });

  it('sends page.a11y.get with stamp: true, then page.evaluate with the rewritten css=[marker] selector', async () => {
    const { client, gateway } = await grantedClient({
      granted: GRANTED_WITH_DEVTOOLS_AND_EVALUATE,
    });
    gateway.a11yResponder = (msg) => ({
      t: 'page.a11y.got',
      targetId: msg['targetId'],
      nodes: [a11yNode()],
      total: 1,
      truncated: false,
      marker: 'data-bgls-ax-abc123',
    });
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: {
        matches: [],
        total: 0,
        truncated: false,
        engine: 'css',
        segments: 1,
        scopeMissing: false,
        selectorError: null,
        url: 'https://example.test/',
        title: '',
        viewport: { w: 0, h: 0, scrollX: 0, scrollY: 0 },
      },
      sizeBytes: 4,
    });

    const p = client.resolve('role=button[name="Submit"]');
    await tick();
    await p;

    expect(gateway.a11yCalls.at(-1)).toMatchObject({
      t: 'page.a11y.get',
      role: 'button',
      name: 'Submit',
      stamp: true,
    });
    expect(gateway.evaluateCalls.at(-1)?.['args']).toEqual([
      expect.objectContaining({ selector: 'css=[data-bgls-ax-abc123]' }),
    ]);

    client.close();
  });

  it('short-circuits to an empty resolve() when the AX query matches nothing, never sending page.evaluate at all', async () => {
    const { client, gateway } = await grantedClient({
      granted: GRANTED_WITH_DEVTOOLS_AND_EVALUATE,
    });
    gateway.a11yResponder = (msg) => ({
      t: 'page.a11y.got',
      targetId: msg['targetId'],
      nodes: [],
      total: 0,
      truncated: false,
      marker: null,
    });

    const p = client.resolve('role=button[name="Nope"]');
    await tick();
    const result = await p;

    expect(result).toMatchObject({ matches: [], total: 0 });
    expect(gateway.evaluateCalls).toHaveLength(0);

    client.close();
  });
});
