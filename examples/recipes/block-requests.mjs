// Block requests before they leave the browser: every image on a page, plus
// anything matching a URL pattern. Then prove it by counting.
//
//   node examples/recipes/block-requests.mjs
//
// The gate runs inside the gateway, on Chrome's own network layer. A rule
// with verdict 'allow' or 'deny' is decided there with no round trip. A rule
// with verdict 'ask' holds the request and asks this script, which is how
// we get to see (and count) each one. Writes out/blocked-images.png.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AGENT_CAPS, openBrowser, outDir } from './lib/gateway.mjs';

// `intercept` is the capability the gate needs. It is not in the default set.
const { client, done } = await openBrowser({ caps: [...AGENT_CAPS, 'intercept'], sub: 'blocker' });
try {
  await client.acquireControl();

  const blocked = [];
  // Answer every held request. Whatever this returns is the verdict; if it
  // throws, the request is denied, so a bug here fails closed.
  client.gate.onPaused((req) => {
    blocked.push(`${req.resourceType} ${req.url}`);
    return 'deny';
  });

  const { ruleCount } = await client.gate.enable([
    // Every image, wherever it comes from.
    { urlPattern: '*', resourceTypes: ['Image'], verdict: 'ask' },
    // A URL pattern: this site's stylesheets. `*` matches any run of characters.
    { urlPattern: '*books.toscrape.com/static/*.css', verdict: 'ask' },
  ]);
  console.log(`gate armed with ${ruleCount} rules`);

  await client.navigate('https://books.toscrape.com/', { waitUntil: 'load' });
  await client.waitForFunction('document.readyState === "complete"', { pollTimeoutMs: 20_000 });

  // What the page itself sees: images that never got any pixels.
  const page = await client.evaluate(() => {
    const imgs = [...document.images];
    return {
      images: imgs.length,
      broken: imgs.filter((i) => i.complete && i.naturalWidth === 0).length,
      stylesheets: document.styleSheets.length,
    };
  });

  const images = blocked.filter((b) => b.startsWith('Image')).length;
  const css = blocked.length - images;
  console.log(`blocked ${blocked.length} requests: ${images} images, ${css} stylesheets`);
  const oneOfEach = [
    blocked.find((b) => b.startsWith('Image')),
    blocked.find((b) => !b.startsWith('Image')),
  ];
  for (const b of oneOfEach.filter(Boolean)) console.log(`  e.g. ${b}`);
  console.log(`page reports ${page.broken} of ${page.images} <img> elements with no pixels`);

  const shot = await client.screenshot({ format: 'png' });
  writeFileSync(join(outDir(), 'blocked-images.png'), Buffer.from(shot.data, 'base64'));
  console.log('saved out/blocked-images.png (no covers, no styling)');

  await client.gate.disable();
} finally {
  await done();
}
