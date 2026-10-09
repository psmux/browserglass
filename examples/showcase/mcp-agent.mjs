// An MCP client drives a browser, the way an agent would.
//
// Launches a browser (so it can be recorded), starts `bgls mcp` bound to it
// over stdio, and calls the BrowserGlass MCP tools in the order an agent
// would: take control, open a page, map it, search, read the result. Each
// tool call is shown as the caption.
//
//   node examples/showcase/mcp-agent.mjs

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '../../packages/automation/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StdioClientTransport } from '../../packages/automation/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js';

import { caption, launch, recordRun, sleep } from './lib/showcase.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const gateway = (process.env.BGLS_URL ?? 'http://127.0.0.1:7799/browserglass').replace(/\/+$/, '');
const endpoint = new URL(gateway).origin;

const article = 'https://en.wikipedia.org/wiki/Web_browser';

// The browser the agent will drive. It starts on a plain page, then this
// script lets go of control so the MCP server can take the lease itself,
// through bg_control.
const browser = await launch();
await browser.navigate('about:blank');
await browser.evaluate(() => {
  document.body.style.cssText =
    'margin:0;height:100vh;display:grid;place-items:center;background:#0d1117;color:#e6edf3;font:600 28px system-ui,Segoe UI,sans-serif';
  document.body.textContent = 'An MCP client is driving this browser';
});
await browser.releaseControl();
const mcp = new Client({ name: 'showcase-agent', version: '1.0.0' });
try {
  await mcp.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        join(repo, 'packages', 'cli', 'dist', 'bin.mjs'),
        'mcp',
        '--endpoint',
        endpoint,
        '--instance-id',
        browser.instanceId,
      ],
      env: { ...process.env },
      stderr: 'ignore',
    }),
  );
  const { tools } = await mcp.listTools();
  console.log(`connected to bgls mcp, ${tools.length} tools`);

  const textOf = (res) =>
    (res.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('\n');
  const call = async (name, args = {}) => {
    const res = await mcp.callTool({ name, arguments: args });
    if (res.isError) throw new Error(`${name} failed: ${textOf(res)}`);
    return textOf(res);
  };

  let step = 0;
  const total = 6;
  const show = async (label) => {
    step += 1;
    console.log(`> ${label}`);
    await caption(browser, `${step}/${total}`, label).catch(() => {});
  };

  let summary = '';
  const seconds = await recordRun(
    browser,
    'mcp-agent',
    async () => {
      await show('bg_control acquire');
      await call('bg_control', { action: 'acquire', reason: 'showcase agent' });
      await sleep(800);

      await call('bg_navigate', { url: article });
      await browser.waitFor('#firstHeading');
      step = 1;
      await show(`bg_navigate ${article}`);
      await sleep(1200);

      await show('bg_page_map');
      const map = await call('bg_page_map', {});
      const nodes = (map.match(/^\s*\[\d+\]/gm) ?? []).length;
      console.log(`  page map: ${map.length} chars${nodes ? `, ${nodes} indexed nodes` : ''}`);
      await sleep(900);

      await show('bg_fill input[name="search"] "WebSocket"');
      await call('bg_fill', { selector: 'input[name="search"]', value: 'WebSocket' });
      await sleep(1100);

      await show('bg_press_key Enter');
      await call('bg_press_key', { key: 'Enter' });
      await browser.waitForText('#firstHeading', 'WebSocket');
      await sleep(600);

      step = 5;
      await show('bg_read_page');
      const page = await call('bg_read_page', {});
      const lines = page
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      summary = lines.find((l) => l.startsWith('WebSocket is')) ?? lines.slice(0, 4).join('\n  ');
      await sleep(1600);
    },
    { fps: 8 },
  );

  console.log(`bg_read_page returned:\n  ${summary}`);
  console.log(`recorded ${seconds}s`);
} finally {
  await mcp.close().catch(() => {});
  await browser.release().catch(() => {});
}
