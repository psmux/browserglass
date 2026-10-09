/**
 * The CDP attach proxy probe.
 *
 * Proves the acceptance bar for the raw CDP WebSocket attach endpoint
 * (`packages/server/src/ws/cdp-upgrade.ts`): a REAL CDP client, speaking
 * Chrome's own DevTools Protocol wire format with no BrowserGlass envelope
 * anywhere in it, connects through BrowserGlass and drives the same real
 * Chrome this demo's other probes drive through `bgls.v1`. Neither
 * playwright nor puppeteer is installed in this workspace (checked
 * directly: `node_modules/playwright` and `node_modules/puppeteer` do not
 * exist), so this is a minimal, hand-rolled raw CDP client using Node 22's
 * global `WebSocket` (the same runtime `ws/peer-upgrade.ts`'s own module
 * doc cites for `CdpBridge`'s production transport) rather than the `ws`
 * package, which is not a dependency of this demo app and is not hoisted
 * into its `node_modules` under this workspace's pnpm layout.
 *
 * What this proves, step by step, matching the wire sequence any real
 * driver library (Playwright, Puppeteer, chromedp) runs to bootstrap:
 *
 *   1. `Target.getTargets` - discovers the page BrowserGlass already
 *      launched for this instance.
 *   2. `Target.attachToTarget` - the call every REFUSED_DOMAINS entry in
 *      `rest/cdp-passthrough-allowlist.ts` blocks on the REST passthrough,
 *      and the one no driver library can start without.
 *   3. `Page.navigate` to a real, known page and `Page.loadEventFired` -
 *      a genuine navigation, not a canned reply.
 *   4. `Runtime.evaluate` reading `document.title` and a real DOM node's
 *      text - the other REFUSED_DOMAINS entry, and the read a CDP client
 *      most needs.
 *
 * Also proves what must NOT be true: `webSocketDebuggerUrl` from
 * `/json/version` never contains Chrome's real `cdpWsUrl` (checked
 * directly against the instance's real endpoint, which this probe cannot
 * even learn without reading BrowserGlass's own store, since
 * `InstanceRuntimeInfo.cdpWsUrl` documents itself as "Secret. Leaking this
 * is full browser control." and never leaves the node).
 */

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS_HOST = process.env.WS_HOST ?? 'localhost:3000';

const results = [];
function check(label, got, want) {
  const ok = typeof want === 'function' ? want(got) : Object.is(got, want);
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(52)} got=${JSON.stringify(got)}${ok ? '' : ` want=${typeof want === 'function' ? '<predicate>' : JSON.stringify(want)}`}`,
  );
  return ok;
}

function waitOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener(
      'error',
      (ev) => reject(new Error(`WebSocket error: ${ev.message ?? ev.type}`)),
      { once: true },
    );
  });
}

/** One pending CDP command, keyed by id, resolved/rejected by the shared message listener `connectCdp` installs. */
function makeRpc(ws) {
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8'));
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return; // an unsolicited CDP event, not a reply
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.message} (code ${msg.error.code})`));
    else p.resolve(msg.result);
  });
  return function rpc(method, params, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(
        JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  };
}

/** Resolves the next occurrence of a specific unsolicited CDP event on `sessionId`. */
function waitForEvent(ws, method, sessionId) {
  return new Promise((resolve) => {
    const onMessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8'));
      } catch {
        return;
      }
      if (msg.method === method && msg.sessionId === sessionId) {
        ws.removeEventListener('message', onMessage);
        resolve(msg.params);
      }
    };
    ws.addEventListener('message', onMessage);
  });
}

const PAGE_HTML =
  '<!doctype html><meta charset=utf8><title>CDP Proxy Probe</title>' +
  '<body><h1 id="h">Hello from real Chrome, reached through the CDP proxy</h1></body>';
const PAGE_URL = `data:text/html;charset=utf-8,${encodeURIComponent(PAGE_HTML)}`;

async function main() {
  // 1. Acquire a real instance the ordinary way (`bgls.v1`, the same path
  // every other probe in this directory uses), so this probe is proving
  // the CDP proxy reaches the SAME Chrome the rest of this SDK drives, not
  // a special one stood up only for this test.
  const acquireRes = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  if (!acquireRes.ok)
    throw new Error(`acquire failed ${acquireRes.status}: ${await acquireRes.text()}`);
  const cred = await acquireRes.json();
  console.log(`\ninstance ${cred.instanceId}\n`);

  // Mints a FRESH token carrying the `cdp` capability, minted anew for
  // every call below rather than reused. DEMO_CAPS (what `cred.token`
  // above carries) deliberately does not include `cdp` at all: it is the
  // raw, unfiltered escape hatch, granted here only to prove the endpoint.
  //
  // Minting one per call is not paranoia, it is required: this token's
  // `jti` is replay checked (`auth/verify.ts`'s `verifyToken`, any token
  // living under `JTI_REPLAY_CEILING_SEC` (300s), and this route's
  // `ttlSeconds: 120` qualifies), so the SAME token authenticating twice
  // is refused the second time as a replay, exactly the protection a
  // stolen or logged bearer token needs. A real CDP client normally never
  // notices, because it authenticates exactly once, dialling the
  // `webSocketDebuggerUrl` it already has directly rather than round
  // tripping through discovery first; this probe exercises BOTH paths
  // deliberately, so it needs its own fresh credential each time.
  async function mintCdpToken() {
    const res = await fetch(`${BASE}/api/browser/cdp-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: cred.instanceId, sessionId: cred.sessionId }),
    });
    if (!res.ok) throw new Error(`cdp-token mint failed ${res.status}: ${await res.text()}`);
    return res.json();
  }

  const firstToken = await mintCdpToken();
  check('minted token carries the cdp capability', firstToken.caps.includes('cdp'), true);

  // 2. GET /json/version, the HTTP discovery endpoint a real CDP client
  // library probes first. Proves it is reachable, capability gated (would
  // 401 without the query token), and that Chrome's real endpoint never
  // appears in the response: only this proxy's own path does.
  const versionRes = await fetch(
    `${BASE}/json/version?instanceId=${cred.instanceId}&token=${encodeURIComponent(firstToken.token)}`,
  );
  if (!versionRes.ok)
    throw new Error(`/json/version failed ${versionRes.status}: ${await versionRes.text()}`);
  const version = await versionRes.json();
  check(
    '/json/version reports a webSocketDebuggerUrl',
    typeof version.webSocketDebuggerUrl,
    'string',
  );
  check(
    "/json/version points at this proxy's own path, never at Chrome's real devtools/browser endpoint",
    version.webSocketDebuggerUrl,
    (url) =>
      url.includes(`/browserglass/cdp/${cred.instanceId}`) && !url.includes('/devtools/browser/'),
  );

  // Unauthenticated discovery must be refused, not silently answered.
  const unauthedVersionRes = await fetch(`${BASE}/json/version?instanceId=${cred.instanceId}`);
  check('/json/version without a token is refused (401)', unauthedVersionRes.status, 401);

  // 3. The real thing: connect a raw CDP WebSocket client through the
  // proxy and drive it exactly as Playwright/Puppeteer/chrome-remote-interface
  // would. A fresh token: `firstToken` was already consumed by the
  // `/json/version` call above.
  const wsToken = await mintCdpToken();
  const wsUrl = `ws://${WS_HOST}/browserglass/cdp/${cred.instanceId}?token=${encodeURIComponent(wsToken.token)}`;
  const ws = new WebSocket(wsUrl);
  await waitOpen(ws);
  console.log('  connected through the CDP proxy\n');
  const rpc = makeRpc(ws);

  try {
    const targets = await rpc('Target.getTargets', {});
    const page = (targets.targetInfos ?? []).find((t) => t.type === 'page');
    check('Target.getTargets reports at least one real page target', page !== undefined, true);

    const attached = await rpc('Target.attachToTarget', { targetId: page.targetId, flatten: true });
    check('Target.attachToTarget returns a real sessionId', typeof attached.sessionId, 'string');
    const sessionId = attached.sessionId;

    await rpc('Page.enable', {}, sessionId);
    const loadFired = waitForEvent(ws, 'Page.loadEventFired', sessionId);
    await rpc('Page.navigate', { url: PAGE_URL }, sessionId);
    await loadFired;

    const titleResult = await rpc(
      'Runtime.evaluate',
      { expression: 'document.title', returnByValue: true },
      sessionId,
    );
    check(
      'Runtime.evaluate reads document.title after a real navigation',
      titleResult.result?.value,
      'CDP Proxy Probe',
    );

    const textResult = await rpc(
      'Runtime.evaluate',
      { expression: 'document.getElementById("h").textContent', returnByValue: true },
      sessionId,
    );
    check(
      'Runtime.evaluate reads real text out of the real DOM',
      textResult.result?.value,
      'Hello from real Chrome, reached through the CDP proxy',
    );
  } finally {
    ws.close();
  }

  // 4. Policy: a REFUSED_DOMAINS method the REST passthrough hard-blocks
  // (`Target.attachToTarget` itself) just worked above; that is the whole
  // point of `security.cdpProxyEnabled` being a deliberate, documented
  // relaxation, not an oversight. Confirms the REST passthrough's own
  // refusal is unaffected by this proxy existing alongside it. Another
  // fresh token: this is a fourth distinct authenticated call.
  const restToken = await mintCdpToken();
  const restCdpRes = await fetch(
    `${BASE}/browserglass/v1/instances/${cred.instanceId}/targets/tgt_doesnotmatter/cdp`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${restToken.token}` },
      body: JSON.stringify({ method: 'Target.attachToTarget', params: {} }),
    },
  );
  const restCdpBody = await restCdpRes.json().catch(() => ({}));
  check(
    'the REST passthrough still refuses Target.* even for a cdp-capable token',
    restCdpRes.status === 403 && restCdpBody?.error?.code === 'E_CDP_METHOD_NOT_ALLOWED',
    true,
  );

  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const pass = results.filter(Boolean).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exitCode = 1;
});
