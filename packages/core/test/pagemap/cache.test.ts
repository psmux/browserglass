/**
 * `pagemap/cache.ts`.
 *
 * A fake `CdpBridge` whose `on()` records handlers per `(sessionId, event)`
 * key and can `fire()` them on demand, mirroring the real bridge's own
 * per-session event filtering (`CdpBridgeImpl`'s `handlers` map, keyed the
 * same way). This is what lets a test prove the two measured invalidators
 * actually drop a cached entry, and that they never cross sessions.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId, Unsubscribe } from '../../src/cdp/types.js';
import { PageMapCache } from '../../src/pagemap/cache.js';
import type { PageMapCapture } from '../../src/pagemap/types.js';

function fakeBridge() {
  const handlers = new Map<
    string,
    Set<(params: Record<string, unknown>, sessionId: CdpSessionId | null) => void>
  >();
  let unsubscribeCalls = 0;

  const bridge = {
    on(
      event: string,
      handler: (params: Record<string, unknown>, sessionId: CdpSessionId | null) => void,
      sessionId?: CdpSessionId,
    ): Unsubscribe {
      const key = sessionId ? `${sessionId} ${event}` : event;
      let bucket = handlers.get(key);
      if (!bucket) {
        bucket = new Set();
        handlers.set(key, bucket);
      }
      bucket.add(handler);
      return () => {
        unsubscribeCalls += 1;
        handlers.get(key)?.delete(handler);
      };
    },
  } as unknown as CdpBridge;

  return {
    bridge,
    fire(event: string, sessionId: CdpSessionId): void {
      const bucket = handlers.get(`${sessionId} ${event}`);
      if (!bucket) return;
      for (const handler of [...bucket]) handler({}, sessionId);
    },
    handlerCount(event: string, sessionId: CdpSessionId): number {
      return handlers.get(`${sessionId} ${event}`)?.size ?? 0;
    },
    get unsubscribeCalls(): number {
      return unsubscribeCalls;
    },
  };
}

function fakeCapture(epoch: string): PageMapCapture {
  return {
    epoch,
    nodes: new Map(),
    scrollX: 0,
    scrollY: 0,
    viewportWidth: 800,
    viewportHeight: 600,
    failures: [],
  };
}

const SESS_A = 'sess-a' as CdpSessionId;
const SESS_B = 'sess-b' as CdpSessionId;

describe('PageMapCache: get/set/invalidate', () => {
  it('returns undefined for a target nothing was ever cached for', () => {
    const { bridge } = fakeBridge();
    const cache = new PageMapCache(bridge);
    expect(cache.get('tgt_1')).toBeUndefined();
  });

  it('set then get returns the exact cached capture', () => {
    const { bridge } = fakeBridge();
    const cache = new PageMapCache(bridge);
    const capture = fakeCapture('epoch-1');
    cache.set('tgt_1', SESS_A, capture);
    expect(cache.get('tgt_1')).toBe(capture);
  });

  it('invalidate drops the entry, and get returns undefined afterward', () => {
    const { bridge } = fakeBridge();
    const cache = new PageMapCache(bridge);
    cache.set('tgt_1', SESS_A, fakeCapture('epoch-1'));
    cache.invalidate('tgt_1');
    expect(cache.get('tgt_1')).toBeUndefined();
  });

  it('invalidate on an unknown target is a safe no-op', () => {
    const { bridge } = fakeBridge();
    const cache = new PageMapCache(bridge);
    expect(() => cache.invalidate('never-cached')).not.toThrow();
  });

  it('invalidate is safe to call twice in a row', () => {
    const { bridge } = fakeBridge();
    const cache = new PageMapCache(bridge);
    cache.set('tgt_1', SESS_A, fakeCapture('epoch-1'));
    cache.invalidate('tgt_1');
    expect(() => cache.invalidate('tgt_1')).not.toThrow();
  });

  it('caching a second target does not touch the first', () => {
    const { bridge } = fakeBridge();
    const cache = new PageMapCache(bridge);
    const a = fakeCapture('epoch-a');
    const b = fakeCapture('epoch-b');
    cache.set('tgt_1', SESS_A, a);
    cache.set('tgt_2', SESS_B, b);
    expect(cache.get('tgt_1')).toBe(a);
    expect(cache.get('tgt_2')).toBe(b);
    cache.invalidate('tgt_2');
    expect(cache.get('tgt_1')).toBe(a);
    expect(cache.get('tgt_2')).toBeUndefined();
  });
});

describe('PageMapCache: the two measured invalidators', () => {
  it('DOM.documentUpdated on the cached session invalidates the entry', () => {
    const { bridge, fire } = fakeBridge();
    const cache = new PageMapCache(bridge);
    cache.set('tgt_1', SESS_A, fakeCapture('epoch-1'));
    fire('DOM.documentUpdated', SESS_A);
    expect(cache.get('tgt_1')).toBeUndefined();
  });

  it('Page.frameNavigated on the cached session invalidates the entry', () => {
    const { bridge, fire } = fakeBridge();
    const cache = new PageMapCache(bridge);
    cache.set('tgt_1', SESS_A, fakeCapture('epoch-1'));
    fire('Page.frameNavigated', SESS_A);
    expect(cache.get('tgt_1')).toBeUndefined();
  });

  it('an event on a DIFFERENT session never invalidates this entry', () => {
    const { bridge, fire } = fakeBridge();
    const cache = new PageMapCache(bridge);
    const capture = fakeCapture('epoch-1');
    cache.set('tgt_1', SESS_A, capture);
    fire('DOM.documentUpdated', SESS_B);
    fire('Page.frameNavigated', SESS_B);
    expect(cache.get('tgt_1')).toBe(capture);
  });

  it('subscribes exactly two handlers per session on set, and unsubscribes both on invalidate', () => {
    const fake = fakeBridge();
    const { bridge, handlerCount } = fake;
    const cache = new PageMapCache(bridge);
    cache.set('tgt_1', SESS_A, fakeCapture('epoch-1'));
    expect(handlerCount('DOM.documentUpdated', SESS_A)).toBe(1);
    expect(handlerCount('Page.frameNavigated', SESS_A)).toBe(1);

    const before = fake.unsubscribeCalls;
    cache.invalidate('tgt_1');
    expect(fake.unsubscribeCalls).toBe(before + 2);
    expect(handlerCount('DOM.documentUpdated', SESS_A)).toBe(0);
    expect(handlerCount('Page.frameNavigated', SESS_A)).toBe(0);
  });

  it('re-set on an already-cached target tears down the old subscriptions before installing new ones', () => {
    const { bridge, fire } = fakeBridge();
    const cache = new PageMapCache(bridge);
    cache.set('tgt_1', SESS_A, fakeCapture('epoch-1'));
    const second = fakeCapture('epoch-2');
    cache.set('tgt_1', SESS_B, second); // moved to a new session, e.g. a reattach
    expect(cache.get('tgt_1')).toBe(second);

    // The OLD session's events must no longer be able to invalidate anything for this target.
    fire('DOM.documentUpdated', SESS_A);
    expect(cache.get('tgt_1')).toBe(second);

    // The NEW session's events do invalidate it.
    fire('DOM.documentUpdated', SESS_B);
    expect(cache.get('tgt_1')).toBeUndefined();
  });
});

describe('PageMapCache: dispose', () => {
  it('invalidates every cached entry at once', () => {
    const { bridge } = fakeBridge();
    const cache = new PageMapCache(bridge);
    cache.set('tgt_1', SESS_A, fakeCapture('epoch-1'));
    cache.set('tgt_2', SESS_B, fakeCapture('epoch-2'));
    cache.dispose();
    expect(cache.get('tgt_1')).toBeUndefined();
    expect(cache.get('tgt_2')).toBeUndefined();
  });
});
