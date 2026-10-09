import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFakeClient, tick } from '../helpers.js';

/**
 * End to end verification against a scripted fake gateway (see
 * `../fake-gateway.ts`) rather than a real `@browserglass/server`. This
 * suite substitutes a
 * hand-scripted `bgls.v1` responder speaking just enough of the protocol
 * to exercise connect, acquire control, navigate, click, screenshot, and
 * release, plus the preemption contract mid `humanType()`.
 */
describe('AutomationClient', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drives connect, acquireControl, navigate, clickAt, screenshot, release end to end', async () => {
    const { client, gateway } = await connectFakeClient();

    expect(client.viewerId).toBe('vwr_00000000000000000000000001');
    expect(client.instanceId).toBe('inst_0000000000000000000000001');
    expect(client.targetId).toBe('tgt_0000000000000000000000001');
    expect(client.granted.has('control')).toBe(true);

    const leasePromise = client.acquireControl({ waitMs: 5000 });
    await tick();
    const lease = await leasePromise;
    expect(lease.leaseId).toMatch(/^lease_/);
    expect(lease.priority).toBe(50);

    const navPromise = client.navigate('https://example.test/page');
    await tick();
    const nav = await navPromise;
    expect(nav.url).toBe('https://example.test/page');
    expect(nav.loading).toBe(false);

    const clickPromise = client.clickAt(100, 200, { button: 'left' });
    await tick();
    await clickPromise;
    const sent = gateway.ws.sentJsonMessages();
    const down = sent.find((m) => m['t'] === 'input.mouse' && m['kind'] === 'down');
    const up = sent.find((m) => m['t'] === 'input.mouse' && m['kind'] === 'up');
    expect(down).toMatchObject({
      x: 100,
      y: 200,
      leaseId: lease.leaseId,
      targetId: client.targetId,
    });
    expect(up).toMatchObject({ x: 100, y: 200, leaseId: lease.leaseId });

    const shotPromise = client.screenshot();
    await tick();
    const shot = await shotPromise;
    expect(shot.data).toBe('ZmFrZQ==');
    expect(shot.format).toBe('png');

    const releasePromise = lease.release();
    await tick();
    await releasePromise;
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'control.release')).toBe(true);

    client.close();
  });

  it('pdf() returns inline data when the reply carries it, and forwards options on the wire', async () => {
    const { client, gateway } = await connectFakeClient();

    const pdfPromise = client.pdf({ format: 'A4', landscape: true, scale: 0.9 });
    await tick();
    const result = await pdfPromise;
    expect(result.data).toBe('ZmFrZQ==');
    expect(result.downloadId).toBeUndefined();
    expect(result.url).toBeUndefined();

    const sent = gateway.pdfCalls.at(-1);
    expect(sent).toMatchObject({ t: 'page.pdf.get', format: 'A4', landscape: true, scale: 0.9 });

    client.close();
  });

  it('pdf() DOES NOT throw NOT_IMPLEMENTED for a download-delivery reply, unlike screenshot(): it returns downloadId/url/expiresAt/sha256 with data absent', async () => {
    const { client, gateway } = await connectFakeClient();

    gateway.pdfResponder = (msg) => ({
      t: 'page.pdf.got',
      pdfId: 'pdf_big',
      targetId: msg['targetId'],
      sizeBytes: 500000,
      gen: 1,
      downloadId: 'pdf_big',
      url: '/v1/downloads/faketoken',
      expiresAt: Date.now() + 60000,
      sha256: 'a'.repeat(64),
    });

    const pdfPromise = client.pdf();
    await tick();
    const result = await pdfPromise;
    expect(result.data).toBeUndefined();
    expect(result.downloadId).toBe('pdf_big');
    expect(result.url).toBe('/v1/downloads/faketoken');
    expect(result.sizeBytes).toBe(500000);
    expect(result.sha256).toBe('a'.repeat(64));

    client.close();
  });

  it('clickAt() throws LEASE_NOT_HELD before any CDP traffic when no lease is held', async () => {
    const { client, gateway } = await connectFakeClient();

    await expect(client.clickAt(1, 1)).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'input.mouse')).toBe(false);

    client.close();
  });

  it('status() is built from cached broadcasts with no CDP traffic', async () => {
    const { client, gateway } = await connectFakeClient();

    const before = gateway.ws.sentJsonMessages().length;
    const status = await client.status();
    expect(status.url).toBe('https://example.test/');
    expect(status.title).toBe('Example');
    expect(gateway.ws.sentJsonMessages().length).toBe(before);

    client.close();
  });

  /**
   * `text()`, `html()` and `waitForFunction()` are no longer in this list:
   * they are implemented on top of `page.evaluate` and are covered by
   * `./evaluate.test.ts`. What they throw now is `POLICY_DENIED` when the
   * token lacks the `evaluate` capability (which the harness's default
   * granted set deliberately does not carry), which is a different and
   * correct answer, not a stub.
   *
   * `click()`, `fill()`, `waitForSelector()` and `resolve()` have since
   * left this list too: the locator engine is built. They now refuse on
   * the missing `evaluate` capability, exactly as `text()` does, which is
   * what proves they are wired rather than stubbed.
   *
   * `select()` and `waitForText()` left this list in the same pass that
   * built them: `select()` on top of the locator engine and
   * `locator/script.ts`'s `SELECT_SCRIPT` (own test coverage in
   * `./locator.test.ts`'s `describe('select', ...)`), `waitForText()` as a
   * thin wrapper over `waitForFunction()` (own coverage in
   * `./evaluate.test.ts`). Both now refuse on the missing `evaluate`
   * capability, the same as every other locator-surface verb, which is
   * what proves they are wired rather than stubbed.
   *
   * `waitForNetworkIdle()` has also since left this list: `TargetDiagnostics`
   * (`packages/core/src/diagnostics/target-diagnostics.ts`) now publishes
   * the in-flight count it was already tracking internally
   * (`pendingRequests.size`) as `NetworkSummaryPayload.inFlight`, and this
   * method watches that. It refuses on the missing `devtools` capability
   * (which the harness's default granted set deliberately does not
   * carry) rather than throwing `NOT_IMPLEMENTED`, the same shape as the
   * `evaluate`-gated methods below; its own working behaviour has separate
   * coverage in `./wait-for-network-idle.test.ts`.
   *
   * `a11y()` has also since left this list: `packages/core/src/cdp/accessibility.ts`
   * is now the one place in this build that sends `Accessibility.queryAXTree`,
   * and `a11y()` is its read-only caller. It refuses on the missing
   * `devtools` capability, checked locally before any round trip, exactly
   * like `waitForNetworkIdle()` below; its own working behaviour has
   * separate coverage in `./a11y.test.ts`.
   *
   * What stays refused is refused BY DESIGN rather than for want of a
   * build pass: `elements()` would have to return handles this wire will
   * never carry, and `waitForDownload()` needs a download event bridge
   * that is declared on the wire but that nothing server side sends yet.
   */
  it('every still-refused method throws a typed NOT_IMPLEMENTED naming what it needs', async () => {
    const { client } = await connectFakeClient();

    await expect(client.elements()).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' });

    // Every refusal names a working alternative rather than just refusing,
    // because "not implemented" without a next step is the least useful
    // true thing an SDK can say.
    await expect(client.elements()).rejects.toMatchObject({
      message: expect.stringContaining('resolve(selector)'),
    });

    // `a11y()` refuses on the missing `devtools` capability, checked
    // locally before any round trip, exactly like `waitForNetworkIdle()`
    // just below.
    await expect(client.a11y()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });

    // `waitForDownload()` is no longer in the list above: the download
    // bridge it was waiting on now exists (`packages/core/src/downloads/`),
    // so it refuses on the missing capability like every other implemented
    // verb, not on being unbuilt.
    await expect(client.waitForDownload()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'download' },
    });

    // `waitForNetworkIdle()` refuses on the missing `devtools` capability,
    // checked locally before any round trip, exactly like the
    // `evaluate`-gated methods just below.
    await expect(client.waitForNetworkIdle()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'devtools' },
    });

    // The ones page evaluation and the locator engine implemented refuse
    // on the capability instead.
    for (const call of [
      () => client.text(),
      () => client.html(),
      () => client.waitForFunction('window.ready'),
      () => client.resolve('button'),
      () => client.waitFor('button'),
      () => client.waitForSelector('button'),
      () => client.click('button'),
      () => client.fill('input', 'x'),
      () => client.innerText('button'),
      () => client.getAttribute('button', 'id'),
      () => client.isChecked('input'),
      () => client.scrollIntoView('button'),
      () => client.select('select', 'x'),
      () => client.waitForText('div', 'x'),
    ]) {
      await expect(call()).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: { required: 'evaluate' },
      });
    }

    client.close();
  });

  it('forTarget() shares the socket, capability grants, and lease table with the parent client', async () => {
    const { client } = await connectFakeClient();
    const sub = client.forTarget('tgt_other');
    expect(sub.targetId).toBe('tgt_other');
    expect(sub.granted).toBe(client.granted);
    client.close();
  });

  it('tabs.list(), tabs.open(), and tabs.active() round trip through target.list/target.new and the cached target list', async () => {
    const { client, gateway } = await connectFakeClient();

    const listPromise = client.tabs.list();
    await tick();
    await listPromise;
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'target.list')).toBe(true);

    const openPromise = client.tabs.open({ url: 'https://example.test/new' });
    await tick();
    const opened = await openPromise;
    expect(opened.url).toBe('https://example.test/new');

    const active = await client.tabs.active();
    expect(active?.targetId).toBe(client.targetId);

    client.close();
  });

  describe('the preemption contract', () => {
    it('a preemption mid-humanType surfaces LEASE_REVOKED with details.lastCompletedStep, abandons rather than pausing, and blocks an immediate re-acquire', async () => {
      const { client, gateway } = await connectFakeClient();

      // Prime the target generation with a plain round trip so humanType's
      // own per-character `ensureGen()` calls resolve from cache, keeping
      // the fake-timer trace deterministic.
      await client.inspectAt(0, 0);

      const leasePromise = client.acquireControl({ waitMs: 5000 });
      await tick();
      await leasePromise;

      const text = 'hello world';
      const typePromise = client.humanType(text, { delayMs: 80 });
      // The rejection actually settles inside a later `tick()` call below,
      // before this test attaches its real handler via the `try`/`await`
      // further down; a bare no-op catch here just keeps Node/Vitest from
      // flagging that ordinary gap as an unhandled rejection.
      typePromise.catch(() => {});

      // Let two characters complete before the human takes over.
      await tick(80);
      await tick(80);

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: false,
        requeueAfterMs: 30000,
      });

      // Drain the rest of the (aborted) call: enough virtual time for the
      // whole string to have completed had it not been abandoned.
      await tick(2000);

      let caught: unknown;
      try {
        await typePromise;
      } catch (err) {
        caught = err;
      }
      expect(caught).toMatchObject({
        code: 'LEASE_REVOKED',
        details: expect.objectContaining({ partial: true, charsTotal: text.length }),
      });
      const details = (caught as { details: { lastCompletedStep: number; charsTyped: number } })
        .details;
      // Abandoned, not paused: fewer than the full string was sent, and the
      // reported step is the last character actually dispatched, not the
      // full length.
      expect(details.lastCompletedStep).toBeGreaterThanOrEqual(0);
      expect(details.lastCompletedStep).toBeLessThan(text.length - 1);
      expect(details.charsTyped).toBeLessThan(text.length);

      // No auto-retry: exactly the one control.request this test itself sent.
      const controlRequests = gateway.ws
        .sentJsonMessages()
        .filter((m) => m['t'] === 'control.request');
      expect(controlRequests.length).toBe(1);

      // Agent obligation: must not re-request control before requeueAfterMs.
      await expect(client.acquireControl({ waitMs: 0 })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
      });

      client.close();
    });

    it('onRevoked fires exactly once with preempted_by_human when the holder does not release inside the grace', async () => {
      const { client, gateway } = await connectFakeClient();
      const leasePromise = client.acquireControl({ waitMs: 5000 });
      await tick();
      const lease = await leasePromise;

      const seen: string[] = [];
      lease.onRevoked((reason) => seen.push(reason));
      lease.onPreemptionRequested((req) => {
        expect(req.byLabel).toBe('Alice');
        expect(req.reason).toBe('human_takeover');
      });

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: false,
        requeueAfterMs: 30000,
      });

      expect(seen).toEqual(['preempted_by_human']);
      expect(lease.isValid).toBe(false);

      client.close();
    });
  });

  /**
   * Every `input.*` dispatch (`type()`, `insertText()`, `click()`,
   * `scroll()`) is fire-and-forget: `AutomationCore.send()` never awaits a
   * reply, because `ws/connection.ts`'s own input path carries no `id` to
   * correlate one against. The server's ONLY way to tell a caller that a
   * keystroke it sent never reached the page is an uncorrelated `error`
   * push (`bgls.error.input.dispatch_failed`, `managed-session.ts`'s
   * `reportInputSignal`). Before `AutomationCore.handleMessage` grew a
   * `case 'error':`, that push fell through `default: break` and vanished
   * silently, so a server correctly reporting a dropped keystroke and an
   * SDK that discarded the report looked identical to a caller: quiet
   * success either way. This is the fix, verified independent of the
   * server-side reporting change: whatever sends an uncorrelated `error`
   * envelope, this client must surface it rather than swallow it.
   */
  it('surfaces an uncorrelated error push (a dropped input) as a protocolerror event', async () => {
    const { client, gateway } = await connectFakeClient();

    const seen: unknown[] = [];
    client.on('protocolerror', (err) => seen.push(err));

    gateway.ws.simulateJson({
      v: 1,
      t: 'error',
      ts: Date.now(),
      code: 'bgls.error.input.dispatch_failed',
      category: 'input',
      message: 'CDP dispatch failed: session lookup for tgt_1 exceeded 1000ms',
      fatal: false,
      retryable: true,
      context: { targetId: client.targetId },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      code: 'PROTOCOL_ERROR',
      message: expect.stringContaining('dispatch failed'),
    });

    client.close();
  });

  it('does NOT surface a correlated error (one with a matching re) as a protocolerror event', async () => {
    const { client, gateway } = await connectFakeClient();

    const seen: unknown[] = [];
    client.on('protocolerror', (err) => seen.push(err));

    // `AutomationCore.request()` directly, with a made-up type the fake
    // gateway's own responder switch does not recognise (falls through to
    // `default: break`, so it is never auto-answered): the only reply this
    // request will ever see is the one this test injects below, with `re`
    // matching this request's own `id`.
    // biome-ignore lint/suspicious/noExplicitAny: reaches the private `core` field to send a request type the public API does not expose.
    const core = (client as any).core;
    const reqPromise = core.request('made.up.type', {});
    await tick();
    const req = gateway.ws.sentJsonMessages().find((m) => m['t'] === 'made.up.type');
    expect(req).toBeDefined();

    gateway.ws.simulateJson({
      v: 1,
      t: 'error',
      ts: Date.now(),
      re: req?.['id'],
      code: 'bgls.error.target.not_found',
      category: 'target',
      message: 'target closed',
      fatal: false,
      retryable: false,
    });

    await expect(reqPromise).rejects.toMatchObject({ code: 'TARGET_CLOSED' });
    expect(seen).toHaveLength(0); // consumed by request()'s own rejection, not re-broadcast

    client.close();
  });
});
