import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * End-to-end coverage of window isolation's server leg:
 *
 *  - `ManagedSession.promoteOnInput` must not demote a target in a
 *    different OS window: driving target B in window 2 must leave target
 *    A, active in window 1, still `active: true`.
 *  - `target.new`'s `newWindow` forwards to `TargetRegistry.create()`,
 *    explicitly when the caller says so, and from
 *    `ManagedSessionOptions.defaultNewWindow` (the `BrowserSpec.isolation`
 *    resolved default) when the caller does not.
 *
 * Uses the real `bgls.v1` gateway over a real socket, against
 * `FakeChromeServer`'s CDP responder (see that module's doc comment): the
 * one thing scripted here beyond what conformance.test.ts already relies
 * on is `Browser.getWindowForTarget`'s per-target `windowId` answer, which
 * is what makes two pre-added fixture targets land in two different
 * `TargetActivationPolicy.activeByWindow` buckets.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    ...overrides,
  };
}

async function connectAndWelcome(
  gw: TestGateway,
): Promise<{ ws: WebSocket; welcome: Record<string, unknown> }> {
  const token = await gw.issueToken();
  const ws = gw.connect();
  await waitOpen(ws);
  ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
  const welcome = await nextMessage(ws);
  const presenceState = await nextMessage(ws);
  if (presenceState['t'] !== 'presence.state') {
    throw new Error(
      `expected presence.state right after welcome, got "${String(presenceState['t'])}"`,
    );
  }
  return { ws, welcome };
}

/**
 * Unsolicited server pushes that can land between a request and its reply,
 * and which every helper below has to read past.
 *
 * `target.updated` is the one that matters here and it is not noise, it is
 * this feature working: subscribing a target promotes it to the active
 * target of its own window, and the server broadcasts that `active` flip to
 * every viewer immediately. A helper that treated the next message off the
 * socket as its own correlated reply would therefore fail precisely when
 * the code under test is behaving correctly.
 */
// `target.created` is deliberately NOT in this list: it is the correlated
// reply to `target.new`, which the newWindow cases below wait on.
const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

/** Subscribes `ws` to `targetId` and drains through `stream.subscribed`. */
async function subscribe(ws: WebSocket, targetId: string): Promise<void> {
  ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
  const reply = await nextMessageSkipping(ws, UNSOLICITED);
  if (reply['t'] !== 'stream.subscribed') {
    throw new Error(
      `expected stream.subscribed for ${targetId}, got "${String(reply['t'])}": ${JSON.stringify(reply)}`,
    );
  }
}

/**
 * Waits for the `target.updated` that `broadcastActiveFlags()` emits for
 * `targetId` carrying `changed.active === want`, reading past every other
 * message on the way.
 */
async function waitForActiveUpdate(ws: WebSocket, targetId: string, want: boolean): Promise<void> {
  for (;;) {
    const msg = await nextMessage(ws);
    if (msg['t'] !== 'target.updated' || msg['targetId'] !== targetId) continue;
    const changed = msg['changed'] as { active?: boolean } | undefined;
    if (changed?.active === want) return;
  }
}

/** Reads `target.list`'s current `active` flag for `targetId`. */
async function activeFlag(ws: WebSocket, targetId: string): Promise<boolean> {
  ws.send(JSON.stringify({ v: 1, t: 'target.list', ts: Date.now() }));
  const reply = await nextMessageSkipping(ws, UNSOLICITED);
  const targets = reply['targets'] as Array<{ targetId: string; active: boolean }>;
  const found = targets.find((t) => t.targetId === targetId);
  if (!found) throw new Error(`target.list did not include ${targetId}`);
  return found.active;
}

describe('window isolation: promoteOnInput does not demote across windows', () => {
  let gw: TestGateway;

  beforeEach(async () => {
    gw = await startTestGateway();
    // Two targets sharing window 1 (A1 subscribes first, so it is the one
    // that goes live; A2 starts in background/poll mode per
    // `ensureSubscribed`), plus one target alone in window 2. This is the
    // shape that actually exercises `promoteOnInput`: driving A2 must call
    // `TargetActivationPolicy.activate()` (a real promotion, demoting A1,
    // its own window-mate) while leaving B (a different window) untouched.
    // A two-target fixture where the driven target is already active
    // (as the very first draft of this test had) never reaches
    // the demotion path at all and would not have caught the original bug.
    gw.addTarget({
      targetId: 'cdp-a1',
      type: 'page',
      title: 'A1',
      url: 'https://a1.example',
      attached: false,
      windowId: 1,
    });
    gw.addTarget({
      targetId: 'cdp-a2',
      type: 'page',
      title: 'A2',
      url: 'https://a2.example',
      attached: false,
      windowId: 1,
    });
    gw.addTarget({
      targetId: 'cdp-b',
      type: 'page',
      title: 'B',
      url: 'https://b.example',
      attached: false,
      windowId: 2,
    });
  });

  afterEach(async () => {
    await gw.close();
  });

  it('promoting a background tab in one window demotes only its own window-mate, never a target in another window', async () => {
    const { ws, welcome } = await connectAndWelcome(gw);
    const targets = welcome['targets'] as Array<{ targetId: string }>;
    const byTitle = (title: string): string =>
      targets.find((t) => (t as unknown as { title: string }).title === title)!.targetId;
    const idA1 = byTitle('A1');
    const idA2 = byTitle('A2');
    const idB = byTitle('B');

    await subscribe(ws, idA1);
    await subscribe(ws, idA2);
    await subscribe(ws, idB);

    // Starting shape: A1 live (first subscriber in window 1), A2 polling
    // (window 1 already had an active target), B live (only subscriber in
    // window 2).
    expect(await activeFlag(ws, idA1)).toBe(true);
    expect(await activeFlag(ws, idA2)).toBe(false);
    expect(await activeFlag(ws, idB)).toBe(true);

    // Drive A2: this is the real promotion path, not a no-op.
    ws.send(
      JSON.stringify({
        v: 1,
        t: 'input.mouse',
        ts: Date.now(),
        targetId: idA2,
        kind: 'move',
        x: 5,
        y: 5,
        fw: 800,
        fh: 600,
        buttons: 0,
        modifiers: 0,
      }),
    );

    // `promoteOnInput` is fire-and-forget, and the promotion behind it is
    // not one tick: it resolves the target's window, sends
    // `Target.activateTarget`, then stops and rebuilds two `FrameSource`s
    // (the demoted window-mate's and the promoted target's), each with its
    // own CDP round trips. A single ping round trip returns long before
    // any of that finishes, which is what made an earlier version of this
    // test read the pre-promotion state back and fail.
    //
    // So wait on the effect itself rather than on elapsed time: the last
    // thing `activateTarget` does is `broadcastActiveFlags()`, which emits
    // one `target.updated` per target. Waiting for A2's to arrive saying
    // `active: true` is exact, and cannot pass early on a fast machine or
    // flake on a loaded one.
    await waitForActiveUpdate(ws, idA2, true);

    // The fix under test: A2 is promoted, A1 (its own window) is demoted,
    // and B (a different window) is completely unaffected.
    expect(await activeFlag(ws, idA2)).toBe(true);
    expect(await activeFlag(ws, idA1)).toBe(false);
    expect(await activeFlag(ws, idB)).toBe(true);

    ws.close();
  });
});

describe('window isolation: target.new newWindow forwarding', () => {
  it('forwards an explicit newWindow: true to TargetRegistry.create()', async () => {
    const gw = await startTestGateway();
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const { ws } = await connectAndWelcome(gw);
      ws.send(
        JSON.stringify({
          v: 1,
          t: 'target.new',
          ts: Date.now(),
          url: 'https://new.example',
          newWindow: true,
        }),
      );
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('target.created');
      expect(gw.chrome.createTargetCalls.at(-1)).toMatchObject({
        url: 'https://new.example',
        newWindow: true,
      });
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('omits newWindow when the caller does not say, and defaultNewWindow is false', async () => {
    const gw = await startTestGateway({ defaultNewWindow: false });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const { ws } = await connectAndWelcome(gw);
      ws.send(
        JSON.stringify({ v: 1, t: 'target.new', ts: Date.now(), url: 'https://new.example' }),
      );
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('target.created');
      const call = gw.chrome.createTargetCalls.at(-1);
      expect(call?.newWindow).toBeFalsy();
      ws.close();
    } finally {
      await gw.close();
    }
  });

  it('defaults to newWindow: true when the caller does not say and defaultNewWindow is true (BrowserSpec.isolation === "window")', async () => {
    const gw = await startTestGateway({ defaultNewWindow: true });
    gw.addTarget({
      targetId: 'cdp-a',
      type: 'page',
      title: 'A',
      url: 'https://a.example',
      attached: false,
      windowId: 1,
    });
    try {
      const { ws } = await connectAndWelcome(gw);
      ws.send(
        JSON.stringify({ v: 1, t: 'target.new', ts: Date.now(), url: 'https://new.example' }),
      );
      const reply = await nextMessageSkipping(ws, UNSOLICITED);
      expect(reply['t']).toBe('target.created');
      expect(gw.chrome.createTargetCalls.at(-1)).toMatchObject({
        url: 'https://new.example',
        newWindow: true,
      });
      ws.close();
    } finally {
      await gw.close();
    }
  });
});
