// Write a small text file, hand it to a file input with setInputFiles() and
// submit the form. The bytes go from this script to the browser over the
// gateway, so it works the same when the browser runs on another machine.
//
//   node examples/showcase/file-upload.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const fileName = 'release-notes.txt';
const filePath = join(outDir, fileName);
mkdirSync(outDir, { recursive: true });
writeFileSync(
  filePath,
  'BrowserGlass upload demo\nThis file was created by examples/showcase/file-upload.mjs\n',
);

// waitFor() can throw "Inspected target navigated or closed" when a click's
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
let shown = '';
let heading = '';
let seconds = 0;
try {
  // Load the first page before recording, so the clip does not open on a
  // blank tab. This demo host is sometimes slow to answer, so give it time.
  await browser.navigate('https://the-internet.herokuapp.com/upload');
  await browser.waitFor('#file-upload', { timeoutMs: 45000 });
  seconds = await recordRun(browser, 'file-upload', async () => {
    await caption(browser, '1/3', 'Open the upload form');
    await sleep(900);

    await caption(browser, '2/3', `Attach ${fileName} with setInputFiles()`);
    await highlight(browser, '#file-upload', 700);
    const names = await browser.setInputFiles('#file-upload', [
      { name: fileName, data: readFileSync(filePath), mime: 'text/plain' },
    ]);
    await caption(browser, '2/3', `Attached ${names.join(', ')}`);
    await sleep(900);

    await highlight(browser, '#file-submit', 600);
    await browser.click('#file-submit');
    await waitAfterNav(browser, '#uploaded-files');
    heading = (await browser.innerText('h3')).trim();
    shown = (await browser.innerText('#uploaded-files')).trim();
    await caption(browser, '3/3', `Server says: ${heading} ${shown}`);
    await highlight(browser, '#uploaded-files', 900);
  });
} finally {
  await browser.release();
}

console.log(`Uploaded examples/showcase/out/${fileName}`);
console.log(`Page heading: "${heading}", file shown: "${shown}" (${seconds}s)`);
