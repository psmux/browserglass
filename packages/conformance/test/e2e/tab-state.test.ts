/**
 * The three `TargetSummary` fields that were shipped permanently wrong, and
 * the tab operation that was shipped as a silent no op.
 *
 * `loading`, `canGoBack` and `canGoForward` are what a tab strip renders as
 * a spinner and as back and forward controls. Nothing in the build ever
 * wrote `loading`, and `toTargetSummary` hard coded both history flags,
 * because `TargetRegistry` never enabled the `Page` domain on an attached
 * tab and so carried no navigation state at all. All three were `false`
 * forever, on every tab, in every session.
 *
 * `target.reorder` had no server handler whatsoever: the client's own
 * `tabs.reorder()` sent the message and nothing read it, so dragging tabs
 * into a new order did nothing and reported success.
 *
 * Every assertion below reads the ordinary `target.list` a real tab strip
 * reads, against real Chrome.
 */
import type { BrowserGlassClient, TargetSummary } from '@browserglass/client';
import type { InstanceId } from '@browserglass/protocol';
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

/** Polls `fn` until it returns a defined value or the deadline passes. */
async function until<T>(
  fn: () => Promise<T | undefined>,
  timeoutMs: number,
  everyMs = 150,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(everyMs);
  }
}

/** Waits until the summary for `targetId` satisfies `pred`, returning it. */
async function tabUntil(
  client: BrowserGlassClient,
  targetId: string,
  pred: (t: TargetSummary) => boolean,
  timeoutMs: number,
): Promise<TargetSummary | undefined> {
  return until(async () => {
    const tab = (await client.tabs.list()).find((t) => t.targetId === targetId);
    return tab && pred(tab) ? tab : undefined;
  }, timeoutMs);
}

/** The current back/forward state, in a form a failed assertion prints usefully. */
function history(tab: TargetSummary | undefined): string {
  return tab ? `canGoBack=${tab.canGoBack} canGoForward=${tab.canGoForward}` : 'no such tab';
}

describe('tab state a tab strip actually renders', () => {
  let instanceId: InstanceId;
  let client: BrowserGlassClient;

  beforeAll(async () => {
    const acquired = await gateway.acquireInstance();
    instanceId = acquired.instanceId;
    client = await gateway.makeClient(instanceId);
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    client?.destroy();
    if (instanceId) await gateway.releaseInstance(instanceId);
  }, 60_000);

  it('canGoBack and canGoForward track the real navigation history of the tab', async () => {
    // A tab created straight at a URL has exactly one history entry, so it
    // starts with nowhere to go in either direction. Starting from the
    // instance's own first tab would not be deterministic: it has already
    // navigated away from the new tab page before anything connects.
    const created = await client.tabs.new({ url: fixture.pageUrl('hist-a'), background: true });
    const targetId = created.targetId;
    await client.requestControl(targetId);
    // Subscribing forces the CDP attach, and the attach is what enables the
    // `Page` domain on this tab. Without it the first assertion could read a
    // tab whose history has not been looked at yet and pass on the default
    // rather than on the answer.
    await client.subscribe(targetId);

    const atStart = await tabUntil(
      client,
      targetId,
      (t) => t.url.includes('hist-a') && !t.loading,
      30_000,
    );
    expect(atStart, 'the new tab never settled on its first page').toBeDefined();
    expect(history(atStart)).toBe('canGoBack=false canGoForward=false');

    await client.navigate(targetId, fixture.pageUrl('hist-b'));
    const afterForward = await tabUntil(client, targetId, (t) => t.canGoBack, 30_000);
    expect(afterForward, 'a second page in the same tab did not make back available').toBeDefined();
    expect(history(afterForward)).toBe('canGoBack=true canGoForward=false');

    await client.back(targetId);
    const afterBack = await tabUntil(client, targetId, (t) => t.canGoForward, 30_000);
    expect(afterBack, 'going back did not make forward available').toBeDefined();
    expect(history(afterBack)).toBe('canGoBack=false canGoForward=true');

    // And the tab really is showing the earlier page again, not merely
    // reporting that it could.
    expect(afterBack?.url).toContain('hist-a');

    await client.tabs.close(targetId);
  }, 180_000);

  it('loading is true while a tab is genuinely mid load and false once it is not', async () => {
    const created = await client.tabs.new({ url: fixture.pageUrl('load-1'), background: true });
    const targetId = created.targetId;
    await client.requestControl(targetId);

    const settled = await tabUntil(
      client,
      targetId,
      (t) => t.url.includes('load-1') && !t.loading,
      30_000,
    );
    expect(settled, 'a finished page still reported itself as loading').toBeDefined();

    // `slowUrl` blocks its own parser on a request that is never answered,
    // so this tab stays genuinely mid load until something stops it. The
    // navigation is not awaited: it cannot settle for a page that never
    // finishes, which is the whole point of the case.
    void client.navigate(targetId, fixture.slowUrl('load-1')).catch(() => undefined);

    const midLoad = await tabUntil(client, targetId, (t) => t.loading, 30_000);
    expect(midLoad, 'a tab stuck mid load never reported loading:true').toBeDefined();

    await client.stopLoading(targetId);

    const stopped = await tabUntil(client, targetId, (t) => !t.loading, 30_000);
    expect(stopped, 'a stopped tab still reported loading:true').toBeDefined();

    await client.tabs.close(targetId);
  }, 180_000);

  it('target.reorder actually reorders the tabs, and every viewer of the instance sees the new order', async () => {
    const ids: string[] = [];
    for (const label of ['ord-1', 'ord-2', 'ord-3']) {
      ids.push((await client.tabs.new({ url: fixture.pageUrl(label), background: true })).targetId);
    }

    const before = (await client.tabs.list())
      .map((t) => t.targetId)
      .filter((id) => ids.includes(id));
    expect(before, 'the three new tabs did not all appear').toHaveLength(3);

    // A second viewer of the same instance, because tab order is a property
    // of the Instance and not of whoever dragged the tab.
    const observer = await gateway.makeClient(instanceId);
    await observer.connect();

    const reversed = [...before].reverse();
    await client.tabs.reorder(reversed);

    const applied = await until(async () => {
      const order = (await client.tabs.list())
        .map((t) => t.targetId)
        .filter((id) => ids.includes(id));
      return order.join(',') === reversed.join(',') ? order : undefined;
    }, 20_000);
    expect(applied, 'the requested tab order was never applied').toBeDefined();

    const seenByObserver = await until(async () => {
      const order = (await observer.tabs.list())
        .map((t) => t.targetId)
        .filter((id) => ids.includes(id));
      return order.join(',') === reversed.join(',') ? order : undefined;
    }, 20_000);
    expect(seenByObserver, 'the other viewer never saw the new tab order').toBeDefined();

    observer.destroy();
    for (const id of ids) await client.tabs.close(id).catch(() => undefined);
  }, 180_000);
});
