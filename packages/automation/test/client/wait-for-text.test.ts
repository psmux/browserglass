// @vitest-environment jsdom
import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildWaitForTextPredicate } from '../../src/client/AutomationClient.js';
import type { AutomationError } from '../../src/errors.js';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { fixtureOptions, tick } from '../helpers.js';

/** The harness's own default granted set, plus `evaluate`. Copied from `evaluate.test.ts` rather than shared: each file owning its own fixture is this suite's established pattern (`locator.test.ts` defines its own `grantedClient` too). */
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

async function grantedClient(opts?: { granted?: string[] }) {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const gateway = startScriptedGateway(harness, {
    granted: (opts?.granted ?? GRANTED_WITH_EVALUATE) as Capability[],
  });
  const client = await connectPromise;
  return { client, gateway, harness };
}

/**
 * `buildWaitForTextPredicate`, run against a real DOM.
 *
 * `@vitest-environment jsdom` for this whole file (not just this describe
 * block) is what lets it: `AutomationClient.waitForText`'s predicate is
 * page-side JavaScript authored as text, for the same reason
 * `locator/script.ts`'s scripts are (`page.evaluate` never sees a live
 * closure over this process, only a re-parsed function or expression), and
 * the point of pulling it out into its own exported function was exactly
 * so it could be executed here rather than only ever driven through a
 * mocked evaluate reply. See `AutomationClient.ts`'s own doc on
 * `buildWaitForTextPredicate` for why it lives there and not in
 * `locator/script.ts`: it is deliberately NOT part of the `>>`-chained
 * locator dialect.
 */
describe('buildWaitForTextPredicate, against a real DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function run(selector: string, text: string, exact = false): unknown {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(`return ${buildWaitForTextPredicate(selector, text, exact)};`)();
  }

  it('matches a substring, case-insensitively, by default', () => {
    document.body.innerHTML = '<div id="status">Application Submitted</div>';
    expect(run('#status', 'submitted')).toBe('application submitted');
    expect(run('#status', 'SUBMITTED')).toBe('application submitted');
    expect(run('#status', 'not there')).toBe(false);
  });

  it('collapses whitespace before comparing, the same normalisation the text= locator engine applies', () => {
    document.body.innerHTML = '<div id="status">  Application\n  Submitted  </div>';
    expect(run('#status', 'application submitted')).toBe('application submitted');
  });

  it('requires the WHOLE normalised text to match when exact is true, not merely contain it', () => {
    document.body.innerHTML = '<div id="status">Application Submitted</div>';
    expect(run('#status', 'Submitted', true)).toBe(false);
    expect(run('#status', 'Application Submitted', true)).toBe('application submitted');
  });

  it('checks every element the selector matches, not only the first', () => {
    document.body.innerHTML = '<div class="row">Pending</div><div class="row">Submitted</div>';
    expect(run('.row', 'submitted')).toBe('submitted');
  });

  it('reads textContent, so text hidden by CSS still counts (the same trade-off the text= engine documents)', () => {
    document.body.innerHTML = '<div id="status" style="display:none">Submitted</div>';
    expect(run('#status', 'submitted')).toBe('submitted');
  });

  it('returns false, never throwing, when the selector matches nothing at all', () => {
    document.body.innerHTML = '<div>irrelevant</div>';
    expect(run('#missing', 'submitted')).toBe(false);
  });
});

/**
 * `AutomationClient.waitForText()` over the socket: the wiring
 * `waitForFunction` gives it (one `run()` for the whole wait, real polling
 * over `page.evaluate`), plus the timeout message this method adds on top.
 */
describe('AutomationClient.waitForText', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends an expression, not a functionDeclaration, carrying the selector and text as JSON literals', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      ok: true,
      resultType: 'value',
      value: 'saved',
      sizeBytes: 5,
    });

    const p = client.waitForText('#toast', 'Saved');
    await tick();
    await p;

    const call = gateway.evaluateCalls.at(-1);
    expect(call?.['expression']).toContain(JSON.stringify('#toast'));
    expect(call?.['expression']).toContain(JSON.stringify('Saved'));
    expect(call).not.toHaveProperty('functionDeclaration');
  });

  it('polls through waitForFunction rather than opening a second poller: several evaluates, one run() worth of step budget', async () => {
    const { client, gateway } = await grantedClient();
    let calls = 0;
    gateway.evaluateResponder = () => {
      calls += 1;
      return calls < 3
        ? { ok: true, resultType: 'value', value: false, sizeBytes: 5 }
        : { ok: true, resultType: 'value', value: 'saved', sizeBytes: 5 };
    };

    const p = client.waitForText('#toast', 'Saved', { pollingMs: 50, timeoutMs: 5000 });
    await tick(200);
    expect(await p).toBe('saved');
    expect(calls).toBe(3);
  });

  it("times out naming the selector and the text it never found, not waitForFunction's generic predicate message", async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      ok: true,
      resultType: 'value',
      value: false,
      sizeBytes: 5,
    });

    const p = client.waitForText('#toast', 'Saved', { timeoutMs: 300, pollingMs: 100 });
    const settled = p.then(
      () => null,
      (e: unknown) => e as AutomationError,
    );
    await tick(1000);
    const err = await settled;
    expect(err?.code).toBe('TIMEOUT');
    expect(err?.message).toContain('#toast');
    expect(err?.message).toContain('Saved');
    expect(err?.details).toMatchObject({ selector: '#toast', text: 'Saved', exact: false });
  });

  it('refuses locally when the token lacks evaluate, without a round trip', async () => {
    const harness = createFakeGatewayHarness();
    const connectPromise = AutomationClient.connect(fixtureOptions(harness));
    await tick();
    const gateway = startScriptedGateway(harness);
    const client = await connectPromise;

    await expect(client.waitForText('#toast', 'Saved')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'evaluate' },
    });
    expect(gateway.evaluateCalls).toHaveLength(0);
    client.close();
  });
});
