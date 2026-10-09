// Visit the Wikipedia articles for four programming languages in one
// browser, read "First appeared" and "Designed by" from each infobox, show
// the collected table on screen, and write it to a CSV.
//
//   node examples/showcase/infobox-table.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const LANGS = [
  ['Python', 'Python_(programming_language)'],
  ['Rust', 'Rust_(programming_language)'],
  ['Go', 'Go_(programming_language)'],
  ['TypeScript', 'TypeScript'],
];

async function readInfobox(browser) {
  return browser.evaluate(() => {
    const clean = (s) =>
      s
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\s+/g, ' ')
        .split(';')[0]
        .trim();
    const row = (label) => {
      const th = [...document.querySelectorAll('table.infobox tr > th')].find(
        (h) => h.textContent.replace(/\s+/g, ' ').trim() === label,
      );
      if (!th) return '';
      const td = th.parentElement.querySelector('td');
      // Lists of designers are <li> items or <br> separated; join with commas.
      const parts = [...td.querySelectorAll('li')].map((li) => clean(li.innerText));
      return (parts.length ? parts : td.innerText.split('\n').map(clean))
        .filter(Boolean)
        .join(', ');
    };
    // Rust's infobox has no "Designed by" row, only "Developer"; fall back to it.
    const designer = row('Designed by') ? 'Designed by' : 'Developer';
    return {
      firstAppeared: row('First appeared'),
      designedBy: row(designer),
      designerRow: designer,
    };
  });
}

// Marks one infobox row so highlight() can find it by a plain selector.
const markRow = (browser, label) =>
  browser.evaluate((l) => {
    for (const el of document.querySelectorAll('[data-showcase]'))
      el.removeAttribute('data-showcase');
    const th = [...document.querySelectorAll('table.infobox tr > th')].find(
      (h) => h.textContent.replace(/\s+/g, ' ').trim() === l,
    );
    th?.parentElement.setAttribute('data-showcase', l);
    th?.parentElement.scrollIntoView({ block: 'center' });
  }, label);

// waitFor() can throw "Inspected target navigated or closed" when a
// navigation lands mid poll, so retry it across the page swap.
async function waitAfterNav(browser, selector) {
  for (let i = 0; ; i++) {
    try {
      return await browser.waitFor(selector);
    } catch (err) {
      if (i >= 5 || !/navigated or closed/.test(String(err?.message))) throw err;
      await sleep(300);
    }
  }
}

const browser = await launch();
const rows = [];
let seconds = 0;
try {
  await browser.navigate(`https://en.wikipedia.org/wiki/${LANGS[0][1]}`);
  await browser.waitFor('table.infobox');
  await sleep(600);
  seconds = await recordRun(browser, 'infobox-table', async () => {
    for (let i = 0; i < LANGS.length; i++) {
      const [name, slug] = LANGS[i];
      if (i > 0) {
        await browser.navigate(`https://en.wikipedia.org/wiki/${slug}`);
        await waitAfterNav(browser, 'table.infobox');
      }
      const facts = await readInfobox(browser);
      const { designerRow, ...data } = facts;
      rows.push({ language: name, ...data });
      await caption(
        browser,
        `${i + 1}/5`,
        `${name}: first appeared ${facts.firstAppeared.replace(/^.*?(\d{4}).*$/, '$1')}`,
      );
      await markRow(browser, designerRow);
      await highlight(browser, 'table.infobox tr[data-showcase]', 500);
      await markRow(browser, 'First appeared');
      await highlight(browser, 'table.infobox tr[data-showcase]', 700);
    }

    // Draw the collected table on a blank page so the clip ends on the result.
    await browser.navigate('about:blank');
    await browser.evaluate((data) => {
      document.title = 'Collected infobox data';
      document.body.style.cssText =
        'margin:0;padding:48px 64px;background:#f6f8fa;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#1f2328';
      const h = document.createElement('h1');
      h.textContent = 'Programming languages, from Wikipedia infoboxes';
      h.style.cssText = 'font-size:26px;margin:0 0 24px';
      const table = document.createElement('table');
      table.style.cssText =
        'border-collapse:collapse;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.12);border-radius:8px;overflow:hidden;min-width:900px';
      const head = ['Language', 'First appeared', 'Designed by'];
      const tr = (cells, th) => {
        const r = document.createElement('tr');
        for (const c of cells) {
          const cell = document.createElement(th ? 'th' : 'td');
          cell.textContent = c;
          cell.style.cssText = `text-align:left;padding:14px 20px;border-bottom:1px solid #d0d7de;${th ? 'background:#7c3aed;color:#fff;font-weight:600' : ''}`;
          r.appendChild(cell);
        }
        return r;
      };
      table.appendChild(tr(head, true));
      for (const d of data)
        table.appendChild(tr([d.language, d.firstAppeared, d.designedBy], false));
      document.body.replaceChildren(h, table);
    }, rows);
    await caption(browser, '5/5', `${rows.length} languages saved to out/languages.csv`);
    await sleep(1500);
  });
} finally {
  await browser.release();
}

const esc = (v) => `"${String(v).replaceAll('"', '""')}"`;
const csv = [
  'language,first_appeared,designed_by',
  ...rows.map((r) => [r.language, r.firstAppeared, r.designedBy].map(esc).join(',')),
].join('\n');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'languages.csv'), `${csv}\n`);

console.log(
  `${rows.length} languages written to examples/showcase/out/languages.csv in ${seconds}s`,
);
for (const r of rows)
  console.log(`  ${r.language.padEnd(11)} ${r.firstAppeared.padEnd(18)} ${r.designedBy}`);
