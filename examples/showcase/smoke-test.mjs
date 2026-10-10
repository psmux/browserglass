// A quick QA pass over the-internet.herokuapp.com: open seven example pages
// one after another, check one thing on each and screenshot it, then draw
// a PASS/FAIL table into the last page and save the results as JSON.
//
//   node examples/showcase/smoke-test.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, clickShown, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const BASE = 'https://the-internet.herokuapp.com';

// Each check opens its page, does one thing and returns [pass, detail].
const CHECKS = [
  {
    name: 'Checkboxes',
    path: '/checkboxes',
    ready: '#checkboxes',
    async run(b) {
      await clickShown(b, '#checkboxes input:first-of-type', 400);
      const ok = await b.isChecked('#checkboxes input:first-of-type');
      return [ok, ok ? 'first box ticks' : 'first box did not tick'];
    },
  },
  {
    name: 'Dropdown',
    path: '/dropdown',
    ready: '#dropdown',
    async run(b) {
      await b.select('#dropdown', { label: 'Option 2' });
      const v = await b.evaluate(
        () => document.querySelector('#dropdown').selectedOptions[0].textContent,
      );
      return [v === 'Option 2', `selected "${v}"`];
    },
  },
  {
    name: 'Broken Images',
    path: '/broken_images',
    ready: '.example img',
    async run(b) {
      await sleep(600); // give the images a moment to fail or load
      const [broken, total] = await b.evaluate(() => {
        const imgs = [...document.querySelectorAll('.example img')];
        return [imgs.filter((i) => i.complete && i.naturalWidth === 0).length, imgs.length];
      });
      return [broken === 0, `${broken} of ${total} images broken`];
    },
  },
  {
    name: 'Status Codes',
    path: '/status_codes/404',
    ready: '.example p',
    async run(b) {
      const text = await b.innerText('.example p');
      const ok = text.includes('404 status code');
      return [ok, ok ? 'page reports 404' : 'unexpected text'];
    },
  },
  {
    name: 'Inputs',
    path: '/inputs',
    ready: 'input[type=number]',
    async run(b) {
      await b.click('input[type=number]');
      await b.humanType('42', { delayMs: 60 });
      const v = await b.evaluate(() => document.querySelector('input[type=number]').value);
      return [v === '42', `number field holds ${v}`];
    },
  },
  {
    name: 'Key Presses',
    path: '/key_presses',
    ready: '#target',
    async run(b) {
      await b.click('#target');
      await b.pressKey('Enter');
      const text = await b.innerText('#result');
      return [text.includes('ENTER'), `page says "${text.trim()}"`];
    },
  },
  {
    name: 'Add/Remove Elements',
    path: '/add_remove_elements/',
    ready: 'button',
    async run(b) {
      // The button calls jQuery, which can arrive late from this host.
      for (
        let t = 0;
        t < 100 && !(await b.evaluate(() => typeof window.jQuery === 'function'));
        t++
      )
        await sleep(300);
      for (let i = 0; i < 3; i++) await b.click('text="Add Element"');
      const n = await b.evaluate(
        () => document.querySelectorAll('#elements .added-manually').length,
      );
      return [n === 3, `${n} of 3 buttons added`];
    },
  },
];

// Opens a page and waits for the element a check needs. This host
// sometimes stops sending a page halfway (one of its stylesheets never
// arrives), and the page then stays "loading" for good. Loading it again
// fixes that, and once its shared files are cached it stops happening.
async function openPage(browser, url, ready) {
  for (let attempt = 1; ; attempt++) {
    await browser.navigate(url, { waitUntil: 'commit' });
    try {
      await browser.waitFor(ready, { timeoutMs: 3000 });
      for (let t = 0; t < 25; t++) {
        if ((await browser.evaluate(() => document.readyState)) === 'complete') return;
        await sleep(200);
      }
    } catch (err) {
      if (attempt >= 5) throw err;
    }
    if (attempt >= 5) return;
  }
}

mkdirSync(join(outDir, 'smoke'), { recursive: true });
const browser = await launch();
const results = [];
let seconds = 0;
try {
  // Open the start page before recording, which also caches the files
  // every page of this site shares.
  await openPage(browser, `${BASE}/`, '#content ul');
  seconds = await recordRun(browser, 'smoke-test', async () => {
    await caption(browser, '1/3', `Smoke test: ${CHECKS.length} pages from the example list`);
    await sleep(900);

    for (const [i, c] of CHECKS.entries()) {
      await openPage(browser, `${BASE}${c.path}`, c.ready);
      await caption(browser, '2/3', `Page ${i + 1} of ${CHECKS.length}: ${c.name}`);
      let pass = false;
      let detail = '';
      try {
        [pass, detail] = await c.run(browser);
      } catch (err) {
        detail = `error: ${String(err?.message).slice(0, 80)}`;
      }
      // Keep a screenshot of every page as evidence next to the report.
      const shot = await browser.screenshot({ format: 'png' });
      const shotFile = `${c.path.replace(/\W+/g, '-').replace(/^-|-$/g, '')}.png`;
      writeFileSync(join(outDir, 'smoke', shotFile), Buffer.from(shot.data, 'base64'));
      results.push({
        page: c.name,
        url: `${BASE}${c.path}`,
        pass,
        detail,
        screenshot: `smoke/${shotFile}`,
      });
      await caption(browser, '2/3', `${c.name}: ${pass ? 'PASS' : 'FAIL'}, ${detail}`);
      await sleep(500);
    }

    const passed = results.filter((r) => r.pass).length;
    await browser.evaluate(
      (rows, summary) => {
        document.head.innerHTML = '<title>Smoke test report</title>';
        document.body.innerHTML = '';
        document.body.style.cssText =
          'margin:0;background:#0d1117;color:#e6edf3;font:16px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;display:flex;justify-content:center;padding:36px 16px';
        const wrap = document.createElement('div');
        wrap.style.cssText = 'width:min(860px,100%)';
        const h = document.createElement('h1');
        h.textContent = 'Smoke test report';
        h.style.cssText = 'margin:0 0 4px;font-size:28px';
        const sub = document.createElement('p');
        sub.textContent = summary;
        sub.style.cssText = 'margin:0 0 20px;color:#8b949e';
        const table = document.createElement('table');
        table.style.cssText =
          'width:100%;border-collapse:collapse;background:#161b22;border-radius:10px;overflow:hidden';
        for (const r of rows) {
          const tr = document.createElement('tr');
          tr.style.cssText = 'border-top:1px solid #30363d';
          const cells = [r.page, r.pass ? 'PASS' : 'FAIL', r.detail];
          cells.forEach((text, k) => {
            const td = document.createElement('td');
            td.textContent = text;
            td.style.cssText = 'padding:10px 14px';
            if (k === 1) {
              td.style.cssText += `;font-weight:700;font-size:13px;letter-spacing:.04em;color:${r.pass ? '#3fb950' : '#f85149'}`;
            }
            if (k === 2) td.style.cssText += ';color:#8b949e';
            tr.appendChild(td);
          });
          table.appendChild(tr);
        }
        wrap.append(h, sub, table);
        document.body.appendChild(wrap);
      },
      results,
      `${passed} of ${results.length} checks passed on the-internet.herokuapp.com`,
    );
    await caption(browser, '3/3', `Report: ${passed} passed, ${results.length - passed} failed`);
    await sleep(2200);
  });
} finally {
  await browser.release();
}

writeFileSync(
  join(outDir, 'smoke-report.json'),
  `${JSON.stringify({ site: BASE, ranAt: new Date().toISOString(), results }, null, 2)}\n`,
);
const passed = results.filter((r) => r.pass).length;
console.log(
  `${passed} of ${results.length} checks passed (${seconds}s), report in examples/showcase/out/smoke-report.json`,
);
for (const r of results)
  console.log(`  ${r.pass ? 'PASS' : 'FAIL'}  ${r.page.padEnd(20)} ${r.detail}`);
