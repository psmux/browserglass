/**
 * Two independent viewers on ONE browser, at the same time.
 *
 * This is the claim the whole shared control model rests on and it is not
 * covered by the other probes: `parallel-probe.mjs` drives N browsers with
 * one client each, which is a different thing entirely. Here two separate
 * connections, each with its own viewer id and its own lease, drive the
 * SAME target, and a third watches without driving.
 *
 * What is being proved:
 *  1. Two viewers can hold control of one target simultaneously (shared
 *     mode), neither queued behind the other.
 *  2. Both can actually dispatch, not merely be told they hold a lease.
 *  3. A watcher sees the same target and can take control on demand
 *     without anybody being kicked out.
 *  4. Attaching to an existing instance does NOT launch a second browser,
 *     which is the "why do new browsers keep opening" complaint.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';

const PAGE = `data:text/html,<body style="margin:0;font:16px system-ui">
<input id=a style="position:absolute;left:40px;top:40px;width:600px;height:40px">
<div id=log style="position:absolute;top:120px">idle</div>
<script>window.seen=[];document.addEventListener('click',e=>{window.seen.push(e.clientX+','+e.clientY);document.getElementById('log').textContent=window.seen.join(' | ')},true)</script>`;

const results = [];
function check(label, got, want) {
  const ok = got === want;
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(got)}${ok ? '' : ` want=${JSON.stringify(want)}`}`,
  );
}

/** A fresh credential for the SAME instance, as a different viewer would get. */
async function joinExisting(instanceId) {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId }),
  });
  if (!res.ok) throw new Error(`join failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function main() {
  // Viewer A launches.
  const aRes = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  const aCred = await aRes.json();
  console.log(`\ninstance ${aCred.instanceId}\n`);

  const a = await AutomationClient.connect({ endpoint: WS, token: aCred.token });
  const targetId = (await a.tabs.list())[0].targetId;
  const ca = a.forTarget(targetId);
  await ca.acquireControl();
  await ca.navigate(PAGE, { waitUntil: 'load' });

  console.log('=== two viewers, one browser ===');

  // Viewers B and C join the SAME instance.
  const bCred = await joinExisting(aCred.instanceId);
  const cCred = await joinExisting(aCred.instanceId);

  check(
    'joining an existing instance launches no new browser',
    bCred.instanceId === aCred.instanceId && cCred.instanceId === aCred.instanceId,
    true,
  );

  const b = await AutomationClient.connect({ endpoint: WS, token: bCred.token });
  const c = await AutomationClient.connect({ endpoint: WS, token: cCred.token });
  const cb = b.forTarget(targetId);
  const cc = c.forTarget(targetId);

  check(
    'all three viewers see the same target',
    (await b.tabs.list()).some((t) => t.targetId === targetId) &&
      (await c.tabs.list()).some((t) => t.targetId === targetId),
    true,
  );

  // B takes control while A still holds it. In shared mode this must be
  // immediate, with nobody queued and nobody evicted.
  const tB = Date.now();
  await cb.acquireControl();
  const bWaitMs = Date.now() - tB;
  check('second viewer gets control without queueing', bWaitMs < 2000, true);

  // Both drive the same target, concurrently.
  await Promise.all([ca.clickAt(100, 60), cb.clickAt(300, 60)]);
  await new Promise((r) => setTimeout(r, 900));
  const seen = JSON.parse(await ca.evaluate('JSON.stringify(window.seen)'));
  check('both drivers reached the page', seen.length >= 2, true);

  // Both type into the same field, interleaved. This is allowed and is the
  // documented hazard of shared control, not a defect: what matters is
  // that BOTH sets of characters arrive, not their order.
  await ca.evaluate('document.getElementById("a").focus()');
  await Promise.all([ca.insertText('AAA'), cb.insertText('BBB')]);
  await new Promise((r) => setTimeout(r, 900));
  const value = await ca.evaluate('document.getElementById("a").value');
  check(
    'both drivers typed into the same field',
    value.includes('AAA') && value.includes('BBB'),
    true,
  );

  // C is a watcher: it never acquired control. It must still be able to
  // read, and must be able to take control on demand.
  const watched = await cc.evaluate('document.getElementById("a").value');
  check('a watcher can read without holding control', watched === value, true);

  const tC = Date.now();
  await cc.acquireControl();
  check('a watcher can take control on demand, immediately', Date.now() - tC < 2000, true);

  // And A must still be driving: shared control evicts nobody.
  await ca.clickAt(150, 60);
  await new Promise((r) => setTimeout(r, 700));
  const after = JSON.parse(await ca.evaluate('JSON.stringify(window.seen)'));
  check('the first driver still drives after two others joined', after.length > seen.length, true);

  a.close();
  b.close();
  c.close();
  await fetch(`${BASE}/api/browser?instanceId=${aCred.instanceId}`, { method: 'DELETE' });

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('collab probe failed:', e);
  process.exit(1);
});
