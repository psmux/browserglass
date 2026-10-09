// Open the Releases page of a public GitHub project and save the
// latest five release names and dates to a JSON file. No sign in needed.
//
//   node examples/showcase/github-releases.mjs [owner/repo]

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, framesToGif, highlight, launch, mediaDir, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const REPO = process.argv[2] ?? 'microsoft/vscode';
const COUNT = 5;

// This page reliably stalls the live recorder a few seconds in (the
// recorder's backlog fills and it is skipped from then on; see the report),
// so this clip is built from a loop of screenshots instead of recordRun().
async function recordWithScreenshots(browser, name, body) {
  const dir = join(tmpdir(), `bgls-showcase-${name}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const frames = [];
  const started = Date.now();
  let done = false;
  const grab = (async () => {
    while (!done) {
      const shot = await browser.screenshot({ format: 'jpeg', quality: 80 }).catch(() => null);
      if (!shot) continue;
      const file = `${String(frames.length + 1).padStart(6, '0')}.jpg`;
      writeFileSync(join(dir, file), Buffer.from(shot.data, 'base64'));
      frames.push({ file, tsDeltaMs: Date.now() - started });
    }
  })();
  try {
    await body();
    await sleep(1200);
  } finally {
    done = true;
    await grab;
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ frames }));
  mkdirSync(mediaDir, { recursive: true });
  framesToGif(dir, join(mediaDir, `${name}.gif`), join(mediaDir, `${name}.png`));
  return Math.round((Date.now() - started) / 1000);
}

const browser = await launch();
const releases = [];
let seconds = 0;
try {
  await browser.navigate(`https://github.com/${REPO}/releases`);
  await browser.waitFor(`a.Link--primary[href^="/${REPO}/releases/tag/"]`, { timeoutMs: 20000 });
  await sleep(800);
  seconds = await recordWithScreenshots(browser, 'github-releases', async () => {
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

    // End on the result: the collected list, drawn over the page.
    await browser.evaluate(
      (repo, list) => {
        window.scrollTo({ top: 0 });
        const card = document.createElement('div');
        card.style.cssText =
          'position:fixed;top:120px;right:48px;z-index:2147483640;background:#fff;color:#1f2328;border-radius:12px;padding:20px 26px;box-shadow:0 12px 40px rgba(0,0,0,.45);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;min-width:340px';
        const title = document.createElement('div');
        title.textContent = `${repo}, latest releases`;
        title.style.cssText = 'font-weight:700;font-size:18px;margin-bottom:10px';
        card.appendChild(title);
        for (const r of list) {
          const row = document.createElement('div');
          row.style.cssText =
            'display:flex;justify-content:space-between;gap:32px;padding:5px 0;border-top:1px solid #d0d7de';
          const name = document.createElement('span');
          name.textContent = r.name;
          name.style.fontWeight = '600';
          const date = document.createElement('span');
          date.textContent = r.date;
          date.style.color = '#59636e';
          row.append(name, date);
          card.appendChild(row);
        }
        document.documentElement.appendChild(card);
      },
      REPO,
      releases,
    );
    await caption(browser, '4/4', `Saved ${releases.length} releases to out/releases.json`);
    await sleep(1300);
  });
} finally {
  // On a busy machine ending the browser can fail (E_TERMINATE_FAILED); say
  // so, but still write out the data that was collected.
  await browser
    .release()
    .catch((err) => console.error(`could not end the browser: ${err.message}`));
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
