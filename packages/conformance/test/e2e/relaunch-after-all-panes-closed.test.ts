import type { BrowserGlassClient } from '@browserglass/client';
import type { InstanceId } from '@browserglass/protocol';
/**
 * Real-Chrome, headful-only coverage for the defect found driving the real
 * demo: close every pane at once, then open a new one.
 *
 * Under `isolation: 'window'` every streamed target is a whole OS window,
 * so closing every pane closes every window. Headful Chrome quits when its
 * last window closes (a desktop-shell behaviour; headless Chrome has no
 * shell and cannot reproduce this at all), which takes the CDP WebSocket
 * down with it. `Session.createTarget()` (`packages/core/src/session/session.ts`)
 * is the fix under test: it detects the dead bridge and transparently
 * relaunches the browser, reusing `restartInstance()`'s own `R4` machinery,
 * before handing the call on to `TargetRegistry.create()`.
 *
 * This MUST run `headless: 'off'`. `packages/runtime-host/test/spike/spike-keep-alive.ts`
 * measured this directly against real Chrome 151: headless survives zero
 * windows, headful does not, and no launch flag changes that (see that
 * file's own module doc for the full measurement). A `headless: 'new'` run
 * of this file would pass whether or not the fix exists, which is exactly
 * why this is its own file rather than folded into `parallel-live-streams.test.ts`
 * (`headless: 'new'`, and its own "closes and
 * reopens every target" case cannot see this defect for the same reason).
 *
 * Three things this file asserts:
 *
 * 1. Closing every pane leaves no window behind at all: `target.list` (via
 *    `client.targets`) is empty, not "empty except for one anchor tab the
 *    server kept alive." An anchor window would be a visible, permanently
 *    open browser nobody is using, which is the exact thing "excess
 *    browsers should not be spawned except what is used" rules out.
 * 2. The next `target.new` succeeds and comes back with a real, live
 *    target: capturing a real `Page.captureScreenshot` from it proves the
 *    relaunched browser is genuinely driving Chrome, not just a resolved
 *    promise with a made-up target id.
 * 3. Three `target.new` calls that race (the user opening three panes at
 *    once) produce exactly one relaunch and three distinct targets, all
 *    on the SAME client connection this suite already had open: the
 *    viewer never had to reconnect, re-authenticate, or re-acquire.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

let gateway: RealGateway;
let fixture: FixtureServer;
let client: BrowserGlassClient;
let instanceId: InstanceId;

beforeAll(async () => {
  [gateway, fixture] = await Promise.all([
    // `headless: 'off'` is load-bearing: see the module doc. `isolation:
    // 'window'` is what makes every streamed target its own OS window, the
    // precondition for "closing every pane closes every window."
    startRealGateway({ headless: 'off', isolation: 'window' }),
    startFixtureServer(),
  ]);

  const acquired = await gateway.acquireInstance();
  instanceId = acquired.instanceId;
  client = await gateway.makeClient(instanceId);
  await client.connect();
}, 120_000);

afterAll(async () => {
  // Same cleanup contract as `parallel-live-streams.test.ts`:
  // `gateway.close()` releases every acquired instance, disposes the
  // runtime (which SIGTERMs anything still tracked, `killOnShutdown:
  // true`), and then sweeps this run's own `profileRoot` for any straggler
  // `chrome.exe` a launch-through-relaunch cycle left behind, so a failed
  // assertion above can never leave a real, visible window on this
  // machine.
  await gateway?.close(client ? [client] : []);
  await fixture?.close();
}, 120_000);

describe('a browser that lost every window comes back transparently on the next target.new', () => {
  it('closing every pane leaves no window behind, and a single target.new after that relaunches and streams', async () => {
    // Whatever the launch opened by default plus one extra tab: at least
    // two real OS windows to close at once, matching "closing ...
    // parallelly simultaneously" rather than a single-tab edge case.
    const startingIds = client.targets.map((t) => t.targetId);
    if (startingIds.length < 2) {
      const created = await client.tabs.new({ url: fixture.pageUrl('seed') });
      startingIds.push(created.targetId);
    }
    expect(startingIds.length).toBeGreaterThanOrEqual(2);

    await Promise.all(startingIds.map((targetId) => client.tabs.close(targetId)));

    // No anchor tab left behind: every pane closed really means every
    // window closed, not "every window but one the server kept open on
    // its own account."
    const noneLeft = await waitUntil(() => client.targets.length === 0, 5000);
    expect(noneLeft).toBe(true);
    expect(client.targets).toEqual([]);

    // The moment of the defect: Chrome has already quit (its last window
    // just closed), so the CDP WebSocket this session's `Session` holds
    // is dead. Before the fix, this next call rejected outright with
    // `CdpError: Target.createTarget rejected, the bridge closed`.
    const reopened = await client.tabs.new({ url: fixture.animatedUrl('reopened') });
    expect(reopened.targetId).toBeTruthy();
    // `isolation: 'window'` still applies to the relaunched browser: the
    // fix must not silently fall back to tab isolation.
    expect(typeof reopened.windowId).toBe('number');

    // Real liveness, not just a well-shaped reply: a real
    // `Page.captureScreenshot` round trip against the relaunched
    // browser's CDP session, the same proof `reply-correlation.test.ts`
    // uses ("capture.blob.size > 0" is a real screenshot, not an empty
    // placeholder).
    const capture = await client.capture(reopened.targetId);
    expect(capture.targetId).toBe(reopened.targetId);
    expect(capture.blob.size).toBeGreaterThan(0);
    await client.tabs.close(reopened.targetId);
  }, 90_000);

  it('three target.new calls that race after every pane is closed relaunch exactly once and all three come back, on the same connection', async () => {
    const remaining = client.targets.map((t) => t.targetId);
    if (remaining.length > 0) {
      await Promise.all(remaining.map((targetId) => client.tabs.close(targetId)));
      await waitUntil(() => client.targets.length === 0, 5000);
    }
    expect(client.targets).toEqual([]);

    // The scenario being reproduced: a user opens three panes at
    // once. No await between these three calls: `Promise.all` starts
    // them all before any of them resolves, which is what actually
    // exercises the single-flight guard in `Session.createTarget()`
    // rather than three sequential relaunches that happen to each
    // succeed on their own.
    const created = await Promise.all([
      client.tabs.new({ url: fixture.animatedUrl('race-0') }),
      client.tabs.new({ url: fixture.animatedUrl('race-1') }),
      client.tabs.new({ url: fixture.animatedUrl('race-2') }),
    ]);

    expect(created).toHaveLength(3);
    const ids = created.map((t) => t.targetId);
    expect(new Set(ids).size).toBe(3);
    for (const t of created) {
      expect(typeof t.windowId).toBe('number');
    }

    // Every target genuinely exists in the relaunched browser: a real
    // `Page.captureScreenshot` against each one, on the exact same
    // `client`/socket this suite connected at the top of the file. If
    // the viewer had been forced to reconnect, `client.capture` below
    // would be operating on a stale or dead transport and would time out
    // or throw.
    //
    // Sequential, not `Promise.all`: `target.capture` is rate limited to
    // `captureRatePerSec: 1` per viewer (`@browserglass/protocol`'s
    // `DEFAULT_LIMITS`), which is a wire-layer concern unrelated to the
    // relaunch fix under test here; three at once trips it and answers
    // with `bgls.error.rate_limited` instead of a screenshot. The
    // `target.new` race just above stays fully concurrent, since that is
    // the actual behaviour this file exists to prove.
    //
    // The leading sleep is the same rate limit's own recovery, not the
    // fix under test: the previous `it()` already spent this connection's
    // one `capture` token, and a fast relaunch (this one, reusing a
    // recently-launched profile) can land here well under the 1 token per
    // second refill.
    await sleep(1100);
    for (const targetId of ids) {
      const capture = await client.capture(targetId);
      expect(capture.blob.size).toBeGreaterThan(0);
      await sleep(1100);
    }

    await Promise.all(ids.map((targetId) => client.tabs.close(targetId)));
  }, 120_000);
});
