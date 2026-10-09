/**
 * The CDP collaboration probe.
 *
 * `cdp-attach-probe.mjs` proves the raw CDP proxy reaches real Chrome.
 * This probe proves the point of THIS pass: that a raw CDP client attached
 * through the proxy (`packages/server/src/ws/cdp-upgrade.ts`) is a real,
 * first-class participant in BrowserGlass's collaboration model, not an
 * invisible side channel around it. Concretely:
 *
 *   1. The raw CDP client appears in `presence.state`, with `kind: 'agent'`
 *      and `controlling` naming the target it holds the lease on. A HUMAN
 *      viewer (a real `@browserglass/client` `BrowserGlassClient`, the
 *      same class the demo's own UI uses, carrying a token with no
 *      `automation` capability) is what reads this roster back, exactly as
 *      a real operator's UI would.
 *
 *   2. When that human viewer takes control of the same target
 *      (`client.requestControl(targetId)`, the ordinary "take the wheel"
 *      button any exclusive-mode app already has), the raw CDP client's
 *      socket closes with `CONTROL_LOST` (4611): a comprehensible failure a
 *      Playwright/Puppeteer caller can catch, not a hang and not a silent
 *      continuation of driving underneath the person who just took over.
 *
 *   3. `presence.state` settles to show the human now controlling the
 *      target and the CDP client gone from the roster entirely: no ghost
 *      viewer, no ghost lease.
 *
 * Two real drivers, one real browser, one real lease: this is the
 * end-to-end proof `test/session/managed-session-collab.test.ts` and
 * `test/ws/cdp-upgrade.test.ts` (unit level, `@browserglass/server`) argue
 * for from the inside; this probe is the outside view, through the exact
 * two client libraries a real integration would use.
 */

import { BrowserGlassClient } from '@browserglass/client';

const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS_HOST = process.env.WS_HOST ?? 'localhost:3000';
const WS = process.env.WS ?? `ws://${WS_HOST}/browserglass/socket`;

const results = [];
function check(label, got, want) {
  const ok = typeof want === 'function' ? want(got) : Object.is(got, want);
  results.push(ok);
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(66)} got=${JSON.stringify(got)}${ok ? '' : ` want=${typeof want === 'function' ? '<predicate>' : JSON.stringify(want)}`}`,
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

function waitClose(ws) {
  return new Promise((resolve) => {
    ws.addEventListener('close', (ev) => resolve({ code: ev.code, reason: ev.reason }), {
      once: true,
    });
  });
}

/** Polls `fn` (a synchronous predicate) until it returns true or `timeoutMs` elapses, checking every `stepMs`. Returns the last value `fn` produced. */
async function waitFor(fn, { timeoutMs = 5000, stepMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

async function main() {
  // 1. Acquire a real instance the ordinary way, the same path every other
  // probe in this directory uses.
  const acquireRes = await fetch(`${BASE}/api/browser`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ fresh: true }),
  });
  if (!acquireRes.ok)
    throw new Error(`acquire failed ${acquireRes.status}: ${await acquireRes.text()}`);
  const cred = await acquireRes.json();
  console.log(`\ninstance ${cred.instanceId}\n`);

  // 2. The HUMAN: an ordinary `@browserglass/client` connection, minted
  // WITHOUT `automation` (`/api/browser/human-token`, this probe's own
  // route: see its module doc for why `POST /api/browser/token` cannot be
  // reused here), so `ws/connection.ts`'s `viewerIdentity()` derives
  // `kind: 'human'`, `DEFAULT_PRIORITY.human` (100), for real, the way an
  // actual operator's browser tab would be, not merely labelled so.
  async function mintHumanToken() {
    const res = await fetch(`${BASE}/api/browser/human-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: cred.instanceId, sessionId: cred.sessionId }),
    });
    if (!res.ok) throw new Error(`token mint failed ${res.status}: ${await res.text()}`);
    return res.json();
  }

  const humanToken = await mintHumanToken();
  const human = new BrowserGlassClient({ url: WS, token: humanToken.token });
  await human.connect();
  check('the human viewer connects and sees at least one target', human.targets.length > 0, true);
  const targetId = human.targets[0].targetId;

  const humanEntry = () => human.presence.find((v) => v.viewerId === human.viewerId);
  check('the human itself appears in presence.state with kind human', humanEntry()?.kind, 'human');

  // 3. Mints a FRESH `cdp` token per call, matching `cdp-attach-probe.mjs`'s
  // own reasoning (`jti` replay protection): a raw CDP client authenticates
  // exactly once, so a fresh token per attempt is required here, not
  // paranoia.
  async function mintCdpToken() {
    const res = await fetch(`${BASE}/api/browser/cdp-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ instanceId: cred.instanceId, sessionId: cred.sessionId }),
    });
    if (!res.ok) throw new Error(`cdp-token mint failed ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // 4. The raw CDP client: no `bgls.v1` anywhere in it, exactly the shape
  // a real Playwright/Puppeteer/chrome-remote-interface client dials.
  const cdpToken = await mintCdpToken();
  const cdpWsUrl = `ws://${WS_HOST}/browserglass/cdp/${cred.instanceId}?token=${encodeURIComponent(cdpToken.token)}`;
  const cdpWs = new WebSocket(cdpWsUrl);
  await waitOpen(cdpWs);
  console.log('  raw CDP client attached through the proxy\n');

  // 5. REQUIREMENT 1: the CDP client is visible, as kind agent, controlling
  // the same target the human is looking at. `presence.state` broadcasts
  // are asynchronous relative to this probe's own `waitOpen` (the human's
  // OWN connection is a different socket from the CDP proxy's), so this
  // polls the human's live `.presence` getter rather than assuming the
  // very next event already carries it.
  const cdpEntry = await waitFor(() => human.presence.find((v) => v.label.startsWith('cdp:')), {
    label: 'the CDP client to appear in presence.state',
  });
  check(
    'the CDP client appears in presence.state (not invisible to it)',
    cdpEntry !== undefined,
    true,
  );
  check("the CDP client's kind is 'agent'", cdpEntry?.kind, 'agent');
  check(
    'the CDP client is shown controlling the same target the human sees',
    cdpEntry?.controlling?.includes(targetId),
    true,
  );
  check(
    'the CDP client holds no video subscription (watching is empty)',
    cdpEntry?.watching,
    (w) => Array.isArray(w) && w.length === 0,
  );

  // Drive something real through the raw pipe, so this probe also proves
  // the CDP client was not merely granted a lease on paper but was
  // actually able to use it before the human ever showed up.
  let nextId = 1;
  function rpc(method, params, sessionId) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const onMessage = (ev) => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString('utf8'));
        if (msg.id !== id) return;
        cdpWs.removeEventListener('message', onMessage);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      };
      cdpWs.addEventListener('message', onMessage);
      cdpWs.send(
        JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }
  const cdpTargets = await rpc('Target.getTargets', {});
  const rawPage = (cdpTargets.targetInfos ?? []).find((t) => t.type === 'page');
  check('the raw CDP client can list at least one real page target', rawPage !== undefined, true);
  const attached = await rpc('Target.attachToTarget', {
    targetId: rawPage.targetId,
    flatten: true,
  });
  const evaluated = await rpc(
    'Runtime.evaluate',
    { expression: '1 + 1', returnByValue: true },
    attached.sessionId,
  );
  check(
    'the raw CDP client actually drives (Runtime.evaluate reaches real Chrome)',
    evaluated.result?.value,
    2,
  );

  // 6. REQUIREMENT 3/4: the human takes control. Priority (`human: 100` >
  // `agent: 50`) means this wins; the CDP client cannot cooperate with the
  // engine's grace period the way a `bgls.v1` `AutomationClient` can, so it
  // must observably stop, not hang and not keep driving underneath the
  // person who just took over.
  const cdpClosed = waitClose(cdpWs);
  console.log('\n  the human takes control...\n');
  // In exclusive mode, preempting an AGENT holder is two steps
  // (`ControlLeaseEngine`'s own module doc, "TWO MODES... the two-step
  // preemption machine"): the human's OWN `control.request` gets
  // `control.queued` immediately (the CDP agent is still, technically,
  // the current holder during the grace window), and `control.granted`
  // follows once the CDP client actually stands down (or the grace
  // deadline lapses). So `queued: true` here is success, not a stalled
  // request; `human.presence`'s own `controlling[]` (checked further
  // down) is what proves the handover actually completed.
  const outcome = await human.requestControl(targetId, { reason: 'taking the wheel' });
  check(
    "the human's requestControl begins a preemption (queued) rather than being denied outright",
    outcome.granted === false && outcome.queued === true,
    true,
  );

  const { code } = await Promise.race([
    cdpClosed,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error('timed out waiting for the CDP socket to close')), 5000),
    ),
  ]);
  check('the raw CDP socket closes once the human takes over (CONTROL_LOST, 4611)', code, 4611);

  // A closed socket cannot drive: proves "stops being able to drive" is
  // not merely "the server would refuse it" but "there is no channel left
  // to try it on at all".
  check(
    'the raw CDP socket is actually closed, not merely told to stop',
    cdpWs.readyState,
    WebSocket.CLOSED,
  );

  // 7. REQUIREMENT 6: presence settles cleanly. The human now controls the
  // target, and the CDP client's row is gone entirely, not left behind as
  // a ghost.
  await waitFor(() => humanEntry()?.controlling?.includes(targetId), {
    label: "the human's own controlling[] to include the target",
  });
  check(
    'the human now shows as controlling the target',
    humanEntry()?.controlling?.includes(targetId),
    true,
  );
  await waitFor(() => !human.presence.some((v) => v.label.startsWith('cdp:')), {
    label: 'the CDP client to disappear from presence.state',
  });
  check(
    'the CDP client is gone from presence.state (no ghost viewer)',
    human.presence.some((v) => v.label.startsWith('cdp:')),
    false,
  );

  human.destroy();
  await fetch(`${BASE}/api/browser?instanceId=${cred.instanceId}`, { method: 'DELETE' });

  const pass = results.filter(Boolean).length;
  console.log(`\n=== ${pass}/${results.length} passed ===`);
  if (pass !== results.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error('probe failed:', err);
  process.exitCode = 1;
});
