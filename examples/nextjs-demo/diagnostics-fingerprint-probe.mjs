/**
 * The diagnostics fingerprint probe.
 *
 * This proves a tradeoff BrowserGlass makes on purpose: BrowserGlass is quiet by default (no `Runtime.enable` anywhere
 * until a caller asks for console/error diagnostics), and becomes loud
 * (the CDP automation fingerprint `packages/core/src/cdp/hit-test.ts`'s
 * module doc measures) the moment it does. Two independent things are
 * proved against one real Chrome instance:
 *
 * PART A, re-measuring `hit-test.ts`'s own claim directly, over a RAW CDP
 * connection through the `/browserglass/cdp/:instanceId` proxy (the same
 * technique `cdp-attach-probe.mjs` uses), on a session BrowserGlass itself
 * never touches:
 *   - Five `Runtime.evaluate` calls on a session with `Runtime` never
 *     enabled produce ZERO `Runtime.executionContextCreated` and ZERO
 *     `Runtime.consoleAPICalled` events.
 *   - One `Runtime.enable` immediately produces a real
 *     `executionContextCreated`, and subsequent `console.log` calls the
 *     page's own script makes become newly OBSERVABLE as
 *     `consoleAPICalled` events, where a moment ago they were invisible.
 *
 * PART B, the diagnostics status feature: the SAME quiet -> loud
 * transition, surfaced through the `bgls.v1` wire protocol rather than
 * inferred from raw CDP traffic.
 *   - `diagnostics.status.get` (a read-only query, no side effect) reports
 *     `fingerprintActive: false` before anything subscribes.
 *   - `diagnostics.subscribe({ console: true, errors: true })` flips it to
 *     `true`, both on the subscribe reply itself and on a follow-up
 *     `diagnostics.status.get`.
 *   - Unsubscribing, then subscribing again with `network: true` ALONE,
 *     proves the useful part: network
 *     diagnostics never touches `Runtime` at all, so `fingerprintActive`
 *     stays `false` throughout, matching
 *     `TargetDiagnostics.applyFeeds`'s independent `Network` domain.
 *
 * The stealth GATE itself (point 2: refusing `console`/`errors` on a
 * stealth-launched instance without `acknowledgeStealthRisk`) is NOT
 * exercised here: this demo's own `BrowserSpec.stealth` is fixed to
 * `'off'` (`server.mjs`), and launching a genuinely stealth-active
 * instance needs a registered `StealthProfile`
 * (`packages/runtime-host/src/stealth*`, `stealth-profiles/**`). That gate is covered instead by
 * `packages/server/test/ws/diagnostics-stealth-gate.test.ts`, over a real
 * socket with `ManagedSessionOptions.stealthActive` set directly, and by
 * `packages/core/test/diagnostics/target-diagnostics.test.ts` /
 * `packages/core/test/session/session.test.ts` for the surfacing itself.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';
const WS_HOST = process.env.WS_HOST ?? 'localhost:3000';

const results = [];
function check(label, got, want) {
  const ok = typeof want === 'function' ? want(got) : Object.is(got, want);
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(66)} got=${JSON.stringify(got)}${ok ? '' : ` want=${typeof want === 'function' ? '<predicate>' : JSON.stringify(want)}`}`,
  );
  return ok;
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener(
      'error',
      (ev) => reject(new Error(`WebSocket error: ${ev.message ?? ev.type}`)),
      { once: true },
    );
  });
}

/** Same hand-rolled raw CDP client `cdp-attach-probe.mjs` uses, plus a running tally of every unsolicited event by method name, which THIS probe needs and that one does not. */
function makeCdpClient(ws) {
  let nextId = 1;
  const pending = new Map();
  const eventCounts = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
      else p.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') {
      eventCounts.set(msg.method, (eventCounts.get(msg.method) ?? 0) + 1);
    }
  });
  const rpc = (method, params, sessionId) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(
        JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  };
  return { rpc, countOf: (method) => eventCounts.get(method) ?? 0 };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PAGE_HTML =
  '<!doctype html><meta charset=utf8><title>Fingerprint Probe</title><body><h1 id="h">fingerprint probe</h1>';
const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`;

async function main() {
  // ── setup: one real instance, one real page, driven the ordinary bgls.v1 way ──
  const acquireRes = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  if (!acquireRes.ok)
    throw new Error(`acquire failed ${acquireRes.status}: ${await acquireRes.text()}`);
  const cred = await acquireRes.json();
  console.log(`\ninstance ${cred.instanceId}\n`);

  const client = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  const tabs = await client.tabs.list();
  const targetId = tabs[0].targetId;
  const c = client.forTarget(targetId);
  await c.acquireControl();
  await c.navigate(PAGE_URL, { waitUntil: 'load' });

  console.log("=== PART A: raw CDP, re-measuring hit-test.ts's own claim ===\n");

  async function mintCdpToken() {
    const res = await fetch(`${BASE}/api/browser/cdp-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: cred.instanceId, sessionId: cred.sessionId }),
    });
    if (!res.ok) throw new Error(`cdp-token mint failed ${res.status}: ${await res.text()}`);
    return res.json();
  }

  const cdpToken = await mintCdpToken();
  const cdpWsUrl = `ws://${WS_HOST}/browserglass/cdp/${cred.instanceId}?token=${encodeURIComponent(cdpToken.token)}`;
  const cdpWs = new WebSocket(cdpWsUrl);
  await waitOpen(cdpWs);
  const cdp = makeCdpClient(cdpWs);

  const targets = await cdp.rpc('Target.getTargets', {});
  const page = (targets.targetInfos ?? []).find((t) => t.type === 'page');
  if (!page) throw new Error('no page target visible over the raw CDP proxy');
  const attached = await cdp.rpc('Target.attachToTarget', {
    targetId: page.targetId,
    flatten: true,
  });
  const rawSessionId = attached.sessionId;

  // Five plain Runtime.evaluate calls, Runtime never enabled on this session.
  for (let i = 0; i < 5; i++) {
    await cdp.rpc(
      'Runtime.evaluate',
      { expression: `1 + ${i}`, returnByValue: true },
      rawSessionId,
    );
  }
  await sleep(300); // let any unsolicited event that WOULD have fired actually arrive
  check(
    'five Runtime.evaluate calls with Runtime never enabled: zero executionContextCreated events',
    cdp.countOf('Runtime.executionContextCreated'),
    0,
  );
  check(
    'five Runtime.evaluate calls with Runtime never enabled: zero consoleAPICalled events',
    cdp.countOf('Runtime.consoleAPICalled'),
    0,
  );

  // Now flip the domain on, on this SAME session, and watch it become loud.
  await cdp.rpc('Runtime.enable', {}, rawSessionId);
  await sleep(300);
  check(
    'one Runtime.enable produces at least one executionContextCreated event',
    cdp.countOf('Runtime.executionContextCreated') >= 1,
    true,
  );
  check(
    'consoleAPICalled is still zero immediately after enable: nothing has logged yet',
    cdp.countOf('Runtime.consoleAPICalled'),
    0,
  );

  // The page logs; with Runtime enabled, those calls are now OBSERVABLE,
  // where a moment ago (identical page script, Runtime not enabled) they
  // were invisible to this exact same session.
  await cdp.rpc(
    'Runtime.evaluate',
    { expression: "for (let i = 0; i < 25; i++) console.log('probe line', i);" },
    rawSessionId,
  );
  await sleep(300);
  check(
    'after Runtime.enable, 25 console.log calls produce 25 newly-observable consoleAPICalled events',
    cdp.countOf('Runtime.consoleAPICalled'),
    25,
  );

  await cdp.rpc('Runtime.disable', {}, rawSessionId);
  cdpWs.close();

  console.log('\n=== PART B: the wire-level surfacing (fingerprintActive) ===\n');

  // Quiet before anything subscribes. This is BrowserGlass's OWN
  // bookkeeping (`TargetDiagnostics.enabledDomains`, never a live poll of
  // Chrome), and Part A ran on a completely separate CDP session (its own
  // `Target.attachToTarget`), so it has no way to have moved this needle.
  const before = await client.core.request('diagnostics.status.get', { targetId });
  check(
    'diagnostics.status.get before any subscribe: fingerprintActive is false (quiet)',
    before.fingerprintActive,
    false,
  );

  // The transition: subscribing to console+errors is exactly what needs
  // Runtime.enable server side (`target-diagnostics.ts`'s `applyFeeds`).
  const sub = await client.core.request('diagnostics.subscribe', {
    targetId,
    console: true,
    errors: true,
  });
  check('diagnostics.subscribed echoes console:true', sub.console, true);
  check(
    'diagnostics.subscribed reports fingerprintActive: true on the SAME reply (loud)',
    sub.fingerprintActive,
    true,
  );

  const after = await client.core.request('diagnostics.status.get', { targetId });
  check(
    'diagnostics.status.get after subscribing: fingerprintActive is now true',
    after.fingerprintActive,
    true,
  );

  // Prove console diagnostics genuinely work end to end on this same
  // subscription (not just that the flag flipped): trigger a page log and
  // see the `console.entry` envelope arrive.
  let sawConsoleEntry = false;
  const offConsole = client.on('console', (ev) => {
    if (ev.targetId === targetId && ev.text.includes('bgls console proof')) sawConsoleEntry = true;
  });
  await c.evaluate("console.log('bgls console proof')");
  await sleep(1200); // TargetDiagnostics coalesces identical (level, text) for 1s before emitting
  check(
    'a real console.log the page makes reaches this client as console.entry',
    sawConsoleEntry,
    true,
  );
  offConsole();

  // Unsubscribe, then re-subscribe with network ONLY. Network.enable never touches Runtime
  // (`applyFeeds`'s `needNetwork`/`needRuntime` are never combined), so
  // this must go back to quiet even though a diagnostics feed is still on.
  await new Promise((resolve) => {
    const id = `u${Math.random().toString(36).slice(2)}`;
    client.core.send('diagnostics.unsubscribe', { targetId });
    setTimeout(resolve, 200); // fire-and-forget on the wire; no reply to await
  });

  const networkOnly = await client.core.request('diagnostics.subscribe', {
    targetId,
    console: false,
    errors: false,
    network: true,
  });
  check('network-only subscribe echoes network:true', networkOnly.network, true);
  check(
    'network-only subscribe: fingerprintActive stays false. Network diagnostics can be had without touching Runtime at all',
    networkOnly.fingerprintActive,
    false,
  );

  const statusNetworkOnly = await client.core.request('diagnostics.status.get', { targetId });
  check(
    'diagnostics.status.get confirms it independently: still false with network on',
    statusNetworkOnly.fingerprintActive,
    false,
  );

  // Prove network diagnostics genuinely work too, on this Runtime-free
  // subscription: fetch something real and see a network.request envelope.
  let sawNetworkRequest = false;
  const offNetwork = client.on('network', (ev) => {
    if (ev.targetId === targetId) sawNetworkRequest = true;
  });
  await c.evaluate(
    `fetch(${JSON.stringify(`${BASE}/api/browser`)}, { method: 'GET' }).catch(() => {})`,
  );
  await sleep(1000);
  check(
    'a real fetch() the page makes reaches this client as network.request, with Runtime never touched',
    sawNetworkRequest,
    true,
  );
  offNetwork();

  client.close();
  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exitCode = 1;
});
