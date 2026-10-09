// Drive the TodoMVC demo: add five todos, tick two off, then switch the
// filter to Active. Prints how many are left.
//
//   node examples/showcase/todo-app.mjs

import { caption, clickShown, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const TODOS = [
  'Write the release notes',
  'Review the open pull requests',
  'Update the changelog',
  'Tag version 1.0',
  'Announce the release',
];
const DONE = [0, 2];

const browser = await launch();
let left = '';
let visible = [];
let seconds = 0;
try {
  seconds = await recordRun(
    browser,
    'todo-app',
    async () => {
      await caption(browser, '1/4', 'Open the TodoMVC demo');
      await sleep(700);

      await caption(browser, '2/4', 'Add five todos');
      await clickShown(browser, '.new-todo');
      for (const t of TODOS) {
        await browser.humanType(t, { delayMs: 25 });
        await browser.pressKey('Enter');
        await sleep(150);
      }
      await sleep(500);

      await caption(browser, '3/4', 'Complete two of them');
      for (const i of DONE) {
        const target = `.todo-list li:nth-child(${i + 1}) .toggle`;
        await clickShown(browser, target);
        await sleep(400);
      }
      await sleep(400);

      await caption(browser, '4/4', 'Show only the active ones');
      await clickShown(browser, 'a[href="#/active"]', 600);
      await browser.waitFor('a[href="#/active"].selected');
      await sleep(300);
      left = (await browser.innerText('.todo-count')).trim();
      visible = await browser.evaluate(() =>
        [...document.querySelectorAll('.todo-list li label')].map((l) => l.textContent),
      );
      await caption(browser, '4/4', `Active filter on: ${left}`);
      await highlight(browser, '.todo-count', 900);
    },
    { url: 'https://demo.playwright.dev/todomvc/', ready: '.new-todo' },
  );
} finally {
  await browser.release();
}

console.log(`Remaining: ${left}`);
for (const v of visible) console.log(`  [ ] ${v}`);
console.log(`(${seconds}s)`);
