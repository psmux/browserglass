/**
 * `pagemap/interactivity.ts`. Pure function, no CDP, no fake bridge: every
 * case here is a `PageMapNodeRecord` literal in, a boolean out.
 */

import { describe, expect, it } from 'vitest';
import { computeInteractivity, isInteractive } from '../../src/pagemap/interactivity.js';
import type { PageMapNodeRecord } from '../../src/pagemap/types.js';

/**
 * A minimal, otherwise-inert `PageMapNodeRecord`: an unstyled `div` with no
 * signal of any kind, matching `ax-merge.test.ts`'s own `baseNode` shape.
 * Every test overrides only the fields its case is about.
 */
function baseNode(overrides: Partial<PageMapNodeRecord> = {}): PageMapNodeRecord {
  return {
    backendNodeId: 1,
    parentBackendNodeId: null,
    tag: 'div',
    nodeType: 1,
    nodeValue: null,
    attributes: new Map(),
    shadowKind: null,
    frameId: null,
    rect: null,
    scrollRect: null,
    paintOrder: null,
    style: null,
    role: null,
    name: null,
    axIgnored: false,
    axProperties: new Map(),
    hasClickListener: null,
    ...overrides,
  };
}

const NO_WRAPPERS: ReadonlySet<number> = new Set();

describe('isInteractive: non-element nodes', () => {
  it('a text node is never interactive, whatever else it carries', () => {
    const node = baseNode({
      nodeType: 3,
      tag: '#text',
      style: { ...emptyStyle(), cursor: 'pointer' },
    });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });
});

function emptyStyle() {
  return {
    display: null,
    visibility: null,
    opacity: null,
    overflow: null,
    overflowX: null,
    overflowY: null,
    cursor: null,
    pointerEvents: null,
    position: null,
    backgroundColor: null,
  };
}

describe('isInteractive: disqualifiers beat qualifiers', () => {
  it('AX disabled=true beats a native interactive tag', () => {
    const node = baseNode({ tag: 'button', axProperties: new Map([['disabled', true]]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('AX disabled=false does not disqualify (absent is not the same as false, but false itself is not true either)', () => {
    const node = baseNode({ tag: 'button', axProperties: new Map([['disabled', false]]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('AX hidden=true beats an explicit role', () => {
    const node = baseNode({
      attributes: new Map([['role', 'button']]),
      axProperties: new Map([['hidden', true]]),
    });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('pointer-events: none beats cursor: pointer', () => {
    const node = baseNode({ style: { ...emptyStyle(), cursor: 'pointer', pointerEvents: 'none' } });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('pointer-events: none beats hasClickListener: true', () => {
    const node = baseNode({
      hasClickListener: true,
      style: { ...emptyStyle(), pointerEvents: 'none' },
    });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('label[for] beats even being in the wrapper set', () => {
    const wrappers = new Set([1]);
    const node = baseNode({ tag: 'label', attributes: new Map([['for', 'x']]) });
    expect(isInteractive(node, wrappers)).toBe(false);
  });

  it('label[for=""] (empty value) does not trip the for-proxy exception', () => {
    const wrappers = new Set([1]);
    const node = baseNode({ tag: 'label', attributes: new Map([['for', '']]) });
    expect(isInteractive(node, wrappers)).toBe(true);
  });
});

describe('isInteractive: tristate axProperties, absent is not false', () => {
  it('disabled absent (key never set) does not disqualify', () => {
    const node = baseNode({ tag: 'button' });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('disabled explicitly null (property present but tristate-null) does not disqualify', () => {
    const node = baseNode({ tag: 'button', axProperties: new Map([['disabled', null]]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('focusable=true qualifies a node with no other signal', () => {
    const node = baseNode({ axProperties: new Map([['focusable', true]]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('focusable=false (present but false) does not qualify on its own', () => {
    const node = baseNode({ axProperties: new Map([['focusable', false]]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('focusable absent does not qualify on its own', () => {
    const node = baseNode();
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('checked="mixed" (an indeterminate checkbox) qualifies', () => {
    const node = baseNode({ axProperties: new Map([['checked', 'mixed']]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('checked=true qualifies', () => {
    const node = baseNode({ axProperties: new Map([['checked', true]]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('checked=false does not qualify on its own', () => {
    const node = baseNode({ axProperties: new Map([['checked', false]]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('pressed="mixed" qualifies', () => {
    const node = baseNode({ axProperties: new Map([['pressed', 'mixed']]) });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('expanded=true, selected=true and required=true each qualify alone', () => {
    expect(
      isInteractive(baseNode({ axProperties: new Map([['expanded', true]]) }), NO_WRAPPERS),
    ).toBe(true);
    expect(
      isInteractive(baseNode({ axProperties: new Map([['selected', true]]) }), NO_WRAPPERS),
    ).toBe(true);
    expect(
      isInteractive(baseNode({ axProperties: new Map([['required', true]]) }), NO_WRAPPERS),
    ).toBe(true);
  });
});

describe('isInteractive: hasClickListener is tristate, false proves nothing', () => {
  it('hasClickListener=true qualifies a node with no other signal', () => {
    const node = baseNode({ hasClickListener: true });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('hasClickListener=false does not disqualify or qualify: it is silent, never evidence of "not interactive"', () => {
    const node = baseNode({ hasClickListener: false });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
    // The same node otherwise qualifies on a different, independent signal:
    // hasClickListener: false must never override a real qualifier either.
    const withRole = baseNode({
      hasClickListener: false,
      attributes: new Map([['role', 'button']]),
    });
    expect(isInteractive(withRole, NO_WRAPPERS)).toBe(true);
  });

  it('hasClickListener=null (signal did not run) behaves identically to false: no evidence either way', () => {
    const node = baseNode({ hasClickListener: null });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });
});

describe('isInteractive: tag allowlist', () => {
  it.each([
    'button',
    'input',
    'select',
    'textarea',
    'a',
    'details',
    'summary',
    'option',
    'optgroup',
  ])('<%s> qualifies with no other signal', (tag) => {
    expect(isInteractive(baseNode({ tag }), NO_WRAPPERS)).toBe(true);
  });

  it('a bare label (no wrapped control, no for) does not qualify by tag alone', () => {
    expect(isInteractive(baseNode({ tag: 'label' }), NO_WRAPPERS)).toBe(false);
  });

  it('a bare div does not qualify with no signal at all', () => {
    expect(isInteractive(baseNode({ tag: 'div' }), NO_WRAPPERS)).toBe(false);
  });
});

describe('isInteractive: role attribute and computed AX role', () => {
  it('role="button" on the attribute qualifies', () => {
    expect(
      isInteractive(baseNode({ attributes: new Map([['role', 'button']]) }), NO_WRAPPERS),
    ).toBe(true);
  });

  it('a non-interactive role attribute does not qualify', () => {
    expect(
      isInteractive(baseNode({ attributes: new Map([['role', 'presentation']]) }), NO_WRAPPERS),
    ).toBe(false);
  });

  it('a space-separated ARIA fallback role list qualifies when any token matches', () => {
    expect(
      isInteractive(baseNode({ attributes: new Map([['role', 'nonsense tab']]) }), NO_WRAPPERS),
    ).toBe(true);
  });

  it('computed AX role="link" qualifies even with no role attribute', () => {
    expect(isInteractive(baseNode({ role: 'link' }), NO_WRAPPERS)).toBe(true);
  });

  it('a non-interactive computed AX role does not qualify', () => {
    expect(isInteractive(baseNode({ role: 'generic' }), NO_WRAPPERS)).toBe(false);
  });
});

describe('isInteractive: onclick and friends, and tabindex', () => {
  it.each(['onclick', 'onmousedown', 'onmouseup', 'onkeydown', 'onkeyup'])(
    '%s attribute qualifies',
    (attr) => {
      expect(
        isInteractive(baseNode({ attributes: new Map([[attr, 'doStuff()']]) }), NO_WRAPPERS),
      ).toBe(true);
    },
  );

  it('tabindex qualifies regardless of its value', () => {
    expect(
      isInteractive(baseNode({ attributes: new Map([['tabindex', '-1']]) }), NO_WRAPPERS),
    ).toBe(true);
  });
});

describe('isInteractive: cursor: pointer', () => {
  it('cursor: pointer qualifies a div with no other signal, the div-styled-as-button case', () => {
    const node = baseNode({ style: { ...emptyStyle(), cursor: 'pointer' } });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('cursor: default does not qualify', () => {
    const node = baseNode({ style: { ...emptyStyle(), cursor: 'default' } });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('a null style (snapshot supplied none for this node) does not qualify or crash', () => {
    expect(isInteractive(baseNode({ style: null }), NO_WRAPPERS)).toBe(false);
  });
});

describe('isInteractive: scroll containers', () => {
  it('a non-null scrollRect qualifies a node with no click semantics at all', () => {
    const node = baseNode({ scrollRect: { x: 0, y: 0, width: 200, height: 200 } });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('a null scrollRect does not qualify on its own', () => {
    expect(isInteractive(baseNode({ scrollRect: null }), NO_WRAPPERS)).toBe(false);
  });
});

describe('isInteractive: label/span wrapping a form control', () => {
  it('a label in the wrapper set qualifies', () => {
    const wrappers = new Set([1]);
    expect(isInteractive(baseNode({ tag: 'label', backendNodeId: 1 }), wrappers)).toBe(true);
  });

  it('a span in the wrapper set qualifies', () => {
    const wrappers = new Set([1]);
    expect(isInteractive(baseNode({ tag: 'span', backendNodeId: 1 }), wrappers)).toBe(true);
  });

  it('a div in the wrapper set does not qualify: only label/span are eligible wrapper tags', () => {
    const wrappers = new Set([1]);
    expect(isInteractive(baseNode({ tag: 'div', backendNodeId: 1 }), wrappers)).toBe(false);
  });

  it('a label not in the wrapper set does not qualify by that rule alone', () => {
    expect(isInteractive(baseNode({ tag: 'label', backendNodeId: 1 }), new Set([2]))).toBe(false);
  });
});

describe('computeInteractivity: label > input and label > span > input, built structurally', () => {
  it('marks both the label directly wrapping an input, and the input itself, interactive', () => {
    const label: PageMapNodeRecord = baseNode({
      backendNodeId: 1,
      parentBackendNodeId: null,
      tag: 'label',
    });
    const input: PageMapNodeRecord = baseNode({
      backendNodeId: 2,
      parentBackendNodeId: 1,
      tag: 'input',
    });
    const nodes = new Map([
      [1, label],
      [2, input],
    ]);
    const result = computeInteractivity(nodes);
    expect(result.get(1)).toBe(true);
    expect(result.get(2)).toBe(true);
  });

  it('marks both a label two levels above an input (label > span > input) and the span between them', () => {
    const label: PageMapNodeRecord = baseNode({
      backendNodeId: 1,
      parentBackendNodeId: null,
      tag: 'label',
    });
    const span: PageMapNodeRecord = baseNode({
      backendNodeId: 2,
      parentBackendNodeId: 1,
      tag: 'span',
    });
    const input: PageMapNodeRecord = baseNode({
      backendNodeId: 3,
      parentBackendNodeId: 2,
      tag: 'input',
    });
    const nodes = new Map([
      [1, label],
      [2, span],
      [3, input],
    ]);
    const result = computeInteractivity(nodes);
    expect(result.get(1)).toBe(true); // label, 2 levels up from the input
    expect(result.get(2)).toBe(true); // span, 1 level up
    expect(result.get(3)).toBe(true); // the input itself, via the tag allowlist
  });

  it('does not reach three levels up: a label three levels above an input is not marked a wrapper', () => {
    const label: PageMapNodeRecord = baseNode({
      backendNodeId: 1,
      parentBackendNodeId: null,
      tag: 'label',
    });
    const outer: PageMapNodeRecord = baseNode({
      backendNodeId: 2,
      parentBackendNodeId: 1,
      tag: 'div',
    });
    const inner: PageMapNodeRecord = baseNode({
      backendNodeId: 3,
      parentBackendNodeId: 2,
      tag: 'span',
    });
    const input: PageMapNodeRecord = baseNode({
      backendNodeId: 4,
      parentBackendNodeId: 3,
      tag: 'input',
    });
    const nodes = new Map([
      [1, label],
      [2, outer],
      [3, inner],
      [4, input],
    ]);
    const result = computeInteractivity(nodes);
    expect(result.get(1)).toBe(false);
  });

  it('a label[for] wrapping an input directly is still disqualified by the for-proxy exception', () => {
    const label: PageMapNodeRecord = baseNode({
      backendNodeId: 1,
      parentBackendNodeId: null,
      tag: 'label',
      attributes: new Map([['for', 'x']]),
    });
    const input: PageMapNodeRecord = baseNode({
      backendNodeId: 2,
      parentBackendNodeId: 1,
      tag: 'input',
    });
    const nodes = new Map([
      [1, label],
      [2, input],
    ]);
    const result = computeInteractivity(nodes);
    expect(result.get(1)).toBe(false);
    expect(result.get(2)).toBe(true); // the input is unaffected; it qualifies on its own tag
  });
});

describe('isInteractive: realistic composite nodes', () => {
  it('a React-style clickable div: no listener found directly (delegated to the root), but styled as a button', () => {
    // The common delegated handler shape: `hasClickListener`
    // is false because the handler lives on the delegated root container,
    // not this element, but the cursor rule still catches it.
    const node = baseNode({
      tag: 'div',
      hasClickListener: false,
      style: { ...emptyStyle(), cursor: 'pointer' },
      attributes: new Map([['class', 'card card--clickable']]),
    });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });

  it('a disabled submit button: native tag, but AX disabled wins', () => {
    const node = baseNode({
      tag: 'button',
      attributes: new Map([
        ['type', 'submit'],
        ['disabled', ''],
      ]),
      axProperties: new Map([['disabled', true]]),
      style: { ...emptyStyle(), cursor: 'default' },
    });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('a decorative icon span with a listener elsewhere in the delegation chain and no other signal is not interactive', () => {
    const node = baseNode({
      tag: 'span',
      hasClickListener: null,
      attributes: new Map([['class', 'icon icon--chevron']]),
    });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(false);
  });

  it('a custom combobox: role + aria-expanded, no native tag at all', () => {
    const node = baseNode({
      tag: 'div',
      attributes: new Map([['role', 'combobox']]),
      axProperties: new Map([['expanded', false]]),
    });
    expect(isInteractive(node, NO_WRAPPERS)).toBe(true);
  });
});
