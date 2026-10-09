// Write a small text file, hand it to a file input with setInputFiles() and
// submit the form. The bytes go from this script to the browser over the
// gateway, so it works the same when the browser runs on another machine.
//
//   node examples/showcase/file-upload.mjs

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, clickShown, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const fileName = 'release-notes.txt';
const filePath = join(outDir, fileName);
mkdirSync(outDir, { recursive: true });
writeFileSync(
  filePath,
  'BrowserGlass upload demo\nThis file was created by examples/showcase/file-upload.mjs\n',
);

async function upload(browser) {
  await caption(browser, '1/3', 'Open the upload form');
  await sleep(900);

  await caption(browser, '2/3', `Attach ${fileName} with setInputFiles()`);
  await highlight(browser, '#file-upload', 700);
  const names = await browser.setInputFiles('#file-upload', [
    { name: fileName, data: readFileSync(filePath), mime: 'text/plain' },
  ]);
  await caption(browser, '2/3', `Attached ${names.join(', ')}`);
  await sleep(900);

  await clickShown(browser, '#file-submit', 600);
  await browser.waitFor('#uploaded-files', { timeoutMs: 12000 });
  const heading = (await browser.innerText('h3')).trim();
  const shown = (await browser.innerText('#uploaded-files')).trim();
  await caption(browser, '3/3', `Server says: ${heading} ${shown}`);
  await highlight(browser, '#uploaded-files', 900);
  return { heading, shown };
}

// This demo host sometimes stops sending a page halfway, so the result
// never shows up. When that happens, record the run again.
const browser = await launch();
let result;
let seconds = 0;
try {
  for (let attempt = 1; !result; attempt++) {
    try {
      seconds = await recordRun(
        browser,
        'file-upload',
        async () => {
          result = await upload(browser);
        },
        { url: 'https://the-internet.herokuapp.com/upload', ready: '#file-upload' },
      );
    } catch (err) {
      if (attempt >= 4) throw err;
      console.error(`attempt ${attempt}: ${err.message.split('\n')[0]}`);
    }
  }
} finally {
  await browser.release();
}

console.log(`Uploaded examples/showcase/out/${fileName}`);
console.log(`Page heading: "${result.heading}", file shown: "${result.shown}" (${seconds}s)`);
