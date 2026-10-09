/**
 * The interactivity cascade: for one merged {@link PageMapNodeRecord}, is
 * this something an agent can act on. Ordered rules, one table, early
 * returns. That is the whole module.
 *
 * ── The order is the design ────────────────────────────────────────────
 *
 * {@link isInteractive} is one function, read top to bottom. Disqualifiers
 * run first and short-circuit to `false` before any qualifier gets a
 * chance to fire: an element the accessibility tree marks `disabled`, or
 * one sitting under `pointer-events: none`, is not interactive no matter
 * how many qualifying signals it also carries. Everything after that is a
 * qualifier, in priority order, each one an early return to `true`. There
 * is no second file and no helper that hides part of the order; a reader
 * who wants to know why one node is interactive and a neighbour is not can
 * read this one function start to finish.
 *
 * ── Tristate fields, twice ──────────────────────────────────────────────
 *
 * Two fields on {@link PageMapNodeRecord} are tristate, and getting the
 * third state wrong here would make the whole page map worse than useless
 * on a modern framework site. `axProperties`
 * (`types.ts`, `PageMapNodeRecord.axProperties`) distinguishes "the
 * accessibility tree never reported this property" from "it reported the
 * property as false", so every read below is an explicit `=== true` (or
 * `=== 'mixed'` for the two properties CDP itself reports tristate),
 * never a truthiness check that would treat "absent" and "false" alike.
 * `hasClickListener` (`types.ts`, same interface) is tristate for a
 * different, measured reason: the probe at
 * `examples/nextjs-demo/pagemap-listeners-probe.mjs` found that a React
 * 17+ delegated handler is reported on the CONTAINER, never on the child
 * that looks clickable, so `false` here means only "no listener found
 * directly on this node," not "this node is not clickable." Only `true`
 * is ever treated as evidence.
 *
 * ── What was refused, and why ─────────────────────────────────────────
 *
 * Three rules from browser-use's `dom/serializer/clickable_elements.py` and
 * `serializer.py` are refused by name: a Semantic UI class-name match on `class` containing
 * both `ui` and `dropdown` (`serializer.py:732`), an Ant Design label
 * carve-out (`clickable_elements.py:58`), and a Bootstrap/jQuery/Angular
 * datepicker class-name match (`serializer.py:1246`). None of the three
 * appear here. This module also leaves out that same file's "search
 * indicators" block (`clickable_elements.py:76` through `:103`, matching
 * `class`, `id` and `data-*` values against words like `search`,
 * `magnify` and `lookup`): it is the identical class of rule as the three
 * above, a string match nobody can re-derive or say when to retire,
 * and it is not on the principled list this module was built from. Where
 * browser-use's rule stood for a real, generic signal, that generic
 * signal is here instead: an ARIA role, `aria-haspopup`, a pointer
 * cursor, or the label/span wrapping rule below, which is the
 * framework-independent version of their Ant Design carve-out.
 *
 * ── A user-agent shadow root's contents get no special case ──────────────
 *
 * `dom-tree.ts` now distinguishes a `'user-agent'` shadow host
 * (`types.ts`'s {@link PageMapShadowKind}) from `null`, and still walks
 * into it, so nodes inside a browser-internal root like `<input
 * type=range>`'s thumb/track reach this cascade like any other node. This
 * module adds no ancestry check to suppress or specially qualify them:
 * `isInteractive` runs unchanged on a UA-shadow descendant, judged purely
 * on its own tag/role/style/AX signals the same as anywhere else. Decided,
 * not merely defaulted: the HOST of a UA root is always a native form
 * control already in {@link INTERACTIVE_TAGS} (`input`, in every case this
 * codebase has observed one), so acting on the host is never blocked by
 * this; and this module has no measured basis for assuming a UA-internal
 * part never carries genuine native semantics of its own across every
 * Chrome build this design targets, so suppressing it would be a guess,
 * exactly what this file already avoids elsewhere. If UA-shadow descendants prove noisy in practice
 * (a redundant second candidate for one control), gating them by
 * `shadowKind` ancestry is the natural follow-up; UNMEASURED, not
 * implemented speculatively here.
 *
 * ── Complexity ────────────────────────────────────────────────────────
 *
 * {@link computeInteractivity} is O(N) for N nodes in the capture: one
 * pass over every node to build the label/span wrapper set (each pass
 * touches only `input`/`select`/`textarea` nodes and walks at most two
 * ancestors per one, both O(1) map lookups), then one pass calling
 * {@link isInteractive} once per node. `isInteractive` itself is O(1) per
 * call: every membership test is against a module-level `Set`, nothing is
 * compiled or allocated on the call path except, in the one case a `role`
 * attribute carries more than one space-separated token (rare: ARIA's
 * fallback-role syntax), the short-lived substrings that check produces.
 */

import type { PageMapNodeRecord } from './types.js';

/** DOM's `Node.ELEMENT_NODE`. Only element records carry interactivity of their own. */
const ELEMENT_NODE_TYPE = 1;

/**
 * Tags whose native semantics already ARE interactivity: a browser makes
 * every one of these focusable and activatable with no author code at
 * all. `label` is deliberately absent, matching browser-use's own later
 * correction (`clickable_elements.py:138`, "'label' removed... otherwise
 * labels with a 'for' attribute can destroy the real clickable element");
 * a label is handled on its own below, where the `for`-proxy exception
 * can be applied.
 */
const INTERACTIVE_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'a',
  'details',
  'summary',
  'option',
  'optgroup',
]);

/**
 * ARIA roles, whether written on the `role` attribute or already resolved
 * by the accessibility tree, that name a widget kind that is interactive
 * by definition: a screen reader user could focus and operate each of
 * these, so an agent should be able to as well.
 */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'option',
  'radio',
  'checkbox',
  'tab',
  'textbox',
  'combobox',
  'slider',
  'spinbutton',
  'listbox',
  'search',
  'searchbox',
  'row',
  'cell',
  'gridcell',
]);

/**
 * Inline handler attributes: still common in generated markup, email-style
 * widgets and older hand-rolled components that never moved to
 * `addEventListener`. `tabindex` is checked separately, immediately below
 * where this set is used, because it is a distinct real page shape (an
 * author making a plain element keyboard-reachable) rather than a handler.
 */
const CLICK_HANDLER_ATTRS = new Set([
  'onclick',
  'onmousedown',
  'onmouseup',
  'onkeydown',
  'onkeyup',
]);

/** Tags a form control can be "wrapped by" for the label/span rule below. */
const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea']);

/** Tags that can act as a wrapper: `label > input` and `label > span > input` are both real, framework-independent markup. */
const WRAPPABLE_TAGS = new Set(['label', 'span']);

/**
 * True when `roleAttr` names an interactive role. ARIA allows a
 * space-separated fallback list (`role="tab button"`, the user agent
 * picks the first token it understands), so the whole string is tried as
 * one token first (the overwhelmingly common case, and the one with no
 * allocation at all) before paying to split it.
 */
function hasInteractiveRole(roleAttr: string | undefined): boolean {
  if (roleAttr === undefined) return false;
  if (INTERACTIVE_ROLES.has(roleAttr)) return true;
  if (roleAttr.indexOf(' ') === -1) return false;
  for (const token of roleAttr.split(' ')) {
    if (INTERACTIVE_ROLES.has(token)) return true;
  }
  return false;
}

/**
 * The set of `label`/`span` backend node ids that wrap a form control
 * within two levels (`label > input`, `label > span > input`, and the
 * one-level-shallower case for a bare `span`). Built by walking UP from
 * every form control rather than down from every label, because the node
 * index only carries `parentBackendNodeId`; this makes each control's
 * contribution O(1) (at most two `Map.get` calls) instead of an O(N)
 * children scan per label.
 *
 * `label[for=...]` is excluded here, not just left to fall through: a
 * `<label for="x">` already natively activates `#x` on click, so adding
 * the label to this set as well would hand an agent a second index for
 * the same action, one that would double-activate on a naive replay.
 * Matches browser-use's own exception (`clickable_elements.py:59` through
 * `:62`).
 */
function buildLabelSpanWrapperSet(
  nodes: ReadonlyMap<number, PageMapNodeRecord>,
): ReadonlySet<number> {
  const wrappers = new Set<number>();
  for (const node of nodes.values()) {
    if (!FORM_CONTROL_TAGS.has(node.tag)) continue;
    let ancestorId = node.parentBackendNodeId;
    for (let depth = 0; depth < 2 && ancestorId !== null; depth++) {
      const ancestor = nodes.get(ancestorId);
      if (ancestor === undefined) break;
      if (WRAPPABLE_TAGS.has(ancestor.tag)) {
        const proxiesViaFor =
          ancestor.tag === 'label' && (ancestor.attributes.get('for') ?? '').length > 0;
        if (!proxiesViaFor) wrappers.add(ancestor.backendNodeId);
      }
      ancestorId = ancestor.parentBackendNodeId;
    }
  }
  return wrappers;
}

/**
 * The cascade. One ordered pass, early returns, over one node. See this
 * module's own doc for the full argument behind the order; every branch
 * below carries a one-line comment naming the real page shape it exists
 * to catch.
 *
 * `labelSpanWrappers` is {@link buildLabelSpanWrapperSet}'s output,
 * computed once per capture by {@link computeInteractivity} and passed in
 * here so this function stays O(1) and allocation-free on its own call
 * path.
 */
export function isInteractive(
  node: PageMapNodeRecord,
  labelSpanWrappers: ReadonlySet<number>,
): boolean {
  // Only an element carries interactivity of its own; a text, comment or
  // document record is inert by construction. Matches browser-use's own
  // first check (`clickable_elements.py:28`).
  if (node.nodeType !== ELEMENT_NODE_TYPE) return false;

  // --- Disqualifiers. Nothing below is allowed to override these. ---

  // The accessibility tree marking a node disabled settles it: no tag,
  // role or cursor style overrides an explicit `disabled`. Tristate:
  // only `true` counts, never a bare truthiness check, because "absent"
  // is not "false" on this field.
  if (node.axProperties.get('disabled') === true) return false;

  // Same for AX `hidden`: a node hidden from assistive tech is not on
  // offer to an agent even if a stale style or a leftover handler makes
  // it look actionable.
  if (node.axProperties.get('hidden') === true) return false;

  // `pointer-events: none` catches the "greyed out" pattern: a page
  // disables a control (or a wrapper around it) by turning off pointer
  // events, so a click on it falls through to whatever is behind it.
  if (node.style?.pointerEvents === 'none') return false;

  // `label[for=...]` already natively activates the input it names; see
  // `buildLabelSpanWrapperSet`'s own doc for why this must be a hard
  // disqualifier and not merely "skip the wrapping rule below."
  if (node.tag === 'label' && (node.attributes.get('for') ?? '').length > 0) return false;

  // --- Qualifiers, in priority order. ---

  // ARIA widget-state properties exist only on real interactive widgets:
  // a plain, unstyled `<div>` never carries `aria-checked` or
  // `aria-expanded`. `checked`/`pressed` can also read `'mixed'`
  // (an indeterminate checkbox, a tri-state toggle), which is real
  // evidence of a widget, not an absence.
  const ax = node.axProperties;
  if (ax.get('focusable') === true) return true;
  if (ax.get('editable') === true) return true;
  if (ax.get('settable') === true) return true;
  if (ax.get('checked') === true || ax.get('checked') === 'mixed') return true;
  if (ax.get('expanded') === true) return true;
  if (ax.get('pressed') === true || ax.get('pressed') === 'mixed') return true;
  if (ax.get('selected') === true) return true;
  if (ax.get('required') === true) return true;

  // Tags whose native semantics already are interactivity.
  if (INTERACTIVE_TAGS.has(node.tag)) return true;

  // A form control wrapped by this label or span (`label > input`,
  // `label > span > input`, or a bare `span > input`) is the
  // framework-independent version of a component library's "the wrapper
  // carries the click" pattern, detected structurally rather than by any
  // library's class names.
  if ((node.tag === 'label' || node.tag === 'span') && labelSpanWrappers.has(node.backendNodeId))
    return true;

  // An explicit ARIA role, on the markup or already resolved by the
  // accessibility tree, names a widget kind that is interactive by
  // definition.
  if (hasInteractiveRole(node.attributes.get('role'))) return true;
  if (node.role !== null && INTERACTIVE_ROLES.has(node.role)) return true;

  // Inline handler attributes and an explicit `tabindex` (the standard
  // way to make a plain element keyboard-reachable) are both author
  // signals that this element is meant to be acted on.
  for (const attr of CLICK_HANDLER_ATTRS) {
    if (node.attributes.has(attr)) return true;
  }
  if (node.attributes.has('tabindex')) return true;

  // `cursor: pointer` catches the `div` styled and scripted as a button
  // with none of the markers above. This rule carries more weight than it first looks: on a React 17+
  // page a delegated click handler never shows up as `hasClickListener`
  // on the element itself, so cursor is often the only signal left.
  if (node.style?.cursor === 'pointer') return true;

  // `hasClickListener` is TRISTATE. Only `true` is evidence. `false`
  // proves nothing (the probe in `pagemap-listeners-probe.mjs` found a
  // delegated React handler reported on the container, never the child
  // that looks clickable) and `null` means the signal did not run at
  // all; neither is ever branched on here.
  if (node.hasClickListener === true) return true;

  // A node with its own scrollable extent is something an agent can act
  // on, by scrolling it, even with no click semantics of its own.
  if (node.scrollRect !== null) return true;

  return false;
}

/**
 * Runs {@link isInteractive} once for every node in `nodes`, in whatever
 * order `Map` iteration gives (the cascade has no cross-node dependency
 * beyond the wrapper set below, so order does not affect the result).
 * O(N) total: see this module's own doc, "Complexity".
 */
export function computeInteractivity(
  nodes: ReadonlyMap<number, PageMapNodeRecord>,
): ReadonlyMap<number, boolean> {
  const labelSpanWrappers = buildLabelSpanWrapperSet(nodes);
  const result = new Map<number, boolean>();
  for (const node of nodes.values()) {
    result.set(node.backendNodeId, isInteractive(node, labelSpanWrappers));
  }
  return result;
}
