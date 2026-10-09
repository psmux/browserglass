/**
 * Closing a tab is an ordinary thing a user does, and it must not disturb
 * the Instance the tab belongs to.
 *
 * It did. Chrome answers `Target.closeTarget` with
 * `Target.detachedFromTarget` and only then `Target.targetDestroyed`, and
 * `TargetRegistry` emitted `'detached'` for that first event, which reaches
 * `Session.reportSignal` as the `cdp_detached` recovery signal. So closing
 * one tab put the whole Instance into `recovering`: the remaining viewers
 * were told the instance was recovering, and anyone who connected during
 * the window was refused outright, the socket closing on
 * "illegal recovering --viewerAttached--> ?". The registry's own
 * `recentlyDestroyed` guard could not help, because it is populated by the
 * destroy event, which arrives after the detach.
 *
 * This asserts the two things that were actually broken: a second viewer
 * can still connect after a tab closes, and no viewer is told the instance
 * is recovering.
 */
import type { BrowserGlassClient } from '@browserglass/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FixtureServer, startFixtureServer } from './support/fixture-server.js';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

let gateway: RealGateway;
let fixture: FixtureServer;

beforeAll(async () => {
  [gateway, fixture] = await Promise.all([
    startRealGateway({ headless: 'new' }),
    startFixtureServer(),
  ]);
}, 180_000);

afterAll(async () => {
  await Promise.all([gateway?.close(), fixture?.close()]);
}, 120_000);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('closing a tab leaves its Instance alone', () => {
  it('a tab that is controlled, streaming and mid load can be closed without putting the session into recovery', async () => {
    const acquired = await gateway.acquireInstance();
    const client: BrowserGlassClient = await gateway.makeClient(acquired.instanceId);

    /** Every `instance.recovering` this viewer is told about. Recovery is legitimate after a real fault; the point here is that closing a tab is not one. */
    const recoveringNotices: unknown[] = [];
    client.on('recovering', (ev) => recoveringNotices.push(ev));
    await client.connect();

    // A tab the Session is genuinely managing: it holds a control lease and
    // a live stream, which is what puts it in `Session.perTarget` and so
    // makes its detach signal reach the recovery ladder at all.
    const created = await client.tabs.new({ url: fixture.pageUrl('closing'), background: true });
    const targetId = created.targetId;

    const control = await client.requestControl(targetId);
    expect(control.granted).toBe(true);
    await client.subscribe(targetId);

    // Left deliberately mid load, the least forgiving moment to close at:
    // this page's parser is blocked on a request that is never answered.
    void client.navigate(targetId, fixture.slowUrl('closing')).catch(() => undefined);
    await sleep(1000);

    await client.tabs.close(targetId);

    // The recovery ladder is asynchronous, so a moment is given for a
    // wrongly-triggered one to show itself.
    await sleep(2500);

    expect(recoveringNotices, 'closing a tab announced an instance recovery').toEqual([]);

    // The load-bearing consequence: a second viewer can still get in. While
    // the session sat in `recovering`, this threw `internal_error` as the
    // gateway closed the socket during the handshake.
    const observer = await gateway.makeClient(acquired.instanceId);
    await observer.connect();
    expect(observer.viewerId).not.toBe(client.viewerId);

    // And the instance is still usable by the original viewer.
    const tabs = await client.tabs.list();
    expect(
      tabs.some((t) => t.targetId === targetId),
      'the closed tab is still listed',
    ).toBe(false);
    expect(tabs.length, 'closing one tab took the rest of them with it').toBeGreaterThan(0);

    observer.destroy();
    client.destroy();
    await gateway.releaseInstance(acquired.instanceId);
  }, 180_000);
});
