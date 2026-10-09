// Show that a named profile keeps its cookies after the browser is gone.
//
// Run 1 starts a browser on the profile key below, gets a cookie from
// httpbin.org, and ends the browser. Run 2 starts a brand new browser on the
// same key and asks httpbin which cookies it sent. This is how you keep a
// site logged in between jobs without logging in every time.
//
//   node examples/recipes/persistent-login.mjs
//
// The profile lives in the gateway's data dir (<data-dir>/profiles). Pick
// your own key per account or per job. Leave the key out and you get a
// throwaway profile that is deleted when the browser ends.

import { openBrowser } from './lib/gateway.mjs';

const PROFILE_KEY = process.env.PROFILE_KEY ?? 'recipes-demo-profile';
const stamp = String(Date.now());

async function cookiesSeenByHttpbin(client) {
  // httpbin.org/cookies answers with the cookies the browser sent, as JSON.
  await client.navigate('https://httpbin.org/cookies', { waitUntil: 'load' });
  await client.waitForFunction('document.readyState === "complete"');
  return JSON.parse(await client.text()).cookies;
}

// Run 1: set a cookie.
{
  const { client, instanceId, done } = await openBrowser({ profileKey: PROFILE_KEY });
  try {
    await client.acquireControl();
    // httpbin sends back whatever response header we ask for, so this gets
    // a real Set-Cookie from the server. Max-Age matters: like a site's
    // "remember me" cookie it is stored on disk. A cookie with no expiry is
    // a session cookie, and Chrome drops those when it exits, profile or not.
    const setCookie = `demo=${stamp}; Max-Age=86400; Path=/; Secure`;
    await client.navigate(
      `https://httpbin.org/response-headers?Set-Cookie=${encodeURIComponent(setCookie)}`,
      { waitUntil: 'load' },
    );
    console.log(`run 1 (${instanceId}): cookies now`, await cookiesSeenByHttpbin(client));

    // Chrome writes new cookies to disk in batches, about every 30 seconds.
    // On Windows this gateway ends Chrome with taskkill, which skips the
    // final write, so give the batch time to land before releasing. On a
    // long running job this wait is free: it has already happened.
    console.log('waiting 35 s for Chrome to write its cookie store...');
    await new Promise((r) => setTimeout(r, 35_000));
  } finally {
    await done(); // the browser is gone after this
  }
}

// Run 2: a different browser process, same profile key.
{
  const { client, instanceId, done } = await openBrowser({ profileKey: PROFILE_KEY });
  try {
    await client.acquireControl();
    const cookies = await cookiesSeenByHttpbin(client);
    console.log(`run 2 (${instanceId}): cookies now`, cookies);
    const kept = cookies.demo === stamp;
    console.log(kept ? 'PASS: the cookie survived the restart' : 'FAIL: the cookie was lost');
    process.exitCode = kept ? 0 : 1;
  } finally {
    await done();
  }
}
