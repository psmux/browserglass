import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/** The harness's own default granted set, plus `devtools`, the same pattern `./evaluate.test.ts`'s `grantedClient()` uses for `evaluate`. */
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

/**
 * `AutomationClient.diagnostics.responseBody()` against the scripted fake
 * gateway.
 *
 * As with `./evaluate.test.ts` and `./wait-for-network-idle.test.ts`, the
 * harness's default granted set deliberately omits `devtools`, so the
 * local refusal is the first thing this suite proves. The rest is mostly
 * error mapping: `@browserglass/protocol`'s `wire/messages/response-body.ts`
 * exists specifically to refuse a `requestId` a caller was not shown, to
 * refuse an oversized body rather than truncate it, and to say a body is
 * GONE rather than answer with an empty one, and each of those has to
 * surface through `AutomationClient` as a distinguishable `AutomationError`.
 */
describe('AutomationClient.diagnostics.responseBody', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses locally on the missing devtools capability, without a round trip', async () => {
    const { client, gateway } = await connectFakeClient();
    const before = gateway.ws.sentJsonMessages().length;

    await expect(client.diagnostics.responseBody('req_1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    expect(gateway.ws.sentJsonMessages().length).toBe(before);
    expect(gateway.responseBodyCalls).toHaveLength(0);

    client.close();
  });

  it('sends targetId and requestId on page.responsebody.get and resolves body/base64Encoded/sizeBytes from the reply', async () => {
    const { client, gateway } = await grantedClient();
    gateway.responseBodyResponder = (msg) => ({
      t: 'page.responsebody.got',
      targetId: msg['targetId'],
      requestId: msg['requestId'],
      body: '{"ok":true}',
      base64Encoded: false,
      sizeBytes: 11,
    });

    const p = client.diagnostics.responseBody('req_42');
    await tick();
    const result = await p;

    expect(gateway.responseBodyCalls.at(-1)).toMatchObject({
      t: 'page.responsebody.get',
      targetId: client.targetId,
      requestId: 'req_42',
    });
    expect(result).toEqual({ body: '{"ok":true}', base64Encoded: false, sizeBytes: 11 });

    client.close();
  });

  it('carries a base64Encoded binary body through unchanged', async () => {
    const { client, gateway } = await grantedClient();
    gateway.responseBodyResponder = (msg) => ({
      t: 'page.responsebody.got',
      targetId: msg['targetId'],
      requestId: msg['requestId'],
      body: 'ZmFrZQ==',
      base64Encoded: true,
      sizeBytes: 4,
    });

    const p = client.diagnostics.responseBody('req_bin');
    await tick();
    const result = await p;
    expect(result.base64Encoded).toBe(true);
    expect(result.body).toBe('ZmFrZQ==');

    client.close();
  });

  it('surfaces bgls.error.responsebody.unknown_request as POLICY_DENIED, the scoping refusal for a requestId this client was never shown', async () => {
    const { client, gateway } = await grantedClient();
    gateway.responseBodyResponder = () => ({
      t: 'error',
      code: 'bgls.error.responsebody.unknown_request',
      category: 'responsebody',
      message: 'This requestId was never sent to you as a network.request on this target.',
      fatal: false,
      retryable: false,
    });

    // Settled BEFORE ticking, never `await expect(p).rejects` after it: the
    // reply lands inside `tick()`, so a handler attached afterwards means
    // the rejection is briefly unhandled (`./evaluate.test.ts`'s own note
    // on the same trap).
    const settled = client.diagnostics.responseBody('guessed').then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'POLICY_DENIED',
      details: { wireCode: 'bgls.error.responsebody.unknown_request' },
    });

    client.close();
  });

  it('surfaces bgls.error.responsebody.too_large as POLICY_DENIED, carrying sizeBytes/maxBytes rather than a truncated body', async () => {
    const { client, gateway } = await grantedClient();
    gateway.responseBodyResponder = () => ({
      t: 'error',
      code: 'bgls.error.responsebody.too_large',
      category: 'responsebody',
      message: 'The response body is 5000000 bytes, over the 4194304 byte ceiling.',
      fatal: false,
      retryable: false,
      context: { sizeBytes: 5000000, maxBytes: 4194304 },
    });

    const settled = client.diagnostics.responseBody('req_big').then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'POLICY_DENIED',
      details: {
        wireCode: 'bgls.error.responsebody.too_large',
        context: { sizeBytes: 5000000, maxBytes: 4194304 },
      },
    });

    client.close();
  });

  it('surfaces bgls.error.responsebody.unavailable as NOT_FOUND, not as a resolved empty body', async () => {
    const { client, gateway } = await grantedClient();
    gateway.responseBodyResponder = () => ({
      t: 'error',
      code: 'bgls.error.responsebody.unavailable',
      category: 'responsebody',
      message: 'Chrome no longer has this body buffered.',
      fatal: false,
      retryable: false,
    });

    const settled = client.diagnostics.responseBody('req_gone').then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'NOT_FOUND',
      details: { wireCode: 'bgls.error.responsebody.unavailable' },
    });

    client.close();
  });
});
