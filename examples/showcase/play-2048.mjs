// Plays 2048 with arrow keys for about twelve seconds.
//
// The strategy is the simple one everybody learns first: keep the big tiles
// in the bottom left corner by cycling Down, Left, Down, Right, and press Up
// only when nothing else moves. The score is read from the page itself.
//
//   node examples/showcase/play-2048.mjs

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const readScore = (browser) =>
  browser.evaluate(() => {
    const label = [...document.querySelectorAll('span')].find(
      (s) => s.textContent.trim().toLowerCase() === 'score',
    );
    const box = label?.parentElement;
    const value = box ? [...box.querySelectorAll('span')].pop()?.textContent : null;
    return Number(value ?? 0);
  });

const boardKey = (browser) =>
  browser.evaluate(() => document.querySelector('main')?.innerText ?? document.body.innerText);

const browser = await launch();
try {
  await browser.navigate('https://play2048.co/');
  await browser.waitFor('text=New Game');
  await sleep(1500);
  // Dismiss the "would you like a tutorial" bubble if it shows.
  await browser.click('button.bg-near-black.absolute', { timeoutMs: 3000 }).catch(() => {});
  await sleep(400);

  const cycle = ['ArrowDown', 'ArrowLeft', 'ArrowDown', 'ArrowRight'];
  let moves = 0;
  let score = 0;
  const seconds = await recordRun(
    browser,
    'play-2048',
    async () => {
      await caption(browser, '1/3', 'Open 2048 and play it with arrow keys');
      await highlight(browser, 'text=New Game', 900);

      const until = Date.now() + 12000;
      let i = 0;
      let stuck = 0;
      while (Date.now() < until) {
        const before = await boardKey(browser);
        await browser.pressKey(cycle[i % cycle.length]);
        i += 1;
        moves += 1;
        await sleep(110);
        if ((await boardKey(browser)) === before) {
          stuck += 1;
          if (stuck >= cycle.length) {
            await browser.pressKey('ArrowUp');
            moves += 1;
            stuck = 0;
            await sleep(110);
          }
        } else {
          stuck = 0;
        }
        if (moves % 4 === 0) {
          score = await readScore(browser);
          await caption(browser, '2/3', `Down, Left, Down, Right: ${moves} moves, score ${score}`);
        }
      }
      score = await readScore(browser);
      await caption(browser, '3/3', `Done: ${moves} moves in 12 seconds, score ${score}`);
      await sleep(1200);
    },
    { fps: 8 },
  );

  console.log(`played ${moves} moves, final score ${score}`);
  console.log(`recorded ${seconds}s`);
} finally {
  await browser.release().catch(() => {});
}
