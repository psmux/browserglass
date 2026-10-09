/**
 * `cdp/accessibility.ts`.
 *
 * Mirrors `hit-test.test.ts`'s own approach: a scripted fake bridge, and
 * assertions on WHICH CDP commands go out (domain enable/disable, exactly
 * once, bracketing the query) as much as on what comes back, because a
 * test that only checked the returned shape would not catch a domain left
 * enabled or a stray `Runtime.*`/`objectId` path sneaking in.
 */

import { describe, expect, it } from 'vitest';
import { queryAccessibilityTree, stampAccessibilityNodes } from '../../src/cdp/accessibility.js';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId } from '../../src/cdp/types.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: CdpSessionId | undefined;
}

/** A `CdpBridge` whose `send` is driven by a per-method handler function, so the same method can answer differently across repeated calls (`DOM.setAttributeValue`, sent once per node). */
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

function axValue(value: unknown): { value: unknown } {
  return { value };
}

function axProp(name: string, value: unknown): { name: string; value: { value: unknown } } {
  return { name, value: axValue(value) };
}

const BUTTON_NODE = {
  ignored: false,
  role: axValue('button'),
  name: axValue('Submit'),
  backendDOMNodeId: 42,
  properties: [axProp('focusable', true), axProp('disabled', false)],
};

const DOC_ROOT_NODE_ID = 1;

/**
 * The three calls every `queryAccessibilityTree` makes regardless of
 * filter: enable, learn the document's own `nodeId` (measured against real
 * Chrome to be REQUIRED even for an unfiltered query, see this module's
 * own doc on `queryAccessibilityTree`), disable. A test overrides
 * `Accessibility.queryAXTree` (and, rarely, one of the other two) to script
 * the one behaviour it cares about.
 */
function axHandlers(
  overrides: Readonly<
    Record<string, (params: Record<string, unknown>, callIndex: number) => unknown>
  >,
): Record<string, (params: Record<string, unknown>, callIndex: number) => unknown> {
  return {
    'Accessibility.enable': () => ({}),
    'DOM.getDocument': () => ({ root: { nodeId: DOC_ROOT_NODE_ID } }),
    'Accessibility.disable': () => ({}),
    ...overrides,
  };
}

describe('queryAccessibilityTree: which CDP commands go out', () => {
  it('enables Accessibility, reads the document root nodeId, queries once, disables Accessibility, and never touches Runtime or any DOM node-mutating command', async () => {
    const { bridge, sent } = fakeBridge(
      axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes: [BUTTON_NODE] }) }),
    );

    await queryAccessibilityTree(bridge, SESSION, { maxNodes: 10, maxResultBytes: 100000 });

    expect(sent.map((s) => s.method)).toEqual([
      'Accessibility.enable',
      'DOM.getDocument',
      'Accessibility.queryAXTree',
      'Accessibility.disable',
    ]);
    expect(sent.every((s) => s.sessionId === SESSION)).toBe(true);
    // `DOM.getDocument` is a read; nothing here ever mutates the page or
    // resolves a live object.
    expect(
      sent.some(
        (s) =>
          s.method.startsWith('Runtime.') ||
          s.method === 'DOM.resolveNode' ||
          s.method === 'DOM.setAttributeValue',
      ),
    ).toBe(false);
  });

  it('always sends the document root nodeId, and passes role through but matches the name itself', async () => {
    const { bridge, sent } = fakeBridge(
      axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes: [] }) }),
    );

    await queryAccessibilityTree(bridge, SESSION, {
      role: 'button',
      name: 'Submit',
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    const call = sent.find((s) => s.method === 'Accessibility.queryAXTree');
    expect(call?.params).toEqual({
      nodeId: DOC_ROOT_NODE_ID,
      role: 'button',
    });
  });

  it('matches the name with whitespace trimmed and collapsed on both sides', async () => {
    const named = (name: string, id: number) => ({
      ...BUTTON_NODE,
      name: axValue(name),
      backendDOMNodeId: id,
    });
    const { bridge } = fakeBridge(
      axHandlers({
        'Accessibility.queryAXTree': () => ({
          // Chrome's real name for the-internet's Login button: icon glyph, space, word.
          nodes: [
            named('\uF090 Login', 1),
            named('Log  in\n', 2),
            named('Logout', 3),
            named('login', 4),
          ],
        }),
      }),
    );
    const one = await queryAccessibilityTree(bridge, SESSION, {
      role: 'button',
      name: 'Login',
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(one.nodes.map((n) => n.backendNodeId)).toEqual([1]);
    const two = await queryAccessibilityTree(bridge, SESSION, {
      role: 'button',
      name: ' Log in ',
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(two.nodes.map((n) => n.backendNodeId)).toEqual([2]);
  });

  it('sends only the document root nodeId, no role/accessibleName, for an unfiltered whole-page query', async () => {
    const { bridge, sent } = fakeBridge(
      axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes: [] }) }),
    );

    await queryAccessibilityTree(bridge, SESSION, { maxNodes: 10, maxResultBytes: 100000 });
    const call = sent.find((s) => s.method === 'Accessibility.queryAXTree');
    expect(call?.params).toEqual({ nodeId: DOC_ROOT_NODE_ID });
  });

  it('addresses the root by backendNodeId when Chrome reports one, since a nodeId can go stale', async () => {
    const { bridge, sent } = fakeBridge(
      axHandlers({
        'DOM.getDocument': () => ({ root: { nodeId: DOC_ROOT_NODE_ID, backendNodeId: 7 } }),
        'Accessibility.queryAXTree': () => ({ nodes: [] }),
      }),
    );
    await queryAccessibilityTree(bridge, SESSION, {
      role: 'searchbox',
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    const call = sent.find((s) => s.method === 'Accessibility.queryAXTree');
    expect(call?.params).toEqual({ backendNodeId: 7, role: 'searchbox' });
  });

  it('re-reads the document and queries once more when the root no longer exists', async () => {
    const { bridge, sent } = fakeBridge(
      axHandlers({
        'Accessibility.queryAXTree': (_p, i) =>
          i === 0 ? new Error('Could not find node with given id') : { nodes: [BUTTON_NODE] },
      }),
    );
    const out = await queryAccessibilityTree(bridge, SESSION, {
      role: 'button',
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(out.nodes).toHaveLength(1);
    expect(sent.filter((s) => s.method === 'DOM.getDocument')).toHaveLength(2);
    expect(sent.filter((s) => s.method === 'Accessibility.queryAXTree')).toHaveLength(2);
  });

  it('still disables Accessibility when queryAXTree itself throws', async () => {
    const { bridge, sent } = fakeBridge(
      axHandlers({ 'Accessibility.queryAXTree': () => new Error('boom') }),
    );

    await expect(
      queryAccessibilityTree(bridge, SESSION, { maxNodes: 10, maxResultBytes: 100000 }),
    ).rejects.toThrow('boom');
    expect(sent.map((s) => s.method)).toEqual([
      'Accessibility.enable',
      'DOM.getDocument',
      'Accessibility.queryAXTree',
      'Accessibility.disable',
    ]);
  });

  it('tolerates Accessibility.disable itself failing, without masking the real result', async () => {
    const { bridge } = fakeBridge(
      axHandlers({
        'Accessibility.queryAXTree': () => ({ nodes: [BUTTON_NODE] }),
        'Accessibility.disable': () => new Error('session already gone'),
      }),
    );

    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(outcome.nodes).toHaveLength(1);
  });
});

describe('queryAccessibilityTree: what it reports', () => {
  it('shapes role, name, and the actionability properties, with an absent property reported as null (not false)', async () => {
    const { bridge } = fakeBridge(
      axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes: [BUTTON_NODE] }) }),
    );

    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(outcome.nodes).toEqual([
      {
        role: 'button',
        name: 'Submit',
        backendNodeId: 42,
        ignored: false,
        focusable: true,
        editable: null,
        settable: null,
        disabled: false,
        hidden: null,
        expanded: null,
        checked: null,
        pressed: null,
        selected: null,
        required: null,
        readonly: null,
        invalid: null,
        level: null,
      },
    ]);
  });

  it('reports the tristate checked/pressed properties, including mixed', async () => {
    const { bridge } = fakeBridge(
      axHandlers({
        'Accessibility.queryAXTree': () => ({
          nodes: [
            {
              ignored: false,
              role: axValue('checkbox'),
              name: axValue('Select all'),
              backendDOMNodeId: 7,
              properties: [axProp('checked', 'mixed')],
            },
          ],
        }),
      }),
    );

    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(outcome.nodes[0]?.checked).toBe('mixed');
  });

  it('filters out ignored nodes entirely, and they do not count toward total', async () => {
    const { bridge } = fakeBridge(
      axHandlers({
        'Accessibility.queryAXTree': () => ({
          nodes: [
            { ...BUTTON_NODE, ignored: true, backendDOMNodeId: 1 },
            { ...BUTTON_NODE, backendDOMNodeId: 2 },
          ],
        }),
      }),
    );

    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(outcome.total).toBe(1);
    expect(outcome.nodes.map((n) => n.backendNodeId)).toEqual([2]);
  });

  it('drops a node with no backendDOMNodeId: neither caller can address it', async () => {
    const { bridge } = fakeBridge(
      axHandlers({
        'Accessibility.queryAXTree': () => ({
          nodes: [{ ignored: false, role: axValue('button'), name: axValue('x'), properties: [] }],
        }),
      }),
    );

    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    expect(outcome.nodes).toEqual([]);
    expect(outcome.total).toBe(0);
  });

  it('bounds by maxNodes and reports truncated honestly, with the real total', async () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      ...BUTTON_NODE,
      backendDOMNodeId: i + 1,
    }));
    const { bridge } = fakeBridge(axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes }) }));

    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 2,
      maxResultBytes: 100000,
    });
    expect(outcome.total).toBe(5);
    expect(outcome.nodes).toHaveLength(2);
    expect(outcome.truncated).toBe(true);
  });

  it('bounds by maxResultBytes, dropping only from the tail, keeping every surviving node fully intact', async () => {
    const nodes = Array.from({ length: 20 }, (_, i) => ({
      ...BUTTON_NODE,
      backendDOMNodeId: i + 1,
      name: axValue('Submit'.repeat(20)),
    }));
    const { bridge } = fakeBridge(axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes }) }));

    // Small enough that not all 20 fit, large enough that at least one does.
    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 50,
      maxResultBytes: 800,
    });
    expect(outcome.total).toBe(20);
    expect(outcome.nodes.length).toBeGreaterThan(0);
    expect(outcome.nodes.length).toBeLessThan(20);
    expect(outcome.truncated).toBe(true);
    // The survivors are the FIRST ones, untouched: dropping is from the
    // tail of the list, never a mid-record truncation.
    expect(outcome.nodes[0]?.backendNodeId).toBe(1);
    for (const n of outcome.nodes) expect(n.name).toBe('Submit'.repeat(20));
  });

  it('is not truncated when everything fits both bounds', async () => {
    const { bridge } = fakeBridge(
      axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes: [BUTTON_NODE] }) }),
    );
    const outcome = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 50,
      maxResultBytes: 100000,
    });
    expect(outcome.truncated).toBe(false);
  });

  it('survives a cross-origin navigation with no rebind step: a fresh session id gets its own fresh enable/getDocument/query/disable sequence', async () => {
    // Nothing here reuses state from a previous call: `queryAccessibilityTree`
    // holds no session-scoped cache the way `evaluate.ts`'s isolated-world
    // cache does, so a caller resolving a NEW session after a renderer swap
    // (`ManagedSession.ensureAttached()`'s own job) needs no special
    // handling from this module at all. See this module's own doc, "domain
    // ownership".
    const SESSION_2 = 'cdpsess_2' as CdpSessionId;
    const { bridge, sent } = fakeBridge(
      axHandlers({ 'Accessibility.queryAXTree': () => ({ nodes: [BUTTON_NODE] }) }),
    );

    const first = await queryAccessibilityTree(bridge, SESSION, {
      maxNodes: 10,
      maxResultBytes: 100000,
    });
    const second = await queryAccessibilityTree(bridge, SESSION_2, {
      maxNodes: 10,
      maxResultBytes: 100000,
    });

    expect(first.nodes).toHaveLength(1);
    expect(second.nodes).toHaveLength(1);
    const bySession = (id: CdpSessionId) =>
      sent.filter((s) => s.sessionId === id).map((s) => s.method);
    expect(bySession(SESSION)).toEqual([
      'Accessibility.enable',
      'DOM.getDocument',
      'Accessibility.queryAXTree',
      'Accessibility.disable',
    ]);
    expect(bySession(SESSION_2)).toEqual([
      'Accessibility.enable',
      'DOM.getDocument',
      'Accessibility.queryAXTree',
      'Accessibility.disable',
    ]);
  });
});

describe('stampAccessibilityNodes: which CDP commands go out', () => {
  it('pushes backend ids to the frontend, then writes the attribute per node, never through Runtime and never resolving a live object', async () => {
    const { bridge, sent } = fakeBridge({
      'DOM.pushNodesByBackendIdsToFrontend': () => ({ nodeIds: [101, 102] }),
      'DOM.setAttributeValue': () => ({}),
    });

    const outcome = await stampAccessibilityNodes(bridge, SESSION, [42, 43], 'data-bgls-ax-abc');

    expect(sent[0]?.method).toBe('DOM.pushNodesByBackendIdsToFrontend');
    expect(sent[0]?.params).toEqual({ backendNodeIds: [42, 43] });
    expect(sent.slice(1).map((s) => s.method)).toEqual([
      'DOM.setAttributeValue',
      'DOM.setAttributeValue',
    ]);
    expect(sent.slice(1).map((s) => s.params)).toEqual([
      { nodeId: 101, name: 'data-bgls-ax-abc', value: '1' },
      { nodeId: 102, name: 'data-bgls-ax-abc', value: '1' },
    ]);
    expect(sent.every((s) => s.sessionId === SESSION)).toBe(true);
    expect(
      sent.some((s) => s.method.startsWith('Runtime.') || s.method === 'DOM.resolveNode'),
    ).toBe(false);
    expect(outcome.stamped).toEqual([true, true]);
  });

  it('reports a node false at its own index, without failing the others, when its own DOM.setAttributeValue fails', async () => {
    const { bridge } = fakeBridge({
      'DOM.pushNodesByBackendIdsToFrontend': () => ({ nodeIds: [101, 102] }),
      'DOM.setAttributeValue': (params) => (params['nodeId'] === 101 ? new Error('node gone') : {}),
    });

    const outcome = await stampAccessibilityNodes(bridge, SESSION, [42, 43], 'data-bgls-ax-abc');
    expect(outcome.stamped).toEqual([false, true]);
  });

  it('reports false for a backend id CDP could not resolve to a nodeId (0), without attempting to stamp it', async () => {
    const { bridge, sent } = fakeBridge({
      'DOM.pushNodesByBackendIdsToFrontend': () => ({ nodeIds: [0, 102] }),
      'DOM.setAttributeValue': () => ({}),
    });

    const outcome = await stampAccessibilityNodes(bridge, SESSION, [42, 43], 'data-bgls-ax-abc');
    expect(outcome.stamped).toEqual([false, true]);
    expect(sent.filter((s) => s.method === 'DOM.setAttributeValue')).toHaveLength(1);
  });

  it('reports every index false, rather than throwing, when the whole batch push fails', async () => {
    const { bridge } = fakeBridge({
      'DOM.pushNodesByBackendIdsToFrontend': () => new Error('document gone'),
    });

    const outcome = await stampAccessibilityNodes(
      bridge,
      SESSION,
      [42, 43, 44],
      'data-bgls-ax-abc',
    );
    expect(outcome.stamped).toEqual([false, false, false]);
  });

  it('sends nothing at all for an empty batch', async () => {
    const { bridge, sent } = fakeBridge({});
    const outcome = await stampAccessibilityNodes(bridge, SESSION, [], 'data-bgls-ax-abc');
    expect(sent).toEqual([]);
    expect(outcome.stamped).toEqual([]);
  });
});
