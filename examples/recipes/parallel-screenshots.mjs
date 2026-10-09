// Screenshot nine public pages at the same time with BrowserSwarm.
//
// Each swarm member is its own headless Chrome. BrowserSwarm never starts a
// browser itself: you hand it an acquire() function and it calls that once
// per member, all at once. Then swarm.all() runs one callback on every
// member concurrently and reports each result separately, so one slow or
// broken page does not sink the other eight.
//
//   node examples/recipes/parallel-screenshots.mjs
//
// Writes out/shot-<n>-<host>.png.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BrowserSwarm, WS_URL, mintToken, outDir, release, startBrowser } from './lib/gateway.mjs';

const URLS = [
  'https://example.com/',
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://en.wikipedia.org/wiki/Chromium_(web_browser)',
  'https://news.ycombinator.com/',
  'https://quotes.toscrape.com/',
  'https://books.toscrape.com/',
  'https://en.wikipedia.org/wiki/Headless_browser',
  'https://httpbin.org/',
  'https://github.com/psmux/browserglass',
];

const out = outDir();
const started = Date.now();

// acquire() is the only part you write. Here it starts a browser on the
// gateway and mints a token for it. Every member gets its own requestId
// inside startBrowser(), so nine calls give nine different browsers.
const swarm = await BrowserSwarm.open({
  size: URLS.length,
  acquire: async () => {
    const instanceId = await startBrowser();
    const token = await mintToken(instanceId, { sub: 'screenshot-swarm' });
    return { instanceId, wsUrl: WS_URL, token };
  },
});
console.log(`${swarm.members.length} browsers up in ${Date.now() - started} ms`);

try {
  const results = await swarm.all(async (member, i) => {
    const { client } = member;
    // Navigating needs the control lease, the same lease a person watching
    // would compete for. Screenshots do not.
    const lease = await client.acquireControl();
    try {
      await client.navigate(URLS[i], { waitUntil: 'load' });
      // navigate() can come back a moment before the page has painted on a
      // busy machine. Give the document up to 10 s to say it is done, then
      // take the picture anyway: a page with one slow third party script
      // should still get its screenshot.
      await client
        .waitForFunction('document.readyState === "complete"', { pollTimeoutMs: 10_000 })
        .catch(() => {});
    } finally {
      await lease.release();
    }
    // One retry: with nine Chromes busy at once, a capture now and then
    // misses the gateway's 10 s CDP deadline.
    const shot = await client
      .screenshot({ format: 'png' })
      .catch(() => client.screenshot({ format: 'png' }));
    const file = `shot-${i + 1}-${new URL(URLS[i]).hostname}.png`;
    writeFileSync(join(out, file), Buffer.from(shot.data, 'base64'));
    return `${file} (${shot.width}x${shot.height}, ${Math.round(shot.sizeBytes / 1024)} KB)`;
  });

  results.forEach((r, i) => {
    console.log(r.status === 'fulfilled' ? `ok    ${r.value}` : `fail  ${URLS[i]}: ${r.reason}`);
  });
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  console.log(`${ok}/${URLS.length} screenshots in ${Date.now() - started} ms, saved to out/`);
} finally {
  // swarm.close() closes the connections. Ending the browsers is our job,
  // because acquire() was ours too.
  const ids = swarm.members.map((m) => m.instanceId);
  await swarm.close();
  const ended = await Promise.allSettled(ids.map(release));
  for (const r of ended) if (r.status === 'rejected') console.warn(String(r.reason));
}
