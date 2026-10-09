import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * `page.map.get`/`page.map.stamp` end to end, over a real socket, through
 * the real handshake, the real capability check, a real `ManagedSession`
 * and a real (fake) Chrome endpoint.
 *
 * `@browserglass/core`'s own `pagemap/capture.test.ts` already proves the
 * capture pipeline itself (phase order, fatal-vs-degrade, the byte budget).
 * This file proves the SERVER wiring around it: that `devtools` alone gates
 * the door (matching `page.a11y.get`), that an over-large `timeoutMs` is
 * clamped rather than refused, that a stale `epoch` on `page.map.stamp` is
 * refused before any CDP command goes out, and above all that
 * the page map's "truncation and degradation are never silent" rule
 * (`docs/page-map.md`) survives the trip onto the wire: a failed frame, a failed
 * listener phase, and the `unpositioned` truncation tier all have to reach
 * `page.map.got` intact.
 */
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import type { PageMapRawDomNode, PageMapRawSnapshot } from './support/fake-chrome-server.js';
import {
  type TestGateway,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

function hello(): Record<string, unknown> {
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
  };
}

/** The harness's usual default caps; deliberately WITHOUT `devtools`, so a test has to ask for it explicitly to get it. */
const DEFAULT_CAPS = ['view', 'control', 'navigate', 'tabs.manage', 'capture', 'probe', 'admin'];

const OPEN_SOCKETS: WebSocket[] = [];

async function connectViewer(
  gw: TestGateway,
  caps: string[],
): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken({ caps });
  const ws = gw.connect();
  OPEN_SOCKETS.push(ws);
  await waitOpen(ws);
  ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessageSkipping(ws, UNSOLICITED);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

/** Same tracked-socket teardown discipline as `page-evaluate.test.ts`: a failed assertion must not leave a socket open for `gw.close()` to hang on. */
async function withGateway(fn: (gw: TestGateway) => Promise<void>): Promise<void> {
  const gw = await startTestGateway();
  gw.addTarget({
    targetId: 'cdp-a',
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
    windowId: 1,
  });
  OPEN_SOCKETS.length = 0;
  try {
    await fn(gw);
  } finally {
    for (const ws of OPEN_SOCKETS) ws.close();
    OPEN_SOCKETS.length = 0;
    await gw.close();
  }
}

async function sendAndAwait(
  ws: WebSocket,
  t: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `m${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ v: 1, t, id, ts: Date.now(), ...payload }));
  for (;;) {
    const msg = await nextMessageSkipping(ws, UNSOLICITED);
    if (msg['re'] === id) return msg;
  }
}

async function pageMapGet(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendAndAwait(ws, 'page.map.get', payload);
}

async function pageMapStamp(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendAndAwait(ws, 'page.map.stamp', payload);
}

/**
 * One document, one body, one button (backendNodeId 3), positioned at
 * (10,10,40,20). Mirrors `packages/core/test/pagemap/capture.test.ts`'s own
 * `MAIN_DOM_TREE`/`MAIN_SNAPSHOT` fixtures, the smallest capture that
 * reaches `page.map.got` with one real node.
 */
function installSimpleFixture(gw: TestGateway): void {
  const domTree: PageMapRawDomNode = {
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
            attributes: ['id', 'submit-btn'],
          },
        ],
      },
    ],
  };
  const snapshot: PageMapRawSnapshot = {
    documents: [
      {
        nodes: { backendNodeId: [1, 2, 3] },
        layout: { nodeIndex: [2], bounds: [[10, 10, 40, 20]] },
      },
    ],
    strings: [],
  };
  gw.chrome.setPageMapDomTree(domTree);
  gw.chrome.setPageMapSnapshot(snapshot);
  gw.chrome.setPageMapFrameTree({
    frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://a.example/' },
  });
}

describe('page.map.get / page.map.stamp: the capability is real', () => {
  it('refuses page.map.get from a caller holding view, control, navigate, capture, probe and admin but not devtools', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const reply = await pageMapGet(ws, { targetId });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('devtools');
    });
  });

  it('refuses page.map.stamp the same way', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const reply = await pageMapStamp(ws, { targetId, epoch: 'e1', indices: [1] });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
      expect((reply['context'] as { required: string }).required).toBe('devtools');
    });
  });

  it('admits page.map.get to a caller that holds devtools, gated identically to page.a11y.get rather than a wider or narrower door', async () => {
    await withGateway(async (gw) => {
      installSimpleFixture(gw);
      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools']);
      const reply = await pageMapGet(ws, { targetId });
      expect(reply['t']).toBe('page.map.got');
    });
  });
});

describe('page.map.get: a successful capture reaches the client in full', () => {
  it('returns the epoch, the node, and an undegraded, untruncated report', async () => {
    await withGateway(async (gw) => {
      installSimpleFixture(gw);
      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools']);
      const reply = await pageMapGet(ws, { targetId });

      expect(reply['t']).toBe('page.map.got');
      expect(typeof reply['epoch']).toBe('string');
      expect((reply['epoch'] as string).length).toBeGreaterThan(0);

      const nodes = reply['nodes'] as Array<Record<string, unknown>>;
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.['tag']).toBe('button');
      expect(nodes[0]?.['rect']).toEqual({ x: 10, y: 10, w: 40, h: 20 });
      expect((nodes[0]?.['attributes'] as Record<string, string>)['id']).toBe('submit-btn');

      expect(reply['total']).toBe(1);
      expect(reply['truncated']).toBe(false);
      expect(reply['truncatedByReason']).toEqual({ offscreen: 0, onscreen: 0, unpositioned: 0 });

      const degraded = reply['degraded'] as Record<string, unknown>;
      expect(degraded['framesFailed']).toBe(0);
      expect(degraded['failures']).toEqual([]);
      expect(degraded['listeners']).toBe('ok');
      expect(degraded).not.toHaveProperty('listenersReason');
    });
  });
});

describe('page.map.get: timeoutMs is clamped server side, never refused for being large', () => {
  it('refuses a non-positive or non-numeric timeoutMs but still captures with one far past MAX_PAGEMAP_TIMEOUT_MS', async () => {
    await withGateway(async (gw) => {
      installSimpleFixture(gw);
      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools']);

      const zero = await pageMapGet(ws, { targetId, timeoutMs: 0 });
      expect(zero['code']).toBe('bgls.error.pagemap.invalid_request');

      const notANumber = await pageMapGet(ws, { targetId, timeoutMs: 'soon' });
      expect(notANumber['code']).toBe('bgls.error.pagemap.invalid_request');

      // MAX_PAGEMAP_TIMEOUT_MS is 60000: an ask ten thousand times larger is
      // optimism, not a typo, and is clamped rather than refused, the
      // identical precedent `page.evaluate`'s own `timeoutMs` clamp sets.
      const huge = await pageMapGet(ws, { targetId, timeoutMs: 600_000_000 });
      expect(huge['t']).toBe('page.map.got');
    });
  });
});

describe('page.map.stamp: a stale epoch is refused before any CDP command goes out', () => {
  it('refuses an epoch with nothing captured yet for this target', async () => {
    await withGateway(async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools']);
      const reply = await pageMapStamp(ws, { targetId, epoch: 'never-captured', indices: [3] });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.pagemap.stale_epoch');
      expect(reply['category']).toBe('pagemap');
    });
  });

  it('refuses an epoch that does not match the one just minted by page.map.get', async () => {
    await withGateway(async (gw) => {
      installSimpleFixture(gw);
      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools']);
      const got = await pageMapGet(ws, { targetId });
      expect(got['t']).toBe('page.map.got');
      expect(got['epoch']).not.toBe('a-different-epoch');

      const stamped = await pageMapStamp(ws, {
        targetId,
        epoch: 'a-different-epoch',
        indices: [3],
      });
      expect(stamped['t']).toBe('error');
      expect(stamped['code']).toBe('bgls.error.pagemap.stale_epoch');
    });
  });
});

describe('page.map.get: degradation is never silent, a failed frame and a failed listener phase both surface', () => {
  it("reports the CHILD frame's accessibility failure in degraded.failures and the listener phase as failed, without failing the whole capture", async () => {
    await withGateway(async (gw) => {
      const domTree: PageMapRawDomNode = {
        backendNodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        children: [
          {
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'BODY',
            localName: 'body',
            children: [{ backendNodeId: 3, nodeType: 1, nodeName: 'BUTTON', localName: 'button' }],
          },
        ],
      };
      const snapshot: PageMapRawSnapshot = {
        documents: [
          {
            nodes: { backendNodeId: [1, 2, 3] },
            layout: { nodeIndex: [2], bounds: [[10, 10, 40, 20]] },
          },
        ],
        strings: [],
      };
      gw.chrome.setPageMapDomTree(domTree);
      gw.chrome.setPageMapSnapshot(snapshot);
      gw.chrome.setPageMapFrameTree({
        frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://a.example/' },
        childFrames: [
          { frame: { id: 'CHILD', loaderId: 'LOADER_CHILD', url: 'https://a.example/child' } },
        ],
      });
      // Lets `frames.ts` resolve CHILD's own offset (`DOM.getFrameOwner` +
      // `DOM.getBoxModel`) so it survives into Phase B at all; without this
      // CHILD would be dropped as a `phase: 'frameTree'` failure instead of
      // reaching (and failing) its own accessibility read.
      gw.chrome.setPageMapFrameOwner('CHILD', {
        backendNodeId: 500,
        content: [0, 0, 10, 0, 10, 10, 0, 10],
      });
      gw.chrome.setPageMapAccessibility((params) =>
        params.frameId === 'CHILD' ? new Error('detached session') : { nodes: [] },
      );
      gw.chrome.setPageMapEventListeners(() => new Error('resolve failed'));

      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools']);
      const reply = await pageMapGet(ws, { targetId });

      expect(reply['t']).toBe('page.map.got'); // a degrade, never a fatal error.
      const degraded = reply['degraded'] as {
        framesAttempted: number;
        framesFailed: number;
        failures: Array<{ frameId: string; reason: string }>;
        listeners: string;
        listenersReason?: string;
      };
      expect(degraded.framesFailed).toBe(1);
      expect(degraded.failures).toContainEqual({ frameId: 'CHILD', reason: 'detached session' });
      expect(degraded.framesAttempted).toBeGreaterThanOrEqual(2); // MAIN (via its own node) plus CHILD (via the failure entry).
      expect(degraded.listeners).toBe('failed');
      expect(degraded.listenersReason).toBe('resolve failed');

      // The main frame's own node is unaffected by CHILD's degradation.
      const nodes = reply['nodes'] as Array<Record<string, unknown>>;
      expect(nodes).toHaveLength(1);
      expect(nodes[0]?.['tag']).toBe('button');
    });
  });
});

describe('page.map.get: truncation is never silent, including the unpositioned tier', () => {
  it('reports a byte-ceiling cut across many onscreen candidates alongside a separate, non-budget unpositioned count', async () => {
    await withGateway(async (gw) => {
      // Enough identically-positioned, interactive <button> candidates to
      // exceed MAX_PAGEMAP_RESULT_BYTES (2 * MAX_A11Y_RESULT_BYTES =
      // 524288 bytes) on volume alone: each wire node is roughly 140 bytes
      // encoded, so 4200 of them (~588000 bytes) reliably overflows the
      // ceiling with real nodes surviving on both sides of the cut.
      const POSITIONED_COUNT = 4200;
      const UNPOSITIONED_COUNT = 3;
      const FIRST_ID = 3;
      const positionedIds = Array.from({ length: POSITIONED_COUNT }, (_, i) => FIRST_ID + i);
      const unpositionedIds = Array.from(
        { length: UNPOSITIONED_COUNT },
        (_, i) => FIRST_ID + POSITIONED_COUNT + i,
      );

      const domTree: PageMapRawDomNode = {
        backendNodeId: 1,
        nodeType: 9,
        nodeName: '#document',
        children: [
          {
            backendNodeId: 2,
            nodeType: 1,
            nodeName: 'BODY',
            localName: 'body',
            children: [...positionedIds, ...unpositionedIds].map((id) => ({
              backendNodeId: id,
              nodeType: 1,
              nodeName: 'BUTTON',
              localName: 'button',
            })),
          },
        ],
      };

      // Node position 0 is the document, 1 is body, 2..(POSITIONED_COUNT+1)
      // are the positioned buttons; the UNPOSITIONED ids follow with no
      // matching `layout.nodeIndex` entry at all, which is exactly what
      // makes `budget.ts` count them under `unpositioned` rather than
      // giving them an invented rect.
      const backendNodeIdArray = [1, 2, ...positionedIds, ...unpositionedIds];
      const nodeIndex = positionedIds.map((_, i) => 2 + i);
      const bounds = positionedIds.map(() => [0, 0, 10, 10]);
      const snapshot: PageMapRawSnapshot = {
        documents: [
          {
            nodes: { backendNodeId: backendNodeIdArray },
            layout: { nodeIndex, bounds },
          },
        ],
        strings: [],
      };

      gw.chrome.setPageMapDomTree(domTree);
      gw.chrome.setPageMapSnapshot(snapshot);
      gw.chrome.setPageMapFrameTree({
        frame: { id: 'MAIN', loaderId: 'LOADER_1', url: 'https://a.example/' },
      });

      const { ws, targetId } = await connectViewer(gw, ['view', 'devtools']);
      const reply = await pageMapGet(ws, { targetId });

      expect(reply['t']).toBe('page.map.got');
      expect(reply['total']).toBe(POSITIONED_COUNT); // unpositioned nodes were never candidates; excluded from `total`.
      expect(reply['truncated']).toBe(true);

      const nodes = reply['nodes'] as Array<Record<string, unknown>>;
      expect(nodes.length).toBeLessThan(POSITIONED_COUNT);
      expect(nodes.length).toBeGreaterThan(0); // some survive the byte ceiling; the cut is not total.

      const truncatedByReason = reply['truncatedByReason'] as {
        offscreen: number;
        onscreen: number;
        unpositioned: number;
      };
      // Every positioned candidate sits at the same in-viewport rect, so
      // every drop for want of bytes lands in the 'onscreen' tier, never
      // 'offscreen'.
      expect(truncatedByReason.offscreen).toBe(0);
      expect(truncatedByReason.onscreen).toBe(POSITIONED_COUNT - nodes.length);
      expect(truncatedByReason.onscreen).toBeGreaterThan(0);
      // The third, non-budget tier this build stage added: reported
      // alongside the byte-ceiling counts in the very same reply, not
      // dropped on the way to the wire.
      expect(truncatedByReason.unpositioned).toBe(UNPOSITIONED_COUNT);
    });
  }, 20_000);
});
