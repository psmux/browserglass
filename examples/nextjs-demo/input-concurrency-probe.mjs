/**
 * Two questions this answers, both raised by driving several browsers at
 * once and watching input silently do nothing while every call returned
 * success:
 *
 *  1. Does `type()` ever put text on the page? (Serially it does not,
 *     which makes it a plain bug rather than a concurrency one.)
 *  2. Do mouse and wheel events survive concurrency? Serially a click
 *     runs the page's handler and a wheel scrolls the page. Under a
 *     four-way concurrent drive both stopped taking effect, while still
 *     reporting success.
 *
 * So: run the SAME tiny script at increasing concurrency and count how
 * many browsers each operation actually reached. An operation that
 * reaches 4/4 at N=1 and 1/4 at N=8 is being dropped under load, and
 * dropped silently, which is worse than failing.
 *
 * `insertText` is measured next to `type` on purpose: they are the two
 * spellings of the same intent, and if one lands and the other does not
 * that isolates the fault to the key-event path rather than to focus or
 * to the lease.
 *
 * Run:  node examples/nextjs-demo/input-concurrency-probe.mjs
 *       LEVELS=1,4,8 node examples/nextjs-demo/input-concurrency-probe.mjs
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';
const LEVELS = (process.env.LEVELS ?? '1,2,4').split(',').map(Number);

const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8"><title>input concurrency</title>
<style>body{font:16px system-ui;margin:0;padding:16px}input{display:block;width:400px;font-size:18px;padding:8px;margin:6px 0}#tall{height:3000px}</style>
<input id="typed" value="">
<input id="inserted" value="">
<button id="btn" onclick="document.getElementById('log').textContent='clicked'">click me</button>
<div id="log">no clicks</div>
<div id="scrolled">scrollY=0</div>
<div id="tall"></div>
<script>window.addEventListener('scroll',()=>{document.getElementById('scrolled').textContent='scrollY='+Math.round(window.scrollY)})</script>`)}`;

const log = (...a) => console.log(...a);

async function mint() {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  if (!res.ok) throw new Error(`acquire ${res.status}: ${await res.text()}`);
  return res.json();
}

/** One browser, one pass over the input surface. Returns what landed. */
async function one() {
  const cred = await mint();
  const root = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  const result = { instanceId: cred.instanceId };
  try {
    const tabs = await root.tabs.list();
    const c = root.forTarget(tabs[0].targetId);
    await c.acquireControl();
    await c.navigate(PAGE, { waitUntil: 'load' });

    await c.click('css=#typed');
    await c.type('hello');
    await c.sleep(200);
    result.type = await c.evaluate('document.getElementById("typed").value');

    await c.click('css=#inserted');
    await c.insertText('world');
    await c.sleep(200);
    result.insertText = await c.evaluate('document.getElementById("inserted").value');

    await c.click('css=#btn');
    await c.sleep(250);
    result.click = await c.evaluate('document.getElementById("log").textContent');

    await c.scroll({ dy: 900 });
    await c.sleep(300);
    result.scroll = await c.evaluate('document.getElementById("scrolled").textContent');
  } catch (e) {
    result.error = `${e?.code ?? ''} ${e?.message ?? e}`.trim();
  } finally {
    root.close();
    await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' }).catch(
      () => {},
    );
  }
  return result;
}

const LANDED = {
  type: (r) => r.type === 'hello',
  insertText: (r) => r.insertText === 'world',
  click: (r) => r.click === 'clicked',
  scroll: (r) => /scrollY=[1-9]/.test(r.scroll ?? ''),
};

async function main() {
  log('\nHow many browsers did each operation actually reach?\n');
  log(
    `  ${'concurrency'.padEnd(12)} ${Object.keys(LANDED)
      .map((k) => k.padEnd(12))
      .join('')}`,
  );
  log(`  ${'-'.repeat(12)} ${'-'.repeat(48)}`);

  const table = [];
  for (const n of LEVELS) {
    const results = await Promise.all(
      Array.from({ length: n }, () => one().catch((e) => ({ error: String(e) }))),
    );
    const row = { n };
    const cells = [];
    for (const [op, landed] of Object.entries(LANDED)) {
      const hits = results.filter(landed).length;
      row[op] = `${hits}/${n}`;
      cells.push(`${hits}/${n}`.padEnd(12));
    }
    table.push({ row, results });
    log(`  ${String(n).padEnd(12)} ${cells.join('')}`);
    const errs = results.filter((r) => r.error);
    for (const e of errs) log(`      error: ${e.error}`);
  }

  log('\nRaw values from the highest concurrency level:');
  const last = table[table.length - 1];
  for (const r of last.results) {
    log(
      `  ${r.instanceId ?? '(failed)'}  type=${JSON.stringify(r.type)} insertText=${JSON.stringify(r.insertText)} click=${JSON.stringify(r.click)} scroll=${JSON.stringify(r.scroll)}`,
    );
  }

  log('\nReading the table:');
  log('  An operation at n/n on every row is fine.');
  log(
    '  An operation that starts at n/n and falls off as concurrency rises is dropped under load.',
  );
  log('  An operation at 0/n on EVERY row is broken outright, concurrency is not involved.');

  const broken = Object.keys(LANDED).filter((op) => table.every((t) => t.row[op].startsWith('0/')));
  const degrading = Object.keys(LANDED).filter((op) => {
    const first = table[0].row[op];
    const lastRow = table[table.length - 1].row[op];
    const rate = (s) => {
      const [a, b] = s.split('/').map(Number);
      return b === 0 ? 1 : a / b;
    };
    return rate(first) > rate(lastRow) + 0.01;
  });

  log(`\n  broken outright:   ${broken.length ? broken.join(', ') : 'none'}`);
  log(`  degrades on load:  ${degrading.length ? degrading.join(', ') : 'none'}`);
  process.exit(broken.length + degrading.length > 0 ? 1 : 0);
}

main().then(undefined, (e) => {
  console.error('probe failed:', e);
  process.exit(2);
});
