/**
 * Proves the outbound request gate against real Chrome.
 *
 * The page below fires three fetches at three different paths. The gate
 * allows one, denies one outright with a server side rule, and asks about
 * the third so the verdict travels the full round trip. What the PAGE
 * observes (which fetches resolved and which threw) is the evidence,
 * because that is the only thing an application could act on.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';

// Same origin as the page, so nothing here depends on the outside network.
const PAGE = `<!doctype html><meta charset=utf8><title>gate</title><body>
<h1 id=h>gate probe</h1>
<script>
  window.results = {};
  async function hit(name, path) {
    try { const r = await fetch(path, { method: 'POST', body: 'x' }); window.results[name] = 'ok:' + r.status; }
    catch (e) { window.results[name] = 'blocked'; }
  }
  window.run = async () => {
    await hit('allowed', '/api/browser/instances?probe=allowed');
    await hit('denied',  '/api/browser/instances?probe=denied');
    await hit('asked',   '/api/browser/instances?probe=asked');
    return JSON.stringify(window.results);
  };
</script>`;

const results = [];
function check(label, got, want) {
  const ok = got === want;
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(46)} got=${JSON.stringify(got)}${ok ? '' : ` want=${JSON.stringify(want)}`}`,
  );
}

async function main() {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  const cred = await res.json();
  console.log(`\ninstance ${cred.instanceId}`);
  console.log(`caps include intercept: ${(cred.caps ?? []).includes('intercept')}\n`);

  const client = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  const c = client.forTarget((await client.tabs.list())[0].targetId);
  await c.acquireControl();

  // Serve the page from the demo's own origin so the fetches below are
  // same origin and reach a real server.
  await c.navigate(`${BASE}/browser`, { waitUntil: 'load' });
  await c.evaluate(`document.open(); document.write(${JSON.stringify(PAGE)}); document.close();`);
  await new Promise((r) => setTimeout(r, 400));

  console.log('=== request gate ===');

  const asked = [];
  const enabled = await c.gate.enable([
    { urlPattern: '*probe=denied*', verdict: 'deny' },
    { urlPattern: '*probe=asked*', verdict: 'ask', holdMs: 4000 },
    { urlPattern: '*', verdict: 'allow' },
  ]);
  check('gate.enable accepted all three rules', enabled.ruleCount, 3);

  // Answer the held request by denying it, so the round trip is what
  // decides the outcome rather than any server side rule.
  const off = c.gate.onPaused((ev) => {
    asked.push(ev.url);
    return 'deny';
  });

  const raw = await c.evaluate('window.run()');
  const seen = JSON.parse(raw);

  check('allowed request reached the server', String(seen.allowed).startsWith('ok:'), true);
  check('server side deny rule blocked the request', seen.denied, 'blocked');
  check('asked request was held and paused the caller', asked.length >= 1, true);
  check('caller verdict of deny blocked the request', seen.asked, 'blocked');

  off();

  // Disabling must actually let traffic through again.
  await c.gate.disable();
  await c.evaluate('window.results = {}');
  const raw2 = await c.evaluate('window.run()');
  const seen2 = JSON.parse(raw2);
  check(
    'after disable, previously denied request goes through',
    String(seen2.denied).startsWith('ok:'),
    true,
  );
  check(
    'after disable, previously asked request goes through',
    String(seen2.asked).startsWith('ok:'),
    true,
  );

  client.close();
  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('gate probe failed:', e);
  process.exit(1);
});
