// Nine browsers working at once, watched live in one page.
//
// Opens a swarm of nine headless browsers, mints a view only token for
// each, and serves a small local page with a 3x3 grid of <browser-glass>
// panes. A tenth browser opens that page and is the one recorded, so the
// clip shows the nine live streams while they each browse a different site.
//
// Needs `pnpm --filter @browserglass/embed build` first, and a gateway
// that lets the grid page's origin open sockets:
//
//   bgls serve --cors http://127.0.0.1:7826
//   node examples/showcase/nine-browsers-live.mjs
//
// The page port is SHOWCASE_PAGE_PORT, default 7826.

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrowserSwarm, caption, launch, recordRun, sleep } from './lib/showcase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const embedJs = readFileSync(
  resolve(here, '..', '..', 'packages', 'embed', 'dist', 'browserglass-embed.global.js'),
);

const gateway = (process.env.BGLS_URL ?? 'http://127.0.0.1:7799/browserglass').replace(/\/+$/, '');
const adminToken = process.env.BGLS_ADMIN_TOKEN;
const wsUrl = `${gateway.replace(/^http/, 'ws')}/socket`;
const pagePort = Number(process.env.SHOWCASE_PAGE_PORT ?? 7826);

const sites = [
  'https://en.wikipedia.org/wiki/Web_browser',
  'https://books.toscrape.com/',
  'https://quotes.toscrape.com/',
  'https://en.wikipedia.org/wiki/WebSocket',
  'https://example.com/',
  'https://httpbin.org/',
  'https://en.wikipedia.org/wiki/JSON',
  'https://demo.playwright.dev/todomvc/',
  'https://en.wikipedia.org/wiki/Chromium_(web_browser)',
];

async function viewToken(instanceId) {
  const res = await fetch(`${gateway}/v1/tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      sub: 'showcase-grid',
      subKind: 'service',
      scope: { kind: 'instance', instanceId, targets: '*' },
      caps: ['view'],
      ttlSeconds: 600,
    }),
  });
  if (!res.ok) throw new Error(`POST /v1/tokens: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).token;
}

function gridPage(panes) {
  const cells = panes
    .map(
      (p, i) =>
        `<div class="cell"><browser-glass url="${wsUrl}" token="${p.token}" target-id="${p.targetId}" fit="contain" readonly></browser-glass><span class="n">${i + 1}</span></div>`,
    )
    .join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>9 browsers, one gateway</title>
<style>
  html,body{margin:0;height:100%;background:#0d1117;color:#e6edf3;font-family:system-ui,Segoe UI,sans-serif}
  body{display:flex;flex-direction:column;padding:10px 14px 64px;box-sizing:border-box}
  h1{font-size:17px;font-weight:600;margin:0 0 8px;letter-spacing:.01em}
  h1 span{color:#a78bfa}
  .grid{flex:1;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(3,1fr);gap:8px;min-height:0}
  .cell{position:relative;background:#161b22;border:1px solid #30363d;border-radius:8px;overflow:hidden}
  browser-glass{display:block;width:100%;height:100%}
  .n{position:absolute;top:6px;left:6px;background:#7c3aed;color:#fff;font-size:11px;font-weight:700;border-radius:5px;padding:1px 6px}
</style></head><body>
<h1><span>9 browsers</span>, one gateway</h1>
<div class="grid">${cells}</div>
<script src="/embed.js"></script>
</body></html>`;
}

// 1. Nine browsers, each its own headless Chrome.
const swarm = await BrowserSwarm.open({
  size: 9,
  launch: { viewport: { width: 1280, height: 800 } },
});
let camera;
let server;
try {
  const panes = [];
  for (const m of swarm.members) {
    panes.push({ targetId: m.targetId, token: await viewToken(m.instanceId) });
  }

  // 2. A tiny local page that shows all nine live.
  const html = gridPage(panes);
  server = createServer((req, res) => {
    if (req.url === '/embed.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(embedJs);
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }
  });
  await new Promise((r) => server.listen(pagePort, '127.0.0.1', r));
  const pageUrl = `http://127.0.0.1:${pagePort}/`;

  // Give every member something on screen before the camera starts.
  await swarm.all(async (m, i) => {
    await m.client.navigate('about:blank');
    await m.client.evaluate((n) => {
      document.body.style.cssText =
        'margin:0;height:100vh;display:grid;place-items:center;background:#161b22;color:#8b949e;font:600 64px system-ui,Segoe UI,sans-serif';
      document.body.textContent = `Browser ${n}, ready`;
    }, i + 1);
  });

  // 3. The camera: a tenth browser that opens the grid page.
  camera = await launch({ viewport: { width: 1280, height: 860 } });
  await camera.navigate(pageUrl);
  await camera.waitFor('browser-glass');
  // Wait until all nine panes are streaming.
  let paneStates = [];
  for (let k = 0; k < 30; k++) {
    paneStates = await camera.evaluate(() =>
      [...document.querySelectorAll('browser-glass')].map((el) => el.getAttribute('state')),
    );
    if (paneStates.every((s) => s === 'live')) break;
    await sleep(500);
  }
  console.log('pane states:', paneStates.join(' '));
  await sleep(1000);

  const results = [];
  const seconds = await recordRun(
    camera,
    'nine-browsers-live',
    async () => {
      await caption(camera, '1/3', 'Nine browsers, each streamed live into this page');
      await sleep(1000);

      await caption(camera, '2/3', 'All nine open a different site at the same time');
      const t0 = Date.now();
      const loads = await swarm.all(async (m, i) => {
        await m.client.navigate(sites[i]);
        await m.client.waitFor('body');
        const title = await m.client.evaluate(() => document.title);
        results[i] = { site: sites[i], title, ms: Date.now() - t0 };
      });
      const failed = loads.filter((r) => r.status === 'rejected');
      if (failed.length)
        console.warn(
          `${failed.length} member(s) failed:`,
          failed.map((f) => String(f.reason)),
        );
      await sleep(1000);

      await caption(camera, '3/3', 'Each one scrolls its page, in parallel');
      for (let k = 0; k < 3; k++) {
        await swarm.all((m) => m.client.scroll({ dy: 400 }));
        await sleep(600);
      }
    },
    { fps: 8 },
  );

  for (const [i, r] of results.entries()) {
    if (r) console.log(`${i + 1}. ${r.title}  (${r.ms} ms)`);
  }
  console.log(`recorded ${seconds}s, 9 live panes`);
} finally {
  await camera?.release().catch(() => {});
  await swarm.close().catch(() => {});
  server?.close();
}
