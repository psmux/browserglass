// Click the "inspirational" tag on quotes.toscrape.com, follow its pages,
// and save every quote with its author to a JSON file.
//
//   node examples/showcase/quotes-by-tag.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, clickShown, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const TAG = 'inspirational';

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
  seconds = await recordRun(
    browser,
    'quotes-by-tag',
    async () => {
      await caption(browser, '1/4', `Pick "${TAG}" from the Top Ten tags`);
      await sleep(800);
      const tagLink = `.tags-box a[href="/tag/${TAG}/"]`;
      await clickShown(browser, tagLink, 700);
      await browser.waitFor(`text=Viewing tag: ${TAG}`);

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
        await clickShown(browser, 'li.next a', 700);
        await browser.waitFor('li.previous a');
      }

      await browser.evaluate(() => window.scrollTo(0, 0));
      await caption(browser, '4/4', `Saved ${quotes.length} quotes to out/quotes.json`);
      await sleep(1200);
    },
    { url: 'https://quotes.toscrape.com/', ready: '.tags-box' },
  );
} finally {
  await browser.release();
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'quotes.json'), `${JSON.stringify({ tag: TAG, quotes }, null, 2)}\n`);

console.log(
  `${quotes.length} "${TAG}" quotes written to examples/showcase/out/quotes.json in ${seconds}s`,
);
for (const q of quotes.slice(0, 3)) console.log(`  ${q.author}: ${q.text.slice(0, 60)}...`);
