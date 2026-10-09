// Click the "inspirational" tag on quotes.toscrape.com, follow its pages,
// and save every quote with its author to a JSON file.
//
//   node examples/showcase/quotes-by-tag.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TAG = 'inspirational';

// waitFor() can throw "Inspected target navigated or closed" when the
// click's navigation lands mid poll, so retry it across the page swap.
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

const readQuotes = (browser) =>
  browser.evaluate(() =>
    [...document.querySelectorAll('.quote')].map((q) => ({
      text: q.querySelector('.text').textContent.trim().replace(/^“|”$/g, ''),
      author: q.querySelector('.author').textContent.trim(),
    })),
  );

const browser = await launch();
const quotes = [];
let seconds = 0;
try {
  await browser.navigate('https://quotes.toscrape.com/');
  await browser.waitFor('.tags-box');
  await sleep(600);
  seconds = await recordRun(browser, 'quotes-by-tag', async () => {
    await caption(browser, '1/4', `Pick "${TAG}" from the Top Ten tags`);
    await sleep(800);
    const tagLink = `.tags-box a[href="/tag/${TAG}/"]`;
    await highlight(browser, tagLink);
    await browser.click(tagLink);
    await waitAfterNav(browser, `text=Viewing tag: ${TAG}`);

    for (let page = 1; ; page++) {
      quotes.push(...(await readQuotes(browser)));
      await caption(browser, '2/4', `Page ${page}: ${quotes.length} quotes collected`);
      await sleep(700);
      await browser.scroll({ dy: 700 });
      await sleep(700);
      const hasNext = await browser.evaluate(() => !!document.querySelector('li.next a'));
      if (!hasNext) break;
      await browser.evaluate(() =>
        document.querySelector('li.next a').scrollIntoView({ block: 'center' }),
      );
      await caption(browser, '3/4', 'Follow "Next" to the following page');
      await highlight(browser, 'li.next a');
      await browser.click('li.next a');
      await waitAfterNav(browser, 'li.previous a');
    }

    await browser.evaluate(() => window.scrollTo(0, 0));
    await caption(browser, '4/4', `Saved ${quotes.length} quotes to out/quotes.json`);
    await sleep(1200);
  });
} finally {
  // On a busy machine ending the browser can fail (E_TERMINATE_FAILED); say
  // so, but still write out the data that was collected.
  await browser
    .release()
    .catch((err) => console.error(`could not end the browser: ${err.message}`));
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'quotes.json'), `${JSON.stringify({ tag: TAG, quotes }, null, 2)}\n`);

console.log(
  `${quotes.length} "${TAG}" quotes written to examples/showcase/out/quotes.json in ${seconds}s`,
);
for (const q of quotes.slice(0, 3)) console.log(`  ${q.author}: ${q.text.slice(0, 60)}...`);
