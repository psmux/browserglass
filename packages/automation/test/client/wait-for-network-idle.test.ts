import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutomationError } from '../../src/errors.js';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/** The harness's own default granted set, plus `devtools`. */
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

/**
 * Connects a client whose `welcome.granted` carries `devtools`, the same
 * pattern `./evaluate.test.ts`'s `grantedClient()` uses for `evaluate`:
 * the harness's default granted set deliberately omits it, so that
 * absence is itself the first test below.
 */
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
 * `AutomationClient.waitForNetworkIdle()` against the scripted fake
 * gateway (see `../fake-gateway.ts`'s `sendNetworkSummary()`).
 *
 * There is no real `@browserglass/server`/`@browserglass/protocol` support
 * for `NetworkSummaryPayload.inFlight` yet (see this method's own doc):
 * `packages/protocol/src/wire/messages/diagnostics.ts`'s `NetworkSummary`
 * and `packages/server/src/session/managed-session.ts` still enumerate
 * only the original six fields. `sendNetworkSummary()` stands in for a
 * gateway that HAS been updated to include `inFlight`, which is what this
 * suite verifies the client side actually does with it; a gateway that has
 * not been updated is covered separately below (the "no inFlight field at
 * all" test).
 */
describe('AutomationClient.waitForNetworkIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses on the missing devtools capability, checked locally before any round trip', async () => {
    const { client, gateway } = await connectFakeClient();
    const before = gateway.ws.sentJsonMessages().length;

    await expect(client.waitForNetworkIdle()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });
    expect(gateway.ws.sentJsonMessages().length).toBe(before);

    client.close();
  });

  it('refuses when no network diagnostics subscription is active, naming diagnostics.subscribe({ network: true })', async () => {
    const { client, gateway } = await grantedClient();
    const before = gateway.ws.sentJsonMessages().length;

    await expect(client.waitForNetworkIdle()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(client.waitForNetworkIdle()).rejects.toMatchObject({
      message: expect.stringContaining('diagnostics.subscribe({ network: true })'),
    });
    // Refused locally: no wire traffic for the failed calls above.
    expect(gateway.ws.sentJsonMessages().length).toBe(before);

    client.close();
  });

  it('still refuses when a subscription is active but network was not turned on', async () => {
    const { client } = await grantedClient();
    const subPromise = client.diagnostics.subscribe({ console: true, network: false });
    await tick();
    const sub = await subPromise;
    expect(sub.network).toBe(false);

    await expect(client.waitForNetworkIdle()).rejects.toMatchObject({ code: 'POLICY_DENIED' });

    client.close();
  });

  it('resolves once inFlight reaches maxInflight and stays there for idleMs', async () => {
    const { client, gateway } = await grantedClient();
    const subPromise = client.diagnostics.subscribe({ network: true });
    await tick();
    await subPromise;

    const settled = client.waitForNetworkIdle({ idleMs: 500, timeoutMs: 10000 }).then(
      () => 'resolved',
      (e: unknown) => e as AutomationError,
    );

    gateway.sendNetworkSummary(client.targetId, { inFlight: 2, requests: 2 });
    await tick(200);
    gateway.sendNetworkSummary(client.targetId, { inFlight: 0, requests: 2 });
    // Not yet: the idle window has not elapsed.
    await tick(499);
    gateway.sendNetworkSummary(client.targetId, { inFlight: 0, requests: 2 });
    await tick(1);

    expect(await settled).toBe('resolved');

    client.close();
  });

  it('restarts the idle window if the count rises again before idleMs elapses', async () => {
    const { client, gateway } = await grantedClient();
    const subPromise = client.diagnostics.subscribe({ network: true });
    await tick();
    await subPromise;

    // A boolean flag settled by a handler attached synchronously (before
    // any `tick()`), not `Promise.race`: racing an unresolved promise
    // against a resolved one is a timing gamble on microtask ordering,
    // not a deterministic check that the wait is still pending.
    let settled = false;
    const p = client.waitForNetworkIdle({ idleMs: 500, timeoutMs: 10000 });
    p.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    gateway.sendNetworkSummary(client.targetId, { inFlight: 0 });
    await tick(300); // idle timer armed but not yet at 500ms
    gateway.sendNetworkSummary(client.targetId, { inFlight: 1 }); // a new request started: cancels it
    await tick(400); // well past 500ms since the ORIGINAL zero reading, had it not been cancelled
    expect(settled).toBe(false);

    gateway.sendNetworkSummary(client.targetId, { inFlight: 0 });
    await tick(500);
    expect(settled).toBe(true);
    await expect(p).resolves.toBeUndefined();

    client.close();
  });

  it('rejects TIMEOUT when the in-flight count never comes down', async () => {
    const { client, gateway } = await grantedClient();
    const subPromise = client.diagnostics.subscribe({ network: true });
    await tick();
    await subPromise;

    const settled = client.waitForNetworkIdle({ idleMs: 200, timeoutMs: 1000 }).then(
      () => 'resolved',
      (e: unknown) => e as AutomationError,
    );

    gateway.sendNetworkSummary(client.targetId, { inFlight: 1 });
    await tick(1000);

    const result = await settled;
    expect((result as AutomationError).code).toBe('TIMEOUT');
    expect((result as AutomationError).message).toContain('1000ms');

    client.close();
  });

  it('ignores a network.summary for a different target', async () => {
    const { client, gateway } = await grantedClient();
    const subPromise = client.diagnostics.subscribe({ network: true });
    await tick();
    await subPromise;

    const settled = client.waitForNetworkIdle({ idleMs: 100, timeoutMs: 300 }).then(
      () => 'resolved',
      (e: unknown) => e as AutomationError,
    );

    gateway.sendNetworkSummary('tgt_some_other_target', { inFlight: 0 });
    await tick(300);

    const result = await settled;
    expect((result as AutomationError).code).toBe('TIMEOUT');

    client.close();
  });

  /**
   * Stands in for a gateway whose own `network.summary` has not been
   * updated to carry `inFlight` at all (the real state of this build,
   * per this method's own doc: `packages/protocol` and
   * `packages/server/src/session/managed-session.ts` do not send it yet).
   * This method must never fabricate a value for a field the wire never
   * sent; it times out honestly instead.
   */
  it('never resolves from a network.summary that carries no inFlight field, and times out honestly', async () => {
    const { client, gateway } = await grantedClient();
    const subPromise = client.diagnostics.subscribe({ network: true });
    await tick();
    await subPromise;

    const settled = client.waitForNetworkIdle({ idleMs: 100, timeoutMs: 300 }).then(
      () => 'resolved',
      (e: unknown) => e as AutomationError,
    );

    gateway.sendNetworkSummary(client.targetId); // no inFlight at all
    await tick(300);

    const result = await settled;
    expect((result as AutomationError).code).toBe('TIMEOUT');

    client.close();
  });

  it('honours a non-default maxInflight', async () => {
    const { client, gateway } = await grantedClient();
    const subPromise = client.diagnostics.subscribe({ network: true });
    await tick();
    await subPromise;

    const settled = client
      .waitForNetworkIdle({ maxInflight: 2, idleMs: 100, timeoutMs: 2000 })
      .then(
        () => 'resolved',
        (e: unknown) => e as AutomationError,
      );

    // 2 is "idle enough" under maxInflight: 2, even though it is not zero.
    gateway.sendNetworkSummary(client.targetId, { inFlight: 2 });
    await tick(100);

    expect(await settled).toBe('resolved');

    client.close();
  });
});
