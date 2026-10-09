// Takes a 25 word typing test on typings.gg with humanType().
//
// Reads the highlighted word off the page, types it key by key with a short
// delay between keystrokes, and repeats until the test is done. Then reads
// the speed and accuracy the page reports.
//
//   node examples/showcase/typing-test.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');

const nextWord = (browser) =>
  browser.evaluate(
    () =>
      document
        .querySelector('#text-display span.highlight:not(.correct):not(.wrong)')
        ?.textContent.trim() ?? null,
  );

const browser = await launch();
try {
  await browser.navigate('https://typings.gg/');
  await browser.waitFor('#text-display .highlight');
  await sleep(600);

  let typed = 0;
  let result = '';
  const seconds = await recordRun(
    browser,
    'typing-test',
    async () => {
      await caption(browser, '1/3', 'A 25 word typing test, typed by a script');
      await highlight(browser, '#wc-25', 700);
      await browser.click('#wc-25');
      await sleep(500);
      await browser.click('#input-field');

      await caption(browser, '2/3', 'Read the next word, type it key by key');
      for (let k = 0; k < 40; k++) {
        const word = await nextWord(browser);
        if (!word) break;
        await browser.humanType(`${word} `, { delayMs: 45 });
        typed += 1;
      }
      await sleep(600);
      result = await browser.evaluate(() =>
        document.querySelector('#right-wing')?.textContent.trim(),
      );
      await highlight(browser, '#right-wing', 300);
      await caption(browser, '3/3', `Done: ${typed} words, ${result}`);
      await sleep(1800);
    },
    { fps: 10 },
  );

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'typing-test.json'),
    JSON.stringify({ words: typed, result }, null, 2),
  );
  console.log(`typed ${typed} words, page reports ${result}`);
  console.log(`recorded ${seconds}s`);
} finally {
  await browser.release().catch(() => {});
}
