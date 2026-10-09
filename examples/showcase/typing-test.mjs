// Takes a 15 second typing test on monkeytype.com with humanType().
//
// Reads the next word off the page, types it key by key with a short
// delay between keystrokes, and repeats until the test ends. Then reads the
// speed and accuracy from the result screen.
//
//   node examples/showcase/typing-test.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');

const activeWord = (browser) =>
  browser.evaluate(() => {
    const w = document.querySelector('#words .word.active');
    return w ? [...w.querySelectorAll('letter')].map((l) => l.textContent).join('') : null;
  });

const testOver = (browser) =>
  browser.evaluate(() => {
    const r = document.querySelector('#result');
    return !!r && r.offsetParent !== null && !r.classList.contains('hidden');
  });

const browser = await launch();
try {
  await browser.navigate('https://monkeytype.com/');
  await browser.waitFor('#words .word');
  await browser.click('text="reject non-essential"', { timeoutMs: 5000 }).catch(() => {});
  await sleep(500);

  let typed = 0;
  let result = {};
  const seconds = await recordRun(
    browser,
    'typing-test',
    async () => {
      await caption(browser, '1/3', 'A 15 second typing test, typed by a script');
      await highlight(browser, '#words', 900);
      // The page opens in 30 second mode; pick 15.
      await browser.click('text="15"', { timeoutMs: 2000 }).catch(() => {});
      await sleep(500);

      await caption(browser, '2/3', 'Read the next word, type it key by key');
      const until = Date.now() + 25000;
      while (Date.now() < until && !(await testOver(browser))) {
        const word = await activeWord(browser);
        if (!word) break;
        await browser.humanType(`${word} `, { delayMs: 45 });
        typed += 1;
      }
      await browser.waitFor('#result', { timeoutMs: 8000 }).catch(() => {});
      await sleep(1200);
      result = await browser.evaluate(() => {
        const lines = (document.querySelector('#result')?.innerText ?? '')
          .split('\n')
          .map((l) => l.trim());
        const after = (label) => lines[lines.indexOf(label) + 1] ?? null;
        return { wpm: after('wpm'), acc: after('acc') };
      });
      await caption(browser, '3/3', `Result: ${result.wpm} wpm, ${result.acc} accuracy`);
      await sleep(1800);
    },
    { fps: 8 },
  );

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'typing-test.json'),
    JSON.stringify({ words: typed, ...result }, null, 2),
  );
  console.log(`typed ${typed} words: ${result.wpm} wpm, ${result.acc} accuracy`);
  console.log(`recorded ${seconds}s`);
} finally {
  await browser.release().catch(() => {});
}
