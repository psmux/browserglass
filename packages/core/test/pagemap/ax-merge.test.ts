/**
 * `pagemap/ax-merge.ts`.
 *
 * Mirrors `cdp/accessibility.test.ts`'s own approach: a scripted fake
 * bridge, and assertions on WHICH CDP commands go out and on WHICH session
 * each one used, as much as on the merged shape that comes back, because a
 * test that only checked the returned node record would not catch a frame
 * queried on the wrong session or a concurrency cap silently ignored.
 *
 * `./frames.js` is
 * imported by `ax-merge.ts` as a TYPE ONLY (`import type { PageMapFrame }`),
 * so this test never needs that module to exist on disk: a type-only
 * import is erased before anything runs, and every `PageMapFrame` value
 * this file constructs is a plain object literal shaped to the two fields
 * `ax-merge.ts` actually reads (`frameId`, `sessionId`), not an import of
 * anything `frames.ts` would export at runtime.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { PAGEMAP_AX_CONCURRENCY_CAP, mergeAccessibility } from '../../src/pagemap/ax-merge.js';
import type { PageMapFrame } from '../../src/pagemap/frames.js';
import type { PageMapNodeRecord } from '../../src/pagemap/types.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: CdpSessionId | undefined;
}

/** A `CdpBridge` whose `send` is driven by a per-method handler, matching `cdp/accessibility.test.ts`'s own `fakeBridge`. */
function fakeBridge(
  handlers: Readonly<
    Record<
      string,
      (
        params: Record<string, unknown>,
        sessionId: CdpSessionId | undefined,
        callIndex: number,
      ) => unknown
    >
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
      const reply = handler(p, sessionId, callIndex);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

function frame(frameId: string, sessionId: string): PageMapFrame {
  return { frameId, sessionId: sessionId as CdpSessionId };
}

/** A minimal, otherwise-empty {@link PageMapNodeRecord}, pre-merge shape: every accessibility field at its documented "source did not run yet" default. */
function baseNode(backendNodeId: number, frameId: string | null = null): PageMapNodeRecord {
  return {
    backendNodeId,
    parentBackendNodeId: null,
    tag: 'button',
    nodeType: 1,
    attributes: new Map(),
    shadowKind: null,
    frameId,
    rect: null,
    scrollRect: null,
    paintOrder: null,
    style: null,
    role: null,
    name: null,
    axIgnored: false,
    axProperties: new Map(),
    hasClickListener: null,
  };
}

function axValue(value: unknown): { value: unknown } {
  return { value };
}

function axPropRaw(name: string, value: unknown): { name: string; value: { value: unknown } } {
  return { name, value: axValue(value) };
}

const BUTTON_AX_NODE = {
  ignored: false,
  role: axValue('button'),
  name: axValue('Submit'),
  backendDOMNodeId: 42,
  properties: [axPropRaw('focusable', true), axPropRaw('disabled', false)],
};

describe('mergeAccessibility: which CDP commands go out', () => {
  it('reads one Accessibility.getFullAXTree per frame, each on its own session with its own frameId', async () => {
    const { bridge, sent } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': (_p, sessionId) => ({
        nodes: sessionId === 'sess-main' ? [BUTTON_AX_NODE] : [],
      }),
    });

    const frames = [frame('frame-main', 'sess-main'), frame('frame-oopif', 'sess-oopif')];
    const nodes = new Map([[42, baseNode(42, 'frame-main')]]);

    await mergeAccessibility(bridge, frames, nodes);

    const treeCalls = sent.filter((s) => s.method === 'Accessibility.getFullAXTree');
    expect(treeCalls).toHaveLength(2);
    expect(treeCalls.map((c) => c.sessionId).sort()).toEqual(['sess-main', 'sess-oopif']);
    expect(treeCalls.find((c) => c.sessionId === 'sess-main')?.params).toEqual({
      frameId: 'frame-main',
    });
    expect(treeCalls.find((c) => c.sessionId === 'sess-oopif')?.params).toEqual({
      frameId: 'frame-oopif',
    });
  });

  it('never holds more than PAGEMAP_AX_CONCURRENCY_CAP accessibility reads in flight at once, and actually reaches the cap', async () => {
    const cap = PAGEMAP_AX_CONCURRENCY_CAP;
    const frameCount = cap * 3 + 1; // enough frames that a naive unbounded fan-out would spike well past the cap.
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];

    const bridge = {
      async send(method: string): Promise<unknown> {
        if (method === 'Accessibility.enable' || method === 'Accessibility.disable') return {};
        if (method !== 'Accessibility.getFullAXTree') throw new Error(`unexpected ${method}`);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight -= 1;
        return { nodes: [] };
      },
    } as unknown as CdpBridge;

    const frames = Array.from({ length: frameCount }, (_, i) => frame(`f${i}`, `sess${i}`));
    const nodes = new Map<number, PageMapNodeRecord>();

    let settled = false;
    const outcome = mergeAccessibility(bridge, frames, nodes).finally(() => {
      settled = true;
    });

    // Keep releasing whatever the pool has currently blocked on and
    // yielding a microtask turn, until the whole call settles. Every
    // release is a point where `inFlight`/`maxInFlight` could have been
    // pushed past the cap by a bug in the pool, so draining this way
    // (rather than releasing everything at once) is what actually
    // exercises the cap across every batch, not just the first.
    while (!settled) {
      const r = release.shift();
      r?.();
      await Promise.resolve();
    }

    await outcome;
    expect(maxInFlight).toBe(cap); // frameCount > cap, so the pool should actually reach its ceiling, not just stay under it.
  });
});

describe('mergeAccessibility: the merge', () => {
  it('fills role, name, axIgnored and axProperties on the matching record, leaving every other field untouched', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({ nodes: [BUTTON_AX_NODE] }),
    });

    const original = baseNode(42, 'frame-main');
    const nodes = new Map([[42, original]]);

    const outcome = await mergeAccessibility(bridge, [frame('frame-main', 'sess-main')], nodes);

    const merged = outcome.nodes.get(42);
    expect(merged?.role).toBe('button');
    expect(merged?.name).toBe('Submit');
    expect(merged?.axIgnored).toBe(false);
    expect(merged?.axProperties.get('focusable')).toBe(true);
    expect(merged?.axProperties.get('disabled')).toBe(false);
    // Untouched fields survive byte-for-byte.
    expect(merged?.tag).toBe(original.tag);
    expect(merged?.rect).toBe(original.rect);
    expect(merged?.backendNodeId).toBe(original.backendNodeId);
  });

  it('keeps ignored AX nodes (unlike queryAccessibilityTree) and reports axIgnored: true', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({ nodes: [{ ...BUTTON_AX_NODE, ignored: true }] }),
    });

    const nodes = new Map([[42, baseNode(42)]]);
    const outcome = await mergeAccessibility(bridge, [frame('f', 's')], nodes);
    expect(outcome.nodes.get(42)?.axIgnored).toBe(true);
    // Still merged: role/name are still populated even though ignored.
    expect(outcome.nodes.get(42)?.role).toBe('button');
  });

  it('passes checked/pressed through as tristate, and distinguishes an absent property (null) from an explicit false', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          {
            ignored: false,
            role: axValue('checkbox'),
            name: axValue('Select all'),
            backendDOMNodeId: 7,
            properties: [axPropRaw('checked', 'mixed'), axPropRaw('disabled', false)],
          },
        ],
      }),
    });

    const nodes = new Map([[7, baseNode(7)]]);
    const outcome = await mergeAccessibility(bridge, [frame('f', 's')], nodes);
    const props = outcome.nodes.get(7)?.axProperties;
    expect(props?.get('checked')).toBe('mixed');
    expect(props?.get('disabled')).toBe(false); // explicit false, not absent.
    expect(props?.get('required')).toBeNull(); // never reported by CDP: absent, distinguishable from false.
  });

  it('stringifies the numeric level property, preserving null (heading level absent) as null, not "null"', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({
        nodes: [
          { ...BUTTON_AX_NODE, backendDOMNodeId: 1, properties: [axPropRaw('level', 2)] },
          { ...BUTTON_AX_NODE, backendDOMNodeId: 2, properties: [] },
        ],
      }),
    });

    const nodes = new Map([
      [1, baseNode(1)],
      [2, baseNode(2)],
    ]);
    const outcome = await mergeAccessibility(bridge, [frame('f', 's')], nodes);
    expect(outcome.nodes.get(1)?.axProperties.get('level')).toBe('2');
    expect(outcome.nodes.get(2)?.axProperties.get('level')).toBeNull();
  });

  it('skips an AX node whose backendNodeId the input index never carried, without throwing', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({ nodes: [BUTTON_AX_NODE] }), // backendDOMNodeId 42, not in the index below.
    });

    const nodes = new Map([[99, baseNode(99)]]);
    const outcome = await mergeAccessibility(bridge, [frame('f', 's')], nodes);
    expect(outcome.nodes.size).toBe(1);
    expect(outcome.nodes.get(99)?.role).toBeNull();
    expect(outcome.failures).toEqual([]);
  });

  it('leaves nodes from OTHER frames alone: a merge only ever touches backendNodeIds its own frame reads named', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': (_p, sessionId) =>
        sessionId === 'sess-a'
          ? { nodes: [{ ...BUTTON_AX_NODE, backendDOMNodeId: 1 }] }
          : { nodes: [] },
    });

    const nodes = new Map([
      [1, baseNode(1, 'frame-a')],
      [2, baseNode(2, 'frame-b')],
    ]);
    const outcome = await mergeAccessibility(
      bridge,
      [frame('frame-a', 'sess-a'), frame('frame-b', 'sess-b')],
      nodes,
    );
    expect(outcome.nodes.get(1)?.role).toBe('button');
    expect(outcome.nodes.get(2)?.role).toBeNull();
  });
});

describe('mergeAccessibility: degradation, not failure', () => {
  it('a frame whose read throws degrades that frame only: no exception escapes, and the other frame still merges', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': (_p, sessionId) =>
        sessionId === 'sess-bad' ? new Error('detached session') : { nodes: [BUTTON_AX_NODE] },
    });

    const nodes = new Map([
      [42, baseNode(42, 'frame-good')],
      [43, baseNode(43, 'frame-bad')],
    ]);
    const outcome = await mergeAccessibility(
      bridge,
      [frame('frame-good', 'sess-good'), frame('frame-bad', 'sess-bad')],
      nodes,
    );

    expect(outcome.nodes.get(42)?.role).toBe('button');
    // The bad frame's node keeps its pre-merge default rather than being dropped or nulled out further.
    expect(outcome.nodes.get(43)?.role).toBeNull();
    expect(outcome.nodes.get(43)?.tag).toBe('button'); // tag/rect/attributes are untouched by this module either way.
    expect(outcome.failures).toEqual([
      { phase: 'accessibility', reason: 'detached session', frameId: 'frame-bad' },
    ]);
  });

  it('reports one failure per failed frame, and none for a fully successful capture', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({ nodes: [] }),
    });
    const outcome = await mergeAccessibility(
      bridge,
      [frame('f1', 's1'), frame('f2', 's2')],
      new Map(),
    );
    expect(outcome.failures).toEqual([]);
  });

  it('every frame failing still resolves, with an empty merged index carried through unchanged and one failure per frame', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => new Error('boom'),
    });
    const original = new Map([[1, baseNode(1)]]);
    const outcome = await mergeAccessibility(
      bridge,
      [frame('f1', 's1'), frame('f2', 's2')],
      original,
    );
    expect(outcome.nodes.get(1)).toEqual(original.get(1));
    expect(outcome.failures).toHaveLength(2);
    expect(outcome.failures.every((f) => f.phase === 'accessibility')).toBe(true);
  });
});

describe('mergeAccessibility: cross-session backendNodeId collision guard (GAP 2)', () => {
  it('drops an AX node whose id sessionOf names as belonging to a DIFFERENT session, leaving the already-merged node untouched', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      // Frame "oop" reports role/name for backendNodeId 3, the SAME numeric
      // id `sessionOf` says session "sess-main" already claimed.
      'Accessibility.getFullAXTree': (_p, sessionId) =>
        sessionId === 'sess-oop'
          ? {
              nodes: [
                {
                  ...BUTTON_AX_NODE,
                  backendDOMNodeId: 3,
                  role: axValue('checkbox'),
                  name: axValue('OOP Collider'),
                },
              ],
            }
          : { nodes: [] },
    });

    const original = baseNode(3, null);
    const nodes = new Map([[3, original]]);
    const sessionOf = new Map<number, CdpSessionId>([[3, 'sess-main' as CdpSessionId]]);

    const outcome = await mergeAccessibility(
      bridge,
      [frame('frame-oop', 'sess-oop')],
      nodes,
      sessionOf,
    );

    // The collision is dropped, not applied: role/name stay at their
    // pre-merge default, exactly the same record that went in.
    expect(outcome.nodes.get(3)).toEqual(original);
  });

  it('applies an AX node normally when sessionOf names the SAME session as the frame reporting it', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({ nodes: [BUTTON_AX_NODE] }), // backendDOMNodeId 42.
    });

    const nodes = new Map([[42, baseNode(42, 'frame-main')]]);
    const sessionOf = new Map<number, CdpSessionId>([[42, 'sess-main' as CdpSessionId]]);

    const outcome = await mergeAccessibility(
      bridge,
      [frame('frame-main', 'sess-main')],
      nodes,
      sessionOf,
    );
    expect(outcome.nodes.get(42)?.role).toBe('button');
    expect(outcome.nodes.get(42)?.name).toBe('Submit');
  });

  it('with no sessionOf argument (the pre-existing call shape), every id is unconstrained: behavior is unchanged from before this guard existed', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({ nodes: [BUTTON_AX_NODE] }),
    });

    const nodes = new Map([[42, baseNode(42)]]);
    const outcome = await mergeAccessibility(bridge, [frame('f', 's')], nodes); // no 4th argument.
    expect(outcome.nodes.get(42)?.role).toBe('button');
  });
});

describe('mergeAccessibility: edge cases', () => {
  it('an empty frame list merges nothing and reports no failures', async () => {
    const { bridge, sent } = fakeBridge({});
    const nodes = new Map([[1, baseNode(1)]]);
    const outcome = await mergeAccessibility(bridge, [], nodes);
    expect(sent).toEqual([]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.nodes.get(1)).toEqual(nodes.get(1));
  });

  it('does not mutate the input map', async () => {
    const { bridge } = fakeBridge({
      'Accessibility.enable': () => ({}),
      'Accessibility.disable': () => ({}),
      'Accessibility.getFullAXTree': () => ({ nodes: [BUTTON_AX_NODE] }),
    });
    const nodes = new Map([[42, baseNode(42)]]);
    const before = nodes.get(42);
    await mergeAccessibility(bridge, [frame('f', 's')], nodes);
    expect(nodes.get(42)).toBe(before);
    expect(nodes.get(42)?.role).toBeNull();
  });
});
