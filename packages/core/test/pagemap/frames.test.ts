/**
 * `pagemap/frames.ts`.
 *
 * A scripted fake bridge and a scripted fake `TargetRegistry`, asserting
 * on WHICH CDP commands go out (method, params, and critically WHICH
 * SESSION) as much as on the resulting offsets: this module's own doc
 * calls the offset math "the part that must be exactly right", so several
 * cases here exist purely to pin down the arithmetic and the session
 * routing, not just the returned shape.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { TargetRegistry } from '../../src/cdp/target-registry.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import {
  PAGE_MAP_MAX_FRAME_COUNT,
  PAGE_MAP_MAX_FRAME_DEPTH,
  captureFrameTree,
} from '../../src/pagemap/frames.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  readonly sessionId: CdpSessionId | undefined;
  readonly opts: unknown;
}

/** Per-method handler, keyed additionally by `sessionId` when a test needs to distinguish which session a call landed on (out-of-process frame cases). Mirrors `test/pagemap/listeners.test.ts`'s own `fakeBridge`, extended with the session the handler is allowed to inspect. */
function fakeBridge(
  handlers: Readonly<
    Record<
      string,
      (params: Record<string, unknown>, sessionId: CdpSessionId | undefined) => unknown
    >
  >,
): { bridge: CdpBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const bridge = {
    async send(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: CdpSessionId,
      opts?: unknown,
    ): Promise<unknown> {
      sent.push({ method, params, sessionId, opts });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected CDP method ${method}`);
      const reply = handler(params ?? {}, sessionId);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

function fakeRegistry(
  targets: readonly { type: string; mainFrameId: string | null; cdpSessionId: string | null }[],
): TargetRegistry {
  return { all: () => targets } as unknown as TargetRegistry;
}

const MAIN_SESSION = 'cdpsess_main' as CdpSessionId;
const OOP_SESSION = 'cdpsess_oop' as CdpSessionId;

/** A `DOM.getBoxModel`/`Page.getLayoutMetrics` pair that always answers with the given quad top-left and scroll, regardless of which frame/backendNodeId asked. */
function geometryHandlers(quad: { x: number; y: number }, scroll: { x: number; y: number }) {
  return {
    'DOM.getFrameOwner': () => ({ backendNodeId: 999 }),
    'DOM.getBoxModel': () => ({
      model: {
        content: [
          quad.x,
          quad.y,
          quad.x + 10,
          quad.y,
          quad.x + 10,
          quad.y + 10,
          quad.x,
          quad.y + 10,
        ],
      },
    }),
    'Page.getLayoutMetrics': () => ({ cssVisualViewport: { pageX: scroll.x, pageY: scroll.y } }),
  };
}

describe('captureFrameTree: the frame tree call', () => {
  it('sends Page.getFrameTree on the given session with an explicit timeoutMs, and exposes the main loaderId cleanly', async () => {
    const { bridge, sent } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: { frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://example.test/' } },
      }),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 5000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('Page.getFrameTree');
    expect(sent[0]?.sessionId).toBe(MAIN_SESSION);
    expect(sent[0]?.opts).toEqual({ timeoutMs: 5000 });
    expect(outcome.mainFrameId).toBe('MAIN');
    expect(outcome.mainLoaderId).toBe('LOADER_1');
    expect(outcome.frames).toEqual([
      {
        frameId: 'MAIN',
        parentFrameId: null,
        loaderId: 'LOADER_1',
        url: 'https://example.test/',
        depth: 0,
        outOfProcess: false,
        sessionId: MAIN_SESSION,
        offsetX: 0,
        offsetY: 0,
        scrollOffsetKnown: true,
      },
    ]);
    expect(outcome.failures).toEqual([]);
    expect(outcome.truncated).toBe(false);
  });

  it('throws when the reply carries no frameTree', async () => {
    const { bridge } = fakeBridge({ 'Page.getFrameTree': () => ({}) });
    await expect(captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000)).rejects.toThrow(
      /no frameTree/,
    );
  });

  it('main loaderId is null when Page.getFrameTree omits it, never guessed', async () => {
    const { bridge } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: { frame: { id: 'MAIN', url: 'https://example.test/' } },
      }),
    });
    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);
    expect(outcome.mainLoaderId).toBeNull();
  });
});

describe('captureFrameTree: same-process child frame offset', () => {
  it('computes offset = ownerRect + parentScroll for a child of the main frame, and every geometry call lands on the main session', async () => {
    const { bridge, sent } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames: [
            { frame: { id: 'CHILD', loaderId: 'L1', url: 'https://example.test/child' } },
          ],
        },
      }),
      ...geometryHandlers({ x: 100, y: 200 }, { x: 5, y: 15 }),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);

    const child = outcome.frames.find((f) => f.frameId === 'CHILD');
    expect(child).toBeDefined();
    expect(child?.offsetX).toBe(100 + 5); // ownerRect.x + parentScroll.x, parent offset (0,0)
    expect(child?.offsetY).toBe(200 + 15);
    expect(child?.outOfProcess).toBe(false);
    expect(child?.sessionId).toBe(MAIN_SESSION); // same-process: inherits the parent's session
    expect(child?.scrollOffsetKnown).toBe(true);

    const geometryCalls = sent.filter((s) => s.method !== 'Page.getFrameTree');
    expect(geometryCalls.every((s) => s.sessionId === MAIN_SESSION)).toBe(true);
    expect(geometryCalls.map((s) => s.method)).toEqual([
      'DOM.getFrameOwner',
      'DOM.getBoxModel',
      'Page.getLayoutMetrics',
    ]);
    expect(geometryCalls[0]?.params).toEqual({ frameId: 'CHILD' });
  });

  it('composes offsets additively across two same-process levels', async () => {
    const { bridge } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames: [
            {
              frame: { id: 'CHILD', loaderId: 'L1', url: 'https://example.test/child' },
              childFrames: [
                { frame: { id: 'GRANDCHILD', loaderId: 'L2', url: 'https://example.test/gc' } },
              ],
            },
          ],
        },
      }),
      ...geometryHandlers({ x: 10, y: 20 }, { x: 0, y: 0 }),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);
    const grandchild = outcome.frames.find((f) => f.frameId === 'GRANDCHILD');
    // Both levels contribute the same (10, 20) owner rect with zero scroll: 2 * (10, 20).
    expect(grandchild?.offsetX).toBe(20);
    expect(grandchild?.offsetY).toBe(40);
    expect(grandchild?.scrollOffsetKnown).toBe(true);
  });
});

describe('captureFrameTree: out-of-process frames', () => {
  it('names the registry session for an out-of-process frame, but still runs the owner-rect geometry on the PARENT session', async () => {
    const { bridge, sent } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames: [{ frame: { id: 'OOP_CHILD', loaderId: 'L1', url: 'https://other.test/' } }],
        },
      }),
      ...geometryHandlers({ x: 50, y: 60 }, { x: 0, y: 0 }),
    });
    const registry = fakeRegistry([
      { type: 'iframe', mainFrameId: 'OOP_CHILD', cdpSessionId: OOP_SESSION },
    ]);

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, registry, 1000);

    const oop = outcome.frames.find((f) => f.frameId === 'OOP_CHILD');
    expect(oop?.outOfProcess).toBe(true);
    expect(oop?.sessionId).toBe(OOP_SESSION); // the frame's OWN session, for accessibility/content reads
    expect(oop?.offsetX).toBe(50);
    expect(oop?.offsetY).toBe(60);
    expect(oop?.scrollOffsetKnown).toBe(true); // the frame itself is OOP, but its PARENT (main) is not

    const geometryCalls = sent.filter((s) => s.method !== 'Page.getFrameTree');
    // The owner element lives in the PARENT's document, so every geometry
    // call must run on the parent's (main) session, never the OOP frame's
    // own session.
    expect(geometryCalls.every((s) => s.sessionId === MAIN_SESSION)).toBe(true);
  });

  it('enumerates an out-of-process frame the PARENT tree never lists, by asking that frame own session for its own tree', async () => {
    // This is what real Chrome actually does, measured by
    // `examples/nextjs-demo/pagemap-frame-scroll-probe.mjs`: the parent
    // session's `Page.getFrameTree` does NOT list an out of process child
    // in `childFrames`, on every run. The sibling tests above put the OOP
    // child in `childFrames` for convenience, which is why the gap
    // survived: nothing exercised the shape Chrome really returns.
    //
    // The linkage the parent omits comes back from the child itself: its
    // own session answers with a root carrying `parentId`.
    const { bridge, sent } = fakeBridge({
      'Page.getFrameTree': (_params, sessionId) =>
        sessionId === OOP_SESSION
          ? {
              frameTree: {
                frame: {
                  id: 'OOP_CHILD',
                  parentId: 'MAIN',
                  loaderId: 'L1',
                  url: 'https://other.test/',
                },
              },
            }
          : { frameTree: { frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' } } },
      ...geometryHandlers({ x: 50, y: 60 }, { x: 0, y: 0 }),
    });
    const registry = fakeRegistry([
      { type: 'iframe', mainFrameId: 'OOP_CHILD', cdpSessionId: OOP_SESSION },
    ]);

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, registry, 1000);

    const oop = outcome.frames.find((f) => f.frameId === 'OOP_CHILD');
    expect(oop).toBeDefined(); // before the splice this was undefined, with no failure entry either
    expect(oop?.outOfProcess).toBe(true);
    expect(oop?.sessionId).toBe(OOP_SESSION);
    expect(oop?.offsetX).toBe(50);
    expect(oop?.offsetY).toBe(60);
    expect(outcome.failures).toEqual([]);

    // Exactly one extra frame-tree call, on the OOP frame's own session.
    const treeCalls = sent.filter((s) => s.method === 'Page.getFrameTree');
    expect(treeCalls.map((s) => s.sessionId)).toEqual([MAIN_SESSION, OOP_SESSION]);
  });

  it('reports an out-of-process frame whose own Page.getFrameTree fails, rather than dropping it silently', async () => {
    const { bridge } = fakeBridge({
      'Page.getFrameTree': (_params, sessionId) => {
        if (sessionId === OOP_SESSION) return new Error('session detached');
        return {
          frameTree: { frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' } },
        };
      },
      ...geometryHandlers({ x: 50, y: 60 }, { x: 0, y: 0 }),
    });
    const registry = fakeRegistry([
      { type: 'iframe', mainFrameId: 'OOP_CHILD', cdpSessionId: OOP_SESSION },
    ]);

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, registry, 1000);

    // The capture survives, the main frame is still there, and the frame
    // that could not be read is named rather than quietly missing.
    expect(outcome.frames.some((f) => f.frameId === 'MAIN')).toBe(true);
    expect(outcome.frames.some((f) => f.frameId === 'OOP_CHILD')).toBe(false);
    expect(outcome.failures).toEqual([
      expect.objectContaining({
        phase: 'frameTree',
        frameId: 'OOP_CHILD',
        reason: expect.stringContaining('session detached'),
      }),
    ]);
  });

  it('marks a same-process grandchild of an out-of-process frame as scrollOffsetKnown: true, now that an OOP parent scroll read is measured trustworthy', async () => {
    const { bridge } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames: [
            {
              frame: { id: 'OOP_CHILD', loaderId: 'L1', url: 'https://other.test/' },
              childFrames: [
                { frame: { id: 'GRANDCHILD', loaderId: 'L2', url: 'https://other.test/gc' } },
              ],
            },
          ],
        },
      }),
      ...geometryHandlers({ x: 1, y: 1 }, { x: 0, y: 0 }),
    });
    const registry = fakeRegistry([
      { type: 'iframe', mainFrameId: 'OOP_CHILD', cdpSessionId: OOP_SESSION },
    ]);

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, registry, 1000);

    const oop = outcome.frames.find((f) => f.frameId === 'OOP_CHILD');
    const grandchild = outcome.frames.find((f) => f.frameId === 'GRANDCHILD');
    expect(oop?.scrollOffsetKnown).toBe(true);
    // Before the OOP-parent scroll read was measured, this was `false`: the
    // grandchild's own offset depends on the OOP frame's own
    // `Page.getLayoutMetrics` scroll, read on the OOP frame's own session.
    // That read is now confirmed as trustworthy as the main session's, so
    // this frame's offset is exactly as trusted as any same-process one.
    expect(grandchild?.scrollOffsetKnown).toBe(true);
    expect(grandchild?.outOfProcess).toBe(false);
    expect(grandchild?.sessionId).toBe(OOP_SESSION); // same-process relative to the OOP frame: inherits ITS session, not main's
  });
});

describe('captureFrameTree: degradation', () => {
  it('a frame whose DOM.getFrameOwner fails is reported in failures and absent from frames, without failing the whole capture', async () => {
    const { bridge } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames: [
            { frame: { id: 'BROKEN', loaderId: 'L1', url: 'https://example.test/broken' } },
          ],
        },
      }),
      'DOM.getFrameOwner': () => new Error('E_CDP_DETACHED'),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);

    expect(outcome.frames.map((f) => f.frameId)).toEqual(['MAIN']);
    expect(outcome.failures).toEqual([
      { phase: 'frameTree', reason: 'E_CDP_DETACHED', frameId: 'BROKEN' },
    ]);
  });

  it('a child of a failed frame is also reported as unreachable, and never attempts its own geometry calls', async () => {
    const { bridge, sent } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames: [
            {
              frame: { id: 'BROKEN', loaderId: 'L1', url: 'https://example.test/broken' },
              childFrames: [
                { frame: { id: 'ORPHAN', loaderId: 'L2', url: 'https://example.test/orphan' } },
              ],
            },
          ],
        },
      }),
      'DOM.getFrameOwner': () => new Error('boom'),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);

    expect(outcome.frames.map((f) => f.frameId)).toEqual(['MAIN']);
    const reasons = outcome.failures.map((f) => f.frameId);
    expect(reasons).toContain('BROKEN');
    expect(reasons).toContain('ORPHAN');
    // The orphan's own frameId must never reach DOM.getFrameOwner: its
    // parent's offset was never established, so there is nothing to try.
    expect(
      sent.some((s) => s.method === 'DOM.getFrameOwner' && s.params?.['frameId'] === 'ORPHAN'),
    ).toBe(false);
  });

  it('a frame with no content quad (no layout) degrades that frame with a reason naming it', async () => {
    const { bridge } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames: [
            { frame: { id: 'HIDDEN', loaderId: 'L1', url: 'https://example.test/hidden' } },
          ],
        },
      }),
      'DOM.getFrameOwner': () => ({ backendNodeId: 5 }),
      'DOM.getBoxModel': () => ({ model: {} }),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);
    expect(outcome.frames.map((f) => f.frameId)).toEqual(['MAIN']);
    expect(outcome.failures[0]?.frameId).toBe('HIDDEN');
    expect(outcome.failures[0]?.reason).toMatch(/no content quad/);
  });
});

describe('captureFrameTree: bounds', () => {
  it('caps enumeration at PAGE_MAP_MAX_FRAME_COUNT and reports truncated', async () => {
    const childFrames = Array.from({ length: PAGE_MAP_MAX_FRAME_COUNT + 10 }, (_, i) => ({
      frame: { id: `F${i}`, loaderId: `L${i}`, url: `https://example.test/${i}` },
    }));
    const { bridge } = fakeBridge({
      'Page.getFrameTree': () => ({
        frameTree: {
          frame: { id: 'MAIN', loaderId: 'L0', url: 'https://example.test/' },
          childFrames,
        },
      }),
      ...geometryHandlers({ x: 0, y: 0 }, { x: 0, y: 0 }),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);
    expect(outcome.truncated).toBe(true);
    expect(outcome.frames.length).toBeLessThanOrEqual(PAGE_MAP_MAX_FRAME_COUNT);
  });

  it('stops descending past PAGE_MAP_MAX_FRAME_DEPTH and reports truncated', async () => {
    // Build a chain one level deeper than the cap: depths 0..(cap+1).
    type Node = { frame: { id: string; loaderId: string; url: string }; childFrames?: Node[] };
    let node: Node = {
      frame: {
        id: `D${PAGE_MAP_MAX_FRAME_DEPTH + 1}`,
        loaderId: 'L',
        url: 'https://example.test/',
      },
    };
    for (let d = PAGE_MAP_MAX_FRAME_DEPTH; d >= 0; d -= 1) {
      node = {
        frame: { id: d === 0 ? 'MAIN' : `D${d}`, loaderId: 'L', url: 'https://example.test/' },
        childFrames: [node],
      };
    }
    const { bridge } = fakeBridge({
      'Page.getFrameTree': () => ({ frameTree: node }),
      ...geometryHandlers({ x: 0, y: 0 }, { x: 0, y: 0 }),
    });

    const outcome = await captureFrameTree(bridge, MAIN_SESSION, fakeRegistry([]), 1000);
    expect(outcome.truncated).toBe(true);
    expect(outcome.frames.some((f) => f.frameId === `D${PAGE_MAP_MAX_FRAME_DEPTH + 1}`)).toBe(
      false,
    );
    expect(outcome.frames.some((f) => f.frameId === `D${PAGE_MAP_MAX_FRAME_DEPTH}`)).toBe(true);
  });
});
