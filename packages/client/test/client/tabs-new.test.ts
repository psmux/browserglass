/**
 * `tabs.new()`'s `newWindow` option: the client-side leg of window
 * isolation's `target.new` wire addition (`ManagedSession.newTarget`/`ws/connection.ts`'s `target.new` handler on
 * the server side). Confirms the option reaches the wire message
 * unmodified when given, and is omitted entirely (not sent as `undefined`
 * or `false`) when the caller leaves the server's own
 * `BrowserSpec.isolation`-derived default to decide.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import { connectClientToLive, fixtureClientOptions, flushMicrotasks } from './helpers.js';

function targetCreatedReply(re: string) {
  return {
    v: 1,
    t: 'target.created',
    re,
    ts: Date.now(),
    target: {
      targetId: 'tgt_00000000000000000000000099',
      kind: 'page',
      title: '',
      url: 'https://example.com/',
      faviconUrl: null,
      index: 2,
      active: false,
      audible: false,
      muted: false,
      loading: false,
      canGoBack: false,
      canGoForward: false,
      openerTargetId: null,
      viewers: 0,
      createdAt: 0,
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

describe('tabs.new newWindow forwarding', () => {
  it('forwards newWindow: true on the wire target.new message', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const openPromise = client.tabs.new({ url: 'https://example.com/', newWindow: true });
    await flushMicrotasks();
    const sent = ws.sentJsonMessages();
    const req = [...sent].reverse().find((m) => m.t === 'target.new');
    expect(req).toBeDefined();
    expect(req?.newWindow).toBe(true);

    ws.simulateJson(targetCreatedReply(req?.id as string));
    await openPromise;
  });

  it('forwards newWindow: false explicitly, distinct from omitting it', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const openPromise = client.tabs.new({ url: 'https://example.com/', newWindow: false });
    await flushMicrotasks();
    const req = [...ws.sentJsonMessages()].reverse().find((m) => m.t === 'target.new');
    expect(req?.newWindow).toBe(false);

    ws.simulateJson(targetCreatedReply(req?.id as string));
    await openPromise;
  });

  it('omits newWindow entirely when not given, leaving the server default (BrowserSpec.isolation) to decide', async () => {
    const { options, harness } = fixtureClientOptions();
    const client = new BrowserGlassClient(options);
    await connectClientToLive(client, harness);
    const ws = harness.latest();

    const openPromise = client.tabs.new({ url: 'https://example.com/' });
    await flushMicrotasks();
    const req = [...ws.sentJsonMessages()].reverse().find((m) => m.t === 'target.new');
    expect(req).toBeDefined();
    expect('newWindow' in (req as Record<string, unknown>)).toBe(false);

    ws.simulateJson(targetCreatedReply(req?.id as string));
    await openPromise;
  });
});
