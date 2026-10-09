// Walk the first three catalog pages of books.toscrape.com, read title,
// price, star rating and stock for every book, and write them to a CSV.
//
//   node examples/showcase/books-to-csv.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, clickShown, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const PAGES = 3;

const browser = await launch();
const books = [];
let seconds = 0;
try {
  seconds = await recordRun(
    browser,
    'books-to-csv',
    async () => {
      await caption(browser, '1/4', 'Open the book catalog');
      await sleep(900);

      for (let page = 1; page <= PAGES; page++) {
        const rows = await browser.evaluate(() =>
          [...document.querySelectorAll('article.product_pod')].map((a) => ({
            title: a.querySelector('h3 a').getAttribute('title'),
            price: a.querySelector('.price_color').textContent.trim(),
            rating:
              ['One', 'Two', 'Three', 'Four', 'Five'].indexOf(
                a.querySelector('.star-rating').classList[1],
              ) + 1,
            stock: a.querySelector('.availability').textContent.trim(),
          })),
        );
        books.push(...rows);
        const step = page === 1 ? '2/4' : '3/4';
        await caption(browser, step, `Page ${page} of ${PAGES}, ${books.length} books so far`);
        await browser.scroll({ dy: 900 });
        await sleep(700);
        if (page < PAGES) {
          await browser.evaluate(() =>
            document.querySelector('li.next a').scrollIntoView({ block: 'center' }),
          );
          await sleep(300);
          await clickShown(browser, 'li.next a', 700);
          await browser.waitFor(`text=Page ${page + 1} of`);
          await caption(
            browser,
            step,
            `Page ${page + 1} of ${PAGES}, ${books.length} books so far`,
          );
          await sleep(500);
        }
      }

      await browser.evaluate(() => window.scrollTo(0, 0));
      await caption(browser, '4/4', `Saved ${books.length} books to out/books.csv`);
      await sleep(1200);
    },
    { url: 'https://books.toscrape.com/', ready: 'article.product_pod' },
  );
} finally {
  await browser.release();
}

const esc = (v) => `"${String(v).replaceAll('"', '""')}"`;
const csv = [
  'title,price,rating,stock',
  ...books.map((b) => [b.title, b.price, b.rating, b.stock].map(esc).join(',')),
].join('\n');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'books.csv'), `${csv}\n`);

console.log(`${books.length} books written to examples/showcase/out/books.csv in ${seconds}s`);
for (const b of books.slice(0, 3)) console.log(`  ${b.price}  ${b.rating}/5 stars  ${b.title}`);
