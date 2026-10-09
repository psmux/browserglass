/**
 * Proves `waitForNetworkIdle()` actually resolves against a real page.
 *
 * This one is worth a live probe rather than a unit test, because the verb
 * was built and then reported as still non-functional end to end: the
 * `inFlight` gauge existed in `core` but never reached the wire, so
 * against a real gateway the wait could only ever time out. Both halves
 * are now in place. A unit test with a scripted gateway cannot tell the
 * difference between "the field is forwarded" and "the field is not", so
 * the only honest check is a real browser making real requests.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';

/**
 * Fires three staggered same origin requests, the last landing ~1.2s in,
 * so a wait that resolves early is visibly wrong rather than lucky.
 *
 * The idle window has to be WIDER than the largest gap between two
 * consecutive requests. "Idle" means no request was in flight for
 * `idleMs`; it can never mean "the three requests I happened to plan have
 * all finished", because a page is always free to issue another one
 * later. So if a gap in the sequence exceeds the window, the wait is
 * RIGHT to resolve there and the probe is the thing that is wrong.
 *
 * The original numbers had that backwards: requests at 50, 500 and
 * 1200ms with `idleMs: 400` left a 700ms hole between the second and
 * third. `waitForNetworkIdle` correctly resolved in that hole, at ~715ms
 * with 2 of 3 done, and the probe called it a failure. It passed most of
 * the time only because a loaded machine stretched the middle request far
 * enough to close the hole, which is the worst kind of green.
 *
 * Widening `idleMs` alone did not fix it (still 1 flake in 3), because
 * the wait does not start until `evaluate(KICK)` returns, and that
 * round trip eats an unpredictable slice of the schedule. So the stagger
 * is tight instead: the largest gap is 300ms against a 900ms window,
 * which holds even when several hundred milliseconds of it have already
 * elapsed before the wait begins.
 */
const IDLE_MS = 900;
const LAST_REQUEST_AT_MS = 600;
const PAGE = `${BASE}/browser`;
const KICK = `
  window.__done = 0;
  const hit = (d) => setTimeout(() => {
    fetch('/api/browser/instances?netidle=' + d).then(() => { window.__done++; }).catch(() => { window.__done++; });
  }, d);
  hit(50); hit(300); hit(${LAST_REQUEST_AT_MS});
  'kicked'
`;

const results = [];
function check(label, got, want) {
  const ok = got === want;
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(56)} got=${JSON.stringify(got)}${ok ? '' : ` want=${JSON.stringify(want)}`}`,
  );
}

async function main() {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  const cred = await res.json();
  console.log(`\ninstance ${cred.instanceId}\n=== waitForNetworkIdle ===`);

  const client = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  const c = client.forTarget((await client.tabs.list())[0].targetId);
  await c.acquireControl();
  await c.navigate(PAGE, { waitUntil: 'load' });

  // The network feed has to be on: the gauge rides `network.summary`.
  await c.diagnostics.subscribe({ network: true });

  // Settle whatever the page itself was still doing on load, so the
  // measurement below is about OUR requests and not the demo's.
  await c.waitForNetworkIdle({ idleMs: IDLE_MS, timeoutMs: 15_000 }).catch(() => undefined);

  await c.evaluate(KICK);
  const started = Date.now();
  let threw = null;
  try {
    await c.waitForNetworkIdle({ idleMs: IDLE_MS, timeoutMs: 15_000 });
  } catch (e) {
    threw = `${e?.code ?? ''} ${e?.message ?? e}`.trim();
  }
  const elapsed = Date.now() - started;
  const done = await c.evaluate('window.__done');

  console.log(`  (resolved after ${elapsed}ms, page completed ${done}/3 requests)`);

  check('it resolves at all, rather than timing out', threw, null);
  // The last request is scheduled at 1200ms, so anything under that means
  // it declared idle while a request had not even been issued.
  check(
    'it did not resolve before the last request was issued',
    elapsed >= LAST_REQUEST_AT_MS,
    true,
  );
  check('every request had finished by the time it resolved', done, 3);
  check('it did not simply run to the timeout', elapsed < 14_000, true);

  client.close();
  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('netidle probe failed:', e);
  process.exit(1);
});
