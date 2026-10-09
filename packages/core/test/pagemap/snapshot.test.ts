/**
 * `pagemap/snapshot.ts`.
 *
 * `DOMSnapshot.captureSnapshot` never comes back wrong in a way that
 * throws; a misaligned decode produces a plausible rect on the wrong node
 * instead. So this file leans on one hand written fixture reply, built to
 * pin down every indirection the decoder has to get right at once (the
 * string table, the `layout.nodeIndex` sparse relationship back to
 * `nodes.backendNodeId`, a duplicate `nodeIndex` entry, a node with no
 * layout entry at all, paint order present at one layout position and
 * absent at another, a `bounds` entry missing where `clientRects` still
 * has one, and a second document standing in for an iframe) rather than
 * many small ones, so a test that breaks says exactly which piece of the
 * encoding regressed.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { PageMapSnapshotError, captureDomSnapshot } from '../../src/pagemap/snapshot.js';
import { PAGE_MAP_COMPUTED_STYLES } from '../../src/pagemap/types.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: CdpSessionId | undefined;
  readonly timeoutMs: number | undefined;
}

/** A `CdpBridge` whose one `send` always answers (or throws) `reply`, recording what it was called with, including the `SendOptions.timeoutMs` override this module is required to pass explicitly (see `snapshot.ts`'s own module doc on the timeout table entry it is owed and does not have). */
function fakeBridge(reply: unknown): { bridge: CdpBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const bridge = {
    async send(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: CdpSessionId,
      opts?: { timeoutMs?: number },
    ): Promise<unknown> {
      sent.push({ method, params: params ?? {}, sessionId, timeoutMs: opts?.timeoutMs });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

const SESSION = 'cdpsess_1' as CdpSessionId;

/** Builds `{documents, strings}` incrementally so the fixture below can write string VALUES rather than hand counted table indices, which is exactly the class of off by one mistake this module's own doc warns produces silent garbage rather than a thrown error. */
function stringTable() {
  const strings: string[] = [];
  const seen = new Map<string, number>();
  function intern(value: string): number {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const index = strings.length;
    strings.push(value);
    seen.set(value, index);
    return index;
  }
  return { strings, intern };
}

/** The ten style values, in `PAGE_MAP_COMPUTED_STYLES` order, resolved to string indices. `-1` (CDP's own "no value here" sentinel) is threaded through untouched so a caller can assert it decodes to `null`, not `strings[-1]`. */
function styleIndices(
  intern: (value: string) => number,
  values: {
    readonly display?: string | -1;
    readonly visibility?: string | -1;
    readonly opacity?: string | -1;
    readonly overflow?: string | -1;
    readonly overflowX?: string | -1;
    readonly overflowY?: string | -1;
    readonly cursor?: string | -1;
    readonly pointerEvents?: string | -1;
    readonly position?: string | -1;
    readonly backgroundColor?: string | -1;
  },
): number[] {
  const at = (v: string | -1 | undefined): number =>
    v === undefined ? -1 : v === -1 ? -1 : intern(v);
  return [
    at(values.display),
    at(values.visibility),
    at(values.opacity),
    at(values.overflow),
    at(values.overflowX),
    at(values.overflowY),
    at(values.cursor),
    at(values.pointerEvents),
    at(values.position),
    at(values.backgroundColor),
  ];
}

/**
 * The main fixture. Two documents.
 *
 * Document 0 (the top frame, `frameId` string `"main-frame"`), five node
 * positions:
 *   - position 0 -> backendNodeId 100, laid out (layout idx 0): full
 *     bounds, a scroll rect, paint order 7, every style present.
 *   - position 1 -> backendNodeId 101, NOT laid out at all (no entry in
 *     `layout.nodeIndex` names it): the "no layout" case.
 *   - position 2 -> backendNodeId 102, laid out (layout idx 1): paint
 *     order deliberately left as a hole in the array (the "absence" half
 *     of "paint order presence and absence"), and one style
 *     (`backgroundColor`) sent back as the `-1` sentinel.
 *   - position 3 -> backendNodeId 103, named by TWO layout entries (idx 2
 *     and idx 3), a duplicate `nodeIndex`: idx 2's bounds must win.
 *   - position 4 -> backendNodeId 104, laid out (layout idx 4) with NO
 *     `bounds` entry (the `bounds` array is shorter than the others) but a
 *     `clientRects` entry: the bounds-preferred, clientRects-fallback
 *     case.
 *
 * Document 1 (an iframe, `frameId` string `"iframe-frame"`), one node:
 *   - position 0 -> backendNodeId 200, laid out (layout idx 0), and the
 *     document itself carries `scrollOffsetX`/`scrollOffsetY` for
 *     `frames.ts` to read later.
 */
function buildFixtureReply(): unknown {
  const { strings, intern } = stringTable();
  const mainFrameId = intern('main-frame');
  const iframeFrameId = intern('iframe-frame');

  const doc0 = {
    frameId: mainFrameId,
    nodes: {
      backendNodeId: [100, 101, 102, 103, 104],
    },
    layout: {
      nodeIndex: [0, 2, 3, 3, 4],
      bounds: [
        [10, 20, 100, 50], // idx0 -> node position 0 (backendNodeId 100)
        [5, 5, 40, 40], // idx1 -> node position 2 (backendNodeId 102)
        [1, 1, 2, 2], // idx2 -> node position 3 (backendNodeId 103), FIRST occurrence
        [999, 999, 999, 999], // idx3 -> node position 3 again, must be ignored
        // idx4 deliberately absent: array is shorter than the other layout arrays.
      ],
      scrollRects: [[0, 0, 500, 1000]], // only idx0 has one; the rest fall through to null.
      // paintOrders[1] is a genuine hole (never assigned), the "absence" case.
      paintOrders: (() => {
        const arr: number[] = [];
        arr[0] = 7;
        arr[2] = 3;
        arr[3] = 3;
        arr[4] = 9;
        return arr;
      })(),
      clientRects: (() => {
        const arr: number[][] = [];
        arr[4] = [50, 60, 10, 10]; // idx4's fallback, since bounds[4] is absent.
        return arr;
      })(),
      styles: [
        styleIndices(intern, {
          display: 'block',
          visibility: 'visible',
          opacity: '1',
          overflow: 'visible',
          overflowX: 'visible',
          overflowY: 'visible',
          cursor: 'pointer',
          pointerEvents: 'auto',
          position: 'static',
          backgroundColor: 'rgba(0, 0, 0, 0)',
        }),
        styleIndices(intern, {
          display: 'inline',
          visibility: 'visible',
          opacity: '1',
          overflow: 'visible',
          overflowX: 'visible',
          overflowY: 'visible',
          cursor: 'auto',
          pointerEvents: 'auto',
          position: 'static',
          backgroundColor: -1, // the sentinel case
        }),
        // idx2, idx3, idx4: no styles entry at all (array shorter than layout length).
      ],
    },
    // scrollOffsetX/scrollOffsetY deliberately omitted on doc0 to assert the null default.
  };

  const doc1 = {
    frameId: iframeFrameId,
    nodes: {
      backendNodeId: [200],
    },
    layout: {
      nodeIndex: [0],
      bounds: [[1, 2, 3, 4]],
      scrollRects: [[0, 0, 0, 0]],
      paintOrders: [1],
      styles: [styleIndices(intern, { display: 'block' })],
    },
    scrollOffsetX: 15,
    scrollOffsetY: 25,
  };

  return { documents: [doc0, doc1], strings };
}

describe('captureDomSnapshot: which CDP command goes out', () => {
  it('sends exactly one DOMSnapshot.captureSnapshot with the expected flags and computed style list', async () => {
    const { bridge, sent } = fakeBridge({ documents: [], strings: [] });

    await captureDomSnapshot(bridge, SESSION);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('DOMSnapshot.captureSnapshot');
    expect(sent[0]?.sessionId).toBe(SESSION);
    expect(sent[0]?.params).toEqual({
      computedStyles: [...PAGE_MAP_COMPUTED_STYLES],
      includePaintOrder: true,
      includeDOMRects: true,
      includeBlendedBackgroundColors: false,
      includeTextColorOpacities: false,
    });
  });

  it('defaults the send timeout to 20000ms, and honours an explicit override', async () => {
    const { bridge: defaultBridge, sent: defaultSent } = fakeBridge({ documents: [], strings: [] });
    await captureDomSnapshot(defaultBridge, SESSION);
    expect(defaultSent[0]?.timeoutMs).toBe(20000);

    const { bridge: overrideBridge, sent: overrideSent } = fakeBridge({
      documents: [],
      strings: [],
    });
    await captureDomSnapshot(overrideBridge, SESSION, { timeoutMs: 5000 });
    expect(overrideSent[0]?.timeoutMs).toBe(5000);
  });
});

describe('captureDomSnapshot: decode', () => {
  it('keys the output by backendNodeId and resolves frameId through the string table rather than leaving it as a raw index', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    expect(result.nodes.get(100)?.frameId).toBe('main-frame');
    expect(result.nodes.get(200)?.frameId).toBe('iframe-frame');
    expect(result.documents[0]?.frameId).toBe('main-frame');
    expect(result.documents[1]?.frameId).toBe('iframe-frame');
  });

  it('decodes bounds, scroll rect, paint order and every computed style for a fully laid out node', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    const node = result.nodes.get(100);
    expect(node?.rect).toEqual({ x: 10, y: 20, width: 100, height: 50 });
    expect(node?.scrollRect).toEqual({ x: 0, y: 0, width: 500, height: 1000 });
    expect(node?.paintOrder).toBe(7);
    expect(node?.style).toEqual({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      overflow: 'visible',
      overflowX: 'visible',
      overflowY: 'visible',
      cursor: 'pointer',
      pointerEvents: 'auto',
      position: 'static',
      backgroundColor: 'rgba(0, 0, 0, 0)',
    });
  });

  it('a node with no layout entry at all still appears in the map, with every layout field null', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    const node = result.nodes.get(101);
    expect(node).toBeDefined();
    expect(node?.rect).toBeNull();
    expect(node?.scrollRect).toBeNull();
    expect(node?.paintOrder).toBeNull();
    expect(node?.style).toBeNull();
  });

  it('paint order: present at one layout position, a genuine hole (absent) at another', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    expect(result.nodes.get(100)?.paintOrder).toBe(7); // present
    expect(result.nodes.get(102)?.paintOrder).toBeNull(); // hole in paintOrders[1]
  });

  it('a style value sent back as the -1 sentinel decodes to null, not to strings[-1] or a crash', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    const style = result.nodes.get(102)?.style;
    expect(style?.backgroundColor).toBeNull();
    expect(style?.display).toBe('inline'); // the rest of the same entry still decodes normally
  });

  it('a node whose layout entry carries no styles array at all decodes style as null, not as ten nulls silently mistaken for real values', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    expect(result.nodes.get(103)?.style).toBeNull();
  });

  it('a duplicate nodeIndex entry: the FIRST layout position wins, later duplicates are ignored', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    expect(result.nodes.get(103)?.rect).toEqual({ x: 1, y: 1, width: 2, height: 2 });
  });

  it('bounds is preferred when present; clientRects is used only as a fallback when bounds is missing for that layout entry', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    // node 100 has both a scrollRect and a bounds entry; bounds wins (asserted above).
    // node 104 has no bounds entry at all, only a clientRects one.
    expect(result.nodes.get(104)?.rect).toEqual({ x: 50, y: 60, width: 10, height: 10 });
  });

  it("carries each document's own scrollOffsetX/scrollOffsetY, null when the reply omitted them", async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    expect(result.documents[0]).toMatchObject({ scrollOffsetX: null, scrollOffsetY: null });
    expect(result.documents[1]).toMatchObject({ scrollOffsetX: 15, scrollOffsetY: 25 });
  });

  it('merges multiple documents (iframes) into one flat node map keyed by backendNodeId, each node tagged with its own frame', async () => {
    const { bridge } = fakeBridge(buildFixtureReply());
    const result = await captureDomSnapshot(bridge, SESSION);

    expect(result.documents).toHaveLength(2);
    expect([...result.nodes.keys()].sort((a, b) => a - b)).toEqual([100, 101, 102, 103, 104, 200]);
    expect(result.nodes.get(200)?.rect).toEqual({ x: 1, y: 2, width: 3, height: 4 });
    expect(result.nodes.get(200)?.frameId).toBe('iframe-frame');
  });
});

describe('captureDomSnapshot: degradation is fatal, never silent', () => {
  it('wraps a CDP send failure in a PageMapSnapshotError carrying phase: "snapshot"', async () => {
    const cdpFailure = new Error('E_CDP_TIMEOUT: DOMSnapshot.captureSnapshot');
    const { bridge } = fakeBridge(cdpFailure);

    await expect(captureDomSnapshot(bridge, SESSION)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PageMapSnapshotError);
      const failure = (err as PageMapSnapshotError).failure;
      expect(failure.phase).toBe('snapshot');
      expect(failure.reason).toContain('E_CDP_TIMEOUT');
      expect((err as PageMapSnapshotError).cause).toBe(cdpFailure);
      return true;
    });
  });

  it('a reply with no documents/strings table is a fatal PageMapSnapshotError, not an empty result', async () => {
    const { bridge } = fakeBridge({});

    await expect(captureDomSnapshot(bridge, SESSION)).rejects.toSatisfy((err: unknown) => {
      expect(err).toBeInstanceOf(PageMapSnapshotError);
      expect((err as PageMapSnapshotError).failure.phase).toBe('snapshot');
      return true;
    });
  });

  it('an empty documents array is not an error: it is a valid, empty capture', async () => {
    const { bridge } = fakeBridge({ documents: [], strings: [] });

    const result = await captureDomSnapshot(bridge, SESSION);
    expect(result.nodes.size).toBe(0);
    expect(result.documents).toHaveLength(0);
  });
});
