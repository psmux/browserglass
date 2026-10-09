// An agent works, stops at a step it should not do alone, waits for a person
// to do it, then carries on.
//
// The step here is typing a password on the demo login page at
// quotes.toscrape.com (it accepts any username and password). In real life
// it is a CAPTCHA, a 2FA prompt, or "are you sure you want to pay?".
//
//   node examples/recipes/human-in-the-loop.mjs                   # waits for a real person
//   node examples/recipes/human-in-the-loop.mjs --simulate-human  # a second client plays the person
//
// How the handover works. The agent's token carries the `automation`
// capability, which makes the gateway file it as an agent. The person's
// token does not, so the person counts as a human, and a human outranks an
// agent. The agent calls yieldControl(), which drops its control lease
// straight away, so the person can take the browser without waiting. Then
// it waits for someone to pick the browser up, and waitForResume() returns
// once that person lets go. Nothing here re-takes control on a timer: the
// agent asks again, explicitly, with acquireControl().

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { AutomationClient, WS_URL, mintToken, openBrowser, outDir } from './lib/gateway.mjs';

const simulate = process.argv.includes('--simulate-human');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { client: agent, instanceId, done } = await openBrowser({ sub: 'agent:login-bot' });

// Registered once. Fires on every stand down: our own yield, or a person
// grabbing control while the agent was still driving.
agent.onControlYield((ev) => {
  const who = ev.reason === 'voluntary' ? 'the agent itself' : ev.byLabel || 'someone';
  console.log(`[agent] stood down (${ev.phase}, ${ev.reason}), by ${who}, human=${ev.human}`);
});

try {
  // 1. The agent does the part it can do.
  await agent.acquireControl({ reason: 'logging in' });
  await agent.navigate('https://quotes.toscrape.com/login', { waitUntil: 'load' });
  await agent.fill('label=Username', 'demo-user');
  console.log('[agent] filled the username, the password is for a person to type');

  // 2. A token for the person. view + control, and no `automation`, which
  // is what makes them a human to the gateway. Hand it to whatever page
  // shows the live browser (a <browser-glass> element, the React
  // component, examples/embed-demo).
  const humanToken = await mintToken(instanceId, {
    caps: ['view', 'control', 'navigate'],
    sub: 'person:reviewer',
  });
  console.log('[agent] waiting for a person. Viewer settings:');
  console.log(`          url:   ${WS_URL}`);
  console.log(`          token: ${humanToken.slice(0, 24)}... (full token in out/human-token.txt)`);
  writeFileSync(join(outDir(), 'human-token.txt'), `${humanToken}\n`);

  // 3. Step aside. The lease is released now, not after a grace period.
  await agent.yieldControl('need a person to enter the password');

  if (simulate) {
    simulatedPerson(instanceId).catch((err) => console.error('[person] failed:', err.message));
  }

  // 4. Wait for a person to take the browser, then for them to let go.
  // "Someone else" matters: for a moment after the yield the gateway's
  // lease broadcast can still name the agent itself as the holder.
  const someoneElseHasIt = async () => {
    const holder = (await agent.status()).leaseHolderViewerId;
    return holder !== null && holder !== agent.viewerId;
  };
  while (!(await someoneElseHasIt())) await sleep(250);
  console.log('[agent] a person has control, waiting for them to finish');
  await agent.waitForResume({ timeoutMs: 10 * 60_000 });

  // 5. Ask for control again and check what the person did.
  await agent.acquireControl({ reason: 'continuing after the login' });
  const loggedIn = await agent.evaluate(
    () => !!document.querySelector('a[href="/logout"]') && location.pathname === '/',
  );
  console.log(`[agent] control is back. logged in: ${loggedIn}`);
  const first = await agent.evaluate(
    () => document.querySelector('.quote .text')?.textContent ?? null,
  );
  console.log(`[agent] carrying on. First quote on the page: ${first}`);
  process.exitCode = loggedIn ? 0 : 1;
} finally {
  await done();
}

// Plays the person for a test run: connects with a token that has no
// `automation`, takes control, types the password, presses Enter, lets go.
// A real person does the same thing by clicking into the live view.
async function simulatedPerson(id) {
  await sleep(2000);
  const token = await mintToken(id, {
    caps: ['view', 'control', 'navigate', 'evaluate'],
    sub: 'person:simulated',
  });
  const person = await AutomationClient.connect({ endpoint: WS_URL, token, instanceId: id });
  try {
    const lease = await person.acquireControl({ reason: 'typing the password' });
    console.log('[person] took control');
    await person.fill('#password', 'not-a-real-password');
    await person.pressKey('Enter'); // submit the form, as most people do
    await person.waitForFunction(`location.pathname === '/' && document.readyState === 'complete'`);
    console.log('[person] logged in, handing back');
    await lease.release();
  } finally {
    person.close();
  }
}
