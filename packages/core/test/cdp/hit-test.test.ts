/**
 * `cdp/hit-test.ts`.
 *
 * The point of this module is WHICH CDP COMMANDS GO OUT, so that is what
 * most of these assert on. A test that only checked the returned shape
 * would pass just as happily against the `Runtime.evaluate` implementation
 * this replaced, which is exactly the regression that has to stay caught.
 *
 * A scripted fake bridge rather than a real Chrome, in the style of
 * `file-input.test.ts`: the replies below are transcribed from a real
 * headless Chrome (an anchor at `left:50px;top:60px;width:120px;height:30px`
 * really does answer with the quad `[50,60,170,60,170,90,50,90]`, and
 * `DOM.getNodeForLocation` over empty space really does answer with the
 * protocol error `-32000 "No node found at given location"` rather than an
 * empty result).
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import { hitTestAtPoint } from '../../src/cdp/hit-test.js';
import type { CdpSessionId } from '../../src/cdp/types.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: CdpSessionId | undefined;
}

/** A `CdpBridge` that records every `send` and answers from `replies`. An `Error` value is thrown, which is how a CDP protocol error reaches a caller. */
function fakeBridge(replies: Readonly<Record<string, unknown>>): {
  bridge: CdpBridge;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const bridge = {
    async send(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: CdpSessionId,
    ): Promise<unknown> {
      sent.push({ method, params: params ?? {}, sessionId });
      if (!(method in replies)) throw new Error(`unexpected CDP method ${method}`);
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

const SESSION = 'cdpsess_1' as CdpSessionId;
const MAIN_FRAME = 'FRAME_MAIN';

const ANCHOR_QUAD = [50, 60, 170, 60, 170, 90, 50, 90];

function anchorPage(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    'DOM.getNodeForLocation': { backendNodeId: 9, frameId: MAIN_FRAME },
    'DOM.describeNode': {
      node: {
        nodeType: 1,
        nodeName: 'A',
        localName: 'a',
        attributes: ['id', 'signin', 'class', 'btn primary', 'href', 'dest?x=1'],
      },
    },
    'DOM.getBoxModel': { model: { content: ANCHOR_QUAD, width: 120, height: 30 } },
    'DOM.getDocument': {
      root: {
        nodeId: 1,
        baseURL: 'https://example.test/sub/',
        documentURL: 'https://example.test/',
        children: [
          { nodeType: 10, nodeName: 'html' },
          { nodeType: 1, nodeName: 'HTML', frameId: MAIN_FRAME },
        ],
      },
    },
    ...overrides,
  };
}

describe('hitTestAtPoint: which CDP commands go out', () => {
  it('never touches the Runtime domain', async () => {
    // The regression this module exists for. `ManagedSession.probe()` sent
    // a raw `Runtime.evaluate` built around `document.elementFromPoint` on
    // EVERY hover, which put a script of the server's choosing into the
    // page's own world on the path a human uses most. Nothing here may
    // execute script, at any detail level, for any element.
    const { bridge, sent } = fakeBridge(anchorPage());
    await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });

    expect(sent.some((s) => s.method.startsWith('Runtime.'))).toBe(false);
    expect(sent.every((s) => s.method.startsWith('DOM.'))).toBe(true);
  });

  it('hit-tests with DOM.getNodeForLocation and addresses the node by backendNodeId throughout', async () => {
    const { bridge, sent } = fakeBridge(anchorPage());
    await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });

    expect(sent.map((s) => s.method)).toEqual([
      'DOM.getNodeForLocation',
      'DOM.describeNode',
      'DOM.getBoxModel',
      'DOM.getDocument',
    ]);
    expect(sent[0]?.params).toEqual({ x: 60, y: 70, includeUserAgentShadowDOM: false });
    // `nodeId` comes back from `DOM.getNodeForLocation` only for a node
    // already pushed to the frontend, so it is never what the follow-up
    // calls address.
    expect(sent[1]?.params).toEqual({ backendNodeId: 9 });
    expect(sent[2]?.params).toEqual({ backendNodeId: 9 });
    // Every command carries the page session id, so none can fall through
    // to the browser-level target.
    expect(sent.every((s) => s.sessionId === SESSION)).toBe(true);
  });

  it('does not fetch the document at all when the hit element is not a link', async () => {
    // The common case by far, and the one that has to stay cheap: three
    // round trips, not four.
    const { bridge, sent } = fakeBridge(
      anchorPage({
        'DOM.describeNode': {
          node: {
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            attributes: ['class', 'row  wide'],
          },
        },
      }),
    );
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });

    expect(sent.map((s) => s.method)).toEqual([
      'DOM.getNodeForLocation',
      'DOM.describeNode',
      'DOM.getBoxModel',
    ]);
    expect(hit?.href).toBeNull();
  });
});

describe('hitTestAtPoint: what it reports', () => {
  it('reports the tag, the tag#id.class label and the box model rect', async () => {
    const { bridge } = fakeBridge(anchorPage());
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });

    expect(hit).toEqual({
      tagName: 'a',
      // No `aria-label` on this element, so the label falls back to the
      // `'tag#id.class.class'` form `TargetProbed.label` has always been
      // specified as.
      label: 'a#signin.btn.primary',
      rect: { x: 50, y: 60, w: 120, h: 30 },
      href: 'https://example.test/sub/dest?x=1',
    });
  });

  it('prefers a non-empty aria-label over the selector form, as the evaluate path did', async () => {
    // Not cosmetic. The conformance suite's collaboration fixture
    // publishes its entire state into `aria-label` and reads it back out
    // of `target.probed.label`, so this precedence is load bearing, and it
    // costs nothing: `aria-label` arrives in `DOM.describeNode`'s
    // attributes with everything else.
    const { bridge } = fakeBridge(
      anchorPage({
        'DOM.describeNode': {
          node: {
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            attributes: ['id', 'state', 'aria-label', 'C:w=1440;b=0;k=;v=;d=;sel=0'],
          },
        },
      }),
    );
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });
    expect(hit?.label).toBe('C:w=1440;b=0;k=;v=;d=;sel=0');
  });

  it('falls back to the selector form for an empty aria-label', async () => {
    const { bridge } = fakeBridge(
      anchorPage({
        'DOM.describeNode': {
          node: {
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            attributes: ['id', 'x', 'aria-label', ''],
          },
        },
      }),
    );
    expect((await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 }))?.label).toBe('div#x');
  });

  it('resolves a relative href against the document base URL, including a <base href>', async () => {
    const { bridge } = fakeBridge(anchorPage());
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });
    // `<base href="/sub/">` is why this is `/sub/dest`, not `/dest`.
    // `HTMLAnchorElement.href` honoured it, so this has to as well.
    expect(hit?.href).toBe('https://example.test/sub/dest?x=1');
  });

  it('drops a relative href on a node inside a subframe rather than resolving it against the wrong base', async () => {
    // `DOM.getNodeForLocation` descends into same-process iframes, which
    // `document.elementFromPoint` never did. The subframe's own base URL
    // has not been read, and `href` feeds a context menu that offers to
    // open it, so a guess here is a link to somewhere the page did not
    // point at.
    const { bridge } = fakeBridge(
      anchorPage({ 'DOM.getNodeForLocation': { backendNodeId: 22, frameId: 'FRAME_CHILD' } }),
    );
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 100, y: 320 });

    expect(hit?.tagName).toBe('a');
    expect(hit?.href).toBeNull();
  });

  it('still reports an already-absolute href from inside a subframe', async () => {
    const { bridge } = fakeBridge(
      anchorPage({
        'DOM.getNodeForLocation': { backendNodeId: 22, frameId: 'FRAME_CHILD' },
        'DOM.describeNode': {
          node: {
            nodeType: 1,
            nodeName: 'A',
            localName: 'a',
            attributes: ['href', 'https://other.test/x'],
          },
        },
      }),
    );
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 100, y: 320 });
    expect(hit?.href).toBe('https://other.test/x');
  });

  it('reports the element with no rect when Chrome refuses a box model', async () => {
    // Real reply for `display: none`: `-32000 "Could not compute box
    // model."`. The evaluate path reported `0,0,0,0` here, which a viewer
    // draws as a highlight of nothing in the corner of the page.
    const { bridge, sent } = fakeBridge(
      anchorPage({ 'DOM.getBoxModel': new Error('Could not compute box model.') }),
    );
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });

    expect(hit?.rect).toBeNull();
    expect(hit?.tagName).toBe('a');
    // The refusal must not abort the rest of the sequence.
    expect(sent.map((s) => s.method)).toContain('DOM.getDocument');
  });

  it('reports no hit when there is no node under the point', async () => {
    const { bridge, sent } = fakeBridge({
      'DOM.getNodeForLocation': new Error('No node found at given location'),
    });
    expect(await hitTestAtPoint(bridge, SESSION, { x: 60, y: 5000 })).toBeNull();
    // Nothing further is attempted for a point that hit nothing.
    expect(sent.map((s) => s.method)).toEqual(['DOM.getNodeForLocation']);
  });

  it('caps the label at 80 bytes without splitting a code point', async () => {
    const { bridge } = fakeBridge(
      anchorPage({
        'DOM.describeNode': {
          node: {
            nodeType: 1,
            nodeName: 'DIV',
            localName: 'div',
            // Four-byte code points, so a naive slice on the byte length
            // would leave a lone surrogate on the wire.
            attributes: ['class', '\u{1F600}'.repeat(40)],
          },
        },
      }),
    );
    const hit = await hitTestAtPoint(bridge, SESSION, { x: 60, y: 70 });
    const label = hit?.label ?? '';

    expect(new TextEncoder().encode(label).length).toBeLessThanOrEqual(80);
    expect(label.startsWith('div.\u{1F600}')).toBe(true);
    expect(
      [...label].every(
        (ch) => ch === 'd' || ch === 'i' || ch === 'v' || ch === '.' || ch === '\u{1F600}',
      ),
    ).toBe(true);
  });
});
