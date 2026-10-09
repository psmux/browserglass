/**
 * Proves the accessibility tree bridge (`AutomationClient.a11y()` and the
 * `role=` locator selector) against real Chrome, on real markup: a
 * `<button>` with no `role` attribute, an `<a>` with no `href` at all, an
 * `<a href="">` (still a link per the HTML spec, and a case a naive
 * "has an href attribute" check would also get right, unlike the hrefless
 * one above), and an `aria-label` overriding text content. Each is a case
 * a `[role="x"]`/attribute-only lookalike gets wrong and Chrome's own
 * `Accessibility.queryAXTree` gets right, which is the entire argument for
 * building this on CDP rather than on a hand-rolled ARIA table.
 *
 * Navigates to `data:text/html,...` URLs rather than `document.write`-ing
 * into the demo's own live Next.js page: an earlier version of this probe
 * did the latter and was genuinely flaky (Chrome's accessibility tree
 * lagged the DOM rewrite by a variable amount depending on whether the
 * demo's dev server had already JIT-compiled the route, confirmed directly
 * by re-running it: an unfiltered `a11y()` sometimes saw only 4 placeholder
 * nodes with no button at all). A `data:` navigation is a genuinely fresh
 * document and renderer from Chrome's own perspective, and `waitFor('#btn')`
 * (an ordinary DOM wait, independent of the accessibility tree) is the
 * actual readiness signal, not a fixed sleep.
 *
 * Also proves the cross-origin case `packages/core/src/cdp/accessibility.ts`'s
 * module doc argues for on paper: `a11y()`/`role=` never hold the
 * `Accessibility` domain open across a call, so a navigation between two
 * calls (here, one `data:` document to a second, different one, which
 * Chrome treats as its own opaque origin each time) needs no rebind step
 * to keep working.
 */
import { AutomationClient } from '@browserglass/automation';

const BASE = process.env.BASE ?? 'http://localhost:3001';
const WS = process.env.WS ?? 'ws://localhost:3001/browserglass/socket';

const PAGE = `<!doctype html><meta charset=utf8><title>a11y probe</title><body>
<button id="btn">Save changes</button>
<a id="fake-link" href="">looks like a link</a>
<a id="real-link" href="https://example.test/">real link</a>
<a id="no-href-at-all">no href attribute at all</a>
<span id="unlinked">not a link at all</span>
<div id="labeled" aria-label="Close dialog">X</div>
</body>`;

const AFTER_NAV_PAGE = `<!doctype html><meta charset=utf8><title>after nav</title><body>
<button id="btn2">After nav</button>
</body>`;

function dataUrl(html) {
  return `data:text/html,${encodeURIComponent(html)}`;
}

const results = [];
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(66)} got=${JSON.stringify(got)}${ok ? '' : ` want=${JSON.stringify(want)}`}`,
  );
}
function checkTrue(label, ok) {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
}

async function main() {
  const res = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  const cred = await res.json();
  console.log(`\ninstance ${cred.instanceId}`);
  console.log(
    `caps include devtools+evaluate: ${(cred.caps ?? []).includes('devtools') && (cred.caps ?? []).includes('evaluate')}\n`,
  );

  const client = await AutomationClient.connect({ endpoint: WS, token: cred.token });
  const c = client.forTarget((await client.tabs.list())[0].targetId);
  await c.acquireControl();

  await c.navigate(dataUrl(PAGE), { waitUntil: 'load' });
  // The real readiness gate: an ordinary DOM wait, independent of whatever
  // the accessibility tree happens to have caught up to.
  await c.waitFor('#btn');

  console.log('=== a11y(): real markup ===');

  const buttonAttr = await c.getAttribute('#btn', 'role').catch(() => null);
  check('the <button> element genuinely has no role attribute', buttonAttr, null);

  const tree = await c.a11y();
  checkTrue('a11y() returns at least one node', tree.nodes.length > 0);
  const btnNode = tree.nodes.find((n) => n.name === 'Save changes');
  checkTrue('a11y() found the button by its accessible name', Boolean(btnNode));
  check(
    'Chrome computes role "button" for a <button> with no role attribute',
    btnNode?.role,
    'button',
  );

  const closeNode = tree.nodes.find((n) => n.name === 'Close dialog');
  checkTrue(
    'aria-label overrides text content in the computed accessible name',
    Boolean(closeNode),
  );
  if (closeNode)
    check('the overridden name is exactly the aria-label, not "X"', closeNode.name, 'Close dialog');

  const realLinkNode = tree.nodes.find((n) => n.name === 'real link');
  check('an <a href> gets role "link"', realLinkNode?.role, 'link');

  const fakeLinkNode = tree.nodes.find((n) => n.name === 'looks like a link');
  // An empty href="" is still a navigable href per the HTML spec (it
  // resolves to the current page), so Chrome DOES treat it as a link.
  check(
    'an <a> with an empty (but present) href still gets role "link" from Chrome',
    fakeLinkNode?.role,
    'link',
  );

  // The real "not a link" case: an <a> with NO href attribute at all is
  // not a link, and this is exactly what a `[role="x"]`/attribute-presence
  // lookalike would get wrong, since neither approach has an actual
  // attribute to read. Chrome's own engine excludes it from the AX tree
  // entirely (or reports a non-link role for it) either way: whichever it
  // is, the accessible name never surfaces attached to role "link".
  const noHrefIsLink = tree.nodes.some(
    (n) => n.name === 'no href attribute at all' && n.role === 'link',
  );
  checkTrue('an <a> with NO href attribute at all does NOT get role "link"', !noHrefIsLink);

  console.log('\n=== role= selector, on top of the same CDP call ===');

  const byRole = await c.resolve('role=button');
  check(
    'role=button matches exactly the one <button>',
    byRole.matches.map((m) => m.tagName),
    ['button'],
  );

  const byRoleName = await c.resolve('role=button[name="Save changes"]');
  check('role=button[name="..."] narrows by exact accessible name', byRoleName.total, 1);

  const byRoleWrongName = await c.resolve('role=button[name="nope"]');
  check(
    'role= with a name that matches nothing is an ordinary empty answer, not an error',
    byRoleWrongName.total,
    0,
  );

  const clicked = await c.click('role=button[name="Save changes"]');
  checkTrue(
    'click() drives role= through the ordinary actionability pipeline',
    clicked.ok === true,
  );

  console.log('\n=== cross-origin: a11y() and role= after a navigation ===');

  // A second `data:` document is Chrome's own opaque-origin case; whether
  // or not it happens to swap the underlying renderer process, this proves
  // the claim that matters: no rebind step was written, and none was
  // needed, because neither call ever holds the Accessibility domain open
  // between calls in the first place.
  await c.navigate(dataUrl(AFTER_NAV_PAGE), { waitUntil: 'load' });
  await c.waitFor('#btn2');

  const afterNavTree = await c.a11y({ role: 'button' });
  const afterBtn = afterNavTree.nodes.find((n) => n.name === 'After nav');
  checkTrue(
    'a11y() works on the NEW page after navigation, no rebind code required',
    Boolean(afterBtn),
  );

  const afterNavRole = await c.resolve('role=button[name="After nav"]');
  check('role= also works on the new page after navigation', afterNavRole.total, 1);

  client.close();
  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const passed = results.filter(Boolean).length;
  console.log(`\n=== ${passed}/${results.length} passed ===`);
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('a11y probe failed:', e);
  process.exit(1);
});
