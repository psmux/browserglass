/**
 * Measures whether N browsers really are driven at the same time, or only
 * look like it. Talks to the already-running demo gateway exactly the way
 * any third-party SDK consumer would: mint a token over REST, open a
 * socket, drive.
 *
 * The interesting number is not total wall clock. It is OVERLAP: if the
 * gateway serialises work, each browser's busy window sits end to end and
 * the union of the windows equals their sum. If it is genuinely parallel,
 * the windows sit on top of each other and the union is close to the
 * longest single one.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const N = Number(process.env.N ?? 3);
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';

const log = (...a) => console.log(...a);

async function mint(workspace) {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(workspace ? { workspace } : { fresh: true }),
  });
  if (!res.ok) throw new Error(`acquire failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/** One member: its own instance, its own socket, its own browser. */
async function member(i) {
  const t0 = Date.now();
  const cred = await mint(null);
  const client = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  return { i, cred, client, acquiredMs: Date.now() - t0 };
}

const marks = [];
function mark(who, phase, at = Date.now()) {
  marks.push({ who, phase, at });
}

async function main() {
  log(`\n=== spinning up ${N} members ===`);
  const tSpin = Date.now();
  const members = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      member(i).catch((e) => ({ i, error: e instanceof Error ? e.message : String(e) })),
    ),
  );
  const spinMs = Date.now() - tSpin;
  const live = members.filter((m) => !m.error);
  for (const m of members) {
    if (m.error) log(`  member ${m.i}: FAILED ${m.error}`);
    else
      log(
        `  member ${m.i}: instance ${m.cred.instanceId} reused=${m.cred.reused} in ${m.acquiredMs}ms`,
      );
  }
  log(
    `all ${live.length}/${N} up in ${spinMs}ms (sum of individual: ${live.reduce((s, m) => s + m.acquiredMs, 0)}ms)`,
  );
  if (live.length === 0) return;

  // --- targets + control -------------------------------------------------
  log('\n=== targets and control ===');
  for (const m of live) {
    try {
      const tabs = await m.client.tabs.list();
      m.targets = tabs;
      log(`  member ${m.i}: ${tabs.length} targets`);
      for (const t of tabs) log(`      ${t.targetId}  ${JSON.stringify(t.url ?? t.title ?? '')}`);
    } catch (e) {
      log(`  member ${m.i}: tabs.list FAILED ${e?.code ?? ''} ${e?.message ?? e}`);
    }
  }

  // Try to take control of EVERY target, reporting the real error.
  for (const m of live) {
    for (const t of m.targets ?? []) {
      const c = m.client.forTarget(t.targetId);
      try {
        await c.acquireControl();
        log(`  member ${m.i} target ${t.targetId}: control OK`);
      } catch (e) {
        log(
          `  member ${m.i} target ${t.targetId}: control FAILED code=${e?.code} msg=${e?.message}`,
        );
      }
    }
  }

  // --- the parallelism measurement --------------------------------------
  log(`\n=== driving all ${live.length} at once ===`);
  const tDrive = Date.now();
  const results = await Promise.all(
    live.map(async (m) => {
      const started = Date.now();
      mark(m.i, 'start', started);
      const errors = [];
      try {
        await m.client.navigate('https://example.com', { waitUntil: 'load' });
        mark(m.i, 'navigated');
        await m.client.reload();
        mark(m.i, 'reloaded');
        const title = await m.client.evaluate('document.title');
        mark(m.i, 'evaluated');
        const text = await m.client.text();
        mark(m.i, 'read');
        return { i: m.i, title, textLen: text.length, ms: Date.now() - started, errors };
      } catch (e) {
        errors.push(`${e?.code ?? ''} ${e?.message ?? e}`);
        return { i: m.i, ms: Date.now() - started, errors };
      } finally {
        mark(m.i, 'end');
      }
    }),
  );
  const driveMs = Date.now() - tDrive;

  for (const r of results) {
    log(
      `  member ${r.i}: ${r.ms}ms title=${JSON.stringify(r.title ?? null)} textLen=${r.textLen ?? 0}${r.errors.length ? ` ERRORS=${JSON.stringify(r.errors)}` : ''}`,
    );
  }

  const sumMs = results.reduce((s, r) => s + r.ms, 0);
  const maxMs = Math.max(...results.map((r) => r.ms));
  log(`\n  wall clock for all ${live.length}: ${driveMs}ms`);
  log(`  sum of individual:     ${sumMs}ms`);
  log(`  slowest individual:    ${maxMs}ms`);
  const ratio = sumMs / driveMs;
  log(
    `  parallel speedup:      ${ratio.toFixed(2)}x  (${live.length}x would be perfect, 1.0x means fully serialised)`,
  );

  // Interleaving proof: did the busy windows actually overlap?
  const windows = live.map((m) => {
    const s = marks.find((x) => x.who === m.i && x.phase === 'start')?.at ?? 0;
    const e = marks.find((x) => x.who === m.i && x.phase === 'end')?.at ?? 0;
    return [s, e];
  });
  let overlapped = 0;
  for (let a = 0; a < windows.length; a++)
    for (let b = a + 1; b < windows.length; b++)
      if (Math.min(windows[a][1], windows[b][1]) - Math.max(windows[a][0], windows[b][0]) > 0)
        overlapped++;
  const pairs = (windows.length * (windows.length - 1)) / 2;
  log(`  overlapping pairs:     ${overlapped}/${pairs}`);

  // --- teardown ---------------------------------------------------------
  log('\n=== closing ===');
  const tClose = Date.now();
  await Promise.all(
    live.map(async (m) => {
      try {
        m.client.close();
        await fetch(`${BASE}/api/browser?instanceId=${m.cred.instanceId}`, { method: 'DELETE' });
      } catch (e) {
        log(`  member ${m.i} close failed: ${e?.message ?? e}`);
      }
    }),
  );
  log(`  closed in ${Date.now() - tClose}ms`);
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error('probe failed:', e);
    process.exit(1);
  },
);
