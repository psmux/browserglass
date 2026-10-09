import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/** The harness's own default granted set, plus `devtools`, the same pattern `./a11y.test.ts`'s `grantedClient()` uses. */
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

function pageMapNode(over: Record<string, unknown> = {}) {
  return {
    index: 1234,
    tag: 'button',
    role: 'button',
    name: 'Submit',
    rect: { x: 10, y: 20, w: 100, h: 30 },
    inViewport: true,
    occluded: false,
    attributes: { type: 'submit' },
    ...over,
  };
}

/**
 * `AutomationClient.pageMap()` against the scripted fake gateway. Same
 * shape of suite as `./a11y.test.ts`: the local devtools refusal is proven
 * first (this method runs no page script either), then the wire shaping.
 */
describe('AutomationClient.pageMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses locally on the missing devtools capability, without a round trip', async () => {
    const { client, gateway } = await connectFakeClient();
    const before = gateway.ws.sentJsonMessages().length;

    await expect(client.pageMap()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    expect(gateway.ws.sentJsonMessages().length).toBe(before);
    expect(gateway.pageMapCalls).toHaveLength(0);

    client.close();
  });

  it('holding evaluate alone is not enough: pageMap() needs devtools specifically', async () => {
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
    await expect(client.pageMap()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    expect(gateway.pageMapCalls).toHaveLength(0);
    client.close();
  });

  it('sends targetId, include/listeners/timeoutMs only when given, and resolves the full reply shape', async () => {
    const { client, gateway } = await grantedClient();
    gateway.pageMapResponder = (msg) => ({
      t: 'page.map.got',
      targetId: msg['targetId'],
      epoch: 'epoch_abc',
      nodes: [pageMapNode()],
      total: 1,
      truncated: false,
      truncatedByReason: { offscreen: 0, onscreen: 0, unpositioned: 0 },
      degraded: { framesAttempted: 1, framesFailed: 0, failures: [], listeners: 'ok' },
    });

    const p = client.pageMap({ include: ['nodes', 'text'], listeners: false, timeoutMs: 5000 });
    await tick();
    const result = await p;

    expect(gateway.pageMapCalls.at(-1)).toMatchObject({
      t: 'page.map.get',
      targetId: client.targetId,
      include: ['nodes', 'text'],
      listeners: false,
    });
    expect(result.epoch).toBe('epoch_abc');
    expect(result.nodes).toEqual([pageMapNode()]);
    expect(result.total).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.degraded).toEqual({
      framesAttempted: 1,
      framesFailed: 0,
      failures: [],
      listeners: 'ok',
    });

    client.close();
  });

  it('omits include/listeners/timeoutMs on the wire when the caller omits them', async () => {
    const { client, gateway } = await grantedClient();

    const p = client.pageMap();
    await tick();
    await p;

    const call = gateway.pageMapCalls.at(-1) as Record<string, unknown>;
    expect('include' in call).toBe(false);
    expect('listeners' in call).toBe(false);
    expect('timeoutMs' in call).toBe(false);

    client.close();
  });

  it('surfaces truncatedByReason honestly, distinguishing offscreen from onscreen from unpositioned', async () => {
    const { client, gateway } = await grantedClient();
    gateway.pageMapResponder = (msg) => ({
      t: 'page.map.got',
      targetId: msg['targetId'],
      epoch: 'epoch_1',
      nodes: [pageMapNode()],
      total: 40,
      truncated: true,
      truncatedByReason: { offscreen: 20, onscreen: 15, unpositioned: 4 },
      degraded: { framesAttempted: 1, framesFailed: 0, failures: [], listeners: 'ok' },
    });

    const result = await (async () => {
      const p = client.pageMap();
      await tick();
      return p;
    })();

    expect(result.truncated).toBe(true);
    expect(result.truncatedByReason).toEqual({ offscreen: 20, onscreen: 15, unpositioned: 4 });

    client.close();
  });

  it('surfaces per-frame accessibility degradation and listener signal degradation as data', async () => {
    const { client, gateway } = await grantedClient();
    gateway.pageMapResponder = (msg) => ({
      t: 'page.map.got',
      targetId: msg['targetId'],
      epoch: 'epoch_1',
      nodes: [pageMapNode({ role: null, name: null })],
      total: 1,
      truncated: false,
      truncatedByReason: { offscreen: 0, onscreen: 0, unpositioned: 0 },
      degraded: {
        framesAttempted: 2,
        framesFailed: 1,
        failures: [{ frameId: 'frame_2', reason: 'timeout' }],
        listeners: 'failed',
        listenersReason: 'DOMDebugger.getEventListeners did not complete in time',
      },
    });

    const result = await (async () => {
      const p = client.pageMap();
      await tick();
      return p;
    })();

    expect(result.nodes?.[0]).toMatchObject({ role: null, name: null });
    expect(result.degraded).toMatchObject({
      framesAttempted: 2,
      framesFailed: 1,
      listeners: 'failed',
      listenersReason: 'DOMDebugger.getEventListeners did not complete in time',
    });

    client.close();
  });

  it('an empty result is an ordinary answer, never an error', async () => {
    const { client, gateway } = await grantedClient();

    const result = await (async () => {
      const p = client.pageMap();
      await tick();
      return p;
    })();

    expect(result.nodes).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.truncated).toBe(false);

    client.close();
  });

  it('surfaces bgls.error.pagemap.timeout as TIMEOUT', async () => {
    const { client, gateway } = await grantedClient();
    gateway.pageMapResponder = () => ({
      t: 'error',
      code: 'bgls.error.pagemap.timeout',
      category: 'pagemap',
      message: 'the page map capture did not complete in time.',
      fatal: false,
      retryable: true,
    });

    const settled = client.pageMap().then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'TIMEOUT',
      details: { wireCode: 'bgls.error.pagemap.timeout' },
    });

    client.close();
  });
});

/**
 * `AutomationClient.stampPageMap()`: the "act on an index" half of the
 * flow. Same devtools-first refusal shape as `pageMap()` above.
 */
describe('AutomationClient.stampPageMap', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses locally on the missing devtools capability, without a round trip', async () => {
    const { client, gateway } = await connectFakeClient();
    const before = gateway.ws.sentJsonMessages().length;

    await expect(client.stampPageMap('epoch_1', [1234])).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    expect(gateway.ws.sentJsonMessages().length).toBe(before);
    expect(gateway.pageMapStampCalls).toHaveLength(0);

    client.close();
  });

  it('sends targetId, epoch and indices, and resolves results/marker from the reply', async () => {
    const { client, gateway } = await grantedClient();
    gateway.pageMapStampResponder = (msg) => ({
      t: 'page.map.stamped',
      targetId: msg['targetId'],
      results: [
        { index: 1234, stamped: true },
        { index: 5678, stamped: false, reason: 'detached' },
      ],
      marker: 'data-bgls-pm-abc123',
    });

    const p = client.stampPageMap('epoch_1', [1234, 5678]);
    await tick();
    const result = await p;

    expect(gateway.pageMapStampCalls.at(-1)).toMatchObject({
      t: 'page.map.stamp',
      targetId: client.targetId,
      epoch: 'epoch_1',
      indices: [1234, 5678],
    });
    expect(result.marker).toBe('data-bgls-pm-abc123');
    expect(result.results).toEqual([
      { index: 1234, stamped: true },
      { index: 5678, stamped: false, reason: 'detached' },
    ]);

    client.close();
  });

  it('surfaces bgls.error.pagemap.stale_epoch as a refusal before any write, never a partial stamp', async () => {
    const { client, gateway } = await grantedClient();
    gateway.pageMapStampResponder = () => ({
      t: 'error',
      code: 'bgls.error.pagemap.stale_epoch',
      category: 'pagemap',
      message: 'epoch does not match the current capture; the page navigated since it was minted.',
      fatal: false,
      retryable: false,
    });

    const settled = client.stampPageMap('epoch_stale', [1234]).then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'PROTOCOL_ERROR',
      details: { wireCode: 'bgls.error.pagemap.stale_epoch' },
    });

    client.close();
  });
});
