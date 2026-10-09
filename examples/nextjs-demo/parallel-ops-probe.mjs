/**
 * The acceptance test for "drive N browsers, doing everything, all at once".
 *
 * `parallel-probe.mjs` already proves that navigate/reload/evaluate/read
 * overlap across N browsers. It does not touch the rest of the surface a
 * person actually uses: typing, clicking, selecting text, copy and paste,
 * keyboard navigation, scrolling, tab open and close, and reading console
 * and network diagnostics back out. Those are the operations that break
 * first when something in the input or diagnostics path is accidentally
 * keyed per connection instead of per target, because they are the ones
 * that carry a control lease and a rate limit bucket.
 *
 * So this probe runs the WHOLE surface concurrently on N separate
 * browsers and reports, per operation, whether the N executions actually
 * overlapped in time or merely took turns.
 *
 * The number that matters is not wall clock, it is OVERLAP. If the
 * gateway serialises an operation, the N busy windows for that operation
 * sit end to end and no pair intersects. If it is genuinely parallel,
 * they sit on top of each other. A serialised operation is reported as
 * SERIAL even when it is fast, because "fast" stops being true at N=50.
 *
 * Run:  N=5 node examples/nextjs-demo/parallel-ops-probe.mjs
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';
const N = Number(process.env.N ?? 4);

const log = (...a) => console.log(...a);

/**
 * A page with everything the input surface needs to prove it worked:
 * two text fields (so paste has somewhere to land that is not where copy
 * came from), a button that records that it was really clicked, a long
 * scrollable block, and a console line plus a fetch fired on load so the
 * diagnostics feeds have something to carry.
 */
const PAGE = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<title>parallel ops</title>
<style>
  body { font: 16px system-ui; margin: 0; padding: 16px; }
  input { display:block; width: 420px; font-size: 18px; padding: 8px; margin: 8px 0; }
  #tall { height: 3000px; background: linear-gradient(#fff, #ccc); }
  #log { font-family: monospace; white-space: pre; }
</style>
<h1 id="title">parallel ops</h1>
<input id="src" value="">
<input id="dst" value="">
<button id="btn" onclick="window.__clicks=(window.__clicks||0)+1;document.getElementById('log').textContent='clicked '+window.__clicks">click me</button>
<div id="log">no clicks</div>
<div id="scrolled">scrollY=0</div>
<div id="tall"></div>
<script>
  console.log('probe-console-marker');
  window.addEventListener('scroll', () => {
    document.getElementById('scrolled').textContent = 'scrollY=' + Math.round(window.scrollY);
  });
  fetch('https://example.com/', { mode: 'no-cors' }).catch(() => {});
</script>`)}`;

// --- timing bookkeeping ---------------------------------------------------
/** windows[op] = [[startMs, endMs], ...] one entry per member. */
const windows = new Map();
function record(op, member, start, end, ok, detail) {
  if (!windows.has(op)) windows.set(op, []);
  windows.get(op).push({ member, start, end, ok, detail });
}

/** Times one operation for one member and records its busy window. */
async function timed(op, member, fn) {
  const start = Date.now();
  try {
    const detail = await fn();
    record(op, member, start, Date.now(), true, detail);
    return detail;
  } catch (e) {
    record(op, member, start, Date.now(), false, `${e?.code ?? ''} ${e?.message ?? e}`.trim());
    return undefined;
  }
}

/** How many of the C(n,2) pairs of busy windows actually intersect. */
function overlapPairs(entries) {
  let overlapped = 0;
  let pairs = 0;
  for (let a = 0; a < entries.length; a += 1) {
    for (let b = a + 1; b < entries.length; b += 1) {
      pairs += 1;
      const lo = Math.max(entries[a].start, entries[b].start);
      const hi = Math.min(entries[a].end, entries[b].end);
      if (hi - lo > 0) overlapped += 1;
    }
  }
  return { overlapped, pairs };
}

// --- setup ----------------------------------------------------------------
async function mint() {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  if (!res.ok) throw new Error(`acquire failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function member(i) {
  const cred = await mint();
  const client = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  const tabs = await client.tabs.list();
  const targetId = tabs[0]?.targetId;
  const c = targetId ? client.forTarget(targetId) : client;
  await c.acquireControl();
  return { i, cred, client: c, root: client, targetId };
}

// --- the run --------------------------------------------------------------
async function drive(m) {
  const c = m.client;
  const i = m.i;

  // Diagnostics first, so the console line and the fetch that the page
  // fires on load are actually observed rather than missed.
  const consoleLines = [];
  const networkEvents = [];
  c.on('console', (ev) => consoleLines.push(ev));
  c.on('network', (ev) => networkEvents.push(ev));
  await timed('diagnostics.subscribe', i, async () => {
    await c.diagnostics.subscribe({ console: true, errors: true, network: true });
    return 'subscribed';
  });

  await timed(
    'navigate',
    i,
    async () => (await c.navigate(PAGE, { waitUntil: 'load' })).url?.slice(0, 24) ?? 'ok',
  );
  await timed('reload', i, async () => (await c.reload()).url?.slice(0, 24) ?? 'ok');

  // Typing through the real key event path, not fill().
  await timed('type', i, async () => {
    await c.click('css=#src');
    await c.type(`member-${i}-typed`);
    return c.evaluate('document.getElementById("src").value');
  });

  // fill() is the locator path: resolve, verify, set, verify again.
  await timed('fill', i, async () => {
    await c.fill('css=#dst', `member-${i}-filled`);
    return c.evaluate('document.getElementById("dst").value');
  });

  // Clicking a real button and reading back the side effect it caused.
  await timed('click', i, async () => {
    await c.click('css=#btn');
    return c.evaluate('document.getElementById("log").textContent');
  });

  // Coordinate clicking, the path the canvas UI uses.
  await timed('clickAt', i, async () => {
    const r = await c.rect(0, 0);
    await c.clickAt(40, 40);
    return r === null ? 'clicked' : 'clicked';
  });

  // Select all text in #src by triple clicking it, then copy, then paste
  // into #dst. This is the select / copy / paste chain.
  await timed('selectText', i, async () => {
    const box = await c.evaluate(
      'JSON.stringify((()=>{const r=document.getElementById("src").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})())',
    );
    const { x, y } = JSON.parse(box);
    await c.clickAt(x, y, { clickCount: 3 });
    return (
      c.evaluate('String(window.getSelection ? window.getSelection().toString() : "")') ||
      '(selection via input)'
    );
  });

  await timed('copy', i, async () => {
    await c.pressKey('a', { modifiers: ['Control'] });
    await c.pressKey('c', { modifiers: ['Control'] });
    return 'ctrl+a ctrl+c sent';
  });

  await timed('paste', i, async () => {
    const box = await c.evaluate(
      'JSON.stringify((()=>{const r=document.getElementById("dst").getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})())',
    );
    const { x, y } = JSON.parse(box);
    await c.clickAt(x, y);
    await c.pressKey('a', { modifiers: ['Control'] });
    await c.pressKey('v', { modifiers: ['Control'] });
    return c.evaluate('document.getElementById("dst").value');
  });

  await timed('pressKey', i, async () => {
    await c.pressKey('End');
    await c.pressKey('Tab');
    return 'End,Tab sent';
  });

  await timed('scroll', i, async () => {
    await c.scroll({ dy: 900 });
    await c.sleep(150);
    return c.evaluate('document.getElementById("scrolled").textContent');
  });

  await timed('moveTo', i, async () => {
    await c.moveTo(120, 120);
    return 'moved';
  });

  await timed('screenshot', i, async () => {
    const s = await c.screenshot();
    return `${s.width ?? '?'}x${s.height ?? '?'}`;
  });

  await timed('evaluate', i, async () => c.evaluate('document.title'));
  await timed('text', i, async () => `${(await c.text()).length} chars`);
  await timed('html', i, async () => `${(await c.html()).length} chars`);
  await timed('a11y', i, async () => `${(await c.a11y()).nodes?.length ?? 0} nodes`);

  // Tab lifecycle, concurrently across browsers.
  await timed(
    'tabs.open',
    i,
    async () => (await m.root.tabs.open({ url: 'about:blank' })).targetId?.slice(0, 12) ?? 'opened',
  );
  await timed('tabs.list', i, async () => `${(await m.root.tabs.list()).length} tabs`);
  await timed('tabs.close', i, async () => {
    const tabs = await m.root.tabs.list();
    const extra = tabs.find((t) => t.targetId !== m.targetId);
    if (extra) await m.root.tabs.close(extra.targetId);
    return extra ? 'closed' : 'nothing to close';
  });

  // Read the diagnostics that were accumulating this whole time.
  await timed('readConsole', i, async () => {
    const hit = consoleLines.some((l) => JSON.stringify(l).includes('probe-console-marker'));
    return `${consoleLines.length} lines, marker=${hit}`;
  });
  await timed('readNetwork', i, async () => `${networkEvents.length} events`);

  return { i, consoleLines: consoleLines.length, networkEvents: networkEvents.length };
}

async function main() {
  log(`\n=== bringing up ${N} independent browsers ===`);
  const tUp = Date.now();
  const members = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      member(i).catch((e) => ({ i, error: e?.message ?? String(e) })),
    ),
  );
  const live = members.filter((m) => !m.error);
  for (const m of members) {
    if (m.error) log(`  member ${m.i}: FAILED ${m.error}`);
    else log(`  member ${m.i}: ${m.cred.instanceId} target ${m.targetId}`);
  }
  log(`  ${live.length}/${N} up in ${Date.now() - tUp}ms`);
  if (live.length < 2) {
    log('\nNeed at least 2 live browsers to say anything about overlap.');
    process.exit(1);
  }

  log(`\n=== driving all ${live.length} through the full surface, concurrently ===`);
  const tDrive = Date.now();
  await Promise.all(live.map((m) => drive(m)));
  const driveMs = Date.now() - tDrive;

  log(`\n=== per operation: did the ${live.length} executions overlap? ===\n`);
  log(`  ${'operation'.padEnd(22)} ${'ok'.padEnd(6)} ${'overlap'.padEnd(9)} verdict`);
  log(`  ${'-'.repeat(22)} ${'-'.repeat(6)} ${'-'.repeat(9)} ${'-'.repeat(30)}`);

  const serialised = [];
  const failed = [];
  for (const [op, entries] of windows) {
    const { overlapped, pairs } = overlapPairs(entries);
    const okCount = entries.filter((e) => e.ok).length;
    const allOk = okCount === entries.length;
    // An operation that every member completed in under ~2ms can show no
    // overlap simply because it was too fast to collide. Only call it
    // serial if it was slow enough that overlap was actually possible.
    const slowest = Math.max(...entries.map((e) => e.end - e.start));
    const couldOverlap = slowest >= 15;
    const parallel = overlapped > 0 || !couldOverlap;
    const verdict = !allOk
      ? 'ERRORS'
      : parallel
        ? overlapped > 0
          ? 'parallel'
          : 'too fast to tell'
        : 'SERIAL';
    if (allOk && couldOverlap && overlapped === 0) serialised.push(op);
    if (!allOk) failed.push(op);
    log(
      `  ${op.padEnd(22)} ${`${okCount}/${entries.length}`.padEnd(6)} ${`${overlapped}/${pairs}`.padEnd(9)} ${verdict}`,
    );
  }

  if (failed.length > 0) {
    log('\n=== failures ===');
    for (const op of failed) {
      for (const e of windows.get(op).filter((x) => !x.ok))
        log(`  ${op} member ${e.member}: ${e.detail}`);
    }
  }

  // "did not throw" is not the same as "did the right thing". Print what
  // the operations that carry a payload actually came back with, so a
  // silently empty console feed cannot pass as a green row above.
  log('\n=== what came back (proof the calls did something) ===');
  for (const op of [
    'type',
    'fill',
    'click',
    'selectText',
    'paste',
    'scroll',
    'readConsole',
    'readNetwork',
    'a11y',
    'screenshot',
  ]) {
    const entries = windows.get(op) ?? [];
    for (const e of entries)
      log(`  ${op.padEnd(12)} member ${e.member}: ${JSON.stringify(e.detail)}`);
  }

  // Hard assertions on the payloads, so this probe fails loudly rather
  // than reporting a green table over an empty diagnostics feed.
  const assertions = [];
  const detailsOf = (op) => (windows.get(op) ?? []).map((e) => String(e.detail ?? ''));
  assertions.push(['typing reached the page', detailsOf('type').every((d) => d.includes('typed'))]);
  assertions.push(['fill reached the page', detailsOf('fill').every((d) => d.includes('filled'))]);
  assertions.push([
    'click ran the page handler',
    detailsOf('click').every((d) => d.includes('clicked')),
  ]);
  assertions.push([
    'scroll actually moved the page',
    detailsOf('scroll').every((d) => /scrollY=[1-9]/.test(d)),
  ]);
  assertions.push([
    'console feed carried the page marker',
    detailsOf('readConsole').every((d) => d.includes('marker=true')),
  ]);
  assertions.push([
    'network feed carried events',
    detailsOf('readNetwork').every((d) => !/^0 events/.test(d)),
  ]);
  assertions.push(['a11y returned a tree', detailsOf('a11y').every((d) => !/^0 nodes/.test(d))]);

  log('\n=== payload assertions ===');
  let assertionFailures = 0;
  for (const [name, ok] of assertions) {
    if (!ok) assertionFailures += 1;
    log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  }

  log(`\n  total wall clock for the whole surface on ${live.length} browsers: ${driveMs}ms`);
  log(`  operations measured: ${windows.size}`);
  log(`  serialised operations: ${serialised.length === 0 ? 'none' : serialised.join(', ')}`);

  log('\n=== tearing down ===');
  const tClose = Date.now();
  await Promise.all(
    live.map(async (m) => {
      try {
        m.root.close();
        await fetch(`${BASE}/api/browser?instanceId=${m.cred.instanceId}`, { method: 'DELETE' });
      } catch (e) {
        log(`  member ${m.i} teardown failed: ${e?.message ?? e}`);
      }
    }),
  );
  log(`  closed in ${Date.now() - tClose}ms`);

  const bad = failed.length > 0 || serialised.length > 0 || assertionFailures > 0;
  log(
    `\n${bad ? 'FAIL' : 'PASS'}: ${failed.length} operation(s) with errors, ${serialised.length} serialised, ${assertionFailures} payload assertion(s) failed.`,
  );
  process.exit(bad ? 1 : 0);
}

main().then(undefined, (e) => {
  console.error('probe failed:', e);
  process.exit(2);
});
