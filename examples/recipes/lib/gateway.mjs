// Shared plumbing for the recipes: talk to a running `bgls serve`, start a
// browser, mint a token for it, connect, and clean up afterwards.
//
// Two environment variables:
//   BGLS_URL          gateway base URL, default http://127.0.0.1:7799/browserglass
//   BGLS_ADMIN_TOKEN  admin token, from `pnpm bgls token` (run where `bgls serve` runs)
//
// The recipes import the workspace build by path, the same way
// examples/minimal does, so nothing needs installing beyond the repo itself.
// In your own project this would be `import { AutomationClient } from '@browserglass/automation'`.

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AutomationClient } from '../../../packages/automation/dist/index.mjs';

export { AutomationClient };
export { BrowserSwarm } from '../../../packages/automation/dist/index.mjs';

export const BASE_URL = (process.env.BGLS_URL ?? 'http://127.0.0.1:7799/browserglass').replace(
  /\/+$/,
  '',
);
// http://host:port/browserglass  ->  ws://host:port/browserglass/socket
export const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/socket`;

// Everything a script normally needs. `evaluate` is asked for by name because
// no role bundle includes it (it runs script in the page). `devtools` is for
// pageMap() and the network feed, `capture` for screenshots and PDF,
// `download` for recordings, `intercept` for the request gate.
export const AGENT_CAPS = [
  'view',
  'control',
  'navigate',
  'automation',
  'evaluate',
  'capture',
  'devtools',
];

function adminToken() {
  const t = process.env.BGLS_ADMIN_TOKEN;
  if (!t) {
    console.error('BGLS_ADMIN_TOKEN is not set. In the directory where `bgls serve` runs:');
    console.error('  export BGLS_ADMIN_TOKEN=$(pnpm -s bgls token)');
    process.exit(2);
  }
  return t;
}

/** One REST call against the gateway with the admin token. Throws on a non 2xx answer. */
export async function api(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken()}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

let counter = 0;

/**
 * Starts one headless Chrome and returns its id. Pass `profileKey` to use a
 * persistent profile (cookies and storage survive a release); leave it out
 * for a throwaway profile that is deleted on release.
 */
export async function startBrowser({ profileKey } = {}) {
  counter += 1;
  const created = await api('POST', '/v1/instances', {
    // A fresh requestId every time. The gateway dedupes a repeated id for
    // five minutes, which would hand back the same browser.
    requestId: `recipe-${process.pid}-${Date.now()}-${counter}`,
    browser: { headless: 'new' },
    ...(profileKey ? { profile: { mode: 'persistent', key: profileKey } } : {}),
  });
  // The acquire can answer before Chrome is fully up. Wait for `ready`.
  const deadline = Date.now() + 30_000;
  let state = created.state;
  while (state !== 'ready' && Date.now() < deadline) {
    if (['failed', 'released', 'releasing'].includes(state)) {
      throw new Error(`instance ${created.instanceId} ended up ${state}`);
    }
    await new Promise((r) => setTimeout(r, 300));
    state = (await api('GET', `/v1/instances/${created.instanceId}`)).instance.state;
  }
  return created.instanceId;
}

/** Mints a short lived token scoped to one instance, with exactly `caps`. */
export async function mintToken(instanceId, { caps = AGENT_CAPS, sub = 'recipe' } = {}) {
  const minted = await api('POST', '/v1/tokens', {
    sub,
    subKind: 'service',
    scope: { kind: 'instance', instanceId, targets: '*' },
    caps,
    ttlSeconds: 600,
  });
  return minted.token;
}

/**
 * Ends a browser. Its ephemeral profile goes with it; a persistent profile
 * stays on disk.
 *
 * `force=true` because this script owns the browser. Without it the gateway
 * only detaches you while it still counts another viewer on the instance,
 * and a socket you closed a moment ago can still be counted. Retries a
 * couple of times: on Windows a terminate sometimes answers
 * E_TERMINATE_FAILED and the next attempt succeeds.
 */
export async function release(instanceId) {
  for (let attempt = 1; ; attempt++) {
    try {
      await api('DELETE', `/v1/instances/${instanceId}?force=true`);
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

/**
 * The common case in one call: start a browser, mint a token, connect.
 * Returns `{ client, instanceId, done }`; call `done()` in a finally block.
 */
export async function openBrowser({ caps, sub, profileKey } = {}) {
  const instanceId = await startBrowser({ profileKey });
  try {
    const token = await mintToken(instanceId, { caps, sub });
    const client = await AutomationClient.connect({ endpoint: WS_URL, token, instanceId });
    const done = async () => {
      client.close();
      await release(instanceId);
    };
    return { client, instanceId, done };
  } catch (err) {
    await release(instanceId).catch(() => {});
    throw err;
  }
}

/** ./out next to the recipes, created on first use. Returns the absolute path for writing. */
export function outDir() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');
  mkdirSync(dir, { recursive: true });
  return dir;
}
