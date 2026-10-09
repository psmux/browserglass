// Blocking images and stylesheets makes a crawl faster and lighter.
//
// Loads books.toscrape.com twice in the same browser: once normally, then
// again (cache bypassed) with request gate rules that deny every Image and
// Stylesheet request. Load time and bytes transferred come from the page's own
// Performance API, so both runs are measured the same way.
//
//   node examples/showcase/block-images.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { caption, launch, recordRun, sleep } from './lib/showcase.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'out');
const url = 'https://books.toscrape.com/';

/** Waits for the load event, then reads load time and bytes transferred. */
async function measure(browser) {
  for (let k = 0; k < 60; k++) {
    const done = await browser.evaluate(
      () => (performance.getEntriesByType('navigation')[0]?.loadEventEnd ?? 0) > 0,
    );
    if (done) break;
    await sleep(250);
  }
  await sleep(300);
  return browser.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const bytes = res.reduce((n, r) => n + (r.transferSize || 0), nav.transferSize || 0);
    return { ms: Math.round(nav.loadEventEnd - nav.startTime), kb: Math.round(bytes / 1024) };
  });
}

const fmt = (m) => `${(m.ms / 1000).toFixed(2)} s, ${m.kb} KB`;

const browser = await launch();
try {
  await browser.navigate('about:blank');
  let normal;
  let blocked;
  const seconds = await recordRun(
    browser,
    'block-images',
    async () => {
      await caption(browser, '1/3', 'Load the catalogue normally');
      await sleep(600);
      await browser.navigate(url);
      normal = await measure(browser);
      await caption(browser, '1/3', `Normal load: ${fmt(normal)}`);
      await sleep(2200);

      await caption(browser, '2/3', 'Deny every Image and Stylesheet request, then load again');
      await browser.gate.enable([
        { urlPattern: '*', resourceTypes: ['Image', 'Stylesheet'], verdict: 'deny' },
      ]);
      await sleep(1200);
      await browser.reload({ ignoreCache: true });
      blocked = await measure(browser);

      const faster = (normal.ms / Math.max(1, blocked.ms)).toFixed(1);
      const lighter = Math.round(100 - (blocked.kb / Math.max(1, normal.kb)) * 100);
      await caption(
        browser,
        '3/3',
        `Normal ${fmt(normal)}. Blocked ${fmt(blocked)}. ${faster}x faster, ${lighter}% fewer bytes`,
      );
      await sleep(2800);
    },
    { fps: 8 },
  );

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, 'block-images.json'),
    JSON.stringify({ url, normal, blocked }, null, 2),
  );
  console.log(`normal:  ${fmt(normal)}`);
  console.log(`blocked: ${fmt(blocked)}`);
  console.log(`recorded ${seconds}s`);
} finally {
  await browser.release().catch(() => {});
}
