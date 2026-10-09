import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationClient } from '../../src/client/AutomationClient.js';
import {
  AUTOMATION_MCP_TOOLS,
  callAutomationTool,
  createAutomationMcpServer,
  createMcpStateForTest,
} from '../../src/mcp/server.js';
import { ScriptedGateway, completeHandshake, createFakeGatewayHarness } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/** Parses the `--- bgls ---` fenced JSON trailer out of one tool result's text content. */
function trailerOf(text: string): Record<string, unknown> {
  const marker = '--- bgls ---';
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const fenced = text.slice(idx + marker.length);
  const jsonStart = fenced.indexOf('```json');
  const jsonEnd = fenced.lastIndexOf('```');
  const json = fenced.slice(jsonStart + '```json'.length, jsonEnd).trim();
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * `connectFakeClient()` (`../helpers.js`) always welcomes with the fixed
 * grant list `fixtureWelcome()` defaults to, which does not include
 * `devtools`. The diagnostics tools need it, so this drives the same
 * handshake by hand with an extra capability added, rather than editing
 * `../helpers.js` (shared infrastructure other suites use too) just for
 * this file's own tests.
 */
async function connectFakeClientWithDevtools() {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const ws = completeHandshake(harness, {
    granted: [
      'view',
      'control',
      'navigate',
      'tabs.manage',
      'capture',
      'probe',
      'automation',
      'devtools',
    ],
  });
  const gateway = new ScriptedGateway(harness, ws);
  gateway.start();
  const client = await connectPromise;
  return { client, gateway, harness };
}

/**
 * `connectFakeClient()` always welcomes with the fixed grant list
 * `fixtureWelcome()` defaults to, which does not include `evaluate`. Every
 * locator-surface tool needs it (`control` is already in the default
 * list), so this drives the same handshake by hand with `evaluate` added,
 * the same reasoning `connectFakeClientWithDevtools()` above gives for not
 * editing `../helpers.js` just for this file's own tools.
 */
async function connectFakeClientWithEvaluate() {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const ws = completeHandshake(harness, {
    granted: [
      'view',
      'control',
      'navigate',
      'tabs.manage',
      'capture',
      'probe',
      'automation',
      'evaluate',
    ],
  });
  const gateway = new ScriptedGateway(harness, ws);
  gateway.start();
  const client = await connectPromise;
  return { client, gateway, harness };
}

/**
 * `connectFakeClient()` always welcomes with the fixed grant list
 * `fixtureWelcome()` defaults to, which carries `capture` but not
 * `download`. `bg_recording` needs BOTH together (its own manifest
 * description says so), so this drives the same handshake by hand with
 * `download` added, the same reasoning `connectFakeClientWithDevtools()`
 * above gives.
 */
async function connectFakeClientWithDownload() {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const ws = completeHandshake(harness, {
    granted: [
      'view',
      'control',
      'navigate',
      'tabs.manage',
      'capture',
      'probe',
      'automation',
      'download',
    ],
  });
  const gateway = new ScriptedGateway(harness, ws);
  gateway.start();
  const client = await connectPromise;
  return { client, gateway, harness };
}

/**
 * One page-side match, in the `WireResolveResult`/`LocatorMatch` shape
 * `RESOLVE_SCRIPT`/`WAIT_SCRIPT` return (`../../src/locator/engine.ts`,
 * `../../src/locator/types.ts`). Defaults describe an actionable, empty
 * `<input>` so a test only has to override what it cares about.
 */
function fixtureLocatorMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    index: 0,
    ref: 'bg00000001',
    tagName: 'input',
    type: 'text',
    id: null,
    name: 'name',
    role: null,
    rect: { x: 10, y: 20, w: 200, h: 30 },
    center: { x: 110, y: 35 },
    attached: true,
    visible: true,
    enabled: true,
    disabledReason: null,
    editable: true,
    stable: true,
    hitTestOk: true,
    occludedBy: null,
    hitReason: null,
    inViewport: true,
    opacity: 1,
    pointerEvents: 'auto',
    text: null,
    value: '',
    checked: null,
    readValue: null,
    describe: 'input#name',
    ...overrides,
  };
}

/** The `WireResolveResult` shape `RESOLVE_SCRIPT` (and the resolve half of `WAIT_SCRIPT`) returns, wrapping one or more {@link fixtureLocatorMatch}es. */
function fixtureWireResolve(
  matches: Array<Record<string, unknown>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    matches,
    total: matches.length,
    truncated: false,
    engine: 'css',
    segments: 1,
    scopeMissing: false,
    selectorError: null,
    url: 'https://example.test/',
    title: 'Example',
    viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
    ...overrides,
  };
}

/**
 * Builds a `ScriptedGateway.evaluateResponder` that dispatches by WHICH
 * page-side script (`../../src/locator/script.ts`) a `page.evaluate`
 * actually carries, since the locator surface sends several different
 * scripts through the exact same wire message and a single fixed reply
 * cannot serve all of them in the same test. Matched by a source substring
 * unique to each script rather than by call order, so a test does not
 * silently break were the engine ever to reorder its own round trips.
 * `expression` calls (`bg_evaluate`, `bg_wait_for_text`'s poll) are
 * dispatched separately, since those carry an `expression` field and no
 * `functionDeclaration` at all.
 */
function scriptDispatcher(build: {
  resolve?: () => unknown;
  wait?: () => unknown;
  read?: () => unknown;
  clear?: () => unknown;
  select?: () => unknown;
  expression?: (msg: Record<string, unknown>) => unknown;
}): (msg: Record<string, unknown>) => Record<string, unknown> {
  return (msg: Record<string, unknown>) => {
    const fd = msg['functionDeclaration'];
    const src = typeof fd === 'string' ? fd : '';
    const value = ((): unknown => {
      if (src.includes('spec.deadlineMs')) return build.wait?.() ?? fixtureWireResolve([]);
      if (src.includes('spec.what ===')) return build.read?.() ?? { found: false };
      if (src.includes('cleared: false')) return build.clear?.() ?? { found: true, cleared: true };
      if (src.includes('notMultiple')) return build.select?.() ?? { found: false };
      if (src.includes('return bglsResolve(spec);'))
        return build.resolve?.() ?? fixtureWireResolve([]);
      if (typeof msg['expression'] === 'string') return build.expression?.(msg) ?? null;
      return null;
    })();
    return { ok: true, resultType: 'value', value };
  };
}

/**
 * A minimal, hand-rolled structural check against one tool's declared JSON
 * Schema: required properties present, declared types respected, enums
 * respected. Not a full JSON Schema implementation (no `ajv` dependency in
 * this package, and pulling one in for a handful of flat object schemas
 * would be a bigger change than the tools it is checking), but enough to
 * catch a manifest entry whose schema and whose handler have drifted apart.
 */
function schemaProblems(tool: Tool, args: Record<string, unknown>): string[] {
  const schema = tool.inputSchema as {
    type: string;
    properties?: Record<string, { type?: string | string[]; enum?: unknown[] }>;
    required?: string[];
  };
  const problems: string[] = [];
  if (schema.type !== 'object') problems.push(`${tool.name}: inputSchema.type must be 'object'`);
  for (const key of schema.required ?? []) {
    if (!(key in args)) problems.push(`${tool.name}: example is missing required '${key}'`);
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      problems.push(`${tool.name}: example passes undeclared property '${key}'`);
      continue;
    }
    const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : undefined;
    if (types && !types.some((t) => typeMatches(t, value)))
      problems.push(
        `${tool.name}: '${key}' should be ${types.join(' or ')}, example gave ${typeof value}`,
      );
    if (prop.enum && !prop.enum.includes(value))
      problems.push(
        `${tool.name}: '${key}' should be one of ${JSON.stringify(prop.enum)}, example gave ${JSON.stringify(value)}`,
      );
  }
  return problems;
}

function typeMatches(t: string, v: unknown): boolean {
  switch (t) {
    case 'string':
      return typeof v === 'string';
    case 'number':
      return typeof v === 'number';
    case 'boolean':
      return typeof v === 'boolean';
    case 'object':
      return typeof v === 'object' && v !== null;
    case 'array':
      return Array.isArray(v);
    default:
      return true;
  }
}

describe('the automation MCP server', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes the full tool manifest, every one described and object-shaped', () => {
    const names = AUTOMATION_MCP_TOOLS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'bg_status',
        'bg_read_page',
        'bg_click',
        'bg_type',
        'bg_set_input_files',
        'bg_control',
        'bg_navigate',
        'bg_back',
        'bg_forward',
        'bg_reload',
        'bg_stop',
        'bg_press_key',
        'bg_scroll',
        'bg_drag',
        'bg_wait_for_navigation',
        'bg_tabs',
        'bg_screenshot',
        'bg_pdf',
        'bg_recording',
        'bg_diagnostics_subscribe',
        'bg_read_console',
        'bg_read_network',
        'bg_wait_for_network_idle',
        'bg_page_map',
        'bg_evaluate',
        'bg_resolve',
        'bg_wait_for',
        'bg_wait_for_text',
        'bg_get_text',
        'bg_get_attribute',
        'bg_is_checked',
        'bg_get_html',
        'bg_scroll_into_view',
        'bg_fill',
        'bg_select',
        'bg_swarm_open',
        'bg_swarm_list',
        'bg_swarm_grow',
        'bg_swarm_shrink',
        'bg_swarm_close',
        'bg_swarm_run',
      ].sort(),
    );
    for (const tool of AUTOMATION_MCP_TOOLS) {
      expect(tool.description, `${tool.name} needs a description`).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('every tool schema accepts a realistic example call: required fields present, declared types and enums respected', () => {
    const examples: Record<string, Record<string, unknown>> = {
      bg_status: {},
      bg_read_page: { targetId: 'tgt_1' },
      bg_click: { x: 1, y: 2, button: 'left', clickCount: 1, modifiers: ['Shift'] },
      bg_type: { text: 'hi', humanLike: true },
      bg_drag: {
        fromX: 10,
        fromY: 20,
        toSelector: '#drop',
        steps: 5,
        delayMs: 0,
        button: 'left',
        modifiers: ['Shift'],
      },
      bg_set_input_files: {
        selector: '#attachment',
        paths: ['C:/tmp/report.pdf'],
        files: [{ name: 'report.pdf', dataBase64: 'AAA=' }],
      },
      bg_control: { action: 'acquire', waitMs: 1000, durationMs: 2000, reason: 'test' },
      bg_navigate: { url: 'https://example.test/' },
      bg_back: {},
      bg_forward: {},
      bg_reload: { ignoreCache: true },
      bg_stop: {},
      bg_press_key: { key: 'Enter', modifiers: ['Control'] },
      bg_scroll: { x: 10, y: 20, dx: 0, dy: 100 },
      bg_wait_for_navigation: { timeoutMs: 5000 },
      bg_tabs: { action: 'open', url: 'https://example.test/', background: false, tabId: 'tgt_1' },
      bg_screenshot: { format: 'png', fullPage: true, maxDimension: 800 },
      bg_pdf: {
        format: 'A4',
        landscape: true,
        printBackground: true,
        scale: 0.9,
        marginTopInches: 0.5,
        marginBottomInches: 0.5,
        marginLeftInches: 0.5,
        marginRightInches: 0.5,
        pageRanges: '1-3',
        headerTemplate: '<span></span>',
        footerTemplate: '<span></span>',
      },
      bg_recording: { action: 'start', recordingId: 'rec_1', mode: 'live' },
      bg_diagnostics_subscribe: { console: true, errors: true, network: false },
      bg_read_console: {},
      bg_read_network: { swarmId: 'swarm_1', member: 0 },
      bg_wait_for_network_idle: { maxInflight: 0, idleMs: 500, timeoutMs: 5000 },
      bg_page_map: {
        action: 'capture',
        include: ['nodes', 'text'],
        listeners: true,
        timeoutMs: 15000,
      },
      bg_evaluate: {
        expression: 'document.title',
        awaitPromise: true,
        userGesture: false,
        timeoutMs: 5000,
      },
      bg_resolve: {
        selector: 'button',
        limit: 10,
        stamp: true,
        stable: true,
        hitTest: true,
        scroll: false,
        scrollIndex: 0,
        within: 'bg00000001',
        textLimit: 200,
        timeoutMs: 5000,
      },
      bg_wait_for: { selector: 'button', state: 'visible', timeoutMs: 5000, pollMs: 100, index: 0 },
      bg_wait_for_text: {
        selector: '.toast',
        text: 'Saved',
        timeoutMs: 5000,
        pollingMs: 100,
        exact: false,
      },
      bg_get_text: { selector: 'h1', index: 0, timeoutMs: 5000, limit: 200 },
      bg_get_attribute: { selector: 'a', name: 'href', index: 0, timeoutMs: 5000 },
      bg_is_checked: { selector: 'input[type=checkbox]', index: 0, timeoutMs: 5000 },
      bg_get_html: {},
      bg_scroll_into_view: { selector: '#name', index: 0, timeoutMs: 5000 },
      bg_fill: {
        selector: '#name',
        value: 'Ada Lovelace',
        index: 0,
        timeoutMs: 8000,
        mode: 'keys',
        delayMs: 0,
        clear: true,
        click: true,
        verify: true,
        scroll: true,
      },
      bg_select: { selector: '#country', option: 'US', index: 0, timeoutMs: 8000, scroll: true },
      bg_swarm_open: { size: 3, url: 'https://example.test/', isolation: 'window' },
      bg_swarm_list: { swarmId: 'swarm_1' },
      bg_swarm_grow: { swarmId: 'swarm_1', n: 2 },
      bg_swarm_shrink: { swarmId: 'swarm_1', n: 1 },
      bg_swarm_close: { swarmId: 'swarm_1' },
      bg_swarm_run: { swarmId: 'swarm_1', action: 'click', x: 1, y: 2 },
    };
    // Every tool has an example registered above, and vice versa: this
    // catches a new tool added to the manifest without a matching example
    // just as much as a stale example for a tool that got removed.
    expect(Object.keys(examples).sort()).toEqual(AUTOMATION_MCP_TOOLS.map((t) => t.name).sort());

    const problems = AUTOMATION_MCP_TOOLS.flatMap((tool) =>
      schemaProblems(tool, examples[tool.name] ?? {}),
    );
    expect(problems).toEqual([]);
  });

  it('createAutomationMcpServer() builds a Server advertising the tools capability', async () => {
    const { client } = await connectFakeClient();
    const server = createAutomationMcpServer({ client });
    expect(server).toBeDefined();
    client.close();
  });

  it('bg_status returns the correct envelope shape', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const result = await callAutomationTool(state, 'bg_status', {});
    expect(result.content).toHaveLength(1);
    expect(result.content[0]?.type).toBe('text');
    expect(result.isError).toBeFalsy();
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['ok']).toBe(true);
    expect(trailer['action']).toBe('bg_status');
    expect(typeof trailer['durationMs']).toBe('number');
    expect(trailer['status']).toMatchObject({ url: 'https://example.test/' });
    client.close();
  });

  /**
   * `text()` is no longer stubbed: it is implemented on top of
   * `page.evaluate` (`AutomationClient.text()`). What `bg_read_page`
   * reports for a token WITHOUT the `evaluate` capability, which is what
   * the fake gateway's default granted set carries, is a clean
   * `POLICY_DENIED` naming the capability that is missing. That is the
   * useful answer for an agent: the fix is a token change, not waiting for
   * a feature.
   */
  it('bg_read_page reports a clean POLICY_DENIED with a hint when the token lacks evaluate', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const result = await callAutomationTool(state, 'bg_read_page', {});
    expect(result.isError).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['ok']).toBe(false);
    expect(trailer['code']).toBe('POLICY_DENIED');
    expect(trailer['details']).toMatchObject({ required: 'evaluate' });
    expect(typeof trailer['hint']).toBe('string');
    client.close();
  });

  it('bg_click without a lease reports LEASE_NOT_HELD with a hint pointing at bg_control', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const result = await callAutomationTool(state, 'bg_click', { x: 10, y: 10 });
    expect(result.isError).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['code']).toBe('LEASE_NOT_HELD');
    expect(trailer['hint']).toContain('bg_control');
    client.close();
  });

  it('bg_click with neither coordinates nor a selector reports a usage error', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const result = await callAutomationTool(state, 'bg_click', {});
    expect(result.isError).toBe(true);
    client.close();
  });

  /**
   * The selector path used to be a stale lie (`server.ts`'s own comment
   * claimed the locator engine was not wired up); this proves it is:
   * `bg_click` given a selector goes through the same wait/resolve/dispatch
   * `bg_fill`/`bg_select` use, and `button`/`clickCount`/`modifiers` reach
   * the actual `input.mouse` dispatch.
   */
  it('bg_click with a selector clicks the element the locator engine resolved, once a lease is held', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    gateway.evaluateResponder = scriptDispatcher({
      wait: () => ({
        timedOut: false,
        result: fixtureWireResolve([fixtureLocatorMatch()]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      }),
    });

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const clickPromise = callAutomationTool(state, 'bg_click', {
      selector: '#name',
      button: 'right',
      clickCount: 2,
      modifiers: ['Shift'],
    });
    await tick();
    const clickResult = await clickPromise;
    expect(clickResult.isError).toBeFalsy();
    const trailer = trailerOf(clickResult.content[0]?.text ?? '');
    expect(trailer).toMatchObject({ ok: true, ref: 'bg00000001', selector: '#name' });
    expect(
      gateway.ws
        .sentJsonMessages()
        .some(
          (m) =>
            m['t'] === 'input.mouse' &&
            m['kind'] === 'down' &&
            m['button'] === 'right' &&
            m['clickCount'] === 2,
        ),
    ).toBe(true);

    client.close();
  });

  it('bg_control acquires, checks status, and releases; then bg_click succeeds while held', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    const acquireResult = await acquirePromise;
    expect(acquireResult.isError).toBeFalsy();
    const acquireTrailer = trailerOf(acquireResult.content[0]?.text ?? '');
    expect(acquireTrailer['ok']).toBe(true);
    expect(typeof acquireTrailer['leaseId']).toBe('string');

    const statusResult = await callAutomationTool(state, 'bg_control', { action: 'status' });
    const statusTrailer = trailerOf(statusResult.content[0]?.text ?? '');
    expect(statusTrailer['leaseHolderViewerId']).toBe(client.viewerId);

    const clickPromise = callAutomationTool(state, 'bg_click', { x: 5, y: 5 });
    await tick();
    const clickResult = await clickPromise;
    expect(clickResult.isError).toBeFalsy();
    expect(
      gateway.ws.sentJsonMessages().some((m) => m['t'] === 'input.mouse' && m['kind'] === 'down'),
    ).toBe(true);

    const releaseResult = await callAutomationTool(state, 'bg_control', { action: 'release' });
    expect(releaseResult.isError).toBeFalsy();
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'control.release')).toBe(true);

    client.close();
  });

  it('bg_control with an unknown action reports a usage error', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const result = await callAutomationTool(state, 'bg_control', { action: 'teleport' });
    expect(result.isError).toBe(true);
    client.close();
  });

  it('bg_type requires the control lease and types once one is held', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_type', { text: 'hi' });
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const typePromise = callAutomationTool(state, 'bg_type', { text: 'hi' });
    await tick();
    const typeResult = await typePromise;
    expect(typeResult.isError).toBeFalsy();
    expect(
      gateway.ws.sentJsonMessages().some((m) => m['t'] === 'input.key' || m['t'] === 'input.text'),
    ).toBe(true);

    client.close();
  });

  it('bg_navigate requires a held lease and navigates once one is held', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_navigate', {
      url: 'https://example.test/next',
    });
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const navPromise = callAutomationTool(state, 'bg_navigate', {
      url: 'https://example.test/next',
    });
    await tick();
    const navResult = await navPromise;
    expect(navResult.isError).toBeFalsy();
    expect(
      gateway.ws
        .sentJsonMessages()
        .some((m) => m['t'] === 'nav.goto' && m['url'] === 'https://example.test/next'),
    ).toBe(true);
    expect(trailerOf(navResult.content[0]?.text ?? '')['status']).toMatchObject({
      url: 'https://example.test/next',
    });

    client.close();
  });

  it('bg_screenshot captures without needing a held lease', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const result = await callAutomationTool(state, 'bg_screenshot', { format: 'png' });
    expect(result.isError).toBeFalsy();
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'target.capture')).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(typeof trailer['data']).toBe('string');
    expect(trailer['format']).toBe('png');

    client.close();
  });

  it('bg_pdf renders without needing a held lease, inline data when small', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const result = await callAutomationTool(state, 'bg_pdf', { format: 'A4', landscape: true });
    expect(result.isError).toBeFalsy();
    expect(
      gateway.ws
        .sentJsonMessages()
        .some((m) => m['t'] === 'page.pdf.get' && m['format'] === 'A4' && m['landscape'] === true),
    ).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(typeof trailer['data']).toBe('string');
    expect(trailer['downloadId']).toBeUndefined();

    client.close();
  });

  it('bg_pdf reports a downloadId/url instead of data, and no error, when the rendered PDF is too large to inline', async () => {
    const { client, gateway } = await connectFakeClient();
    gateway.pdfResponder = (msg) => ({
      t: 'page.pdf.got',
      pdfId: 'pdf_big',
      targetId: msg['targetId'],
      sizeBytes: 500000,
      gen: 1,
      downloadId: 'pdf_big',
      url: '/browserglass/v1/downloads/faketoken',
      expiresAt: Date.now() + 60000,
      sha256: 'a'.repeat(64),
    });
    const state = createMcpStateForTest({ client });

    const result = await callAutomationTool(state, 'bg_pdf', {});
    expect(result.isError).toBeFalsy();
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['data']).toBeUndefined();
    expect(trailer['downloadId']).toBe('pdf_big');
    expect(trailer['url']).toBe('https://gateway.test/browserglass/v1/downloads/faketoken');
    expect(trailer['sizeBytes']).toBe(500000);
    // The summary text tells an LLM caller to fetch the URL rather than
    // treating a "success" result as though the bytes were already handed
    // over, the same accuracy requirement every other tool description in
    // this file is held to.
    expect(result.content[0]?.text ?? '').toContain('url');

    client.close();
  });

  it('bg_recording reports a clean POLICY_DENIED naming download when the token only has capture', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const result = await callAutomationTool(state, 'bg_recording', { action: 'start' });
    expect(result.isError).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['code']).toBe('POLICY_DENIED');
    expect(trailer['details']).toMatchObject({ required: 'download' });

    client.close();
  });

  it('bg_recording start/stop/list round trips over recording.start/.stop/.list once the token has both capture and download', async () => {
    const { client, gateway } = await connectFakeClientWithDownload();
    const state = createMcpStateForTest({ client });

    const startResult = await callAutomationTool(state, 'bg_recording', {
      action: 'start',
      mode: 'thumbnail',
    });
    expect(startResult.isError).toBeFalsy();
    expect(gateway.recordingStartCalls.at(-1)).toMatchObject({
      t: 'recording.start',
      mode: 'thumbnail',
    });
    const startTrailer = trailerOf(startResult.content[0]?.text ?? '');
    expect(startTrailer['mode']).toBe('thumbnail');
    const recordingId = startTrailer['recordingId'] as string;
    expect(typeof recordingId).toBe('string');
    // Told plainly where the bytes actually live, not just that the call
    // succeeded: an agent that starts a recording and never reads this
    // sentence has no way to find it again.
    expect(startResult.content[0]?.text ?? '').toContain('bgls record');

    const stopResult = await callAutomationTool(state, 'bg_recording', {
      action: 'stop',
      recordingId,
    });
    expect(stopResult.isError).toBeFalsy();
    expect(gateway.recordingStopCalls.at(-1)).toMatchObject({ t: 'recording.stop', recordingId });
    const stopTrailer = trailerOf(stopResult.content[0]?.text ?? '');
    expect(stopTrailer['framesWritten']).toBe(3);
    expect(stopTrailer['failed']).toBe(false);

    gateway.recordingListResponder = () => ({
      t: 'recording.listed',
      recordings: [
        {
          recordingId,
          targetId: client.targetId,
          mode: 'thumbnail',
          startedAtMs: 1,
          stoppedAtMs: 2,
          framesWritten: 3,
          failed: false,
        },
      ],
    });
    const listResult = await callAutomationTool(state, 'bg_recording', { action: 'list' });
    expect(listResult.isError).toBeFalsy();
    const listTrailer = trailerOf(listResult.content[0]?.text ?? '');
    expect(listTrailer['recordings']).toHaveLength(1);

    client.close();
  });

  it('bg_recording stop without a recordingId reports a usage error', async () => {
    const { client } = await connectFakeClientWithDownload();
    const state = createMcpStateForTest({ client });

    const result = await callAutomationTool(state, 'bg_recording', { action: 'stop' });
    expect(result.isError).toBe(true);

    client.close();
  });

  it('bg_recording with an unknown action reports a usage error', async () => {
    const { client } = await connectFakeClientWithDownload();
    const state = createMcpStateForTest({ client });

    const result = await callAutomationTool(state, 'bg_recording', { action: 'pause' });
    expect(result.isError).toBe(true);

    client.close();
  });

  it('bg_diagnostics_subscribe needs the devtools capability, refused locally before any wire traffic', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const before = gateway.ws.sentJsonMessages().length;

    const result = await callAutomationTool(state, 'bg_diagnostics_subscribe', {});
    expect(result.isError).toBe(true);
    expect(trailerOf(result.content[0]?.text ?? '')['code']).toBe('POLICY_DENIED');
    expect(gateway.ws.sentJsonMessages().length).toBe(before);

    client.close();
  });

  it('bg_read_console reports nothing before bg_diagnostics_subscribe, and what was collected after', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });

    const before = await callAutomationTool(state, 'bg_read_console', {});
    expect(trailerOf(before.content[0]?.text ?? '')['console']).toEqual([]);

    const subResult = await callAutomationTool(state, 'bg_diagnostics_subscribe', {});
    expect(subResult.isError).toBeFalsy();
    const subTrailer = trailerOf(subResult.content[0]?.text ?? '');
    expect(subTrailer).toMatchObject({ console: true, errors: true, network: false });

    gateway.sendConsoleEntry(client.targetId, { text: 'hello from the page', level: 'warn' });

    const after = await callAutomationTool(state, 'bg_read_console', {});
    const afterTrailer = trailerOf(after.content[0]?.text ?? '');
    const entries = afterTrailer['console'] as Array<{ text: string; level: string }>;
    expect(entries.map((e) => e.text)).toEqual(['hello from the page']);
    expect(entries[0]?.level).toBe('warn');
    expect(afterTrailer['errors']).toEqual([]);

    client.close();
  });

  it('bg_read_network is empty before subscribing, then reports rows collected after subscribing with network true', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });

    const before = await callAutomationTool(state, 'bg_read_network', {});
    expect(trailerOf(before.content[0]?.text ?? '')['requests']).toEqual([]);

    // network defaults off (asserted directly on the subscribe reply in
    // the console test above); pass it explicitly to see rows at all.
    const subResult = await callAutomationTool(state, 'bg_diagnostics_subscribe', {
      network: true,
    });
    expect(trailerOf(subResult.content[0]?.text ?? '')['network']).toBe(true);

    gateway.sendNetworkRequest(client.targetId, { url: 'https://example.test/api', status: 200 });
    const result = await callAutomationTool(state, 'bg_read_network', {});
    const trailer = trailerOf(result.content[0]?.text ?? '');
    const requests = trailer['requests'] as Array<{ url: string; status: number | null }>;
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: 'https://example.test/api', status: 200 });

    client.close();
  });

  it('subscribing twice on the same target does not double up buffered entries', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });

    await callAutomationTool(state, 'bg_diagnostics_subscribe', {});
    await callAutomationTool(state, 'bg_diagnostics_subscribe', {});
    gateway.sendConsoleEntry(client.targetId, { text: 'once' });

    const result = await callAutomationTool(state, 'bg_read_console', {});
    const entries = trailerOf(result.content[0]?.text ?? '')['console'] as unknown[];
    expect(entries).toHaveLength(1);

    client.close();
  });

  it('bg_page_map needs the devtools capability, refused locally before any wire traffic', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const before = gateway.ws.sentJsonMessages().length;

    const result = await callAutomationTool(state, 'bg_page_map', {});
    expect(result.isError).toBe(true);
    expect(trailerOf(result.content[0]?.text ?? '')['code']).toBe('POLICY_DENIED');
    expect(gateway.ws.sentJsonMessages().length).toBe(before);

    client.close();
  });

  /**
   * The rendering itself: one line per node, index/role/name/attributes on
   * it, no marker when the pass cleared it. This is what
   * `formatPageMapCapture()` (`../../src/mcp/format.ts`) exists for, and
   * the JSON trailer assertion below is the other half of the same point:
   * `nodes` is never duplicated into the trailer, because the rendered
   * text already IS the structured answer for this reader.
   */
  it('bg_page_map captures and renders a small map, with metadata but no duplicate node array in the trailer', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });
    gateway.pageMapResponder = (msg) => ({
      t: 'page.map.got',
      targetId: msg['targetId'],
      epoch: 'epoch_abc',
      nodes: [
        {
          index: 1234,
          tag: 'button',
          role: 'button',
          name: 'Search',
          rect: { x: 1, y: 2, w: 3, h: 4 },
          inViewport: true,
          occluded: false,
          attributes: { type: 'submit', 'aria-label': 'Search' },
        },
      ],
      total: 1,
      truncated: false,
      truncatedByReason: { offscreen: 0, onscreen: 0, unpositioned: 0 },
      degraded: { framesAttempted: 1, framesFailed: 0, failures: [], listeners: 'ok' },
    });

    const result = await callAutomationTool(state, 'bg_page_map', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('[1234] <button role=button "Search"');
    expect(text).not.toContain('|occluded|');
    expect(text).not.toContain('|offscreen|');
    expect(text).not.toContain('|occlusion?|');

    const trailer = trailerOf(text);
    expect(trailer).toMatchObject({ epoch: 'epoch_abc', total: 1, truncated: false });
    expect(trailer).not.toHaveProperty('nodes');

    client.close();
  });

  it('bg_page_map surfaces truncation by reason, and per-frame/listener degradation, in the rendered text', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });
    gateway.pageMapResponder = (msg) => ({
      t: 'page.map.got',
      targetId: msg['targetId'],
      epoch: 'epoch_1',
      nodes: [
        {
          index: 1,
          tag: 'div',
          role: null,
          name: null,
          rect: { x: 0, y: 0, w: 1, h: 1 },
          inViewport: true,
          occluded: null,
          attributes: {},
        },
        {
          index: 2,
          tag: 'a',
          role: 'link',
          name: 'Results',
          rect: { x: 0, y: 900, w: 10, h: 10 },
          inViewport: false,
          occluded: null,
          attributes: { href: '/results' },
        },
      ],
      total: 40,
      truncated: true,
      truncatedByReason: { offscreen: 20, onscreen: 15, unpositioned: 3 },
      degraded: {
        framesAttempted: 2,
        framesFailed: 1,
        failures: [{ frameId: 'frame_2', reason: 'timeout' }],
        listeners: 'failed',
        listenersReason: 'DOMDebugger.getEventListeners did not complete in time',
      },
    });

    const result = await callAutomationTool(state, 'bg_page_map', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Truncation reasons, not just a bare count.
    expect(text).toContain('20 offscreen');
    expect(text).toContain('15 onscreen');
    expect(text).toContain('3 unpositioned');
    // Accessibility degradation named in words, not just visible as an
    // absent field a reader could mistake for "no role".
    expect(text).toContain('Accessibility degraded: 1/2 frame(s)');
    expect(text).toContain('[1] <div role=? "?"');
    // Listener degradation named, so a caller does not read a short node
    // list on a JS-heavy page as proof there is nothing else clickable.
    expect(text).toContain('Listener signal: failed');
    // Occlusion tristate: null in-viewport is "unknown", not "clear".
    expect(text).toContain('[1] <div role=? "?"> |occlusion?|');
    // Offscreen node carries its own marker, never the occlusion one.
    expect(text).toContain('[2] <a role=link "Results" href="/results"> |offscreen|');

    const trailer = trailerOf(text);
    expect(trailer['truncatedByReason']).toEqual({ offscreen: 20, onscreen: 15, unpositioned: 3 });
    expect(trailer['degraded']).toMatchObject({ framesFailed: 1, listeners: 'failed' });

    client.close();
  });

  it('bg_page_map action "stamp" writes the marker onto the requested indices and reports per-index results', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });
    gateway.pageMapStampResponder = (msg) => ({
      t: 'page.map.stamped',
      targetId: msg['targetId'],
      results: [
        { index: 1234, stamped: true },
        { index: 9999, stamped: false, reason: 'detached' },
      ],
      marker: 'data-bgls-pm-abc123',
    });

    const result = await callAutomationTool(state, 'bg_page_map', {
      action: 'stamp',
      epoch: 'epoch_abc',
      indices: [1234, 9999],
    });
    expect(result.isError).toBeFalsy();
    expect(gateway.pageMapStampCalls.at(-1)).toMatchObject({
      epoch: 'epoch_abc',
      indices: [1234, 9999],
    });
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['marker']).toBe('data-bgls-pm-abc123');
    expect(trailer['results']).toEqual([
      { index: 1234, stamped: true },
      { index: 9999, stamped: false, reason: 'detached' },
    ]);
    expect(result.content[0]?.text).toContain('css=[data-bgls-pm-abc123]');

    client.close();
  });

  it('bg_page_map action "stamp" requires epoch and indices, reported as a clean error rather than a wire round trip', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });

    const result = await callAutomationTool(state, 'bg_page_map', { action: 'stamp' });
    expect(result.isError).toBe(true);
    expect(gateway.pageMapStampCalls).toHaveLength(0);

    client.close();
  });

  it.each([
    'bg_evaluate',
    'bg_resolve',
    'bg_wait_for',
    'bg_wait_for_text',
    'bg_get_text',
    'bg_get_attribute',
    'bg_is_checked',
    'bg_get_html',
    'bg_scroll_into_view',
    'bg_fill',
    'bg_select',
  ])(
    '%s reports a clean POLICY_DENIED naming the evaluate capability when the token lacks it',
    async (toolName) => {
      const { client } = await connectFakeClient();
      const state = createMcpStateForTest({ client });
      const minimalArgs: Record<string, Record<string, unknown>> = {
        bg_evaluate: { expression: 'document.title' },
        bg_resolve: { selector: 'button' },
        bg_wait_for: { selector: 'button' },
        bg_wait_for_text: { selector: '.toast', text: 'Saved' },
        bg_get_text: { selector: 'h1' },
        bg_get_attribute: { selector: 'a', name: 'href' },
        bg_is_checked: { selector: 'input' },
        bg_get_html: {},
        bg_scroll_into_view: { selector: '#name' },
        bg_fill: { selector: '#name', value: 'Ada' },
        bg_select: { selector: '#country', option: 'US' },
      };
      const result = await callAutomationTool(state, toolName, minimalArgs[toolName] ?? {});
      expect(result.isError).toBe(true);
      const trailer = trailerOf(result.content[0]?.text ?? '');
      expect(trailer['code']).toBe('POLICY_DENIED');
      expect(trailer['details']).toMatchObject({ required: 'evaluate' });
      client.close();
    },
  );

  it('bg_fill and bg_select need a held control lease on top of the evaluate capability', async () => {
    const { client } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });

    const fillResult = await callAutomationTool(state, 'bg_fill', {
      selector: '#name',
      value: 'Ada',
    });
    expect(fillResult.isError).toBe(true);
    expect(trailerOf(fillResult.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const selectResult = await callAutomationTool(state, 'bg_select', {
      selector: '#country',
      option: 'US',
    });
    expect(selectResult.isError).toBe(true);
    expect(trailerOf(selectResult.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    client.close();
  });

  it('bg_evaluate runs an expression and returns its value', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    gateway.evaluateResponder = scriptDispatcher({ expression: () => 'Example Domain' });

    const result = await callAutomationTool(state, 'bg_evaluate', { expression: 'document.title' });
    expect(result.isError).toBeFalsy();
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['result']).toBe('Example Domain');
    expect(gateway.evaluateCalls.some((m) => m['expression'] === 'document.title')).toBe(true);

    client.close();
  });

  /**
   * The compactness assertion this test carries (no `opacity`,
   * `pointerEvents`, `hitReason`, `inViewport`, `type`, `id`, `name`,
   * `role`, `disabledReason`, `editable`, or `readValue` in the reply) is
   * the point of `summarizeMatch()` in `../../src/mcp/server.ts`: an MCP
   * caller pays real tokens for every field in the reply, and `bg_resolve`
   * keeps only what an agent needs to decide its next move, the rect and
   * the occlusion answer chief among them.
   */
  it('bg_resolve reports every match with its rect and occlusion, trimmed of fields an agent has no use for', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    const match = fixtureLocatorMatch({
      occludedBy: 'div[data-testid="overlay"]',
      hitTestOk: false,
    });
    gateway.evaluateResponder = scriptDispatcher({ resolve: () => fixtureWireResolve([match]) });

    const result = await callAutomationTool(state, 'bg_resolve', { selector: '#name' });
    expect(result.isError).toBeFalsy();
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['total']).toBe(1);
    const matches = trailer['matches'] as Array<Record<string, unknown>>;
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      rect: match['rect'],
      occludedBy: 'div[data-testid="overlay"]',
      hitTestOk: false,
      ref: 'bg00000001',
    });
    for (const droppedField of [
      'opacity',
      'pointerEvents',
      'hitReason',
      'inViewport',
      'type',
      'id',
      'name',
      'role',
      'disabledReason',
      'editable',
      'readValue',
    ]) {
      expect(matches[0]).not.toHaveProperty(droppedField);
    }

    client.close();
  });

  it('bg_wait_for waits for a state and reports the matches actionable when it resolved', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    const match = fixtureLocatorMatch();
    gateway.evaluateResponder = scriptDispatcher({
      wait: () => ({
        timedOut: false,
        result: fixtureWireResolve([match]),
        waitedMs: 12,
        checks: 1,
        wakes: 0,
      }),
    });

    const result = await callAutomationTool(state, 'bg_wait_for', {
      selector: '#name',
      state: 'actionable',
    });
    expect(result.isError).toBeFalsy();
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer).toMatchObject({ total: 1, waitedMs: 12, checks: 1, wakes: 0 });
    expect(trailer['matches'] as unknown[]).toHaveLength(1);

    client.close();
  });

  it('bg_wait_for_text waits for matching text and returns what matched', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    gateway.evaluateResponder = scriptDispatcher({ expression: () => 'Saved successfully' });

    const result = await callAutomationTool(state, 'bg_wait_for_text', {
      selector: '.toast',
      text: 'Saved',
    });
    expect(result.isError).toBeFalsy();
    expect(trailerOf(result.content[0]?.text ?? '')['text']).toBe('Saved successfully');

    client.close();
  });

  it('bg_get_text reads the rendered text of the element a selector resolves to', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    const match = fixtureLocatorMatch({ readValue: 'Welcome back' });
    gateway.evaluateResponder = scriptDispatcher({ resolve: () => fixtureWireResolve([match]) });

    const result = await callAutomationTool(state, 'bg_get_text', { selector: 'h1' });
    expect(result.isError).toBeFalsy();
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['length']).toBe('Welcome back'.length);

    client.close();
  });

  it('bg_fill requires a held lease, then focuses, clears, types, and verifies the field once one is held', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    gateway.evaluateResponder = scriptDispatcher({
      wait: () => ({
        timedOut: false,
        result: fixtureWireResolve([fixtureLocatorMatch()]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      }),
      read: () => ({ found: true, tagName: 'input', value: 'Ada Lovelace' }),
    });

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const fillPromise = callAutomationTool(state, 'bg_fill', {
      selector: '#name',
      value: 'Ada Lovelace',
    });
    await tick();
    const fillResult = await fillPromise;
    expect(fillResult.isError).toBeFalsy();
    const trailer = trailerOf(fillResult.content[0]?.text ?? '');
    expect(trailer).toMatchObject({
      ok: true,
      ref: 'bg00000001',
      actual: 'Ada Lovelace',
      verified: true,
    });
    expect(
      gateway.ws.sentJsonMessages().some((m) => m['t'] === 'input.mouse' && m['kind'] === 'down'),
    ).toBe(true);
    expect(
      gateway.ws.sentJsonMessages().some((m) => m['t'] === 'input.key' || m['t'] === 'input.text'),
    ).toBe(true);

    client.close();
  });

  it("bg_select sets a <select>'s selection and reports what ended up selected", async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });
    gateway.evaluateResponder = scriptDispatcher({
      wait: () => ({
        timedOut: false,
        result: fixtureWireResolve([fixtureLocatorMatch({ tagName: 'select' })]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      }),
      select: () => ({ found: true, values: ['US'], labels: ['United States'] }),
    });

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const selectPromise = callAutomationTool(state, 'bg_select', {
      selector: '#country',
      option: 'US',
    });
    await tick();
    const selectResult = await selectPromise;
    expect(selectResult.isError).toBeFalsy();
    expect(trailerOf(selectResult.content[0]?.text ?? '')).toMatchObject({
      ok: true,
      values: ['US'],
      labels: ['United States'],
    });

    client.close();
  });

  it('bg_back and bg_forward require a held lease and navigate history once one is held', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_back', {});
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const backResult = await callAutomationTool(state, 'bg_back', {});
    expect(backResult.isError).toBeFalsy();
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'nav.back')).toBe(true);
    expect(trailerOf(backResult.content[0]?.text ?? '')['status']).toMatchObject({
      url: 'https://example.test/',
    });

    const forwardResult = await callAutomationTool(state, 'bg_forward', {});
    expect(forwardResult.isError).toBeFalsy();
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'nav.forward')).toBe(true);

    client.close();
  });

  it('bg_reload requires a held lease and reloads, passing ignoreCache through', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_reload', {});
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const reloadResult = await callAutomationTool(state, 'bg_reload', { ignoreCache: true });
    expect(reloadResult.isError).toBeFalsy();
    expect(
      gateway.ws
        .sentJsonMessages()
        .some((m) => m['t'] === 'nav.reload' && m['ignoreCache'] === true),
    ).toBe(true);

    client.close();
  });

  it('bg_stop requires a held lease and sends nav.stop once one is held', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_stop', {});
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const stopResult = await callAutomationTool(state, 'bg_stop', {});
    expect(stopResult.isError).toBeFalsy();
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'nav.stop')).toBe(true);

    client.close();
  });

  it('bg_press_key requires a held lease and dispatches a key down/up once one is held', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_press_key', { key: 'Enter' });
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const pressPromise = callAutomationTool(state, 'bg_press_key', {
      key: 'Control+A',
      modifiers: ['Control'],
    });
    await tick();
    const pressResult = await pressPromise;
    expect(pressResult.isError).toBeFalsy();
    expect(gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.key').length).toBe(2);

    client.close();
  });

  it('bg_scroll requires a held lease and dispatches a wheel event once one is held', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_scroll', { dy: 100 });
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const scrollPromise = callAutomationTool(state, 'bg_scroll', { dy: 100 });
    await tick();
    const scrollResult = await scrollPromise;
    expect(scrollResult.isError).toBeFalsy();
    expect(
      gateway.ws
        .sentJsonMessages()
        .some((m) => m['t'] === 'input.mouse' && m['kind'] === 'wheel' && m['dy'] === 100),
    ).toBe(true);

    client.close();
  });

  it('bg_drag requires a held lease, then presses, moves with the button held, and releases', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const noLease = await callAutomationTool(state, 'bg_drag', {
      fromX: 10,
      fromY: 10,
      toX: 50,
      toY: 10,
    });
    expect(noLease.isError).toBe(true);
    expect(trailerOf(noLease.content[0]?.text ?? '')['code']).toBe('LEASE_NOT_HELD');

    const missingEnd = await callAutomationTool(state, 'bg_drag', { fromX: 10, fromY: 10 });
    expect(missingEnd.isError).toBe(true);

    const acquirePromise = callAutomationTool(state, 'bg_control', {
      action: 'acquire',
      waitMs: 5000,
    });
    await tick();
    await acquirePromise;

    const dragPromise = callAutomationTool(state, 'bg_drag', {
      fromX: 10,
      fromY: 10,
      toX: 50,
      toY: 10,
      steps: 2,
      delayMs: 0,
    });
    for (let i = 0; i < 10; i++) await tick(10);
    const dragResult = await dragPromise;
    expect(dragResult.isError).toBeFalsy();
    const kinds = gateway.ws
      .sentJsonMessages()
      .filter((m) => m['t'] === 'input.mouse')
      .map((m) => `${m['kind']}:${m['x']}:${m['buttons']}`);
    expect(kinds).toEqual(['move:10:0', 'down:10:1', 'move:30:1', 'move:50:1', 'up:50:0']);

    client.close();
  });

  it('bg_wait_for_navigation resolves once the target reports a settled nav.state, no lease required', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const waitPromise = callAutomationTool(state, 'bg_wait_for_navigation', {});
    await tick();
    gateway.ws.simulateJson({
      v: 1,
      t: 'nav.state',
      ts: Date.now(),
      targetId: client.targetId,
      url: 'https://example.test/next',
      title: 'Next',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      securityState: 'secure',
    });
    const result = await waitPromise;
    expect(result.isError).toBeFalsy();
    expect(trailerOf(result.content[0]?.text ?? '')['status']).toMatchObject({
      url: 'https://example.test/next',
    });

    client.close();
  });

  it('bg_tabs lists, opens, activates, and closes tabs; activate/close act on tabId, not targetId', async () => {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const listResult = await callAutomationTool(state, 'bg_tabs', { action: 'list' });
    expect(listResult.isError).toBeFalsy();
    expect(trailerOf(listResult.content[0]?.text ?? '')['tabs']).toEqual([]);

    const openResult = await callAutomationTool(state, 'bg_tabs', {
      action: 'open',
      url: 'https://example.test/new',
      background: true,
    });
    expect(openResult.isError).toBeFalsy();
    const openTrailer = trailerOf(openResult.content[0]?.text ?? '');
    expect(openTrailer['tab']).toMatchObject({
      targetId: 'tgt_new',
      url: 'https://example.test/new',
    });
    expect(
      gateway.ws
        .sentJsonMessages()
        .some(
          (m) =>
            m['t'] === 'target.new' &&
            m['url'] === 'https://example.test/new' &&
            m['background'] === true,
        ),
    ).toBe(true);

    const activateResult = await callAutomationTool(state, 'bg_tabs', {
      action: 'activate',
      tabId: 'tgt_new',
    });
    expect(activateResult.isError).toBeFalsy();
    expect(
      gateway.ws
        .sentJsonMessages()
        .some((m) => m['t'] === 'target.activate' && m['targetId'] === 'tgt_new'),
    ).toBe(true);

    const closeResult = await callAutomationTool(state, 'bg_tabs', {
      action: 'close',
      tabId: 'tgt_new',
    });
    expect(closeResult.isError).toBeFalsy();
    expect(
      gateway.ws
        .sentJsonMessages()
        .some((m) => m['t'] === 'target.close' && m['targetId'] === 'tgt_new'),
    ).toBe(true);

    client.close();
  });

  it('bg_tabs with an unknown action, or activate/close with no tabId, reports a usage error', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });

    const badAction = await callAutomationTool(state, 'bg_tabs', { action: 'teleport' });
    expect(badAction.isError).toBe(true);

    const noTabId = await callAutomationTool(state, 'bg_tabs', { action: 'close' });
    expect(noTabId.isError).toBe(true);

    client.close();
  });

  it('bg_get_attribute, bg_is_checked, bg_scroll_into_view, and bg_get_html read through the locator/evaluate surface', async () => {
    const { client, gateway } = await connectFakeClientWithEvaluate();
    const state = createMcpStateForTest({ client });

    gateway.evaluateResponder = scriptDispatcher({
      resolve: () =>
        fixtureWireResolve([fixtureLocatorMatch({ readValue: 'https://example.test/href' })]),
      expression: () => '<html></html>',
    });
    const attrResult = await callAutomationTool(state, 'bg_get_attribute', {
      selector: 'a',
      name: 'href',
    });
    expect(attrResult.isError).toBeFalsy();
    expect(trailerOf(attrResult.content[0]?.text ?? '')['value']).toBe('https://example.test/href');

    gateway.evaluateResponder = scriptDispatcher({
      resolve: () => fixtureWireResolve([fixtureLocatorMatch({ readValue: true })]),
    });
    const checkedResult = await callAutomationTool(state, 'bg_is_checked', {
      selector: 'input[type=checkbox]',
    });
    expect(checkedResult.isError).toBeFalsy();
    expect(trailerOf(checkedResult.content[0]?.text ?? '')['checked']).toBe(true);

    gateway.evaluateResponder = scriptDispatcher({
      resolve: () => fixtureWireResolve([fixtureLocatorMatch({ occludedBy: null })]),
    });
    const scrollResult = await callAutomationTool(state, 'bg_scroll_into_view', {
      selector: '#name',
    });
    expect(scrollResult.isError).toBeFalsy();
    expect(trailerOf(scrollResult.content[0]?.text ?? '')['match']).toMatchObject({
      ref: 'bg00000001',
    });

    gateway.evaluateResponder = scriptDispatcher({
      expression: () => '<html><body>hi</body></html>',
    });
    const htmlResult = await callAutomationTool(state, 'bg_get_html', {});
    expect(htmlResult.isError).toBeFalsy();
    expect(trailerOf(htmlResult.content[0]?.text ?? '')['length']).toBe(
      '<html><body>hi</body></html>'.length,
    );

    client.close();
  });

  it('bg_wait_for_network_idle needs an active network subscription, then resolves once the in-flight count settles', async () => {
    const { client, gateway } = await connectFakeClientWithDevtools();
    const state = createMcpStateForTest({ client });

    const beforeSub = await callAutomationTool(state, 'bg_wait_for_network_idle', {});
    expect(beforeSub.isError).toBe(true);
    expect(trailerOf(beforeSub.content[0]?.text ?? '')['code']).toBe('POLICY_DENIED');

    const subPromise = callAutomationTool(state, 'bg_diagnostics_subscribe', { network: true });
    await tick();
    await subPromise;

    const waitPromise = callAutomationTool(state, 'bg_wait_for_network_idle', {
      idleMs: 100,
      timeoutMs: 5000,
    });
    gateway.sendNetworkSummary(client.targetId, { inFlight: 0 });
    await tick(100);
    const result = await waitPromise;
    expect(result.isError).toBeFalsy();
    expect(trailerOf(result.content[0]?.text ?? '')['ok']).toBe(true);

    client.close();
  });

  it('an unknown tool name reports a clean error rather than throwing', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const result = await callAutomationTool(state, 'bg_nonexistent', {});
    expect(result.isError).toBe(true);
    client.close();
  });
});
