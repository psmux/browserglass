/**
 * The isolated world probe.
 *
 * `form-parity-probe.mjs` proves the SURFACE works. This one proves WHERE
 * it runs, which is the thing no unit test can settle, because a unit test
 * asserts that the string `'isolated'` was passed and a real page is the
 * only thing that can say whether the world boundary was actually there.
 *
 * The page it loads patches `Document.prototype.querySelectorAll` and
 * `Document.prototype.querySelector` from its own inline script, which by
 * definition runs in the main world, and counts every call. The locator
 * engine's `RESOLVE_SCRIPT` is built on exactly those two methods
 * (`locator/script.ts`). So:
 *
 *   * if `resolve()` runs in the MAIN world, the page's counter goes up
 *     and the page could have returned anything it liked;
 *   * if `resolve()` runs in the ISOLATED world, the counter stays at zero
 *     and the resolve still finds the element, because an isolated world
 *     gets clean prototypes over the same shared DOM.
 *
 * That is a difference a page can produce and a driver cannot fake, which
 * is what makes it a proof rather than a restatement of the code.
 *
 * Run it exactly like `form-parity-probe.mjs`: `npm run dev` in this
 * directory, then `node isolated-world-probe.mjs`.
 *
 * NOTE FOR ANYONE WRITING A CLIENT ON TOP OF THIS. Every read below goes
 * through `evaluateWith(source, args, opts)`, never `evaluate(source,
 * ...args)`. `evaluate` is variadic in its ARGUMENTS, so
 * `evaluate('expr', { world: 'isolated' })` passes the options bag to the
 * page as argument zero and runs in the default world, silently and with
 * no error. The first version of this probe did exactly that and reported
 * that the isolated world could see the page's globals, which was the
 * probe being wrong rather than the SDK. `EvaluateOptions` reaches the
 * wire only through `evaluateWith`.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';

const PAGE = `<!doctype html><meta charset=utf8><title>World probe</title>
<body style="font:16px system-ui;padding:24px">
<h1 id=h>World probe</h1>
<input id=name placeholder="Full name">
<button id=go type=button>Go</button>
<script>
  // Everything in this block runs in the MAIN world. It is the page, and
  // the page is the adversary the isolated world exists to keep out.
  window.__mainWorldMarker = 'set-by-the-page';
  window.__qsaCalls = 0;
  window.__qsCalls = 0;
  const origAll = Document.prototype.querySelectorAll;
  const origOne = Document.prototype.querySelector;
  Document.prototype.querySelectorAll = function (...a) { window.__qsaCalls++; return origAll.apply(this, a); };
  Document.prototype.querySelector = function (...a) { window.__qsCalls++; return origOne.apply(this, a); };
</script>`;

const URL_ = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`;

const results = [];

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
    results.push({ name, ok: true });
    console.log(
      `  PASS  ${name.padEnd(46)} ${String(Date.now() - t0).padStart(5)}ms  ${JSON.stringify(value ?? null)}`,
    );
  } catch (e) {
    results.push({ name, ok: false, error: `${e?.code ?? ''} ${e?.message ?? e}`.trim() });
    console.log(
      `  FAIL  ${name.padEnd(46)} ${String(Date.now() - t0).padStart(5)}ms  ${e?.code ?? ''} ${e?.message ?? e}`,
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

  console.log('=== the two worlds are really two worlds ===');
  await c.navigate(URL_, { waitUntil: 'load' });

  await step(
    "evaluate() default sees the page's own global",
    () => c.evaluate('window.__mainWorldMarker'),
    'set-by-the-page',
  );
  await step(
    "evaluate(world: 'main') sees it too",
    () => c.evaluateWith('window.__mainWorldMarker', [], { world: 'main' }),
    'set-by-the-page',
  );
  await step(
    "evaluate(world: 'isolated') cannot see it",
    () => c.evaluateWith('typeof window.__mainWorldMarker', [], { world: 'isolated' }),
    'undefined',
  );
  await step(
    'the isolated world still shares the DOM',
    () => c.evaluateWith('document.getElementById("h").textContent', [], { world: 'isolated' }),
    'World probe',
  );
  await step(
    'a global set from the isolated world is invisible to the page',
    async () => {
      await c.evaluateWith('window.__isolatedOnly = 42', [], { world: 'isolated' });
      return c.evaluateWith('typeof window.__isolatedOnly', [], { world: 'main' });
    },
    'undefined',
  );
  await step(
    'and is visible to the next isolated evaluate, so it is one persistent world',
    () => c.evaluateWith('window.__isolatedOnly', [], { world: 'isolated' }),
    42,
  );

  console.log('\n=== the locator surface runs where it says it does ===');
  await step(
    'the page has counted no querySelector calls yet',
    () => c.evaluateWith('[window.__qsCalls, window.__qsaCalls].join(",")', [], { world: 'main' }),
    '0,0',
  );
  await step('resolve() finds the element', () => c.resolve('#name').then((r) => r.total), 1);
  await step(
    'fill() writes through it',
    () => c.fill('#name', 'Ada Lovelace').then((r) => r.actual),
    'Ada Lovelace',
  );
  await step('click() dispatches through it', () => c.click('#go').then((r) => r.ok), true);
  /**
   * The whole point. Three locator verbs have now run, every one of them
   * built on `document.querySelector`/`querySelectorAll`, and the page's
   * own patched copies of those two methods were never called once. There
   * is no way to get that reading from a main world evaluate.
   */
  await step(
    "the page's patched querySelector was never called, so none of that ran in its world",
    () => c.evaluateWith('[window.__qsCalls, window.__qsaCalls].join(",")', [], { world: 'main' }),
    '0,0',
  );
  await step(
    'and the page can still see the value the isolated world typed into its DOM',
    () => c.evaluateWith('document.getElementById("name").value', [], { world: 'main' }),
    'Ada Lovelace',
  );

  /**
   * The negative control, without which the two zeroes above prove
   * nothing. A counter that stays at zero because the page's patch never
   * installed looks exactly like a counter that stays at zero because the
   * locator ran somewhere the patch could not reach. This step calls
   * `document.querySelector` from the MAIN world and shows the counter
   * move, which is the only thing that tells those two apart.
   */
  await step(
    'a main world querySelector DOES move the counter, so the patch was live all along',
    async () => {
      await c.evaluateWith('document.querySelector("#name") !== null', [], { world: 'main' });
      return c.evaluateWith('window.__qsCalls', [], { world: 'main' });
    },
    (v) => v >= 1,
  );
  await step(
    'the same call from the isolated world does not move it',
    async () => {
      const before = await c.evaluateWith('window.__qsCalls', [], { world: 'main' });
      await c.evaluateWith('document.querySelector("#name") !== null', [], { world: 'isolated' });
      const after = await c.evaluateWith('window.__qsCalls', [], { world: 'main' });
      return `${before} -> ${after}`;
    },
    (v) => v.split(' -> ')[0] === v.split(' -> ')[1],
  );

  client.close();
  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.log('failed:');
    for (const f of failed) console.log(`  ${f.name}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (e) => {
    console.error('probe failed:', e);
    process.exit(1);
  },
);
