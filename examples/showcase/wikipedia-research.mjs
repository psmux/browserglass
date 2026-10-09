// Search Wikipedia for "Web scraping" by typing into the search box, open
// the article, read its lead paragraph and section headings, and write a
// short Markdown summary.
//
//   node examples/showcase/wikipedia-research.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const QUERY = 'Web scraping';

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
let article = null;
let seconds = 0;
try {
  await browser.navigate('https://www.wikipedia.org/');
  await browser.waitFor('#searchInput');
  await sleep(600);
  seconds = await recordRun(browser, 'wikipedia-research', async () => {
    await caption(browser, '1/4', `Search Wikipedia for "${QUERY}"`);
    // Center the box first so the click does not scroll the page under the highlight.
    await browser.evaluate(() =>
      document.querySelector('#searchInput').scrollIntoView({ block: 'center' }),
    );
    await highlight(browser, '#searchInput', 900);
    await browser.click('#searchInput');
    await browser.humanType(QUERY, { delayMs: 90 });
    await sleep(500);
    await browser.pressKey('Enter');
    await waitAfterNav(browser, '#firstHeading');
    await sleep(300);

    article = await browser.evaluate(() => {
      const body = document.querySelector('#mw-content-text .mw-parser-output');
      const lead = [...body.querySelectorAll('p')]
        .map((p) => p.textContent.trim())
        .find((t) => t.length > 80);
      const sections = [...body.querySelectorAll('.mw-heading2 h2, h2')]
        .map((h) => h.textContent.trim())
        .filter(
          (t, i, all) =>
            t &&
            all.indexOf(t) === i &&
            !/^(Contents|See also|References|External links|Further reading|Notes)$/.test(t),
        );
      return {
        title: document.querySelector('#firstHeading').textContent.trim(),
        url: location.href,
        lead: lead.replace(/\[\d+\]/g, ''),
        sections,
      };
    });
    await caption(browser, '2/4', 'Read the lead paragraph');
    await highlight(browser, '#mw-content-text p:not(.mw-empty-elt)', 900);
    await sleep(600);

    await caption(browser, '3/4', `Skim ${article.sections.length} sections`);
    for (let i = 0; i < 5; i++) {
      await browser.scroll({ dy: 650 });
      await sleep(550);
    }

    await browser.evaluate(() => window.scrollTo({ top: 0 }));
    await caption(browser, '4/4', 'Summary saved to out/web-scraping.md');
    await sleep(1200);
  });
} finally {
  await browser.release();
}

const md = [
  `# ${article.title}`,
  '',
  `Source: ${article.url}`,
  '',
  '## Summary',
  '',
  article.lead,
  '',
  '## Sections',
  '',
  ...article.sections.map((s) => `* ${s}`),
  '',
].join('\n');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'web-scraping.md'), md);

console.log(
  `"${article.title}": lead of ${article.lead.length} chars, ${article.sections.length} sections, in ${seconds}s`,
);
console.log(`  ${article.lead.slice(0, 110)}...`);
console.log(`  sections: ${article.sections.join(', ')}`);
console.log('  written to examples/showcase/out/web-scraping.md');
