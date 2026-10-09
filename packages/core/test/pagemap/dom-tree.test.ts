/**
 * `pagemap/dom-tree.ts`.
 *
 * A scripted fake bridge, in the style of `test/cdp/hit-test.test.ts` and
 * `test/pagemap/listeners.test.ts`: assertions on WHICH CDP command goes
 * out (method, params, session, explicit `timeoutMs`), and on the shape of
 * the resulting index, including the two properties this module's own doc
 * calls out as load-bearing for a sibling module that already depends on
 * them: every document root (not only the call's own) gets
 * `parentBackendNodeId: null`, and `nodes` is built in document order.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { buildDomTree } from '../../src/pagemap/dom-tree.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown> | undefined;
  readonly sessionId: CdpSessionId | undefined;
  readonly opts: unknown;
}

/** A `CdpBridge` that records every `send` (including its options) and answers `'DOM.getDocument'` with `root`. An `Error` value is thrown, matching how a CDP protocol error reaches a caller. */
function fakeBridge(root: unknown): { bridge: CdpBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const bridge = {
    async send(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: CdpSessionId,
      opts?: unknown,
    ): Promise<unknown> {
      sent.push({ method, params, sessionId, opts });
      if (method !== 'DOM.getDocument') throw new Error(`unexpected CDP method ${method}`);
      if (root instanceof Error) throw root;
      return { root };
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

const SESSION = 'cdpsess_1' as CdpSessionId;

describe('buildDomTree: the CDP call', () => {
  it('sends DOM.getDocument with depth:-1, pierce:true, on the given session, with an explicit timeoutMs override', async () => {
    const { bridge, sent } = fakeBridge({ backendNodeId: 1, nodeType: 9, nodeName: '#document' });

    await buildDomTree(bridge, SESSION, 7000);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('DOM.getDocument');
    expect(sent[0]?.params).toEqual({ depth: -1, pierce: true });
    expect(sent[0]?.sessionId).toBe(SESSION);
    expect(sent[0]?.opts).toEqual({ timeoutMs: 7000 });
  });

  it('throws when the reply carries no root', async () => {
    const noRootBridge = {
      async send(): Promise<unknown> {
        return {};
      },
    } as unknown as CdpBridge;
    await expect(buildDomTree(noRootBridge, SESSION, 1000)).rejects.toThrow(/no root node/);
  });

  it('propagates a CDP failure rather than swallowing it', async () => {
    const err = new Error('E_CDP_TIMEOUT');
    const { bridge } = fakeBridge(err);
    await expect(buildDomTree(bridge, SESSION, 1000)).rejects.toThrow('E_CDP_TIMEOUT');
  });
});

describe('buildDomTree: basic shape', () => {
  it('indexes a flat element with attributes, lowercased tag, and a null parent at the root', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'BUTTON',
          localName: 'button',
          attributes: ['id', 'submit', 'class', 'btn primary'],
        },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);

    expect(result.rootBackendNodeId).toBe(1);
    const root = result.nodes.get(1);
    expect(root?.parentBackendNodeId).toBeNull();
    expect(root?.tag).toBe('#document');

    const button = result.nodes.get(2);
    expect(button?.tag).toBe('button');
    expect(button?.parentBackendNodeId).toBe(1);
    expect(button?.nodeType).toBe(1);
    expect(Object.fromEntries(button?.attributes ?? new Map())).toEqual({
      id: 'submit',
      class: 'btn primary',
    });
    expect(button?.frameId).toBeNull();
    expect(button?.shadowKind).toBeNull();
  });

  it('falls back from an absent localName to the (uppercase) nodeName for non-element nodes, lowercased', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [{ backendNodeId: 2, nodeType: 8, nodeName: '#comment' }],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);
    expect(result.nodes.get(2)?.tag).toBe('#comment');
  });

  it("carries a text node's own character data in nodeValue, and null for every other node", async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'P',
          localName: 'p',
          children: [
            { backendNodeId: 3, nodeType: 3, nodeName: '#text', nodeValue: 'hello world' },
          ],
        },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);
    expect(result.nodes.get(3)?.nodeValue).toBe('hello world');
    expect(result.nodes.get(2)?.nodeValue).toBeNull();
    expect(result.nodes.get(1)?.nodeValue).toBeNull();
  });

  it('walks nodes in document order: siblings appear in the map in left-to-right order, not reversed', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        { backendNodeId: 2, nodeType: 1, nodeName: 'DIV', localName: 'div' },
        { backendNodeId: 3, nodeType: 1, nodeName: 'DIV', localName: 'div' },
        { backendNodeId: 4, nodeType: 1, nodeName: 'DIV', localName: 'div' },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);
    expect(Array.from(result.nodes.keys())).toEqual([1, 2, 3, 4]);
  });

  it("visits a node's own children before a later sibling's subtree (pre-order, not breadth-first)", async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'DIV',
          localName: 'div',
          children: [{ backendNodeId: 3, nodeType: 1, nodeName: 'SPAN', localName: 'span' }],
        },
        { backendNodeId: 4, nodeType: 1, nodeName: 'DIV', localName: 'div' },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);
    expect(Array.from(result.nodes.keys())).toEqual([1, 2, 3, 4]);
  });
});

describe('buildDomTree: shadow roots', () => {
  it('records shadowKind "open" on the host, links the shadow root and its content to the host, in the same session and frame', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'MY-WIDGET',
          localName: 'my-widget',
          shadowRoots: [
            {
              backendNodeId: 3,
              nodeType: 11,
              nodeName: '#document-fragment',
              shadowRootType: 'open',
              children: [
                { backendNodeId: 4, nodeType: 1, nodeName: 'BUTTON', localName: 'button' },
              ],
            },
          ],
        },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);

    const host = result.nodes.get(2);
    expect(host?.shadowKind).toBe('open');

    const shadowRoot = result.nodes.get(3);
    expect(shadowRoot?.parentBackendNodeId).toBe(2);
    expect(shadowRoot?.tag).toBe('#document-fragment');

    const inner = result.nodes.get(4);
    expect(inner?.parentBackendNodeId).toBe(3);
    expect(inner?.frameId).toBeNull();
  });

  it('records shadowKind "closed" for a closed shadow root', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'MY-WIDGET',
          localName: 'my-widget',
          shadowRoots: [
            {
              backendNodeId: 3,
              nodeType: 11,
              nodeName: '#document-fragment',
              shadowRootType: 'closed',
            },
          ],
        },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);
    expect(result.nodes.get(2)?.shadowKind).toBe('closed');
  });

  it('descends into a user-agent shadow root and records shadowKind "user-agent" on the host, distinct from both "open"/"closed" and from having no shadow root at all', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'INPUT',
          localName: 'input',
          shadowRoots: [
            {
              backendNodeId: 3,
              nodeType: 11,
              nodeName: '#document-fragment',
              shadowRootType: 'user-agent',
              children: [{ backendNodeId: 4, nodeType: 1, nodeName: 'DIV', localName: 'div' }],
            },
          ],
        },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);
    expect(result.nodes.get(2)?.shadowKind).toBe('user-agent');
    expect(result.nodes.get(4)?.parentBackendNodeId).toBe(3);
  });
});

describe('buildDomTree: same-process iframes', () => {
  it('gives the contentDocument its own root (parentBackendNodeId null, not linked to the owner), and stamps frameId on the child document but not on the owner element', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'IFRAME',
          localName: 'iframe',
          frameId: 'CHILD_FRAME_1',
          contentDocument: {
            backendNodeId: 3,
            nodeType: 9,
            nodeName: '#document',
            children: [{ backendNodeId: 4, nodeType: 1, nodeName: 'H1', localName: 'h1' }],
          },
        },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);

    const owner = result.nodes.get(2);
    expect(owner?.frameId).toBeNull(); // the owner element itself lives in the TOP document

    const childRoot = result.nodes.get(3);
    expect(childRoot?.parentBackendNodeId).toBeNull(); // a fresh root, not linked to the owner
    expect(childRoot?.frameId).toBe('CHILD_FRAME_1');

    const grandchild = result.nodes.get(4);
    expect(grandchild?.parentBackendNodeId).toBe(3);
    expect(grandchild?.frameId).toBe('CHILD_FRAME_1'); // inherits the ambient child-frame context
  });

  it('propagates the ambient frameId through a nested contentDocument two levels deep', async () => {
    const { bridge } = fakeBridge({
      backendNodeId: 1,
      nodeType: 9,
      nodeName: '#document',
      children: [
        {
          backendNodeId: 2,
          nodeType: 1,
          nodeName: 'IFRAME',
          localName: 'iframe',
          frameId: 'CHILD_FRAME_1',
          contentDocument: {
            backendNodeId: 3,
            nodeType: 9,
            nodeName: '#document',
            children: [
              {
                backendNodeId: 4,
                nodeType: 1,
                nodeName: 'IFRAME',
                localName: 'iframe',
                frameId: 'GRANDCHILD_FRAME_1',
                contentDocument: {
                  backendNodeId: 5,
                  nodeType: 9,
                  nodeName: '#document',
                  children: [{ backendNodeId: 6, nodeType: 1, nodeName: 'P', localName: 'p' }],
                },
              },
            ],
          },
        },
      ],
    });

    const result = await buildDomTree(bridge, SESSION, 1000);
    expect(result.nodes.get(4)?.frameId).toBe('CHILD_FRAME_1'); // the second iframe's OWN element still lives in frame 1
    expect(result.nodes.get(5)?.frameId).toBe('GRANDCHILD_FRAME_1');
    expect(result.nodes.get(6)?.frameId).toBe('GRANDCHILD_FRAME_1');
  });
});
