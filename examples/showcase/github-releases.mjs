// Open the Releases page of a public GitHub project and save the
// latest five release names and dates to a JSON file. No sign in needed.
//
//   node examples/showcase/github-releases.mjs [owner/repo]

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, highlight, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const REPO = process.argv[2] ?? 'microsoft/vscode';
const COUNT = 5;

const browser = await launch();
const releases = [];
let seconds = 0;
try {
  await browser.navigate(`https://github.com/${REPO}/releases`);
  await browser.waitFor(`a.Link--primary[href^="/${REPO}/releases/tag/"]`, { timeoutMs: 20000 });
  await sleep(800);
  seconds = await recordRun(browser, 'github-releases', async () => {
    await caption(browser, '1/4', `Open the ${REPO} releases page`);
    await sleep(1000);
    await caption(browser, '2/4', `Read the latest ${COUNT} releases`);
    await sleep(600);

    const found = await browser.evaluate(
      (repo, n) => {
        const out = [];
        for (const link of document.querySelectorAll(
          `a.Link--primary[href^="/${repo}/releases/tag/"]`,
        )) {
          const card = link.closest('section') ?? link.closest('.Box');
          const time = card?.querySelector('relative-time');
          out.push({
            name: link.textContent.trim(),
            tag: decodeURIComponent(link.getAttribute('href').split('/tag/')[1]),
            date: time?.getAttribute('datetime')?.slice(0, 10) ?? null,
          });
          if (out.length === n) break;
        }
        return out;
      },
      REPO,
      COUNT,
    );

    for (let i = 0; i < found.length; i++) {
      releases.push(found[i]);
      const sel = `a.Link--primary[href="/${REPO}/releases/tag/${encodeURIComponent(found[i].tag)}"]`;
      await browser.evaluate(
        (s) => document.querySelector(s).scrollIntoView({ block: 'center' }),
        sel,
      );
      await caption(
        browser,
        '3/4',
        `Release ${i + 1} of ${COUNT}: ${found[i].name}, ${found[i].date}`,
      );
      await highlight(browser, sel, 800);
    }

    await browser.evaluate(() => window.scrollTo({ top: 0 }));
    await caption(browser, '4/4', `Saved ${releases.length} releases to out/releases.json`);
    // Long hold: on a loaded machine the last frames reach the recorder late.
    await sleep(2500);
  });
} finally {
  await browser.release();
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  join(outDir, 'releases.json'),
  `${JSON.stringify({ repo: REPO, releases }, null, 2)}\n`,
);

console.log(
  `${releases.length} latest ${REPO} releases written to examples/showcase/out/releases.json in ${seconds}s`,
);
for (const r of releases) console.log(`  ${r.date}  ${r.name}`);
