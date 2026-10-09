/**
 * The client's tab list is a set keyed by `targetId`, not an append-only
 * array.
 *
 * The same target legitimately arrives more than once. `tabs.new()` gets its
 * own `target.created` back as a correlated reply, and the session also
 * broadcasts one to every viewer on that instance, so the viewer that opened
 * the tab receives both; a target already present in `welcome.targets` can be
 * announced again for the same reason. Appending each time made
 * `client.targets` drift above the browser's real tab count, and `useTargets()`
 * renders that array directly, so the drift showed up as duplicate panes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import { connectClientToLive, fixtureClientOptions, flushMicrotasks } from './helpers.js';

const TARGET = 'tgt_00000000000000000000000042';

function targetCreated(targetId: string, overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    t: 'target.created',
    ts: Date.now(),
    target: {
      targetId,
      kind: 'page',
      title: 'first title',
      url: 'https://example.com/',
      faviconUrl: null,
      index: 1,
      active: false,
      audible: false,
      muted: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      openerTargetId: null,
      viewers: 0,
      createdAt: 0,
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('client tab list identity', () => {
  it('the same target announced twice appears once, and the second announcement updates it rather than duplicating it', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();
    const before = client.targets.length;

    ws.simulateJson(targetCreated(TARGET));
    await flushMicrotasks();
    expect(client.targets).toHaveLength(before + 1);

    // The duplicate a `tabs.new()` caller always receives: reply, then broadcast.
    ws.simulateJson(targetCreated(TARGET, { title: 'second title' }));
    await flushMicrotasks();

    expect(client.targets).toHaveLength(before + 1);
    expect(client.targets.filter((t) => t.targetId === TARGET)).toHaveLength(1);
    expect(client.targets.find((t) => t.targetId === TARGET)?.title).toBe('second title');
  });

  it('closing a target removes it exactly once, leaving no ghost behind a duplicate announcement', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();
    const before = client.targets.length;

    ws.simulateJson(targetCreated(TARGET));
    ws.simulateJson(targetCreated(TARGET));
    await flushMicrotasks();
    expect(client.targets).toHaveLength(before + 1);

    ws.simulateJson({ v: 1, t: 'target.closed', ts: Date.now(), targetId: TARGET, reason: 'user' });
    await flushMicrotasks();

    expect(client.targets.some((t) => t.targetId === TARGET)).toBe(false);
    expect(client.targets).toHaveLength(before);
  });
});
