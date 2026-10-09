// Render a Wikipedia article to PDF.
//
//   node examples/recipes/save-pdf.mjs [url]
//
// Writes out/article.pdf. A small PDF comes back inline as base64. A big one
// (most real pages) comes back as a short lived, single use download link
// on the gateway instead, which this script fetches.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { BASE_URL, openBrowser, outDir } from './lib/gateway.mjs';

const url = process.argv[2] ?? 'https://en.wikipedia.org/wiki/Web_browser';

const { client, done } = await openBrowser({ sub: 'pdf-maker' });
try {
  await client.acquireControl();
  await client.navigate(url, { waitUntil: 'load' });
  await client.waitForFunction('document.readyState === "complete"', { pollTimeoutMs: 20_000 });

  // Same options as Chrome's print dialog. Only `capture` is needed for this.
  const pdf = await client.pdf({ format: 'A4', printBackground: true });

  let bytes;
  if (pdf.data !== undefined) {
    bytes = Buffer.from(pdf.data, 'base64');
  } else {
    // pdf.url is a signed, single use link like /v1/downloads/<token>,
    // relative to the gateway's base path (BGLS_URL), not to the host root.
    // The signature is the credential, so no bearer token is needed.
    const res = await fetch(`${BASE_URL}${pdf.url}`);
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }

  const file = join(outDir(), 'article.pdf');
  writeFileSync(file, bytes);
  const delivery = pdf.data !== undefined ? 'inline' : 'download link';
  console.log(`${url}`);
  console.log(`saved out/article.pdf, ${Math.round(bytes.length / 1024)} KB, via ${delivery}`);
  console.log(`starts with ${JSON.stringify(bytes.subarray(0, 8).toString('latin1'))}`);
} finally {
  await done();
}
