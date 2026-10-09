/**
 * `TargetSummary.title` (`packages/protocol/src/wire/messages/targets.ts`)
 * is what a tab strip renders, and it used to be wrong for the whole life
 * of a session.
 *
 * Chrome emits `Target.targetInfoChanged` when a target's URL changes and
 * never when its title changes: verified directly against real Chrome, a
 * navigation reports the bare host as the title, the document then parses
 * its own `<title>`, and no further event is ever sent. `Target.getTargets`
 * is the only source of the real value, `TargetRegistry.resync()` was the
 * only caller, it ran on a 30 second interval, and it applied what it found
 * without emitting anything, so no viewer was ever told.
 *
 * The visible symptom was a tab strip stuck showing `127.0.0.1:1234/page`
 * where the page's own title should be.
 */
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

describe('tab titles reach the client', () => {
  it("a tab reports the page's own <title>, not its URL, well inside the registry's 30 second resync interval", async () => {
    const acquired = await gateway.acquireInstance();
    const client = await gateway.makeClient(acquired.instanceId);
    await client.connect();
    const targetId = client.targets[0]!.targetId;

    await client.requestControl(targetId);
    await client.navigate(targetId, fixture.pageUrl('titled'));

    // Ten seconds is a third of the resync interval: passing here means
    // the catch-up path ran, not that the periodic sweep eventually did.
    const deadline = Date.now() + 10_000;
    let title = '';
    while (Date.now() < deadline) {
      title = (await client.tabs.list()).find((t) => t.targetId === targetId)?.title ?? '';
      if (title === 'READY:titled') break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(title).toBe('READY:titled');

    client.destroy();
    await gateway.releaseInstance(acquired.instanceId);
  }, 120_000);
});
