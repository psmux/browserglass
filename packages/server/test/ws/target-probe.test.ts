import { setTier1EncoderFactory } from '@browserglass/core';
/**
 * `target.probe` end to end, over a real socket, through the real
 * handshake, the real `ManagedSession` and a real (fake) Chrome endpoint.
 *
 * These tests assert on WHICH CDP COMMANDS REACHED CHROME, not only on the
 * reply that came back, because that is the whole subject. `probe()` used
 * to answer this message by building an expression string around
 * `document.elementFromPoint` and sending it as a raw `Runtime.evaluate`,
 * on every hover, ungated. A suite that only checked the `target.probed`
 * fields would pass identically before and after that was fixed, and
 * would go on passing if somebody reintroduced it tomorrow.
 *
 * What was actually at stake, measured against a real headless Chrome
 * before the change (the full write-up is `cdp/hit-test.ts`'s module doc in
 * `@browserglass/core`): the evaluate did NOT enable the `Runtime` domain,
 * so it never tripped the domain-enable fingerprint it was reported as
 * tripping. It ran script in the page's OWN world instead, which let a
 * page count every hover with the coordinates by reassigning
 * `Document.prototype.elementFromPoint`, and let it return a detached
 * `<a href="https://attacker.example/paid">` so the probe reported an href
 * the page had chosen. `@browserglass/react`'s `<ContextMenu/>` turns
 * `target.probed.href` into "open link in new tab".
 */
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

/** An anchor laid out at `left:50px;top:60px;width:120px;height:30px`. These are the numbers a real Chrome answered with for exactly that element. */
const ANCHOR_QUAD = [50, 60, 170, 60, 170, 90, 50, 90];

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

const OPEN_SOCKETS: WebSocket[] = [];

/**
 * Starts a gateway with one page target, connects a viewer, runs `fn`, and
 * always tears everything down. `caps` deliberately defaults to `view`
 * ALONE: `target.probe` at the default `detail: 'hover'` requires nothing
 * more (`PROBE_CAPABILITY_RULE`), and pinning that here is what would
 * catch a future change that quietly made hover cost a second capability.
 */
async function withProbe(
  fn: (ctx: { gw: TestGateway; ws: WebSocket; targetId: string }) => Promise<void>,
  caps: string[] = ['view'],
): Promise<void> {
  const gw = await startTestGateway();
  try {
    gw.addTarget({
      targetId: 'T_page',
      type: 'page',
      title: 'Page',
      url: 'https://fake.test/sub/',
      attached: false,
    });
    const token = await gw.issueToken({ caps });
    const ws = gw.connect();
    OPEN_SOCKETS.push(ws);
    await waitOpen(ws);
    ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
    const welcome = await nextMessageSkipping(ws, UNSOLICITED);
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
    await fn({ gw, ws, targetId });
  } finally {
    for (const s of OPEN_SOCKETS.splice(0)) s.close();
    await gw.close();
  }
}

async function probe(
  ws: WebSocket,
  targetId: string,
  x: number,
  y: number,
): Promise<Record<string, unknown>> {
  ws.send(
    JSON.stringify({
      v: 1,
      t: 'target.probe',
      id: `p_${x}_${y}`,
      ts: Date.now(),
      targetId,
      x,
      y,
      fw: 1440,
      fh: 900,
    }),
  );
  return await nextMessageSkipping(ws, UNSOLICITED);
}

describe('target.probe: what it sends to Chrome', () => {
  it('never sends Runtime.evaluate, at any point, for any hover', async () => {
    // The regression. `target.probe` is what fires when a person moves the
    // mouse over a streamed pane, so this is the path a HUMAN uses most,
    // and putting the server's script into the page's own world on it is
    // both observable to the page and answerable by the page.
    await withProbe(async ({ gw, ws, targetId }) => {
      gw.chrome.setHitTestNode({
        localName: 'a',
        attributes: ['id', 'signin', 'class', 'btn primary', 'href', 'dest?x=1'],
        content: ANCHOR_QUAD,
      });

      const reply = await probe(ws, targetId, 60, 70);

      expect(reply['t']).toBe('target.probed');
      expect(reply['hit']).toBe(true);
      expect(gw.chrome.runtimeEvaluateCalls).toEqual([]);
      expect(gw.chrome.cdpCalls.some((c) => c.method.startsWith('Runtime.'))).toBe(false);
    });
  });

  it('hit-tests with the DOM domain, on the page session, addressing the node by backendNodeId', async () => {
    await withProbe(async ({ gw, ws, targetId }) => {
      gw.chrome.setHitTestNode({
        localName: 'a',
        attributes: ['id', 'signin', 'class', 'btn primary', 'href', 'dest?x=1'],
        content: ANCHOR_QUAD,
      });
      await probe(ws, targetId, 60, 70);

      const dom = gw.chrome.cdpCalls.filter((c) => c.method.startsWith('DOM.'));
      expect(dom.map((c) => c.method)).toEqual([
        'DOM.getNodeForLocation',
        'DOM.describeNode',
        'DOM.getBoxModel',
        'DOM.getDocument',
      ]);
      expect(dom[0]?.params).toEqual({ x: 60, y: 70, includeUserAgentShadowDOM: false });
      expect(dom[1]?.params).toEqual({ backendNodeId: 9 });
      // Every command carries a page session id, so none of them can fall
      // through to the browser-level target.
      expect(dom.every((c) => typeof c.sessionId === 'string' && c.sessionId.length > 0)).toBe(
        true,
      );
    });
  });

  it('costs three round trips, not four, when the hover is not over a link', async () => {
    await withProbe(async ({ gw, ws, targetId }) => {
      gw.chrome.setHitTestNode({
        localName: 'div',
        attributes: ['class', 'row'],
        content: [0, 0, 100, 0, 100, 40, 0, 40],
      });
      await probe(ws, targetId, 10, 10);

      expect(
        gw.chrome.cdpCalls.filter((c) => c.method.startsWith('DOM.')).map((c) => c.method),
      ).toEqual(['DOM.getNodeForLocation', 'DOM.describeNode', 'DOM.getBoxModel']);
    });
  });
});

describe('target.probe: what it answers', () => {
  it('reports the tag, the tag#id.class label, the rect and the absolutised href', async () => {
    await withProbe(async ({ gw, ws, targetId }) => {
      gw.chrome.setHitTestNode({
        localName: 'a',
        attributes: ['id', 'signin', 'class', 'btn primary', 'href', 'dest?x=1'],
        content: ANCHOR_QUAD,
      });

      const reply = await probe(ws, targetId, 60, 70);

      expect(reply['hit']).toBe(true);
      expect(reply['tagName']).toBe('a');
      // No `aria-label` on this element, so the label is the
      // `'tag#id.class.class'` form `TargetProbed.label` is specified as
      // in `@browserglass/protocol`. The evaluate path sent the element's
      // text here, which was never what the wire contract said.
      expect(reply['label']).toBe('a#signin.btn.primary');
      // The box model content quad, converted to the viewport CSS px rect
      // the wire specifies. Verified against a real Chrome to agree with
      // `getBoundingClientRect` for the same element.
      expect(reply['rect']).toEqual({ x: 50, y: 60, w: 120, h: 30 });
      // Resolved against the document base URL, as
      // `HTMLAnchorElement.href` used to do.
      expect(reply['href']).toBe('https://fake.test/sub/dest?x=1');
    });
  });

  it('still publishes a page state written into aria-label', async () => {
    // The shape the conformance suite's collaboration fixture uses: it
    // republishes its whole state into `aria-label` every 80ms and reads
    // it back through `target.probed.label`. The evaluate path preferred
    // `aria-label` over the element's text, and so does this one, so that
    // read keeps working across the reimplementation.
    await withProbe(async ({ gw, ws, targetId }) => {
      gw.chrome.setHitTestNode({
        localName: 'div',
        attributes: ['id', 'state', 'aria-label', 'C:w=1440;b=0;k=;v=;d=;sel=0'],
        content: [0, 450, 1440, 450, 1440, 855, 0, 855],
      });
      const reply = await probe(ws, targetId, 720, 675);

      expect(reply['hit']).toBe(true);
      expect(reply['label']).toBe('C:w=1440;b=0;k=;v=;d=;sel=0');
    });
  });

  it('reports hit: false for a point with nothing under it', async () => {
    // Real Chrome answers `-32000 "No node found at given location"` here,
    // an error rather than an empty result, so this is the case that turns
    // a hover past the bottom of the page into an unhandled rejection if
    // it is not caught.
    await withProbe(async ({ gw, ws, targetId }) => {
      gw.chrome.setHitTestNode(null);
      const reply = await probe(ws, targetId, 60, 5000);

      expect(reply['t']).toBe('target.probed');
      expect(reply['hit']).toBe(false);
      expect(reply['rect']).toBeUndefined();
      expect(gw.chrome.runtimeEvaluateCalls).toEqual([]);
    });
  });

  it('reports the element with no rect when Chrome refuses a box model', async () => {
    // `display: none`. The evaluate path answered `0,0,0,0`, which a
    // viewer draws as a highlight of nothing at the top left corner.
    await withProbe(async ({ gw, ws, targetId }) => {
      gw.chrome.setHitTestNode({ localName: 'span', attributes: ['class', 'hidden'] });
      const reply = await probe(ws, targetId, 60, 70);

      expect(reply['hit']).toBe(true);
      expect(reply['tagName']).toBe('span');
      expect(reply['rect']).toBeUndefined();
    });
  });

  it('answers a hover for a viewer holding only view, with no evaluate capability anywhere', async () => {
    // The fix must not have quietly moved hover probing behind a
    // capability. `evaluate` is off by default and is in no role bundle,
    // so gating this path on it would have broken hover for every viewer
    // that exists.
    await withProbe(
      async ({ gw, ws, targetId }) => {
        gw.chrome.setHitTestNode({
          localName: 'button',
          attributes: ['id', 'go'],
          content: [1, 2, 11, 2, 11, 12, 1, 12],
        });
        const reply = await probe(ws, targetId, 5, 5);

        expect(reply['t']).toBe('target.probed');
        expect(reply['hit']).toBe(true);
        expect(reply['label']).toBe('button#go');
      },
      ['view'],
    );
  });
});
