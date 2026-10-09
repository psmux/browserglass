/**
 * The form parity probe.
 *
 * Every verb here corresponds to something a typical Playwright form
 * filling script does. It runs against a real
 * gateway and real Chrome, on a real page, so the answer is "it works" or
 * "here is the error", not "the method exists".
 *
 * Serves a form from a data: URL so the probe has no network dependency
 * and the DOM is fixed and known.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';

const PAGE = `<!doctype html><meta charset=utf8><title>Parity form</title>
<body style="font:16px system-ui;padding:24px">
<h1 id=h>Parity form</h1>
<form id=f>
  <input id=name name=name placeholder="Full name">
  <select id=country name=country>
    <option value="">Pick one</option>
    <option value="uk">United Kingdom</option>
    <option value="us">United States</option>
    <option value="in">India</option>
  </select>
  <input id=attachment type=file>
  <input id=agree type=checkbox>
  <button id=submit type=button>Submit</button>
</form>
<p id=status>idle</p>
<script>
  document.getElementById('submit').addEventListener('click', () => {
    document.getElementById('status').textContent = 'submitted:' +
      document.getElementById('name').value + '|' +
      document.getElementById('country').value + '|' +
      (document.getElementById('attachment').files.length ? document.getElementById('attachment').files[0].name : 'nofile');
  });
  setTimeout(() => { const d = document.createElement('div'); d.id='late'; d.textContent='late content arrived'; document.body.appendChild(d); }, 1200);
</script>`;

const URL_ = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`;

const results = [];
const settle = (ms = 600) => new Promise((r) => setTimeout(r, ms));

/**
 * `expect` is not optional decoration here. An earlier version of this
 * probe only checked that a verb did not throw, and reported 21/21 while
 * `fill` was writing nothing, the checkbox was never ticking, and the
 * form's submit handler never ran: every input message was being fenced
 * out as `gen_stale` and dropped, which throws nothing anywhere. A probe
 * that cannot tell "it worked" from "it returned" is worse than no probe.
 */
async function step(name, fn, expect) {
  const t0 = Date.now();
  try {
    const value = await fn();
    if (expect !== undefined) {
      const ok = typeof expect === 'function' ? expect(value) : Object.is(value, expect);
      if (!ok)
        throw new Error(
          `expected ${typeof expect === 'function' ? 'predicate to hold' : JSON.stringify(expect)}, got ${JSON.stringify(value)}`,
        );
    }
    results.push({ name, ok: true, ms: Date.now() - t0, value });
    console.log(
      `  PASS  ${name.padEnd(28)} ${String(Date.now() - t0).padStart(5)}ms  ${JSON.stringify(value ?? null)}`,
    );
  } catch (e) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - t0,
      error: `${e?.code ?? ''} ${e?.message ?? e}`.trim(),
    });
    console.log(
      `  FAIL  ${name.padEnd(28)} ${String(Date.now() - t0).padStart(5)}ms  ${e?.code ?? ''} ${e?.message ?? e}`,
    );
  }
}

async function main() {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  if (!res.ok) throw new Error(`acquire failed ${res.status}: ${await res.text()}`);
  const cred = await res.json();
  console.log(`\ninstance ${cred.instanceId}\n`);

  const client = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  const tabs = await client.tabs.list();
  const c = client.forTarget(tabs[0].targetId);
  await c.acquireControl();

  console.log('=== Form parity surface ===');
  await step('navigate', () =>
    c.navigate(URL_, { waitUntil: 'load' }).then((s) => `${s.url?.slice(0, 24)}...`),
  );
  await step(
    'evaluate',
    () => c.evaluate('document.getElementById("h").textContent'),
    'Parity form',
  );
  await step('evaluateWith(args)', () => c.evaluateWith((a, b) => a + b, [2, 40]), 42);
  await step('text()', () => c.text().then((t) => t.replace(/\s+/g, ' ').trim().slice(0, 30)));
  await step('html()', () => c.html().then((h) => h.length));
  await step('resolve', () =>
    c.resolve('#country').then((r) => `total=${r.total} visible=${r.matches[0]?.visible}`),
  );
  await step('waitForSelector', () => c.waitForSelector('#submit').then((r) => r.found ?? true));
  await step(
    'fill',
    () =>
      c
        .fill('#name', 'Ada Lovelace')
        .then(settle)
        .then(() => c.evaluate('document.getElementById("name").value')),
    'Ada Lovelace',
  );
  await step('select by value', () => c.select('#country', 'us'));
  await step('select by label', () => c.select('#country', { label: 'India' }));
  await step('select by index', () => c.select('#country', { index: 1 }));
  await step('select missing -> error', async () => {
    try {
      await c.select('#country', 'nope');
      return 'NO ERROR RAISED (bad)';
    } catch (e) {
      return `correctly threw ${e?.code}`;
    }
  });
  await step(
    'waitForText',
    () => c.waitForText('#late', 'late content').then(() => 'found'),
    'found',
  );
  await step('waitForFunction', () =>
    c.waitForFunction('document.getElementById("late") !== null'),
  );
  await step('innerText', () => c.innerText('#h'), 'Parity form');
  await step('getAttribute', () => c.getAttribute('#attachment', 'type'), 'file');
  await step(
    'click (checkbox)',
    () =>
      c
        .click('#agree')
        .then(settle)
        .then(() => c.isChecked('#agree')),
    true,
  );
  await step(
    'setInputFiles',
    () =>
      c.setInputFiles('#attachment', {
        name: 'invoice.pdf',
        mimeType: 'application/pdf',
        data: Buffer.from('%PDF-1.4 fake invoice').toString('base64'),
      }),
    (v) => Array.isArray(v) && v[0] === 'invoice.pdf',
  );
  // The end to end assertion: a real click on a real button, running the
  // page's own handler, which reads back values put there by fill, select
  // and setInputFiles. If any of those four only pretended to work, this
  // is the step that says so.
  await step(
    'click submit + read state',
    async () => {
      await c.click('#submit');
      await settle();
      return c.evaluate('document.getElementById("status").textContent');
    },
    'submitted:Ada Lovelace|uk|invoice.pdf',
  );
  await step('screenshot', () => c.screenshot().then((s) => `${s.width}x${s.height}`));

  client.close();
  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('probe failed:', e);
    process.exit(1);
  },
);
