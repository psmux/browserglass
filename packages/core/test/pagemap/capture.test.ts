/**
 * `pagemap/capture.ts`.
 *
 * A scripted fake `CdpBridge` driving every CDP method the full pipeline
 * touches (`DOMSnapshot.captureSnapshot`, `DOM.getDocument` at both
 * `depth: -1` and `depth: 0`, `Page.getFrameTree`, `Page.getLayoutMetrics`,
 * `Accessibility.enable`/`getFullAXTree`/`disable`, `DOM.resolveNode`,
 * `DOMDebugger.getEventListeners`, `Runtime.releaseObject`, and, for the
 * multi-frame case, `DOM.getFrameOwner`/`DOM.getBoxModel`), plus a fake
 * `TargetRegistry`. Mirrors the per-method-handler shape every other
 * `pagemap/test/*.ts` file already uses (`ax-merge.test.ts`,
 * `frames.test.ts`), extended with a per-method call counter so the
 * "no retry" claim in `capture.ts`'s own module doc can actually be
 * checked, not just assumed.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { TargetRegistry } from '../../src/cdp/target-registry.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { PageMapCaptureError, capturePageMap } from '../../src/pagemap/capture.js';

const MAIN = 'sess-main' as CdpSessionId;
const OOP_SESSION = 'sess-oop' as CdpSessionId;

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  readonly sessionId: CdpSessionId | undefined;
  readonly opts: unknown;
}

type Handler = (
  params: Record<string, unknown>,
  sessionId: CdpSessionId | undefined,
  callIndex: number,
) => unknown;

function fakeBridge(handlers: Readonly<Record<string, Handler>>): {
  bridge: CdpBridge;
  sent: Sent[];
  callCount: (method: string) => number;
} {
  const sent: Sent[] = [];
  const counts = new Map<string, number>();
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
      const callIndex = counts.get(method) ?? 0;
      counts.set(method, callIndex + 1);
      const reply = handler(params ?? {}, sessionId, callIndex);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent, callCount: (method) => counts.get(method) ?? 0 };
}

function fakeRegistry(): TargetRegistry {
  return { all: () => [] } as unknown as TargetRegistry;
}

/** The main document's `DOM.getDocument({depth:-1, pierce:true})` reply: `#document(1) > body(2) > button(3)`. */
const MAIN_DOM_TREE = {
  root: {
    backendNodeId: 1,
    nodeType: 9,
    nodeName: '#document',
    children: [
      {
        backendNodeId: 2,
        nodeType: 1,
        nodeName: 'BODY',
        localName: 'body',
        children: [
          {
            backendNodeId: 3,
            nodeType: 1,
            nodeName: 'BUTTON',
            localName: 'button',
            attributes: ['id', 'btn1'],
          },
        ],
      },
    ],
  },
};

/** A `DOMSnapshot.captureSnapshot` reply carrying a rect/style/paintOrder for backendNodeId 3 only (position 2 in the `nodes.backendNodeId` array). Style indices line up positionally with `PAGE_MAP_COMPUTED_STYLES`. */
const MAIN_SNAPSHOT = {
  documents: [
    {
      nodes: { backendNodeId: [1, 2, 3] },
      layout: {
        nodeIndex: [2],
        bounds: [[10, 10, 40, 20]],
        paintOrders: [5],
        styles: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
        scrollRects: [[0, 0, 0, 0]],
      },
      scrollOffsetX: 0,
      scrollOffsetY: 0,
    },
  ],
  strings: [
    'block',
    'visible',
    '1',
    'visible',
    'visible',
    'visible',
    'pointer',
    'auto',
    'static',
    'rgba(0,0,0,0)',
  ],
};

const MAIN_FRAME_TREE = {
  frameTree: { frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://example.test/' } },
};

const LAYOUT_METRICS = {
  cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1000, clientHeight: 800 },
};

const MAIN_AX_TREE = {
  nodes: [
    {
      ignored: false,
      role: { value: 'button' },
      name: { value: 'Submit' },
      backendDOMNodeId: 3,
      properties: [],
    },
  ],
};

/** The full set of handlers a happy-path, single-frame capture needs. Individual tests override one entry to inject a failure. */
function happyPathHandlers(
  overrides: Partial<Record<string, Handler>> = {},
): Record<string, Handler> {
  return {
    'DOMSnapshot.captureSnapshot': () => MAIN_SNAPSHOT,
    'DOM.getDocument': (params) => (params.depth === 0 ? { root: { nodeId: 100 } } : MAIN_DOM_TREE),
    'Page.getFrameTree': () => MAIN_FRAME_TREE,
    'Page.getLayoutMetrics': () => LAYOUT_METRICS,
    'Accessibility.enable': () => ({}),
    'Accessibility.disable': () => ({}),
    'Accessibility.getFullAXTree': () => MAIN_AX_TREE,
    'DOM.resolveNode': () => ({ object: { objectId: 'obj-1' } }),
    'DOMDebugger.getEventListeners': () => ({ listeners: [{ type: 'click', backendNodeId: 3 }] }),
    'Runtime.releaseObject': () => ({}),
    ...overrides,
  };
}

describe('capturePageMap: the happy path, end to end', () => {
  it('merges the DOM tree, snapshot, accessibility and listener signal into one capture, with no failures', async () => {
    const { bridge } = fakeBridge(happyPathHandlers());
    const capture = await capturePageMap(bridge, MAIN, fakeRegistry(), {});

    expect(capture.failures).toEqual([]);
    expect(typeof capture.epoch).toBe('string');
    expect(capture.epoch.length).toBeGreaterThan(0);
    expect(capture.scrollX).toBe(0);
    expect(capture.scrollY).toBe(0);
    expect(capture.viewportWidth).toBe(1000);
    expect(capture.viewportHeight).toBe(800);

    expect(capture.nodes.size).toBe(3);
    const button = capture.nodes.get(3);
    expect(button?.tag).toBe('button');
    expect(button?.rect).toEqual({ x: 10, y: 10, width: 40, height: 20 });
    expect(button?.paintOrder).toBe(5);
    expect(button?.style?.cursor).toBe('pointer');
    expect(button?.role).toBe('button');
    expect(button?.name).toBe('Submit');
    expect(button?.hasClickListener).toBe(true);
    expect(button?.attributes.get('id')).toBe('btn1');

    const body = capture.nodes.get(2);
    expect(body?.hasClickListener).toBe(false); // signal ran; this node just was not named by it.
    expect(body?.role).toBeNull(); // AX tree named only the button.
  });

  it('mints the epoch from the session id and the main loaderId, varying with either', async () => {
    const { bridge } = fakeBridge(happyPathHandlers());
    const a = await capturePageMap(bridge, MAIN, fakeRegistry(), {});
    const { bridge: bridge2 } = fakeBridge(
      happyPathHandlers({
        'Page.getFrameTree': () => ({
          frameTree: { frame: { id: 'MAIN', loaderId: 'LOADER_2', url: 'https://example.test/' } },
        }),
      }),
    );
    const b = await capturePageMap(bridge2, MAIN, fakeRegistry(), {});
    expect(a.epoch).not.toBe(b.epoch); // a navigation (different loaderId) mints a different epoch.
  });
});

describe('capturePageMap: fatal phases, no retry', () => {
  it('a snapshot failure is fatal, tagged phase "snapshot", and never retried', async () => {
    const { bridge, callCount } = fakeBridge(
      happyPathHandlers({ 'DOMSnapshot.captureSnapshot': () => new Error('boom') }),
    );
    let caught: unknown;
    try {
      await capturePageMap(bridge, MAIN, fakeRegistry(), {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PageMapCaptureError);
    expect((caught as PageMapCaptureError).failure.phase).toBe('snapshot');
    expect(callCount('DOMSnapshot.captureSnapshot')).toBe(1); // a snapshot failure is not retried.
  });

  it('a DOM.getDocument failure on the main session is fatal, tagged phase "domTree"', async () => {
    const { bridge } = fakeBridge(
      happyPathHandlers({
        'DOM.getDocument': (params) =>
          params.depth === 0 ? { root: { nodeId: 100 } } : new Error('detached'),
      }),
    );
    let caught: unknown;
    try {
      await capturePageMap(bridge, MAIN, fakeRegistry(), {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PageMapCaptureError);
    expect((caught as PageMapCaptureError).failure.phase).toBe('domTree');
  });

  it('a Page.getFrameTree failure is fatal, tagged phase "frameTree", and never retried', async () => {
    const { bridge, callCount } = fakeBridge(
      happyPathHandlers({ 'Page.getFrameTree': () => new Error('no frame tree') }),
    );
    let caught: unknown;
    try {
      await capturePageMap(bridge, MAIN, fakeRegistry(), {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PageMapCaptureError);
    expect((caught as PageMapCaptureError).failure.phase).toBe('frameTree');
    expect(callCount('Page.getFrameTree')).toBe(1);
  });

  it('a Page.getLayoutMetrics failure is fatal (no viewport, no capture)', async () => {
    const { bridge } = fakeBridge(
      happyPathHandlers({ 'Page.getLayoutMetrics': () => new Error('no metrics') }),
    );
    let caught: unknown;
    try {
      await capturePageMap(bridge, MAIN, fakeRegistry(), {});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PageMapCaptureError);
  });

  it('a timed-out phase-A command fails the capture immediately, with no second attempt', async () => {
    const { bridge, callCount } = fakeBridge(
      happyPathHandlers({
        'DOMSnapshot.captureSnapshot': () => new Error('timeout: DOMSnapshot.captureSnapshot'),
      }),
    );
    await expect(
      capturePageMap(bridge, MAIN, fakeRegistry(), { timeoutMs: 5000 }),
    ).rejects.toBeInstanceOf(PageMapCaptureError);
    expect(callCount('DOMSnapshot.captureSnapshot')).toBe(1);
  });

  it('passes the same timeoutMs to every phase-A command', async () => {
    const { bridge, sent } = fakeBridge(happyPathHandlers());
    await capturePageMap(bridge, MAIN, fakeRegistry(), { timeoutMs: 12345 });
    const snapshotCall = sent.find((s) => s.method === 'DOMSnapshot.captureSnapshot');
    const frameTreeCall = sent.find((s) => s.method === 'Page.getFrameTree');
    expect((snapshotCall?.opts as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(12345);
    expect((frameTreeCall?.opts as { timeoutMs?: number } | undefined)?.timeoutMs).toBe(12345);
  });
});

describe('capturePageMap: accessibility degrades one frame while others succeed', () => {
  const TWO_FRAME_TREE = {
    frameTree: {
      frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://example.test/' },
      childFrames: [
        { frame: { id: 'CHILD', loaderId: 'LOADER_CHILD', url: 'https://example.test/child' } },
      ],
    },
  };

  it('a per-frame Accessibility.getFullAXTree failure degrades that frame only, and is recorded as one failure', async () => {
    const { bridge } = fakeBridge(
      happyPathHandlers({
        'Page.getFrameTree': () => TWO_FRAME_TREE,
        'DOM.getFrameOwner': () => ({ backendNodeId: 999 }),
        'DOM.getBoxModel': () => ({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } }),
        'Accessibility.getFullAXTree': (params) =>
          params.frameId === 'CHILD' ? new Error('detached session') : MAIN_AX_TREE,
      }),
    );

    const capture = await capturePageMap(bridge, MAIN, fakeRegistry(), {});

    // The main frame's own node still has a role: the good frame is unaffected.
    expect(capture.nodes.get(3)?.role).toBe('button');
    // The whole capture still succeeds; the degradation is reported, not thrown.
    expect(capture.failures).toEqual([
      { phase: 'accessibility', reason: 'detached session', frameId: 'CHILD' },
    ]);
  });
});

describe('capturePageMap: listeners degrade to null everywhere on failure', () => {
  it('a DOMDebugger.getEventListeners failure records one phase "listeners" failure and leaves hasClickListener null on every node', async () => {
    const { bridge } = fakeBridge(
      happyPathHandlers({ 'DOMDebugger.getEventListeners': () => new Error('resolve failed') }),
    );

    const capture = await capturePageMap(bridge, MAIN, fakeRegistry(), {});

    expect(capture.failures).toEqual([{ phase: 'listeners', reason: 'resolve failed' }]);
    for (const node of capture.nodes.values()) {
      expect(node.hasClickListener).toBeNull();
    }
    // The rest of the merge is unaffected: this is a degrade, not a fatal failure.
    expect(capture.nodes.get(3)?.role).toBe('button');
  });

  it('req.listeners: false skips the listener phase entirely, with no failure recorded', async () => {
    const { bridge, callCount } = fakeBridge(happyPathHandlers());
    const capture = await capturePageMap(bridge, MAIN, fakeRegistry(), { listeners: false });
    expect(callCount('DOMDebugger.getEventListeners')).toBe(0);
    expect(capture.failures).toEqual([]);
    for (const node of capture.nodes.values()) {
      expect(node.hasClickListener).toBeNull();
    }
  });
});

describe('capturePageMap: include narrows the work', () => {
  it('include: ["text"] skips the snapshot, accessibility and listener phases entirely', async () => {
    const { bridge, callCount } = fakeBridge(happyPathHandlers());
    const capture = await capturePageMap(bridge, MAIN, fakeRegistry(), { include: ['text'] });

    expect(callCount('DOMSnapshot.captureSnapshot')).toBe(0);
    expect(callCount('Accessibility.getFullAXTree')).toBe(0);
    expect(callCount('DOMDebugger.getEventListeners')).toBe(0);
    // The DOM tree itself is still there: text extraction needs it.
    expect(capture.nodes.get(3)?.tag).toBe('button');
    expect(capture.nodes.get(3)?.rect).toBeNull(); // no snapshot ran, so no geometry.
    expect(capture.failures).toEqual([]);
  });
});

describe('capturePageMap: out-of-process iframe geometry (GAP 1)', () => {
  const OOP_FRAME_TREE = {
    frameTree: {
      frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://example.test/' },
      childFrames: [{ frame: { id: 'OOP', loaderId: 'LOADER_OOP', url: 'https://other.test/' } }],
    },
  };

  /** The OOP session's own `DOM.getDocument({depth:-1, pierce:true})` reply: `#document(10) > button(11)`. */
  const OOP_DOM_TREE = {
    root: {
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 11,
          nodeType: 1,
          nodeName: 'BUTTON',
          localName: 'button',
          attributes: ['id', 'oopbtn'],
        },
      ],
    },
  };

  /** The OOP session's own snapshot: button 11 sits at (5, 5, 30, 15) in the OOP frame's OWN document space. */
  const OOP_SNAPSHOT = {
    documents: [
      {
        nodes: { backendNodeId: [10, 11] },
        layout: {
          nodeIndex: [1],
          bounds: [[5, 5, 30, 15]],
          paintOrders: [2],
          styles: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
          scrollRects: [[0, 0, 0, 0]],
        },
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    ],
    strings: [
      'block',
      'visible',
      '1',
      'visible',
      'visible',
      'visible',
      'pointer',
      'auto',
      'static',
      'rgba(0,0,0,0)',
    ],
  };

  const OOP_AX_TREE = {
    nodes: [
      {
        ignored: false,
        role: { value: 'button' },
        name: { value: 'OOP Button' },
        backendDOMNodeId: 11,
        properties: [],
      },
    ],
  };

  /** The frame owner's content quad top-left is (100, 50) in the main document's own space, with zero scroll: `frames.ts` computes `OOP.offsetX = 100`, `OOP.offsetY = 50`. */
  const OOP_GEOMETRY_HANDLERS = {
    'DOM.getFrameOwner': () => ({ backendNodeId: 999 }),
    'DOM.getBoxModel': () => ({ model: { content: [100, 50, 110, 50, 110, 60, 100, 60] } }),
  };

  function oopRegistry(): TargetRegistry {
    return {
      all: () => [{ type: 'iframe', mainFrameId: 'OOP', cdpSessionId: OOP_SESSION }],
    } as unknown as TargetRegistry;
  }

  it("captures the out-of-process frame's own snapshot and composes its rect into top-document space using the offset frames.ts computed", async () => {
    const { bridge } = fakeBridge(
      happyPathHandlers({
        'Page.getFrameTree': () => OOP_FRAME_TREE,
        'DOM.getDocument': (params, sessionId) =>
          params.depth === 0
            ? { root: { nodeId: 100 } }
            : sessionId === OOP_SESSION
              ? OOP_DOM_TREE
              : MAIN_DOM_TREE,
        'DOMSnapshot.captureSnapshot': (_params, sessionId) =>
          sessionId === OOP_SESSION ? OOP_SNAPSHOT : MAIN_SNAPSHOT,
        'Accessibility.getFullAXTree': (params) =>
          params.frameId === 'OOP' ? OOP_AX_TREE : MAIN_AX_TREE,
        ...OOP_GEOMETRY_HANDLERS,
      }),
    );

    const capture = await capturePageMap(bridge, MAIN, oopRegistry(), {});

    expect(capture.failures).toEqual([]);
    const oopButton = capture.nodes.get(11);
    expect(oopButton?.frameId).toBe('OOP');
    // offset(OOP) = ownerRect(100, 50) + parentScroll(0, 0); own rect (5, 5, 30, 15).
    expect(oopButton?.rect).toEqual({ x: 105, y: 55, width: 30, height: 15 });
    expect(oopButton?.role).toBe('button'); // Phase B already reached OOP content before this fix; unaffected.
    expect(oopButton?.name).toBe('OOP Button');

    // The main frame's own geometry is unaffected: offset (0, 0) is a no-op.
    expect(capture.nodes.get(3)?.rect).toEqual({ x: 10, y: 10, width: 40, height: 20 });
  });

  it('a DOMSnapshot.captureSnapshot failure on the out-of-process session degrades that frame only: rect null, one snapshot failure recorded, the capture still succeeds', async () => {
    const { bridge } = fakeBridge(
      happyPathHandlers({
        'Page.getFrameTree': () => OOP_FRAME_TREE,
        'DOM.getDocument': (params, sessionId) =>
          params.depth === 0
            ? { root: { nodeId: 100 } }
            : sessionId === OOP_SESSION
              ? OOP_DOM_TREE
              : MAIN_DOM_TREE,
        'DOMSnapshot.captureSnapshot': (_params, sessionId) =>
          sessionId === OOP_SESSION ? new Error('detached') : MAIN_SNAPSHOT,
        'Accessibility.getFullAXTree': (params) =>
          params.frameId === 'OOP' ? OOP_AX_TREE : MAIN_AX_TREE,
        ...OOP_GEOMETRY_HANDLERS,
      }),
    );

    const capture = await capturePageMap(bridge, MAIN, oopRegistry(), {});

    expect(capture.failures).toContainEqual({
      phase: 'snapshot',
      reason: 'DOMSnapshot.captureSnapshot failed: detached',
      frameId: 'OOP',
    });
    const oopButton = capture.nodes.get(11);
    expect(oopButton?.rect).toBeNull(); // no snapshot for this session, no geometry to compose.
    expect(oopButton?.role).toBe('button'); // accessibility still ran; unaffected by the snapshot degrade.
  });

  it("a node whose own frame's offset never resolved gets rect: null rather than a wrongly composed rect, and the frame failure is reported once by frames.ts", async () => {
    // OOP contains a same-process child frame (OOP_CHILD_BROKEN) whose own
    // DOM.getFrameOwner call (run on OOP's session, since OOP is its
    // parent) fails. frames.ts therefore drops OOP_CHILD_BROKEN from
    // `frames` entirely, but `buildDomTree` on OOP's own session still
    // walks into its `contentDocument` (it has no notion of frame-level
    // failures), producing a node whose `frameId` names a frame this
    // capture never resolved an offset for.
    const FRAME_TREE_WITH_BROKEN_CHILD = {
      frameTree: {
        frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://example.test/' },
        childFrames: [
          {
            frame: { id: 'OOP', loaderId: 'LOADER_OOP', url: 'https://other.test/' },
            childFrames: [
              {
                frame: {
                  id: 'OOP_CHILD_BROKEN',
                  loaderId: 'LOADER_BROKEN',
                  url: 'https://other.test/broken',
                },
              },
            ],
          },
        ],
      },
    };
    const OOP_DOM_TREE_WITH_BROKEN_CHILD = {
      root: {
        backendNodeId: 10,
        nodeType: 9,
        nodeName: '#document',
        children: [
          {
            backendNodeId: 11,
            nodeType: 1,
            nodeName: 'IFRAME',
            localName: 'iframe',
            frameId: 'OOP_CHILD_BROKEN',
            contentDocument: {
              backendNodeId: 12,
              nodeType: 9,
              nodeName: '#document',
              children: [
                { backendNodeId: 13, nodeType: 1, nodeName: 'BUTTON', localName: 'button' },
              ],
            },
          },
        ],
      },
    };
    const OOP_SNAPSHOT_WITH_BROKEN_CHILD = {
      documents: [
        {
          nodes: { backendNodeId: [10, 11, 12, 13] },
          layout: {
            nodeIndex: [3],
            bounds: [[1, 1, 10, 10]],
            paintOrders: [1],
            styles: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
            scrollRects: [[0, 0, 0, 0]],
          },
          scrollOffsetX: 0,
          scrollOffsetY: 0,
        },
      ],
      strings: [
        'block',
        'visible',
        '1',
        'visible',
        'visible',
        'visible',
        'pointer',
        'auto',
        'static',
        'rgba(0,0,0,0)',
      ],
    };

    const { bridge } = fakeBridge(
      happyPathHandlers({
        'Page.getFrameTree': () => FRAME_TREE_WITH_BROKEN_CHILD,
        'DOM.getDocument': (params, sessionId) =>
          params.depth === 0
            ? { root: { nodeId: 100 } }
            : sessionId === OOP_SESSION
              ? OOP_DOM_TREE_WITH_BROKEN_CHILD
              : MAIN_DOM_TREE,
        'DOMSnapshot.captureSnapshot': (_params, sessionId) =>
          sessionId === OOP_SESSION ? OOP_SNAPSHOT_WITH_BROKEN_CHILD : MAIN_SNAPSHOT,
        'DOM.getFrameOwner': (params) =>
          params.frameId === 'OOP_CHILD_BROKEN' ? new Error('boom') : { backendNodeId: 999 },
        'DOM.getBoxModel': () => ({ model: { content: [100, 50, 110, 50, 110, 60, 100, 60] } }),
      }),
    );

    const capture = await capturePageMap(bridge, MAIN, oopRegistry(), {});

    expect(capture.failures).toContainEqual({
      phase: 'frameTree',
      reason: 'boom',
      frameId: 'OOP_CHILD_BROKEN',
    });
    const brokenChildButton = capture.nodes.get(13);
    expect(brokenChildButton?.frameId).toBe('OOP_CHILD_BROKEN');
    // The snapshot DID report a rect for it (bounds [1,1,10,10]); it is
    // still null here, because composing it would need an offset this
    // capture never resolved.
    expect(brokenChildButton?.rect).toBeNull();
  });
});

describe('capturePageMap: cross-session backendNodeId collision (GAP 2)', () => {
  const OOP_FRAME_TREE = {
    frameTree: {
      frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://example.test/' },
      childFrames: [{ frame: { id: 'OOP', loaderId: 'LOADER_OOP', url: 'https://other.test/' } }],
    },
  };

  /** The OOP session's own document root is 10 (no collision), but its one button reuses backendNodeId 3 -- the SAME numeric id `MAIN_DOM_TREE` gives its own button. */
  const OOP_DOM_TREE_COLLIDING = {
    root: {
      backendNodeId: 10,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 3,
          nodeType: 1,
          nodeName: 'BUTTON',
          localName: 'button',
          attributes: ['id', 'oopcollide'],
        },
      ],
    },
  };

  const OOP_SNAPSHOT_COLLIDING = {
    documents: [
      {
        nodes: { backendNodeId: [10, 3] },
        layout: {
          nodeIndex: [1],
          bounds: [[999, 999, 1, 1]], // deliberately implausible, so a passing test proves this data was NEVER applied.
          paintOrders: [9],
          styles: [[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]],
          scrollRects: [[0, 0, 0, 0]],
        },
        scrollOffsetX: 0,
        scrollOffsetY: 0,
      },
    ],
    strings: [
      'block',
      'visible',
      '1',
      'visible',
      'visible',
      'visible',
      'pointer',
      'auto',
      'static',
      'rgba(0,0,0,0)',
    ],
  };

  const OOP_AX_TREE_COLLIDING = {
    nodes: [
      {
        ignored: false,
        role: { value: 'checkbox' },
        name: { value: 'OOP Collider' },
        backendDOMNodeId: 3,
        properties: [],
      },
    ],
  };

  function oopRegistry(): TargetRegistry {
    return {
      all: () => [{ type: 'iframe', mainFrameId: 'OOP', cdpSessionId: OOP_SESSION }],
    } as unknown as TargetRegistry;
  }

  it("keeps the first session's node, drops the second, and reports the conflict as one 'domTree' failure -- across the DOM/snapshot merge AND the accessibility join", async () => {
    const { bridge } = fakeBridge(
      happyPathHandlers({
        'Page.getFrameTree': () => OOP_FRAME_TREE,
        'DOM.getDocument': (params, sessionId) =>
          params.depth === 0
            ? { root: { nodeId: 100 } }
            : sessionId === OOP_SESSION
              ? OOP_DOM_TREE_COLLIDING
              : MAIN_DOM_TREE,
        'DOMSnapshot.captureSnapshot': (_params, sessionId) =>
          sessionId === OOP_SESSION ? OOP_SNAPSHOT_COLLIDING : MAIN_SNAPSHOT,
        'Accessibility.getFullAXTree': (params) =>
          params.frameId === 'OOP' ? OOP_AX_TREE_COLLIDING : MAIN_AX_TREE,
        'DOM.getFrameOwner': () => ({ backendNodeId: 999 }),
        'DOM.getBoxModel': () => ({ model: { content: [100, 50, 110, 50, 110, 60, 100, 60] } }),
      }),
    );

    const capture = await capturePageMap(bridge, MAIN, oopRegistry(), {});

    // MAIN's #document/body/button (1, 2, 3) plus OOP's own #document root
    // (10, no collision); OOP's colliding button never gets a second entry.
    expect(capture.nodes.size).toBe(4);
    expect(capture.nodes.get(10)?.frameId).toBe('OOP'); // the non-colliding OOP node merged normally.

    const node3 = capture.nodes.get(3);
    expect(node3?.attributes.get('id')).toBe('btn1'); // MAIN's own node, byte-for-byte.
    expect(node3?.rect).toEqual({ x: 10, y: 10, width: 40, height: 20 }); // MAIN's own rect, never OOP's implausible one.
    expect(node3?.role).toBe('button'); // MAIN's own AX read, not OOP's colliding "checkbox"/"OOP Collider".
    expect(node3?.name).toBe('Submit');

    expect(capture.failures).toContainEqual({
      phase: 'domTree',
      reason:
        'backendNodeId 3 was reported by two different CDP sessions (kept the node session sess-main reported first; dropped this one from session sess-oop). backendNodeId is unique only within the session that minted it; see index-assign.ts.',
      frameId: 'OOP',
    });
    // Exactly one failure for the one collision: the accessibility join's
    // own guard reuses the DOM/snapshot merge's provenance rather than
    // reporting the identical conflict a second time.
    expect(capture.failures.filter((f) => f.reason.includes('backendNodeId 3'))).toHaveLength(1);
  });
});
