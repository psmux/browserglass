import { describe, expect, it } from 'vitest';
import type { TargetNew, TargetSummary } from '../../src/wire/messages/targets.js';

/**
 * `TargetSummary.windowId` and `TargetNew.newWindow` are plain JSON fields
 * on a `bgls.v1` control message (`envelope.ts`): there is no separate wire
 * schema layer to encode against, so a round trip here is `JSON.stringify`
 * then `JSON.parse`, exactly what the WebSocket text frame does. The point
 * is confirming both a real `windowId` and its `null` "unknown" state
 * survive that unchanged, since a lossy round trip (say, `null` becoming
 * `undefined` and vanishing from the object) would silently break every
 * client relying on the field always being present.
 */
describe('TargetSummary.windowId wire round trip', () => {
  const base: Omit<TargetSummary, 'windowId'> = {
    targetId: 'tgt_00000000000000000000000001',
    kind: 'page',
    title: 'Example',
    url: 'https://example.test/',
    faviconUrl: null,
    index: 0,
    active: true,
    audible: false,
    muted: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    openerTargetId: null,
    viewers: 0,
    createdAt: Date.now(),
  };

  it('round trips a real windowId', () => {
    const summary: TargetSummary = { ...base, windowId: 42 };
    const roundTripped = JSON.parse(JSON.stringify(summary)) as TargetSummary;
    expect(roundTripped.windowId).toBe(42);
  });

  it('round trips a null windowId, for a target whose window is not yet known', () => {
    const summary: TargetSummary = { ...base, windowId: null };
    const roundTripped = JSON.parse(JSON.stringify(summary)) as TargetSummary;
    expect(roundTripped.windowId).toBeNull();
    expect('windowId' in roundTripped).toBe(true);
  });
});

describe('target.new newWindow', () => {
  it('round trips newWindow: true', () => {
    const msg: TargetNew = { v: 1, t: 'target.new', ts: Date.now(), newWindow: true };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as TargetNew;
    expect(roundTripped.newWindow).toBe(true);
  });

  it('stays absent, not false, when the caller never set it, matching every other optional field on this message', () => {
    const msg: TargetNew = { v: 1, t: 'target.new', ts: Date.now(), url: 'https://example.com' };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as TargetNew;
    expect(roundTripped.newWindow).toBeUndefined();
    expect('newWindow' in roundTripped).toBe(false);
  });
});
