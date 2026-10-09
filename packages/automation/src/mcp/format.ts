import { PAGE_MAP_ATTRIBUTES } from '@browserglass/protocol';
import { AutomationError } from '../errors.js';
import type { PageMapNode, PageMapResult, PageMapTextBlock } from '../types.js';

/**
 * The subset of the MCP SDK's `CallToolResult` this module produces:
 * one text content block, plus `isError` on a failure. Kept as a local,
 * minimal, structural type rather than importing the SDK's own (Zod
 * inferred) `CallToolResult`, so this formatting module has no dependency
 * on the SDK at all; `mcp/server.ts` is the only file in this package that
 * touches `@modelcontextprotocol/sdk` directly.
 */
export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/**
 * Builds one MCP tool result in the standard shape:
 * plain text first (what happened, in a sentence), then a `--- bgls ---`
 * fenced JSON trailer carrying `ok`, `action`, `durationMs`, and
 * action-specific fields.
 */
export function formatToolResult(
  summary: string,
  trailer: { ok: boolean; action: string; durationMs: number; [key: string]: unknown },
): McpToolResult {
  const json = JSON.stringify(trailer, null, 2);
  const text = `${summary}\n\n--- bgls ---\n\`\`\`json\n${json}\n\`\`\``;
  return { content: [{ type: 'text', text }], isError: !trailer.ok };
}

/**
 * Builds an error tool result. Every error's trailer carries a `hint` line
 * suggesting the next action: an `AutomationError` uses its own
 * `code`/`message`/`details` (a `NOT_IMPLEMENTED` error's own message
 * already names what it needs, so it doubles as the hint); anything else is
 * wrapped as `PROTOCOL_ERROR`.
 */
export function formatToolError(action: string, startedAt: number, err: unknown): McpToolResult {
  const durationMs = Date.now() - startedAt;
  const automationErr =
    err instanceof AutomationError
      ? err
      : new AutomationError('PROTOCOL_ERROR', err instanceof Error ? err.message : String(err));
  const hint = hintFor(automationErr);
  const summary = `${action} failed: ${automationErr.message}`;
  return formatToolResult(summary, {
    ok: false,
    action,
    durationMs,
    code: automationErr.code,
    message: automationErr.message,
    hint,
    ...(automationErr.details !== undefined ? { details: automationErr.details } : {}),
  });
}

/** One human-actionable next step per {@link AutomationErrorCode}, shown in every error trailer. */
function hintFor(err: AutomationError): string {
  switch (err.code) {
    case 'LEASE_NOT_HELD':
      return 'Call bg_control with action "acquire" first.';
    case 'LEASE_REVOKED':
      // Split three ways because the right next move genuinely differs,
      // and the old single hint asserted "a human took control back" for
      // every revocation, including an expired lease and a colleague agent
      // outranking this one. An agent told a person is present when none
      // is will abandon work it should have retried; told to retry when a
      // person IS present, it fights them for the pointer. The
      // `details.human` flag that decides this is derived in
      // `AutomationCore` from the wire reason AND the presence roster, so
      // it stays right on a gateway that has not shipped the honest
      // `human_takeover` reason yet.
      if (err.details?.['human'] === true) {
        return `A person${typeof err.details['byLabel'] === 'string' && err.details['byLabel'] !== '' ? ` (${String(err.details['byLabel'])})` : ''} has taken this browser over and this agent has stood down. Do NOT retry and do NOT acquire control. Tell the user what you were doing and stop.`;
      }
      if (err.details?.['yielded'] === true) {
        return 'This agent stood down on this browser; input is refused until control is granted again. Call bg_control with action "yield_status" to see who has it and when control may be requested again.';
      }
      return 'The control lease ended. Re-check bg_status before trying again; do not retry the same action automatically.';
    case 'NOT_IMPLEMENTED':
      return err.message;
    case 'OCCLUDED':
      return 'Try pressing Escape, or click the covering element instead.';
    case 'TARGET_CLOSED':
    case 'INSTANCE_GONE':
      return 'Call bg_status to confirm the current target list before retrying.';
    case 'TIMEOUT':
      return 'The gateway did not reply in time. Retry once, then check bg_status.';
    case 'BUDGET_EXHAUSTED':
      return 'This run has used its allotted actions; a new run is needed.';
    case 'POLICY_DENIED':
      return 'The token or the current policy does not allow this action.';
    default:
      return 'Check bg_status for the current page state before retrying.';
  }
}

// ==================================================================
// The page map's own rendering. Read this module's doc above first:
// plain text, then a JSON trailer. Everything below decides what goes in
// the plain text half for `bg_page_map`, and it is a DIFFERENT shape from
// every other tool in this file.
//
// Every other formatter here puts the real payload in the JSON trailer
// (`summarizeMatch()` for `bg_resolve`, the raw reply for `bg_evaluate`)
// and uses the plain-text summary only as a one-line caption. A page map
// reverses that, on purpose: `nodes` can be hundreds of records, this is
// the one reply in the whole manifest sized against its own byte cap
// (`MAX_PAGEMAP_RESULT_BYTES`, double `page.a11y.get`'s own), and every
// field name repeated as a JSON object key is tokens spent saying "role"
// and "occluded" a few hundred times. `formatPageMapNodes()` below is the
// structured answer FOR THIS READER; the trailer built in `mcp/server.ts`
// carries only the counts and the degradation record, never a second copy
// of `nodes`, because duplicating it there would roughly double the bill
// this call exists to keep down.
// ==================================================================

/**
 * Renders one `pageMap()` capture as compact, line-per-node text.
 *
 * Deliberately NOT browser-use's nested, tab-indented pseudo-HTML
 * (`dom/serializer/serializer.py:976` onward, `[42]<button .../>` under a
 * parent indented one tab further). `PageMapNode` is already the curated,
 * FLAT, indexed subset the interactivity cascade picked (see
 * `AutomationClient.pageMap`'s own doc, "Answers are FLAT, not a tree"),
 * not a pruned walk of the whole DOM, so there is no parent/child
 * relationship left to indent for; a tab-indented rendering of a flat list
 * would just be a flat list with a decorative tab in front of every line.
 * One line per node, in the priority order the server already returns them
 * in (in-viewport first, then descending paint order, then document
 * order), costs strictly fewer tokens than the same fields as JSON: no
 * `"index":`/`"tag":`/`"occluded":` key repeated once per node.
 *
 * Two things this codebase carries that browser-use's format has no room
 * for are put ON EVERY LINE they apply to, never only in a footer a reader
 * might skip:
 *
 *  * **The occlusion answer is tristate, and `null` is never rendered as
 *    "visible".** A line carries `|occluded|` when the node was found
 *    covered, `|occlusion?|` when the answer was never computed (the
 *    occlusion pass hit its own rectangle-union cap), and no marker at
 *    all only when the pass actually
 *    cleared it. Collapsing `|occlusion?|` into a bare, unmarked line would
 *    read to a model as "clear to click", which is exactly the modal an
 *    agent walks straight into.
 *  * **`role=? "?"` marks a degraded read, never a bare omission.**
 *    `PageMapNode.role`/`name` are `null` under exactly one condition, this
 *    node's frame losing its accessibility read (`@browserglass/protocol`'s
 *    `wire/messages/pagemap.ts`), so `?` here is not "this element has no
 *    role", it is "this build could not ask". An unlabelled control that
 *    genuinely carries no accessible name still renders `role=generic ""`,
 *    a real, empty string, never `?`.
 */
export function formatPageMapNodes(nodes: readonly PageMapNode[]): string {
  return nodes.map(formatPageMapNodeLine).join('\n');
}

function formatPageMapNodeLine(node: PageMapNode): string {
  const parts = [`role=${node.role ?? '?'}`, JSON.stringify(node.name ?? '?')];
  for (const attr of PAGE_MAP_ATTRIBUTES) {
    const value = node.attributes[attr];
    if (value !== undefined) parts.push(`${attr}=${JSON.stringify(value)}`);
  }
  const suffix = !node.inViewport
    ? ' |offscreen|'
    : node.occluded === true
      ? ' |occluded|'
      : node.occluded === null
        ? ' |occlusion?|'
        : '';
  return `[${node.index}] <${node.tag} ${parts.join(' ')}>${suffix}`;
}

/**
 * Renders `include: ['text']` output as compact markdown: `#`-prefixed
 * headings at their real level, `-`-prefixed list items, `[text](href)`
 * links, and paragraphs verbatim. This version is scoped to
 * headings/paragraphs/list items/link text and nothing else; a table's
 * cells arrive as plain {@link PageMapTextBlock}
 * entries in document order, not reassembled into a markdown table here.
 */
export function formatPageMapText(blocks: readonly PageMapTextBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case 'heading':
          return `${'#'.repeat(Math.min(Math.max(b.level ?? 1, 1), 6))} ${b.text}`;
        case 'listItem':
          return `- ${b.text}`;
        case 'link':
          return `[${b.text}](${b.href ?? ''})`;
        default:
          return b.text;
      }
    })
    .join('\n');
}

/**
 * Assembles the whole `bg_page_map` "capture" body: a one-line header
 * naming the epoch and what was captured, truncation reported by REASON
 * (not just a count) whenever any node was dropped, accessibility and
 * listener degradation stated in words when either happened, then the
 * rendered node list, then the rendered text blocks when `include` asked
 * for `'text'`. Every section but the header is omitted when there is
 * nothing to say in it, so a clean, undegraded, untruncated capture costs
 * exactly one header line plus the node list.
 */
export function formatPageMapCapture(result: PageMapResult): string {
  const sections: string[] = [];
  const nodeCount = result.nodes?.length ?? 0;
  const headerBits = [`epoch ${result.epoch}`];
  if (result.total !== undefined)
    headerBits.push(`${nodeCount} of ${result.total} element(s) captured`);
  if (result.text !== undefined) headerBits.push(`${result.text.length} text block(s)`);
  sections.push(`Page map: ${headerBits.join(', ')}.`);

  if (result.truncated && result.truncatedByReason) {
    const r = result.truncatedByReason;
    const reasons: string[] = [];
    if (r.offscreen > 0)
      reasons.push(`${r.offscreen} offscreen (scroll and re-capture may surface them)`);
    if (r.onscreen > 0)
      reasons.push(
        `${r.onscreen} onscreen (the byte budget went on visible content; scrolling will not help)`,
      );
    if (r.unpositioned > 0)
      reasons.push(
        `${r.unpositioned} unpositioned (no layout to click; re-capturing will not change that)`,
      );
    sections.push(`Truncated: ${reasons.join('; ')}.`);
  }

  if (result.degraded) {
    const d = result.degraded;
    if (d.framesFailed > 0) {
      sections.push(
        `Accessibility degraded: ${d.framesFailed}/${d.framesAttempted} frame(s) failed to read; their nodes show role=? "?" below rather than a real role or name.`,
      );
    }
    if (d.listeners === 'skipped') {
      sections.push(
        'Listener signal: skipped by request. An element whose only actionability signal would have been a JS click handler may be missing from this capture entirely.',
      );
    } else if (d.listeners === 'failed') {
      sections.push(
        `Listener signal: failed (${d.listenersReason ?? 'no reason given'}). An element whose only actionability signal would have been a JS click handler may be missing from this capture entirely.`,
      );
    }
  }

  if (result.nodes) sections.push(formatPageMapNodes(result.nodes));
  if (result.text) sections.push(formatPageMapText(result.text));

  return sections.join('\n');
}
