/**
 * `pagemap/listeners.ts`.
 *
 * Mirrors `cdp/accessibility.test.ts`'s own approach: a scripted fake
 * bridge, and assertions on WHICH CDP commands go out (the three-call
 * sequence, `Runtime.releaseObject` always running, no domain enable/
 * disable anywhere) as much as on what comes back. The live CDP behaviour
 * this sequence relies on (no `DOMDebugger.enable` method, no `DOM.enable`
 * needed, `pierce: true` crossing shadow roots, zero page-visible side
 * effects) is already proven against real Chrome by
 * `examples/nextjs-demo/pagemap-listeners-probe.mjs`; this file does not re-run that
 * probe. What it unit tests is the two things that are actually this
 * module's own logic: the record-to-set mapping and cap, and the
 * click-like event type filter.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import {
  MAX_CLICK_LISTENER_NODES,
  __testOnly_clickListenerNodesFromReply as clickListenerNodesFromReply,
  mintClickListenerNodes,
} from '../../src/pagemap/listeners.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: CdpSessionId | undefined;
}

/** Same shape as `cdp/accessibility.test.ts`'s own `fakeBridge`: a per-method handler function, scripted per test. */
function fakeBridge(
  handlers: Readonly<
    Record<string, (params: Record<string, unknown>, callIndex: number) => unknown>
  >,
): { bridge: CdpBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const callCounts = new Map<string, number>();
  const bridge = {
    async send(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: CdpSessionId,
    ): Promise<unknown> {
      const p = params ?? {};
      sent.push({ method, params: p, sessionId });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected CDP method ${method}`);
      const callIndex = callCounts.get(method) ?? 0;
      callCounts.set(method, callIndex + 1);
      const reply = handler(p, callIndex);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

const SESSION = 'cdpsess_1' as CdpSessionId;
const DOC_ROOT_NODE_ID = 7;
const OBJECT_ID = 'obj-1234';

function sequenceHandlers(
  overrides: Readonly<
    Record<string, (params: Record<string, unknown>, callIndex: number) => unknown>
  >,
): Record<string, (params: Record<string, unknown>, callIndex: number) => unknown> {
  return {
    'DOM.getDocument': () => ({ root: { nodeId: DOC_ROOT_NODE_ID } }),
    'DOM.resolveNode': () => ({ object: { objectId: OBJECT_ID } }),
    'Runtime.releaseObject': () => ({}),
    ...overrides,
  };
}

describe('mintClickListenerNodes: which CDP commands go out', () => {
  it('sends exactly DOM.getDocument, DOM.resolveNode, DOMDebugger.getEventListeners, Runtime.releaseObject, in that order, on the given session, with no domain enable/disable', async () => {
    const { bridge, sent } = fakeBridge(
      sequenceHandlers({ 'DOMDebugger.getEventListeners': () => ({ listeners: [] }) }),
    );

    await mintClickListenerNodes(bridge, SESSION);

    expect(sent.map((s) => s.method)).toEqual([
      'DOM.getDocument',
      'DOM.resolveNode',
      'DOMDebugger.getEventListeners',
      'Runtime.releaseObject',
    ]);
    expect(sent.every((s) => s.sessionId === SESSION)).toBe(true);
    expect(sent.some((s) => s.method.endsWith('.enable') || s.method.endsWith('.disable'))).toBe(
      false,
    );
  });

  it('resolves the document nodeId first, then resolves that exact nodeId, then passes the resulting objectId with depth:-1, pierce:true, and never passes the objectId anywhere else', async () => {
    const { bridge, sent } = fakeBridge(
      sequenceHandlers({ 'DOMDebugger.getEventListeners': () => ({ listeners: [] }) }),
    );

    await mintClickListenerNodes(bridge, SESSION);

    const resolveNode = sent.find((s) => s.method === 'DOM.resolveNode');
    expect(resolveNode?.params).toEqual({ nodeId: DOC_ROOT_NODE_ID });

    const getEventListeners = sent.find((s) => s.method === 'DOMDebugger.getEventListeners');
    expect(getEventListeners?.params).toEqual({ objectId: OBJECT_ID, depth: -1, pierce: true });

    const releaseObject = sent.find((s) => s.method === 'Runtime.releaseObject');
    expect(releaseObject?.params).toEqual({ objectId: OBJECT_ID });
  });

  it('still releases the objectId when DOMDebugger.getEventListeners itself throws, and the throw still propagates', async () => {
    const { bridge, sent } = fakeBridge(
      sequenceHandlers({ 'DOMDebugger.getEventListeners': () => new Error('boom') }),
    );

    await expect(mintClickListenerNodes(bridge, SESSION)).rejects.toThrow('boom');
    expect(sent.map((s) => s.method)).toEqual([
      'DOM.getDocument',
      'DOM.resolveNode',
      'DOMDebugger.getEventListeners',
      'Runtime.releaseObject',
    ]);
  });

  it('tolerates Runtime.releaseObject itself failing, without masking the real result', async () => {
    const { bridge } = fakeBridge(
      sequenceHandlers({
        'DOMDebugger.getEventListeners': () => ({
          listeners: [{ type: 'click', backendNodeId: 42 }],
        }),
        'Runtime.releaseObject': () => new Error('session already gone'),
      }),
    );

    const outcome = await mintClickListenerNodes(bridge, SESSION);
    expect(outcome.backendNodeIds).toEqual(new Set([42]));
  });

  it('throws when DOM.getDocument returns no root nodeId, and never reaches DOM.resolveNode', async () => {
    const { bridge, sent } = fakeBridge(
      sequenceHandlers({ 'DOM.getDocument': () => ({ root: {} }) }),
    );

    await expect(mintClickListenerNodes(bridge, SESSION)).rejects.toThrow();
    expect(sent.map((s) => s.method)).toEqual(['DOM.getDocument']);
  });

  it('throws when DOM.resolveNode returns no objectId, and never reaches DOMDebugger.getEventListeners or releaseObject', async () => {
    const { bridge, sent } = fakeBridge(
      sequenceHandlers({ 'DOM.resolveNode': () => ({ object: {} }) }),
    );

    await expect(mintClickListenerNodes(bridge, SESSION)).rejects.toThrow();
    expect(sent.map((s) => s.method)).toEqual(['DOM.getDocument', 'DOM.resolveNode']);
  });
});

describe('mintClickListenerNodes: what it reports', () => {
  it('collects backendNodeIds from click-like listeners and reports the honest total when under the cap', async () => {
    const { bridge } = fakeBridge(
      sequenceHandlers({
        'DOMDebugger.getEventListeners': () => ({
          listeners: [
            { type: 'click', backendNodeId: 1 },
            { type: 'mousedown', backendNodeId: 2 },
          ],
        }),
      }),
    );

    const outcome = await mintClickListenerNodes(bridge, SESSION);
    expect(outcome.backendNodeIds).toEqual(new Set([1, 2]));
    expect(outcome.total).toBe(2);
    expect(outcome.truncated).toBe(false);
  });
});

describe('clickListenerNodesFromReply: the record-to-set mapping', () => {
  it('keeps a node whose only listener is click-like', () => {
    const outcome = clickListenerNodesFromReply([{ type: 'click', backendNodeId: 1 }]);
    expect(outcome.backendNodeIds).toEqual(new Set([1]));
    expect(outcome.total).toBe(1);
    expect(outcome.truncated).toBe(false);
  });

  it('keeps every click-like type: click, mousedown, mouseup, pointerdown, pointerup', () => {
    const outcome = clickListenerNodesFromReply([
      { type: 'click', backendNodeId: 1 },
      { type: 'mousedown', backendNodeId: 2 },
      { type: 'mouseup', backendNodeId: 3 },
      { type: 'pointerdown', backendNodeId: 4 },
      { type: 'pointerup', backendNodeId: 5 },
    ]);
    expect(outcome.backendNodeIds).toEqual(new Set([1, 2, 3, 4, 5]));
    expect(outcome.total).toBe(5);
  });

  it('drops a listener whose type is not click-like: mouseover, keydown, focus, load', () => {
    const outcome = clickListenerNodesFromReply([
      { type: 'mouseover', backendNodeId: 1 },
      { type: 'keydown', backendNodeId: 2 },
      { type: 'focus', backendNodeId: 3 },
      { type: 'load', backendNodeId: 4 },
    ]);
    expect(outcome.backendNodeIds).toEqual(new Set());
    expect(outcome.total).toBe(0);
  });

  it('drops a listener with no backendNodeId rather than reporting it as node id undefined', () => {
    const outcome = clickListenerNodesFromReply([{ type: 'click' }]);
    expect(outcome.backendNodeIds).toEqual(new Set());
    expect(outcome.total).toBe(0);
  });

  it('collapses multiple click-like listeners on the same node into one entry (the delegated-container case: one node, several event types)', () => {
    const outcome = clickListenerNodesFromReply([
      { type: 'click', backendNodeId: 9 },
      { type: 'mousedown', backendNodeId: 9 },
      { type: 'pointerup', backendNodeId: 9 },
    ]);
    expect(outcome.backendNodeIds).toEqual(new Set([9]));
    expect(outcome.total).toBe(1);
  });

  it('returns an empty set, not an error, for an empty reply', () => {
    const outcome = clickListenerNodesFromReply([]);
    expect(outcome.backendNodeIds).toEqual(new Set());
    expect(outcome.total).toBe(0);
    expect(outcome.truncated).toBe(false);
  });

  describe('the cap', () => {
    it('does not truncate at exactly MAX_CLICK_LISTENER_NODES', () => {
      const listeners = Array.from({ length: MAX_CLICK_LISTENER_NODES }, (_, i) => ({
        type: 'click',
        backendNodeId: i,
      }));
      const outcome = clickListenerNodesFromReply(listeners);
      expect(outcome.backendNodeIds.size).toBe(MAX_CLICK_LISTENER_NODES);
      expect(outcome.total).toBe(MAX_CLICK_LISTENER_NODES);
      expect(outcome.truncated).toBe(false);
    });

    it('truncates to MAX_CLICK_LISTENER_NODES and reports the real total when the set exceeds the cap', () => {
      const distinctCount = MAX_CLICK_LISTENER_NODES + 25;
      const listeners = Array.from({ length: distinctCount }, (_, i) => ({
        type: 'click',
        backendNodeId: i,
      }));
      const outcome = clickListenerNodesFromReply(listeners);
      expect(outcome.backendNodeIds.size).toBe(MAX_CLICK_LISTENER_NODES);
      expect(outcome.total).toBe(distinctCount);
      expect(outcome.truncated).toBe(true);
    });
  });
});
