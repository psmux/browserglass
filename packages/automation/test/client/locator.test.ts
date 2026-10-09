import { MAX_EVALUATE_TIMEOUT_MS } from '@browserglass/protocol';
import type { Capability, EvaluateWorld } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationError } from '../../src/errors.js';
import { AutomationClient } from '../../src/index.js';
import { LocatorEngine, type LocatorRuntime } from '../../src/locator/engine.js';
import {
  CLEAR_SCRIPT,
  DISPATCH_CLICK_SCRIPT,
  FIND_IN_PAGE_SCRIPT,
  LOCATOR_REF_ATTRIBUTE,
  READ_SCRIPT,
  RESOLVE_SCRIPT,
  SELECT_SCRIPT,
  WAIT_SCRIPT,
} from '../../src/locator/script.js';
import {
  MAX_FRAME_SEGMENTS,
  STALE_RESOLVE_WINDOW_MS,
  parseRoleValue,
  parseSelector,
  splitSegments,
} from '../../src/locator/selector.js';
import type { LocatorMatch } from '../../src/locator/types.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { fixtureOptions, tick } from '../helpers.js';

/** The harness default plus `evaluate`, which the default deliberately omits. */
const GRANTED = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'automation',
  'evaluate',
] as Capability[];

async function grantedClient() {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const gateway = startScriptedGateway(harness, { granted: GRANTED });
  const client = await connectPromise;
  return { client, gateway, harness };
}

// ====================================================================
// Fixtures for the shapes the page script returns. Written out in full
// rather than partially, because a partial fixture would let a missing
// field in the real script pass a test that the client would then read as
// `undefined`.
// ====================================================================

function wireMatch(over: Partial<LocatorMatch> = {}): LocatorMatch {
  return {
    index: 0,
    ref: 'bgtest_0',
    tagName: 'button',
    type: null,
    id: 'submit',
    name: null,
    role: null,
    rect: { x: 10, y: 20, w: 100, h: 40 },
    center: { x: 60, y: 40 },
    attached: true,
    visible: true,
    enabled: true,
    disabledReason: null,
    editable: false,
    stable: true,
    hitTestOk: true,
    occludedBy: null,
    hitReason: null,
    inViewport: true,
    opacity: 1,
    pointerEvents: 'auto',
    text: 'Apply',
    value: null,
    checked: null,
    readValue: null,
    describe: 'button#submit',
    ...over,
  };
}

function wireResult(matches: LocatorMatch[], over: Record<string, unknown> = {}) {
  return {
    matches,
    total: matches.length,
    truncated: false,
    engine: 'css',
    segments: 1,
    scopeMissing: false,
    selectorError: null,
    url: 'https://shop.example.com/checkout',
    title: 'Apply',
    viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
    ...over,
  };
}

/**
 * A `LocatorRuntime` under full test control.
 *
 * The engine is tested against this rather than through the socket for the
 * cases that are about TIME (the staleness window, the retry budget) and
 * about SEQUENCE (click then clear then type then read back). Both need the
 * clock and the reply order in the test's hands; a scripted gateway replies
 * synchronously and can express neither.
 */
class FakeRuntime implements LocatorRuntime {
  readonly defaultTimeoutMs = 15000;
  readonly evaluations: Array<{
    targetId: string;
    source: string;
    args: readonly unknown[];
    timeoutMs: number;
    world: EvaluateWorld;
  }> = [];
  readonly expressions: Array<{ expression: string; timeoutMs: number; world: EvaluateWorld }> = [];
  readonly clicks: Array<{ x: number; y: number; opts: unknown }> = [];
  readonly moves: Array<{ x: number; y: number }> = [];
  readonly wheels: Array<{ x: number; y: number; dx: number; dy: number }> = [];
  readonly typed: Array<{ text: string; delayMs: number }> = [];
  readonly inserted: string[] = [];
  readonly sleeps: number[] = [];

  /** Queued answers, consumed in order; the last one repeats. */
  resolveReplies: Array<Record<string, unknown>> = [];
  waitReplies: Array<Record<string, unknown>> = [];
  readReplies: Array<Record<string, unknown>> = [];
  clearReply: Record<string, unknown> = { found: true, cleared: true };
  dispatchReply: Record<string, unknown> = { found: true };
  selectReply: Record<string, unknown> = { found: true, values: [], labels: [] };
  findInPageReply: Record<string, unknown> = {
    matches: [],
    total: 0,
    truncated: false,
    scopeMissing: false,
    patternError: null,
    url: 'https://shop.example.com/checkout',
    title: 'Apply',
  };
  verifyReplies: unknown[] = [];
  /** Milliseconds the fake clock jumps in `prepareDispatch`, standing in for the round trip the input path pays before it can send a frame. */
  advanceOnPrepareMs = 0;
  prepareCalls = 0;

  /** Every `queryAndStampByRole` call, in order. */
  readonly roleCalls: Array<{
    role: string | undefined;
    name: string | undefined;
    timeoutMs: number;
  }> = [];
  /** Queued answers, consumed in order; the last one repeats. Unset, a call throws: a test exercising `role=` has to say what the CDP side found. */
  roleReplies: Array<{ attr: string | null }> = [];
  /** Thrown, one per call and in order, by `WAIT_SCRIPT` evaluations before any reply is used. */
  waitErrors: unknown[] = [];
  /** What `listFrameTargets()` answers. A test wanting a cross-origin `frame=` hop to succeed sets this to the one `iframe`-kind target its `src` should correlate to. */
  frameTargets: Array<{ targetId: string; url: string }> = [];

  private shift(queue: Array<Record<string, unknown>>): Record<string, unknown> {
    if (queue.length === 0) throw new Error('FakeRuntime: no scripted reply left for this call');
    return queue.length === 1
      ? (queue[0] as Record<string, unknown>)
      : (queue.shift() as Record<string, unknown>);
  }

  async evaluateFunction<T>(
    targetId: string,
    source: string,
    args: readonly unknown[],
    timeoutMs: number,
    world: EvaluateWorld,
  ): Promise<T> {
    this.evaluations.push({ targetId, source, args, timeoutMs, world });
    if (source === RESOLVE_SCRIPT) return this.shift(this.resolveReplies) as T;
    if (source === WAIT_SCRIPT) {
      const err = this.waitErrors.shift();
      if (err !== undefined) throw err;
      return this.shift(this.waitReplies) as T;
    }
    if (source === READ_SCRIPT) return this.shift(this.readReplies) as T;
    if (source === CLEAR_SCRIPT) return this.clearReply as T;
    if (source === DISPATCH_CLICK_SCRIPT) return this.dispatchReply as T;
    if (source === SELECT_SCRIPT) return this.selectReply as T;
    if (source === FIND_IN_PAGE_SCRIPT) return this.findInPageReply as T;
    throw new Error('FakeRuntime: unrecognised script source');
  }

  async evaluateExpression<T>(
    _targetId: string,
    expression: string,
    timeoutMs: number,
    world: EvaluateWorld,
  ): Promise<T> {
    this.expressions.push({ expression, timeoutMs, world });
    if (this.verifyReplies.length === 0) return false as T;
    return (
      this.verifyReplies.length === 1 ? this.verifyReplies[0] : this.verifyReplies.shift()
    ) as T;
  }

  async prepareDispatch(_targetId: string): Promise<void> {
    this.prepareCalls += 1;
    if (this.advanceOnPrepareMs > 0) vi.setSystemTime(Date.now() + this.advanceOnPrepareMs);
  }

  async clickPoint(
    _targetId: string,
    x: number,
    y: number,
    opts: Record<string, unknown>,
  ): Promise<void> {
    this.clicks.push({ x, y, opts });
  }

  async movePoint(_targetId: string, x: number, y: number): Promise<void> {
    this.moves.push({ x, y });
  }

  async wheelAt(_targetId: string, x: number, y: number, dx: number, dy: number): Promise<void> {
    this.wheels.push({ x, y, dx, dy });
  }

  async typeChars(_targetId: string, text: string, delayMs: number): Promise<void> {
    this.typed.push({ text, delayMs });
  }

  async insertText(_targetId: string, text: string): Promise<void> {
    this.inserted.push(text);
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
  }

  async queryAndStampByRole(
    _targetId: string,
    role: string | undefined,
    name: string | undefined,
    timeoutMs: number,
  ): Promise<{ attr: string | null }> {
    this.roleCalls.push({ role, name, timeoutMs });
    if (this.roleReplies.length === 0)
      throw new Error('FakeRuntime: no scripted role reply left for this call');
    return this.roleReplies.length === 1
      ? (this.roleReplies[0] as { attr: string | null })
      : (this.roleReplies.shift() as { attr: string | null });
  }

  listFrameTargets(): readonly { targetId: string; url: string }[] {
    return this.frameTargets;
  }

  /** The spec object the last call to `source` was given. */
  lastSpec(source: string): Record<string, unknown> {
    for (let i = this.evaluations.length - 1; i >= 0; i--) {
      const e = this.evaluations[i];
      if (e && e.source === source) return (e.args[0] ?? {}) as Record<string, unknown>;
    }
    throw new Error('FakeRuntime: that script was never evaluated');
  }

  count(source: string): number {
    return this.evaluations.filter((e) => e.source === source).length;
  }
}

function engineWith(): { engine: LocatorEngine; rt: FakeRuntime } {
  const rt = new FakeRuntime();
  return { engine: new LocatorEngine(rt), rt };
}

// ====================================================================

describe('locator selector dialect', () => {
  it('splits on >> and leaves CSS child combinators, quotes and brackets alone', () => {
    expect(splitSegments('button')).toEqual(['button']);
    expect(splitSegments('div > span')).toEqual(['div > span']);
    expect(splitSegments('input#a >> xpath=ancestor::label[1]')).toEqual([
      'input#a',
      'xpath=ancestor::label[1]',
    ]);
    expect(splitSegments('button >> visible=true')).toEqual(['button', 'visible=true']);
    // The bug this scanner exists to avoid: a '>>' inside an attribute
    // value is data, not a combinator.
    expect(splitSegments('[data-x=">>"]')).toEqual(['[data-x=">>"]']);
    expect(splitSegments("[title='a >> b'] >> span")).toEqual(["[title='a >> b']", 'span']);
  });

  it('defaults to CSS, honours an explicit engine prefix, and auto-detects XPath on a leading slash', () => {
    expect(parseSelector('[data-testid="x"]')[0]).toMatchObject({ engine: 'css' });
    expect(parseSelector('text=Submit')[0]).toMatchObject({ engine: 'text', value: 'Submit' });
    expect(parseSelector('label=Email')[0]).toMatchObject({ engine: 'label', value: 'Email' });
    expect(parseSelector('ref=bg123_0')[0]).toMatchObject({ engine: 'ref', value: 'bg123_0' });
    expect(parseSelector('css=/not/xpath')[0]).toMatchObject({
      engine: 'css',
      value: '/not/xpath',
    });
    expect(parseSelector('input >> xpath=..')[1]).toMatchObject({ engine: 'xpath', value: '..' });
  });

  it('refuses an XPath primary selector, naming the chained spelling that is supported', () => {
    for (const bad of ['//button[1]', 'xpath=//button[1]', '(//div)[2]']) {
      expect(() => parseSelector(bad)).toThrowError(/XPath is supported only as a chained segment/);
    }
    // The one that is supported, and the reason the refusal is affordable:
    // the XPath real scripts need is a relative walk off an element CSS
    // already found.
    expect(() => parseSelector('input#first >> xpath=ancestor::label[1]')).not.toThrow();
  });

  it('refuses visible= as a primary selector, because it filters rather than matches', () => {
    expect(() => parseSelector('visible=true')).toThrowError(/It is a filter, not a matcher/);
    expect(() => parseSelector('button >> visible=true')).not.toThrow();
  });

  it('refuses an empty selector locally', () => {
    expect(() => parseSelector('   ')).toThrowError(/non-empty string/);
  });

  it('parses role= as a bare role, or a role plus an exact quoted name', () => {
    expect(parseSelector('role=button')[0]).toMatchObject({ engine: 'role', value: 'button' });
    expect(parseRoleValue('button', 'role=button')).toEqual({ role: 'button', name: null });
    expect(parseRoleValue('button[name="Submit"]', 'role=button[name="Submit"]')).toEqual({
      role: 'button',
      name: 'Submit',
    });
    // No escape processing, mirroring text="exact phrase"'s own convention.
    expect(parseRoleValue('link[name="Say \\"hi\\""]', 'x')).toEqual({
      role: 'link',
      name: 'Say \\"hi\\"',
    });
  });

  it('refuses a malformed role= value locally, before any round trip', () => {
    for (const bad of ['role=', 'role=button[name=Submit]', 'role=button[Submit]']) {
      expect(() => parseSelector(bad)).toThrowError(/not a role filter/);
    }
  });

  it('validates every role= segment in a chain, not just the first', () => {
    expect(() => parseSelector('div.form >> role=')).toThrowError(/not a role filter/);
  });
});

describe('the page-side scripts', () => {
  /**
   * The one failure mode a text-authored script has that a compiled one
   * does not: an escaping mistake in the template literal that produces
   * source the page cannot parse. It would surface at runtime as a
   * `SyntaxError` from the browser with no useful location, so it is
   * caught here instead, in the exact form the server composes
   * (`(<declaration>).call(globalThis, <literal>)`, `buildExpression` in
   * `packages/core/src/cdp/evaluate.ts`).
   */
  it('every script parses as the function call the server composes', () => {
    for (const [name, src] of Object.entries({
      RESOLVE_SCRIPT,
      WAIT_SCRIPT,
      READ_SCRIPT,
      CLEAR_SCRIPT,
      DISPATCH_CLICK_SCRIPT,
      SELECT_SCRIPT,
      FIND_IN_PAGE_SCRIPT,
    })) {
      expect(() => new Function(`return (${src}).call(globalThis, {});`), name).not.toThrow();
    }
  });

  it('addresses stamps by the one attribute name the client also uses', () => {
    expect(LOCATOR_REF_ATTRIBUTE).toBe('data-bgls-ref');
    for (const src of [READ_SCRIPT, CLEAR_SCRIPT, DISPATCH_CLICK_SCRIPT, SELECT_SCRIPT]) {
      expect(src).toContain(JSON.stringify(LOCATOR_REF_ATTRIBUTE));
    }
    expect(RESOLVE_SCRIPT).toContain(JSON.stringify(LOCATOR_REF_ATTRIBUTE));
    expect(FIND_IN_PAGE_SCRIPT).toContain(JSON.stringify(LOCATOR_REF_ATTRIBUTE));
  });
});

describe('resolve', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends one evaluate carrying the whole spec, and stamps a fresh ref prefix per call', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([wireMatch()])];

    await engine.resolve('t1', '[data-testid="x"]');
    const first = rt.lastSpec(RESOLVE_SCRIPT);
    expect(first).toMatchObject({
      selector: '[data-testid="x"]',
      limit: 50,
      stamp: true,
      stable: true,
      hitTest: true,
      scroll: false,
    });
    await engine.resolve('t1', '[data-testid="x"]');
    // A per-call prefix, so two concurrent resolves on one page cannot mint
    // the same token for different elements.
    expect(rt.lastSpec(RESOLVE_SCRIPT)['refPrefix']).not.toBe(first['refPrefix']);
  });

  it('reports nothing, one and many all as ordinary answers, with no strict mode anywhere', async () => {
    const { engine, rt } = engineWith();

    rt.resolveReplies = [wireResult([])];
    const none = await engine.resolve('t1', 'button');
    expect(none.matches).toEqual([]);
    expect(none.total).toBe(0);

    rt.resolveReplies = [
      wireResult([wireMatch(), wireMatch({ index: 1 }), wireMatch({ index: 2 })], {
        total: 9,
        truncated: true,
      }),
    ];
    const many = await engine.resolve('t1', 'button');
    expect(many.total).toBe(9);
    expect(many.truncated).toBe(true);
    expect(many.matches).toHaveLength(3);
  });

  it('stamps the client clock as resolvedAtMs and echoes the selector back', async () => {
    const { engine, rt } = engineWith();
    vi.setSystemTime(1_700_000_000_000);
    rt.resolveReplies = [wireResult([wireMatch()])];
    const r = await engine.resolve('t1', 'button');
    expect(r.resolvedAtMs).toBe(1_700_000_000_000);
    expect(r.selector).toBe('button');
  });

  it('validates the selector locally, before any evaluate is sent', async () => {
    const { engine, rt } = engineWith();
    await expect(engine.resolve('t1', '//button')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(rt.evaluations).toHaveLength(0);
  });

  /**
   * Local validation catches what is wrong on its face; the page's own CSS
   * engine is the authority on the rest, and its refusal comes back as
   * data. Both routes end at INVALID_ARGUMENT, so a caller has one thing
   * to branch on rather than a local error and a page exception carrying
   * a stack.
   */
  it("turns the page's own selector refusal into the same INVALID_ARGUMENT as a local one", async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([], { selectorError: "'button:!!' is not a valid selector" })];
    await expect(engine.resolve('t1', 'button:!!')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { pageError: "'button:!!' is not a valid selector" },
    });
  });
});

/**
 * `role=`, on top of `resolve`/`waitFor` rather than a third implementation:
 * `LocatorEngine.prepareSelector` calls `LocatorRuntime.queryAndStampByRole`
 * to turn a `role=...` segment into `css=[<marker>]` BEFORE either verb's
 * usual `RESOLVE_SCRIPT`/`WAIT_SCRIPT` round trip, so what these tests
 * assert is that rewrite, not a second selector engine.
 */
describe('role= on top of resolve/waitFor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolve() asks queryAndStampByRole with the parsed role/name, then sends the rewritten css=[marker] selector to RESOLVE_SCRIPT, never the literal role= text', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: 'data-bgls-ax-abc' }];
    rt.resolveReplies = [wireResult([wireMatch()])];

    await engine.resolve('t1', 'role=button[name="Submit"]');

    expect(rt.roleCalls).toEqual([
      { role: 'button', name: 'Submit', timeoutMs: rt.defaultTimeoutMs },
    ]);
    expect(rt.lastSpec(RESOLVE_SCRIPT)['selector']).toBe('css=[data-bgls-ax-abc]');
  });

  it('rewrites only the role= segment in a chain, leaving the rest of the selector untouched', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: 'data-bgls-ax-xyz' }];
    rt.resolveReplies = [wireResult([wireMatch()])];

    await engine.resolve('t1', 'div.form >> role=button[name="Submit"] >> visible=true');

    expect(rt.lastSpec(RESOLVE_SCRIPT)['selector']).toBe(
      'div.form >> css=[data-bgls-ax-xyz] >> visible=true',
    );
  });

  it('resolves independent role= segments concurrently, one queryAndStampByRole call per occurrence', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: 'data-bgls-ax-a' }, { attr: 'data-bgls-ax-b' }];
    rt.resolveReplies = [wireResult([wireMatch()])];

    await engine.resolve('t1', 'role=heading >> role=button');

    expect(rt.roleCalls).toHaveLength(2);
    expect(rt.lastSpec(RESOLVE_SCRIPT)['selector']).toBe(
      'css=[data-bgls-ax-a] >> css=[data-bgls-ax-b]',
    );
  });

  it('short-circuits to an empty result when role= matches nothing, without ever calling RESOLVE_SCRIPT', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: null }];

    const r = await engine.resolve('t1', 'role=button[name="Nope"]');

    expect(r).toMatchObject({ matches: [], total: 0, truncated: false, engine: 'role' });
    expect(rt.count(RESOLVE_SCRIPT)).toBe(0);
  });

  it('propagates queryAndStampByRole rejecting (the local devtools capability check) without ever calling RESOLVE_SCRIPT', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = []; // forces the fake to throw, standing in for AutomationClient's own POLICY_DENIED
    await expect(engine.resolve('t1', 'role=button')).rejects.toThrow();
    expect(rt.count(RESOLVE_SCRIPT)).toBe(0);
  });

  it("waitFor(state: 'detached') succeeds immediately when role= matches nothing, without an in-page wait", async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: null }];

    const r = await engine.waitFor('t1', 'role=button', { state: 'detached' });

    expect(r.total).toBe(0);
    expect(r.waitedMs).toBe(0);
    expect(rt.count(WAIT_SCRIPT)).toBe(0);
  });

  it('keeps polling a role= wait until the accessibility query finds the element', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: null }, { attr: null }, { attr: 'data-bgls-ax-late' }];
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];

    const r = await engine.waitFor('t1', 'role=button[name="Late one"]', { timeoutMs: 5000 });

    expect(r.total).toBe(1);
    expect(rt.roleCalls).toHaveLength(3);
    expect(r.checks).toBe(3);
    expect(rt.count(WAIT_SCRIPT)).toBe(1);
  });

  it('fails a role= wait that never matches only after polling, reporting every check', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: null }];

    const err = await engine
      .waitFor('t1', 'role=dialog', { timeoutMs: 1000 })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({ code: 'NOT_FOUND' });
    expect(rt.roleCalls.length).toBeGreaterThan(1);
    expect((err as { details: { checks: number } }).details.checks).toBe(rt.roleCalls.length);
  });

  it('re-queries the accessibility tree when a role= wait slice times out', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: 'data-bgls-ax-a' }, { attr: 'data-bgls-ax-b' }];
    rt.waitReplies = [
      { timedOut: true, result: wireResult([]), waitedMs: 1000, checks: 10, wakes: 0 },
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];

    const r = await engine.waitFor('t1', 'role=button', { timeoutMs: 5000 });

    expect(r.total).toBe(1);
    expect(rt.roleCalls).toHaveLength(2);
    expect(rt.lastSpec(WAIT_SCRIPT)['deadlineMs']).toBeLessThanOrEqual(1000);
  });

  it('keeps waiting through a navigation that tears down the evaluate', async () => {
    const { engine, rt } = engineWith();
    rt.waitErrors = [
      new AutomationError('PROTOCOL_ERROR', 'Inspected target navigated or closed'),
      new Error('Execution context was destroyed.'),
    ];
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];

    const r = await engine.waitFor('t1', '#flash', { timeoutMs: 5000 });

    expect(r.total).toBe(1);
    expect(rt.count(WAIT_SCRIPT)).toBe(3);
  });

  it('does not retry an error that is not a navigation', async () => {
    const { engine, rt } = engineWith();
    rt.waitErrors = [new AutomationError('TARGET_CLOSED', 'Inspected target navigated or closed')];
    await expect(engine.waitFor('t1', '#flash', { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'TARGET_CLOSED',
    });
    rt.waitErrors = [new Error('boom')];
    await expect(engine.waitFor('t1', '#flash', { timeoutMs: 5000 })).rejects.toThrow('boom');
  });

  it("waitFor(state: 'visible') times out immediately when role= matches nothing, without spending the deadline", async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: null }];

    await expect(
      engine.waitFor('t1', 'role=button', { state: 'visible', timeoutMs: 5000 }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    expect(rt.count(WAIT_SCRIPT)).toBe(0);
  });

  it('waitFor() rewrites role= before building the WAIT_SCRIPT check/stamp specs', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: 'data-bgls-ax-q' }];
    rt.waitReplies = [{ timedOut: false, result: wireResult([wireMatch()]) }];

    await engine.waitFor('t1', 'role=button', { state: 'visible' });

    const spec = rt.lastSpec(WAIT_SCRIPT);
    expect((spec['check'] as Record<string, unknown>)['selector']).toBe('css=[data-bgls-ax-q]');
    expect((spec['stamp'] as Record<string, unknown> | null)?.['selector']).toBe(
      'css=[data-bgls-ax-q]',
    );
  });

  it('click() drives role= through the ordinary pipeline: one role query, then the normal waitFor/click round trips', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: 'data-bgls-ax-c' }];
    rt.waitReplies = [{ timedOut: false, result: wireResult([wireMatch()]) }];

    const result = await engine.click('t1', 'role=button[name="Submit"]');

    expect(result.ok).toBe(true);
    // Exactly one AX round trip for the whole click, not one per internal
    // waitFor/resolve re-check: `click()` calls `waitFor()` once here and
    // never re-resolves (the measurement is fresh), so `role=` is rewritten
    // exactly once too.
    expect(rt.roleCalls).toHaveLength(1);
  });
});

describe('the read verbs', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The claim being checked is the round-trip count, not the return value.
   * `innerText`, `getAttribute` and `isChecked` call sites in real scripts
   * nearly always follow a locate; folding the
   * read into the locate is the whole reason they are verbs rather than
   * one-line `evaluate` calls.
   */
  it('each costs exactly one evaluate, with the read folded into the resolver spec', async () => {
    const { engine, rt } = engineWith();

    rt.resolveReplies = [wireResult([wireMatch({ readValue: 'Place order' })])];
    expect(await engine.innerText('t1', 'button')).toBe('Place order');
    expect(rt.count(RESOLVE_SCRIPT)).toBe(1);
    expect(rt.lastSpec(RESOLVE_SCRIPT)).toMatchObject({
      read: { what: 'innerText' },
      stable: false,
      hitTest: false,
      stamp: false,
    });

    rt.resolveReplies = [wireResult([wireMatch({ readValue: 'submit-btn' })])];
    expect(await engine.getAttribute('t1', 'button', 'data-testid')).toBe('submit-btn');
    expect(rt.lastSpec(RESOLVE_SCRIPT)).toMatchObject({
      read: { what: 'attribute', name: 'data-testid' },
    });

    rt.resolveReplies = [wireResult([wireMatch({ readValue: true })])];
    expect(await engine.isChecked('t1', 'input')).toBe(true);
    expect(rt.count(RESOLVE_SCRIPT)).toBe(3);
  });

  it('distinguishes an absent attribute from a selector that matched nothing', async () => {
    const { engine, rt } = engineWith();

    rt.resolveReplies = [wireResult([wireMatch({ readValue: null })])];
    expect(await engine.getAttribute('t1', 'button', 'data-x')).toBeNull();

    rt.resolveReplies = [wireResult([])];
    await expect(engine.getAttribute('t1', 'button', 'data-x')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      details: { matchCount: 0, url: 'https://shop.example.com/checkout' },
    });
  });

  it('says how many DID match when the asked-for index is out of range', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([wireMatch()], { total: 1 })];
    await expect(engine.innerText('t1', 'button', { index: 4 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('only 1 element(s) matched, so there is no index 4'),
    });
  });
});

describe('waitFor', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is ONE evaluate holding in the page, not a client-side poll loop', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 340, checks: 3, wakes: 2 },
    ];

    const r = await engine.waitFor('t1', 'button', { state: 'actionable', timeoutMs: 8000 });

    expect(rt.evaluations).toHaveLength(1);
    expect(r.waitedMs).toBe(340);
    expect(r.wakes).toBe(2);
    const spec = rt.lastSpec(WAIT_SCRIPT);
    expect(spec).toMatchObject({ state: 'actionable', deadlineMs: 8000, pollMs: 100 });
  });

  /**
   * The transport and server deadline has to outlive the in-page one, or a
   * server evaluate timeout arrives first and replaces a report naming the
   * failed actionability check with a bare `evaluate.timeout`.
   */
  it('gives the evaluate a longer deadline than the wait it contains', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    await engine.waitFor('t1', 'button', { timeoutMs: 8000 });
    const call = rt.evaluations[0];
    expect(call?.timeoutMs).toBeGreaterThan(8000);
  });

  it('clamps the in-page deadline so the wait plus its margin still fits the server cap', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    await engine.waitFor('t1', 'button', { timeoutMs: 10 * 60 * 1000 });
    const call = rt.evaluations[0];
    expect(call?.timeoutMs).toBeLessThanOrEqual(MAX_EVALUATE_TIMEOUT_MS);
    expect(rt.lastSpec(WAIT_SCRIPT)['deadlineMs']).toBeLessThan(MAX_EVALUATE_TIMEOUT_MS);
  });

  /**
   * The polling passes measure less than the winning pass, and never
   * stamp. A stamp is an attribute write, the in-page MutationObserver
   * would see its own writes, and the wait would spin itself awake while
   * scribbling on a page an anti-automation script is reading.
   */
  it('polls without stamping and stamps exactly once, on the pass that wins', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    await engine.waitFor('t1', 'button', { state: 'visible' });
    const spec = rt.lastSpec(WAIT_SCRIPT);
    expect((spec['check'] as Record<string, unknown>)['stamp']).toBe(false);
    // 'visible' does not depend on rect stability or the hit test, so the
    // polling pass does not pay two animation frames for them.
    expect((spec['check'] as Record<string, unknown>)['stable']).toBe(false);
    expect((spec['check'] as Record<string, unknown>)['hitTest']).toBe(false);
    expect((spec['stamp'] as Record<string, unknown>)['stamp']).toBe(true);
  });

  it("measures fully while polling only when the state asked for is 'actionable'", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    await engine.waitFor('t1', 'button', { state: 'actionable' });
    const check = rt.lastSpec(WAIT_SCRIPT)['check'] as Record<string, unknown>;
    expect(check['stable']).toBe(true);
    expect(check['hitTest']).toBe(true);
  });

  it('turns a timeout into an error naming the failed check and the state it saw', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: true,
        result: wireResult([
          wireMatch({
            visible: true,
            enabled: true,
            hitTestOk: false,
            occludedBy: 'div[data-testid="click_filter"]',
            hitReason: 'covered',
          }),
        ]),
        waitedMs: 8000,
        checks: 80,
        wakes: 12,
      },
    ];

    await expect(
      engine.waitFor('t1', 'button', { state: 'actionable', timeoutMs: 8000 }),
    ).rejects.toMatchObject({
      code: 'OCCLUDED',
      message: expect.stringContaining('div[data-testid="click_filter"]'),
      details: {
        check: 'receivesEvents',
        occludedBy: 'div[data-testid="click_filter"]',
        state: { visible: true, enabled: true, hitTestOk: false },
      },
    });
  });

  it('reports each failing check with its own code', async () => {
    const cases: Array<[Partial<LocatorMatch>, string, RegExp]> = [
      [{ attached: false }, 'DETACHED', /left the document/],
      [{ visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } }, 'NOT_VISIBLE', /its rect is 0x0/],
      [
        { enabled: false, disabledReason: 'ancestor fieldset[disabled]' },
        'DISABLED',
        /ancestor fieldset\[disabled\]/,
      ],
      [{ stable: false }, 'NOT_STABLE', /still moving/],
    ];
    for (const [over, code, message] of cases) {
      const { engine, rt } = engineWith();
      rt.waitReplies = [
        {
          timedOut: true,
          result: wireResult([wireMatch(over)]),
          waitedMs: 3000,
          checks: 30,
          wakes: 1,
        },
      ];
      await expect(
        engine.waitFor('t1', 'button', { state: 'actionable', timeoutMs: 3000 }),
      ).rejects.toMatchObject({ code, message: expect.stringMatching(message) });
    }
  });

  it('says nothing matched rather than blaming an actionability check when nothing matched', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: true, result: wireResult([]), waitedMs: 5000, checks: 50, wakes: 0 },
    ];
    await expect(engine.waitFor('t1', '#missing', { timeoutMs: 5000 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('50 checks'),
    });
  });

  it("words a 'detached' and a 'hidden' timeout the right way round", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: true, result: wireResult([wireMatch()]), waitedMs: 2000, checks: 20, wakes: 0 },
    ];
    await expect(
      engine.waitFor('t1', '.spinner', { state: 'detached', timeoutMs: 2000 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('still in the document'),
    });

    const b = engineWith();
    b.rt.waitReplies = [
      {
        timedOut: true,
        result: wireResult([wireMatch({ visible: true })]),
        waitedMs: 2000,
        checks: 20,
        wakes: 0,
      },
    ];
    await expect(
      b.engine.waitFor('t1', '.spinner', { state: 'hidden', timeoutMs: 2000 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining('still visible'),
    });
  });

  it('propagates a selector the page cannot parse instead of retrying it for the whole deadline', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        failed: true,
        error: "'button:!!' is not a valid selector",
        result: null,
        waitedMs: 2,
        checks: 1,
        wakes: 0,
      },
    ];
    await expect(engine.waitFor('t1', 'button:!!', { timeoutMs: 8000 })).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      details: { pageError: "'button:!!' is not a valid selector" },
    });
  });
});

describe('click', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for actionable, then dispatches at the rect centre through the input path', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];

    const r = await engine.click('t1', '[data-testid="submit"]', { timeoutMs: 8000 });

    expect(rt.clicks).toEqual([{ x: 60, y: 40, opts: {} }]);
    expect(r).toMatchObject({
      ok: true,
      via: 'coordinates',
      ref: 'bgtest_0',
      point: { x: 60, y: 40 },
      matchCount: 1,
      attempts: 1,
      verified: null,
      reResolved: false,
    });
  });

  /**
   * The scroll has to happen inside the same evaluation that measures.
   * Measuring after a scroll performed in a previous round trip is
   * measuring a different page, and the cost shows up in production: a
   * rect read while the control was below the fold gave
   * coordinates that pointed at whatever was at that spot on screen, and
   * the mouse route clicked empty page.
   */
  it('asks the resolver to scroll inside the measuring evaluation, not as a separate call', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([
          wireMatch({ index: 0 }),
          wireMatch({ index: 1 }),
          wireMatch({ index: 2 }),
        ]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    await engine.click('t1', 'button', { index: 2 });
    const check = rt.lastSpec(WAIT_SCRIPT)['check'] as Record<string, unknown>;
    expect(check['scroll']).toBe(true);
    expect(check['scrollIndex']).toBe(2);
    // And the wait itself is told which match it is waiting for, so a
    // sibling becoming ready first does not release it.
    expect(rt.lastSpec(WAIT_SCRIPT)['index']).toBe(2);
  });

  it('says so when the index asked for is beyond what matched, rather than describing a different element', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    await expect(engine.click('t1', 'button', { index: 3 })).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('index 3 was asked for and only 1 element(s) matched'),
    });
    expect(rt.clicks).toHaveLength(0);
  });

  it('picks the first fully actionable match when no index is given, and reports how many there were', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult(
          [
            wireMatch({ index: 0, visible: false, center: { x: 1, y: 1 } }),
            wireMatch({
              index: 1,
              hitTestOk: false,
              occludedBy: 'div.overlay',
              center: { x: 2, y: 2 },
            }),
            wireMatch({ index: 2, ref: 'bgtest_2', center: { x: 300, y: 400 } }),
          ],
          { total: 3 },
        ),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    const r = await engine.click('t1', 'button');
    expect(rt.clicks).toEqual([{ x: 300, y: 400, opts: {} }]);
    expect(r).toMatchObject({ index: 2, matchCount: 3, ref: 'bgtest_2' });
  });

  it('acts on the index it was given even when a later match would have been actionable, and reports THAT one on failure', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult(
          [
            wireMatch({ index: 0, enabled: false, disabledReason: 'element.disabled' }),
            wireMatch({ index: 1, ref: 'bgtest_1' }),
          ],
          { total: 2 },
        ),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    await expect(engine.click('t1', 'button', { index: 0 })).rejects.toMatchObject({
      code: 'DISABLED',
      details: { state: { index: 0 } },
    });
    expect(rt.clicks).toHaveLength(0);
  });

  /**
   * The dangerous sequence: resolve returns a rect, the element detaches,
   * something else moves into that screen position, and the click lands on
   * it. Anything that can consume real time between the measurement and
   * the dispatch reopens that window, so the window is checked rather than
   * assumed away.
   */
  it('re-resolves when more than the stale window elapsed between measuring and dispatching', async () => {
    const { engine, rt } = engineWith();
    vi.setSystemTime(1_700_000_000_000);
    rt.advanceOnPrepareMs = STALE_RESOLVE_WINDOW_MS + 150;
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ center: { x: 60, y: 40 } })]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    rt.resolveReplies = [
      wireResult([wireMatch({ ref: 'bgtest_fresh', center: { x: 900, y: 120 } })]),
    ];

    const r = await engine.click('t1', 'button');

    expect(r.reResolved).toBe(true);
    expect(r.ref).toBe('bgtest_fresh');
    // The click went to the FRESH coordinates, never the stale ones.
    expect(rt.clicks).toEqual([{ x: 900, y: 120, opts: {} }]);
  });

  it('does not re-resolve when the measurement is still inside the window', async () => {
    const { engine, rt } = engineWith();
    rt.advanceOnPrepareMs = 10;
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    const r = await engine.click('t1', 'button');
    expect(r.reResolved).toBe(false);
    expect(rt.prepareCalls).toBe(1);
    expect(rt.count(RESOLVE_SCRIPT)).toBe(0);
  });

  it('reports a verified click as verified, and does not retry one that passed', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.verifyReplies = [true];

    const r = await engine.click('t1', 'button', {
      verify: 'document.querySelectorAll("[role=option]").length > 0',
    });

    expect(r.verified).toBe(true);
    expect(r.attempts).toBe(1);
    expect(rt.expressions[0]?.expression).toBe(
      'document.querySelectorAll("[role=option]").length > 0',
    );
    expect(rt.sleeps).toEqual([250]);
  });

  /**
   * The difference between "a click was delivered" and "a click worked".
   * Playwright has no equivalent, and its absence has a real cost: a
   * reported success on a click that landed on a transparent overlay with
   * the menu never having opened.
   */
  it('retries a click whose verify predicate never passes, then blames what was on top of the element', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ occludedBy: 'div[data-testid="click_filter"]' })]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    rt.verifyReplies = [false];

    await expect(
      engine.click('t1', 'button', { verify: 'window.opened', retries: 2, timeoutMs: 20000 }),
    ).rejects.toMatchObject({
      code: 'OCCLUDED',
      message: expect.stringContaining('div[data-testid="click_filter"]'),
      details: { delivered: true, verified: false, verify: 'window.opened', attempts: 3 },
    });
    expect(rt.clicks).toHaveLength(3);
  });

  it('reports an unverified click with nothing on top as a timeout that says the click did reach the element', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ occludedBy: null })]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    rt.verifyReplies = [false];
    await expect(
      engine.click('t1', 'button', { verify: 'window.opened', retries: 0 }),
    ).rejects.toMatchObject({
      code: 'TIMEOUT',
      message: expect.stringContaining(
        'The click reached the element; the page did not do what was expected of it',
      ),
    });
  });

  it('does not retry without a verify predicate, because there would be nothing to retry on', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    await engine.click('t1', 'button', { retries: 5 });
    expect(rt.clicks).toHaveLength(1);
    expect(rt.expressions).toHaveLength(0);
  });

  it("via: 'dispatch' calls element.click() by ref and never computes a coordinate", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    const r = await engine.click('t1', 'button', { via: 'dispatch' });
    expect(rt.clicks).toHaveLength(0);
    expect(rt.lastSpec(DISPATCH_CLICK_SCRIPT)).toEqual({ ref: 'bgtest_0' });
    expect(r.point).toBeNull();
  });

  it('reports a ref that no longer resolves as DETACHED and stale, never as a no-op or a generic timeout', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.dispatchReply = { found: false };
    await expect(engine.click('t1', 'button', { via: 'dispatch' })).rejects.toMatchObject({
      code: 'DETACHED',
      message: expect.stringContaining('valid until its subtree re-renders'),
      details: { stale: true, ref: 'bgtest_0' },
    });
  });

  it("refuses via: 'dispatch' together with stamp: false, which has nothing to address", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ ref: null })]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    await expect(
      engine.click('t1', 'button', { via: 'dispatch', stamp: false }),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('fill', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const editable = () =>
    wireMatch({ tagName: 'input', editable: true, value: 'old value', describe: 'input#email' });

  it('clicks to focus, clears, types real keys, and reads the value back', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([editable()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.readReplies = [{ found: true, value: 'ada@example.test' }];

    const r = await engine.fill('t1', '#email', 'ada@example.test');

    expect(rt.clicks).toEqual([{ x: 60, y: 40, opts: {} }]);
    expect(rt.count(CLEAR_SCRIPT)).toBe(1);
    expect(rt.typed).toEqual([{ text: 'ada@example.test', delayMs: 0 }]);
    expect(rt.inserted).toEqual([]);
    expect(r).toMatchObject({
      ok: true,
      mode: 'keys',
      actual: 'ada@example.test',
      verified: true,
      ref: 'bgtest_0',
    });
  });

  /**
   * The default is real keys and not `Input.insertText`, and it is not a
   * style preference: insertText fires `beforeinput` and `input` and no
   * `keydown` at all, and the filtering comboboxes this surface exists for
   * open and filter on `keydown`.
   */
  it("mode: 'insert' sends one insertText and no key events, and is never the default", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([editable()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.readReplies = [{ found: true, value: 'x' }];
    await engine.fill('t1', '#email', 'x', { mode: 'insert' });
    expect(rt.inserted).toEqual(['x']);
    expect(rt.typed).toEqual([]);
  });

  it('passes the inter-character delay through to the preemption-checked typing loop', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([editable()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.readReplies = [{ found: true, value: 'abc' }];
    await engine.fill('t1', '#email', 'abc', { delayMs: 40 });
    expect(rt.typed).toEqual([{ text: 'abc', delayMs: 40 }]);
  });

  it('skips the clear when the field is already empty', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ tagName: 'input', editable: true, value: '' })]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    rt.readReplies = [{ found: true, value: 'x' }];
    await engine.fill('t1', '#email', 'x');
    expect(rt.count(CLEAR_SCRIPT)).toBe(0);
  });

  it('reports a value that did not stick as verified false rather than claiming success', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([editable()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    // A masked or reformatting input: what went in is not what came out.
    rt.readReplies = [{ found: true, value: '(555) 010-9999' }];
    const r = await engine.fill('t1', '#phone', '5550109999');
    expect(r.verified).toBe(false);
    expect(r.actual).toBe('(555) 010-9999');
  });

  it('throws on a value that did not stick when strict is set, without echoing the value', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([editable()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    // The live failure: the trailing '!' of a password never reached the field.
    rt.readReplies = [{ found: true, value: 'SuperSecretPassword' }];
    const err = await engine
      .fill('t1', '#password', 'SuperSecretPassword!', { strict: true })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'TIMEOUT',
      details: { verified: false, expectedLength: 20, actualLength: 19, firstMismatchAt: 19 },
    });
    expect(String((err as Error).message)).not.toContain('SuperSecret');
  });

  it('refuses a match that is not editable, naming the element it actually found', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([
          wireMatch({ tagName: 'div', editable: false, describe: 'div.field-wrapper' }),
        ]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    await expect(engine.fill('t1', '.field-wrapper', 'x')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('div.field-wrapper'),
    });
    expect(rt.typed).toHaveLength(0);
  });

  it('reports a ref that vanished between the click and the read-back as stale', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([editable()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.readReplies = [{ found: false }];
    await expect(engine.fill('t1', '#email', 'x')).rejects.toMatchObject({
      code: 'DETACHED',
      details: { stale: true },
    });
  });
});

describe('select', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const selectEl = () => wireMatch({ tagName: 'select', describe: 'select#country' });

  it('a bare string is shorthand for {value}, and reports what was actually selected', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([selectEl()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.selectReply = { found: true, values: ['US'], labels: ['United States'] };

    const r = await engine.select('t1', '#country', 'US');

    expect(rt.lastSpec(SELECT_SCRIPT)).toEqual({ ref: 'bgtest_0', options: [{ value: 'US' }] });
    expect(r).toMatchObject({
      ok: true,
      ref: 'bgtest_0',
      values: ['US'],
      labels: ['United States'],
      matchCount: 1,
      index: 0,
    });
  });

  it('passes a {label} or {index} spec through untouched, and an array as multiple specs', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([selectEl()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.selectReply = { found: true, values: ['CA', 'US'], labels: ['Canada', 'United States'] };

    await engine.select('t1', '#country', [{ label: 'Canada' }, { index: 3 }]);

    expect(rt.lastSpec(SELECT_SCRIPT)).toEqual({
      ref: 'bgtest_0',
      options: [{ label: 'Canada' }, { index: 3 }],
    });
  });

  it('waits for the <select> to be actionable before acting, the same rule click/fill wait on', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([selectEl()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.selectReply = { found: true, values: ['US'], labels: ['United States'] };
    await engine.select('t1', '#country', 'US');
    expect(rt.lastSpec(WAIT_SCRIPT)).toMatchObject({ state: 'actionable' });
  });

  it('refuses a match that is not a <select>, naming the element it actually found', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ tagName: 'div', describe: 'div.fake-select' })]),
        waitedMs: 5,
        checks: 1,
        wakes: 0,
      },
    ];
    await expect(engine.select('t1', '.fake-select', 'US')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('div.fake-select'),
    });
    // Refused before any mutation was attempted.
    expect(rt.count(SELECT_SCRIPT)).toBe(0);
  });

  it('names every option that did not match AND every option the <select> actually offers, and mutates nothing', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([selectEl()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.selectReply = {
      found: true,
      missing: [{ value: 'ZZ' }],
      available: [
        { value: 'US', label: 'United States', index: 0 },
        { value: 'MX', label: 'Mexico', index: 1 },
      ],
    };
    await expect(engine.select('t1', '#country', 'ZZ')).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining("value 'ZZ'"),
      details: {
        missing: [{ value: 'ZZ' }],
        available: [
          { value: 'US', label: 'United States', index: 0 },
          { value: 'MX', label: 'Mexico', index: 1 },
        ],
      },
    });
  });

  it("refuses more than one option on a <select> that has no 'multiple' attribute, naming how many were asked for", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([selectEl()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.selectReply = { found: true, notMultiple: true };
    await expect(engine.select('t1', '#country', ['US', 'CA'])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('2 options'),
      details: { requested: 2 },
    });
  });

  it('reports a ref that vanished between the resolve and the mutation as stale', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([selectEl()]), waitedMs: 5, checks: 1, wakes: 0 },
    ];
    rt.selectReply = { found: false };
    await expect(engine.select('t1', '#country', 'US')).rejects.toMatchObject({
      code: 'DETACHED',
      details: { stale: true },
    });
  });

  it('refuses an empty option list locally, before any evaluate is sent', async () => {
    const { engine, rt } = engineWith();
    await expect(engine.select('t1', '#country', [])).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
    expect(rt.evaluations).toHaveLength(0);
  });
});

describe('scrollIntoView', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scrolls and measures in the same evaluation and returns the post-scroll rect', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [
      wireResult([
        wireMatch({ rect: { x: 10, y: 300, w: 100, h: 40 }, center: { x: 60, y: 320 } }),
      ]),
    ];
    const m = await engine.scrollIntoView('t1', 'button');
    expect(rt.count(RESOLVE_SCRIPT)).toBe(1);
    expect(rt.lastSpec(RESOLVE_SCRIPT)).toMatchObject({ scroll: true, scrollIndex: 0 });
    expect(m.center).toEqual({ x: 60, y: 320 });
  });
});

/**
 * `frame=`: the locator dialect's frame traversal segment. These tests
 * exercise `LocatorEngine`'s own client-side orchestration
 * (`resolveHop`/`enterFrame`/`translateMatches`) against scripted wire
 * replies; `locator-script.test.ts` exercises the page-side half
 * (`bglsEnterFrame`) against a real DOM for the outcomes jsdom's
 * all-zero `getBoundingClientRect()` does not prevent (everything except
 * a genuine same-process entry with a real rect, which needs a real
 * browser: see that file's own module doc on what jsdom cannot cover).
 */
describe('frame= traversal', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('accepts frame= as the first segment and mid-chain, and refuses it as the last', () => {
    expect(() => parseSelector('frame=#billing >> button.pay')).not.toThrow();
    expect(() => parseSelector('div.form >> frame=iframe#x >> button')).not.toThrow();
    expect(() => parseSelector('frame=#billing')).toThrowError(/ends with 'frame=/);
  });

  it('bounds how many frame= segments one selector may chain', () => {
    const tooMany = `${Array.from({ length: MAX_FRAME_SEGMENTS + 1 }, (_, i) => `frame=iframe${i}`).join(' >> ')} >> button`;
    expect(() => parseSelector(tooMany)).toThrowError(/'frame=' segments/);
    const atLimit = `${Array.from({ length: MAX_FRAME_SEGMENTS }, (_, i) => `frame=iframe${i}`).join(' >> ')} >> button`;
    expect(() => parseSelector(atLimit)).not.toThrow();
  });

  it('costs exactly one evaluate when the page walks the whole frame= chain itself (the same-process path)', async () => {
    const { engine, rt } = engineWith();
    // The page's own bglsResolve walked the 'frame=' segment transparently
    // (same origin, same process) and finished the chain without ever
    // reporting a frameBoundary: whatever offset it folded into rect/center
    // along the way is invisible from here, which is the whole point of
    // doing that translation in the page rather than round-tripping for it.
    rt.resolveReplies = [
      wireResult([wireMatch({ rect: { x: 40, y: 90, w: 80, h: 30 }, center: { x: 80, y: 105 } })]),
    ];
    const r = await engine.resolve('t1', 'frame=iframe#billing >> button.pay');
    expect(rt.count(RESOLVE_SCRIPT)).toBe(1);
    expect(r.resolvedTargetId).toBe('t1');
    expect(r.matches[0]?.rect).toEqual({ x: 40, y: 90, w: 80, h: 30 });
  });

  it('reports a frame= segment matching more than one element as AMBIGUOUS, not as an empty resolve', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [
      wireResult([], { frameBoundary: { atSegment: 0, reason: 'ambiguous', matchCount: 2 } }),
    ];
    await expect(engine.resolve('t1', 'frame=iframe >> button')).rejects.toMatchObject({
      code: 'AMBIGUOUS',
      details: { atSegment: 0, matchCount: 2 },
    });
  });

  it('reports a frame= segment matching something that is not an iframe as INVALID_ARGUMENT', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [
      wireResult([], { frameBoundary: { atSegment: 0, reason: 'not_a_frame', matchCount: 1 } }),
    ];
    await expect(engine.resolve('t1', 'frame=div.form >> button')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('reports a frame= segment too small to be worth entering as NOT_VISIBLE', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [
      wireResult([], { frameBoundary: { atSegment: 0, reason: 'too_small', matchCount: 1 } }),
    ];
    await expect(
      engine.resolve('t1', 'frame=iframe.tracking-pixel >> button'),
    ).rejects.toMatchObject({
      code: 'NOT_VISIBLE',
    });
  });

  it('fails FRAME_DETACHED, not NOT_FOUND, when a cross-origin frame correlates to no attached CDP target', async () => {
    const { engine, rt } = engineWith();
    rt.frameTargets = [];
    rt.resolveReplies = [
      wireResult([], {
        frameBoundary: {
          atSegment: 0,
          reason: 'cross_origin',
          matchCount: 1,
          candidateSrc: 'https://pay.example.test/widget',
          offsetX: 50,
          offsetY: 80,
        },
      }),
    ];
    await expect(engine.resolve('t1', 'frame=iframe#pay >> button.submit')).rejects.toMatchObject({
      code: 'FRAME_DETACHED',
      details: { atSegment: 0, candidateSrc: 'https://pay.example.test/widget' },
    });
  });

  it('fails AMBIGUOUS, not a guess, when a cross-origin frame src correlates to more than one attached CDP target', async () => {
    const { engine, rt } = engineWith();
    rt.frameTargets = [
      { targetId: 't2', url: 'https://pay.example.test/widget' },
      { targetId: 't3', url: 'https://pay.example.test/widget' },
    ];
    rt.resolveReplies = [
      wireResult([], {
        frameBoundary: {
          atSegment: 0,
          reason: 'cross_origin',
          matchCount: 1,
          candidateSrc: 'https://pay.example.test/widget',
          offsetX: 0,
          offsetY: 0,
        },
      }),
    ];
    await expect(engine.resolve('t1', 'frame=iframe#pay >> button.submit')).rejects.toMatchObject({
      code: 'AMBIGUOUS',
    });
  });

  /**
   * THE nested frame coordinate translation case. The cross-origin frame's
   * own iframe element sits at (50, 80) in the top document (what the first
   * evaluate, run against 't1', measured before it had to stop); the button
   * inside it is measured at (10, 15) in the frame's OWN local viewport
   * (what the second evaluate, run against 't2', the frame's own CDP
   * target, reports). The client's job is arithmetic only: (50, 80) +
   * (10, 15) = (60, 95). And it has to run that second evaluate against
   * 't2', never keep asking 't1' for something 't1' cannot see.
   */
  it("translates a cross-origin match into top-document coordinates, hopping to the frame's own CDP target", async () => {
    const { engine, rt } = engineWith();
    rt.frameTargets = [{ targetId: 't2', url: 'https://pay.example.test/widget' }];
    rt.resolveReplies = [
      wireResult([], {
        frameBoundary: {
          atSegment: 0,
          reason: 'cross_origin',
          matchCount: 1,
          candidateSrc: 'https://pay.example.test/widget',
          offsetX: 50,
          offsetY: 80,
        },
      }),
      wireResult([wireMatch({ rect: { x: 10, y: 15, w: 120, h: 32 }, center: { x: 70, y: 31 } })]),
    ];

    const r = await engine.resolve('t1', 'frame=iframe#pay >> button.submit');

    expect(rt.count(RESOLVE_SCRIPT)).toBe(2);
    expect(rt.evaluations[0]?.targetId).toBe('t1');
    expect(rt.evaluations[1]?.targetId).toBe('t2');
    // The remaining chain after the entered segment, reconstructed from the
    // ORIGINAL segment text, not re-derived some other way.
    expect(rt.lastSpec(RESOLVE_SCRIPT)['selector']).toBe('button.submit');
    expect(r.resolvedTargetId).toBe('t2');
    expect(r.matches[0]?.rect).toEqual({ x: 60, y: 95, w: 120, h: 32 });
    expect(r.matches[0]?.center).toEqual({ x: 120, y: 111 });
  });

  it('accumulates offsets additively across two cross-origin hops (a frame inside a frame)', async () => {
    const { engine, rt } = engineWith();
    rt.frameTargets = [
      { targetId: 't2', url: 'https://outer.example.test/a' },
      { targetId: 't3', url: 'https://inner.example.test/b' },
    ];
    rt.resolveReplies = [
      wireResult([], {
        frameBoundary: {
          atSegment: 0,
          reason: 'cross_origin',
          matchCount: 1,
          candidateSrc: 'https://outer.example.test/a',
          offsetX: 20,
          offsetY: 30,
        },
      }),
      wireResult([], {
        frameBoundary: {
          atSegment: 0,
          reason: 'cross_origin',
          matchCount: 1,
          candidateSrc: 'https://inner.example.test/b',
          offsetX: 5,
          offsetY: 7,
        },
      }),
      wireResult([wireMatch({ rect: { x: 1, y: 2, w: 10, h: 10 }, center: { x: 6, y: 7 } })]),
    ];

    const r = await engine.resolve('t1', 'frame=iframe#outer >> frame=iframe#inner >> button');

    expect(rt.count(RESOLVE_SCRIPT)).toBe(3);
    expect(rt.evaluations.map((e) => e.targetId)).toEqual(['t1', 't2', 't3']);
    expect(r.resolvedTargetId).toBe('t3');
    // (20 + 5 + 1, 30 + 7 + 2) = (26, 39)
    expect(r.matches[0]?.rect).toMatchObject({ x: 26, y: 39 });
  });

  /**
   * `MAX_FRAME_HOPS` is a runtime backstop, and `MAX_FRAME_SEGMENTS` (the
   * selector-text bound `parseSelector` already enforces, before any round
   * trip) is what actually makes a chain this deep terminate: every hop
   * consumes one `frame=` segment, so a selector cannot describe more hops
   * than segments it has. The two constants are set equal, so what this
   * test can prove is that the runtime bound does not cut a chain off
   * EARLY: every hop up to the text limit still succeeds, is dispatched
   * against the right target, and the final segment resolves normally
   * against the last one.
   */
  it('completes a chain of exactly MAX_FRAME_SEGMENTS cross-origin hops without an early cutoff', async () => {
    const { engine, rt } = engineWith();
    const chain = Array.from({ length: MAX_FRAME_SEGMENTS }, (_, i) => `frame=iframe${i}`).join(
      ' >> ',
    );
    rt.frameTargets = Array.from({ length: MAX_FRAME_SEGMENTS }, (_, i) => ({
      targetId: `t${i + 2}`,
      url: `https://frame${i}.example.test/`,
    }));
    rt.resolveReplies = [
      ...Array.from({ length: MAX_FRAME_SEGMENTS }, (_, i) =>
        wireResult([], {
          frameBoundary: {
            atSegment: 0,
            reason: 'cross_origin' as const,
            matchCount: 1,
            candidateSrc: `https://frame${i}.example.test/`,
            offsetX: 1,
            offsetY: 1,
          },
        }),
      ),
      wireResult([wireMatch({ rect: { x: 0, y: 0, w: 10, h: 10 }, center: { x: 5, y: 5 } })]),
    ];

    const r = await engine.resolve('t1', `${chain} >> button`);

    expect(rt.count(RESOLVE_SCRIPT)).toBe(MAX_FRAME_SEGMENTS + 1);
    expect(rt.evaluations.map((e) => e.targetId)).toEqual([
      't1',
      ...Array.from({ length: MAX_FRAME_SEGMENTS }, (_, i) => `t${i + 2}`),
    ]);
    expect(r.resolvedTargetId).toBe(`t${MAX_FRAME_SEGMENTS + 1}`);
    // Every one of the MAX_FRAME_SEGMENTS hops added (1, 1) to the offset.
    expect(r.matches[0]?.rect).toMatchObject({ x: MAX_FRAME_SEGMENTS, y: MAX_FRAME_SEGMENTS });
  });

  it('resolves a role= segment written after a frame= boundary once the hop lands, not against the pre-hop target', async () => {
    const { engine, rt } = engineWith();
    rt.roleReplies = [{ attr: 'bgrole_0' }];
    rt.frameTargets = [{ targetId: 't2', url: 'https://pay.example.test/widget' }];
    rt.resolveReplies = [
      wireResult([], {
        frameBoundary: {
          atSegment: 1,
          reason: 'cross_origin',
          matchCount: 1,
          candidateSrc: 'https://pay.example.test/widget',
          offsetX: 0,
          offsetY: 0,
        },
      }),
      wireResult([wireMatch()]),
    ];

    await engine.resolve('t1', 'role=complementary >> frame=iframe#pay >> role=button');

    // Both role= segments resolve exactly once each, in chain order: the
    // pre-hop one before the frame is even looked at, the post-hop one
    // only once the hop has landed. Not zero (unresolved), not duplicated,
    // and not both attempted up front against the wrong target.
    expect(rt.roleCalls.map((c) => c.role)).toEqual(['complementary', 'button']);
  });
});

describe('scrollToText', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('composes over the text= engine rather than a new matcher', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([wireMatch({ text: 'Terms and conditions' })])];
    await engine.scrollToText('t1', 'Terms and conditions');
    expect(rt.lastSpec(RESOLVE_SCRIPT)).toMatchObject({
      selector: 'text=Terms and conditions',
      scroll: true,
    });
  });

  it('wraps in the quoting text= already understands when exact is asked for', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([wireMatch()])];
    await engine.scrollToText('t1', 'Submit', { exact: true });
    expect(rt.lastSpec(RESOLVE_SCRIPT)).toMatchObject({ selector: 'text="Submit"' });
  });
});

describe('hover', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('waits for actionable, then moves the pointer to the centre, in the same round trip shape click uses', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ center: { x: 71, y: 42 } })]),
        waitedMs: 2,
        checks: 1,
        wakes: 0,
      },
    ];
    const r = await engine.hover('t1', 'button');
    expect(rt.lastSpec(WAIT_SCRIPT)).toMatchObject({ state: 'actionable' });
    expect(rt.moves).toEqual([{ x: 71, y: 42 }]);
    expect(r).toMatchObject({
      ok: true,
      ref: 'bgtest_0',
      point: { x: 71, y: 42 },
      reResolved: false,
    });
  });

  it('fails with the same named actionability taxonomy click uses, naming what blocks it', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: true,
        result: wireResult([wireMatch({ visible: false, rect: { x: 0, y: 0, w: 0, h: 0 } })]),
        waitedMs: 8000,
        checks: 5,
        wakes: 0,
      },
    ];
    await expect(engine.hover('t1', 'button', { timeoutMs: 100 })).rejects.toMatchObject({
      code: 'NOT_VISIBLE',
    });
    expect(rt.moves).toEqual([]);
  });

  it('re-resolves and re-checks actionability when the measurement goes stale before the move is dispatched', async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ center: { x: 10, y: 10 } })]),
        waitedMs: 1,
        checks: 1,
        wakes: 0,
      },
    ];
    rt.resolveReplies = [wireResult([wireMatch({ center: { x: 90, y: 90 } })])];
    rt.advanceOnPrepareMs = STALE_RESOLVE_WINDOW_MS + 50;

    const r = await engine.hover('t1', 'button');
    expect(rt.moves).toEqual([{ x: 90, y: 90 }]);
    expect(r.reResolved).toBe(true);
  });
});

describe('scrollContainer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves the container and aims a real wheel dispatch at its centre', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([wireMatch({ center: { x: 33, y: 44 } })])];
    const r = await engine.scrollContainer('t1', '.list', { dy: 200 });
    expect(rt.count(RESOLVE_SCRIPT)).toBe(1);
    expect(rt.wheels).toEqual([{ x: 33, y: 44, dx: 0, dy: 200 }]);
    expect(r).toMatchObject({ ok: true, ref: 'bgtest_0', point: { x: 33, y: 44 } });
  });

  it('refuses to scroll an unactionable container, naming the check that failed', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([wireMatch({ hitTestOk: false, occludedBy: 'div.modal' })])];
    await expect(engine.scrollContainer('t1', '.list', { dy: 100 })).rejects.toMatchObject({
      code: 'OCCLUDED',
    });
    expect(rt.wheels).toEqual([]);
  });
});

describe('dropdownOptions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads every option off the resolver in one round trip', async () => {
    const { engine, rt } = engineWith();
    const options = [
      { value: 'us', label: 'United States', index: 0, selected: true, disabled: false },
      { value: 'mx', label: 'Mexico', index: 1, selected: false, disabled: false },
    ];
    rt.resolveReplies = [wireResult([wireMatch({ tagName: 'select', readValue: options })])];
    const r = await engine.dropdownOptions('t1', '#country');
    expect(r).toEqual(options);
    expect(rt.count(RESOLVE_SCRIPT)).toBe(1);
    expect(rt.lastSpec(RESOLVE_SCRIPT)).toMatchObject({ read: { what: 'options' }, stamp: false });
  });

  it('refuses a match that is not a <select>, naming the element it actually found', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [
      wireResult([wireMatch({ tagName: 'div', describe: 'div.fake-select', readValue: null })]),
    ];
    await expect(engine.dropdownOptions('t1', '.fake-select')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
      message: expect.stringContaining('div.fake-select'),
    });
  });

  it('throws NOT_FOUND when the selector matched nothing', async () => {
    const { engine, rt } = engineWith();
    rt.resolveReplies = [wireResult([])];
    await expect(engine.dropdownOptions('t1', '#missing')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('findInPage', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends an already-escaped pattern and an "ig" flag default for a literal string', async () => {
    const { engine, rt } = engineWith();
    rt.findInPageReply = {
      matches: [{ text: '$45.00', context: 'total: $45.00 due', tagName: 'p', ref: 'bgtest_0' }],
      total: 1,
      truncated: false,
      scopeMissing: false,
      patternError: null,
      url: 'https://x.test',
      title: 'x',
    };
    const r = await engine.findInPage('t1', '$45.00');
    const spec = rt.lastSpec(FIND_IN_PAGE_SCRIPT);
    // The literal '$' and '.' were escaped before the page ever saw them,
    // so a real RegExp built from this source matches the literal string
    // and nothing wider.
    expect(new RegExp(spec['pattern'] as string).test('$45.00')).toBe(true);
    expect(new RegExp(spec['pattern'] as string).test('X45X00')).toBe(false);
    expect(spec['flags']).toBe('ig');
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ text: '$45.00', ref: 'bgtest_0' });
  });

  it('passes a RegExp source and flags through untouched, always forcing the g flag', async () => {
    const { engine, rt } = engineWith();
    await engine.findInPage('t1', /error-\d+/i);
    const spec = rt.lastSpec(FIND_IN_PAGE_SCRIPT);
    expect(spec['pattern']).toBe('error-\\d+');
    expect(spec['flags']).toBe('ig');
  });

  it('does not add a second g when the caller already supplied one', async () => {
    const { engine, rt } = engineWith();
    await engine.findInPage('t1', /x/g);
    const spec = rt.lastSpec(FIND_IN_PAGE_SCRIPT);
    expect(spec['flags']).toBe('g');
  });

  it('throws INVALID_ARGUMENT when the page could not evaluate the pattern, as data rather than a page exception', async () => {
    const { engine, rt } = engineWith();
    // A RegExp literal is already valid JavaScript regex syntax by the
    // time it reaches this method, so this exercises the wire contract
    // (the page's own `new RegExp` reporting failure as data, `script.ts`'s
    // `patternError`) rather than trying to construct something the
    // language itself refuses to parse.
    rt.findInPageReply = {
      matches: [],
      total: 0,
      truncated: false,
      scopeMissing: false,
      patternError: 'Invalid regular expression',
      url: 'https://x.test',
      title: 'x',
    };
    await expect(engine.findInPage('t1', 'anything')).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    });
  });

  it('throws NOT_FOUND when the scope selector matched nothing', async () => {
    const { engine, rt } = engineWith();
    rt.findInPageReply = {
      matches: [],
      total: 0,
      truncated: false,
      scopeMissing: true,
      patternError: null,
      url: 'https://x.test',
      title: 'x',
    };
    await expect(engine.findInPage('t1', 'x', { scope: '#nope' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('runs in the isolated world, like every other fixed script', async () => {
    const { engine, rt } = engineWith();
    await engine.findInPage('t1', 'x');
    expect(rt.evaluations.at(-1)).toMatchObject({ world: 'isolated' });
  });
});

// ====================================================================
// Through the real client and the scripted gateway: the parts that are
// about the wire and the lease rather than about the engine's logic.
// ====================================================================

describe('AutomationClient locator surface, over the socket', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends the resolver as a functionDeclaration with one JSON spec argument', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: wireResult([wireMatch()]),
      sizeBytes: 10,
    });

    const p = client.resolve('[data-testid="submit"]');
    await tick();
    const r = await p;

    const call = gateway.evaluateCalls.at(-1);
    expect(call?.['functionDeclaration']).toBe(RESOLVE_SCRIPT);
    expect(call?.['expression']).toBeUndefined();
    expect((call?.['args'] as unknown[])?.[0]).toMatchObject({
      selector: '[data-testid="submit"]',
    });
    expect(r.matches[0]?.ref).toBe('bgtest_0');
  });

  /**
   * The whole point of building the locator on the existing input path.
   * A click that resolved to coordinates and then opened its own route
   * into `InputDispatcher` would inherit none of the lease fencing, the
   * generation stamp or the stand-down gate, and would become a way for an
   * agent to keep clicking on a browser a person had taken over.
   */
  it('drives the click through the same lease-fenced input.mouse pair a human click uses', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: {
        timedOut: false,
        result: wireResult([wireMatch()]),
        waitedMs: 3,
        checks: 1,
        wakes: 0,
      },
      sizeBytes: 10,
    });

    const lease = client.acquireControl();
    await tick();
    await lease;

    const p = client.click('[data-testid="submit"]');
    await tick();
    await p;

    const inputs = gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.mouse');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      kind: 'down',
      x: 60,
      y: 40,
      button: 'left',
      leaseId: gateway.leaseId,
    });
    expect(inputs[1]).toMatchObject({ kind: 'up', x: 60, y: 40, leaseId: gateway.leaseId });
    // The generation stamp the server fences input against is present on
    // both, learned the same way `clickAt()` learns it.
    expect(inputs[0]?.['gen']).toBe(gateway.gen);
  });

  it('refuses a locator click with no held lease, and sends no input', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: {
        timedOut: false,
        result: wireResult([wireMatch()]),
        waitedMs: 1,
        checks: 1,
        wakes: 0,
      },
      sizeBytes: 10,
    });

    await expect(client.click('button')).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });
    expect(gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.mouse')).toHaveLength(0);
    // And it refused before any evaluation, so a caller without control
    // does not pay a round trip to be told so.
    expect(gateway.evaluateCalls).toHaveLength(0);
  });

  /**
   * `LocatorClickOptions` carries `button`/`clickCount`/`modifiers`, and
   * they have to survive all the way to the dispatched `input.mouse`
   * frames, the same way `clickAt()`'s own options do. A regression here
   * would be silent: `click()` would still report success, having simply
   * clicked with the wrong button.
   */
  it('forwards button, clickCount and modifiers from a locator click to the dispatched input.mouse frames', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: {
        timedOut: false,
        result: wireResult([wireMatch()]),
        waitedMs: 1,
        checks: 1,
        wakes: 0,
      },
      sizeBytes: 10,
    });

    const lease = client.acquireControl();
    await tick();
    await lease;

    const p = client.click('[data-testid="submit"]', {
      button: 'right',
      clickCount: 2,
      modifiers: ['Shift', 'Control'],
    });
    await tick();
    await p;

    const inputs = gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.mouse');
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({
      kind: 'down',
      button: 'right',
      clickCount: 2,
      modifiers: 0x2 | 0x8,
    });
    expect(inputs[1]).toMatchObject({ kind: 'up', button: 'right', modifiers: 0x2 | 0x8 });
  });

  it('drives hover through the same lease-fenced input.mouse move a moveTo() call uses', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: {
        timedOut: false,
        result: wireResult([wireMatch({ center: { x: 15, y: 25 } })]),
        waitedMs: 1,
        checks: 1,
        wakes: 0,
      },
      sizeBytes: 10,
    });

    await expect(client.hover('button')).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });
    expect(gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.mouse')).toHaveLength(0);

    const lease = client.acquireControl();
    await tick();
    await lease;

    const p = client.hover('button');
    await tick();
    const r = await p;

    const moves = gateway.ws
      .sentJsonMessages()
      .filter((m) => m['t'] === 'input.mouse' && m['kind'] === 'move');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ x: 15, y: 25, leaseId: gateway.leaseId });
    expect(r).toMatchObject({ ok: true, point: { x: 15, y: 25 } });
  });

  it('drives scrollContainer through a lease-fenced wheel dispatch aimed at the resolved centre', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: wireResult([wireMatch({ center: { x: 50, y: 60 } })]),
      sizeBytes: 10,
    });

    await expect(client.scrollContainer('.list', { dy: 300 })).rejects.toMatchObject({
      code: 'LEASE_NOT_HELD',
    });

    const lease = client.acquireControl();
    await tick();
    await lease;

    const p = client.scrollContainer('.list', { dy: 300 });
    await tick();
    const r = await p;

    const wheels = gateway.ws
      .sentJsonMessages()
      .filter((m) => m['t'] === 'input.mouse' && m['kind'] === 'wheel');
    expect(wheels).toHaveLength(1);
    expect(wheels[0]).toMatchObject({ x: 50, y: 60, dy: 300, dx: 0, leaseId: gateway.leaseId });
    expect(r).toMatchObject({ ok: true, point: { x: 50, y: 60 } });
  });

  it('reads dropdownOptions without a lease, one evaluate riding along on the resolver', async () => {
    const { client, gateway } = await grantedClient();
    const options = [
      { value: 'us', label: 'United States', index: 0, selected: true, disabled: false },
      { value: 'ca', label: 'Canada', index: 1, selected: false, disabled: false },
    ];
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: wireResult([wireMatch({ tagName: 'select', readValue: options })]),
      sizeBytes: 10,
    });

    const r = await client.dropdownOptions('#country');
    expect(r).toEqual(options);
    expect(gateway.evaluateCalls).toHaveLength(1);
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'input.mouse')).toBe(false);
  });

  it('runs findInPage as one evaluate needing only evaluate, not control', async () => {
    const harness = createFakeGatewayHarness();
    const connectPromise = AutomationClient.connect(fixtureOptions(harness));
    await tick();
    const gateway = startScriptedGateway(harness, {
      granted: ['view', 'automation', 'evaluate'] as Capability[],
    });
    const client = await connectPromise;

    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: {
        matches: [
          { text: 'Submit', context: 'Please Submit the form', tagName: 'button', ref: 'bgtest_0' },
        ],
        total: 1,
        truncated: false,
        scopeMissing: false,
        patternError: null,
        url: 'https://x.test',
        title: 'x',
      },
      sizeBytes: 10,
    });

    const p = client.findInPage('Submit');
    await tick();
    const r = await p;

    const call = gateway.evaluateCalls.at(-1);
    expect(call?.['functionDeclaration']).toBeDefined();
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]).toMatchObject({ text: 'Submit', ref: 'bgtest_0' });
    client.close();
  });

  /**
   * `select()` drives the same wait-then-act composition `click`/`fill`
   * do, so this exercises it end to end over the socket the way the click
   * test above does: two DIFFERENT evaluate shapes on one connection
   * (`WAIT_SCRIPT`'s wait result, then `SELECT_SCRIPT`'s own), which is
   * why the responder here branches on `functionDeclaration` rather than
   * returning one fixed shape the way the fill/click socket tests above
   * get away with.
   */
  it('select() waits for the <select>, mutates it through one evaluate, and requires a held lease like click/fill', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = (msg) => {
      if (msg['functionDeclaration'] === WAIT_SCRIPT) {
        return {
          t: 'page.evaluated',
          ok: true,
          resultType: 'value',
          value: {
            timedOut: false,
            result: wireResult([wireMatch({ tagName: 'select', describe: 'select#country' })]),
            waitedMs: 2,
            checks: 1,
            wakes: 0,
          },
          sizeBytes: 10,
        };
      }
      return {
        t: 'page.evaluated',
        ok: true,
        resultType: 'value',
        value: { found: true, values: ['US'], labels: ['United States'] },
        sizeBytes: 10,
      };
    };

    // No lease yet: refused before any evaluate is sent, the same
    // ordering `click()`'s own socket test proves.
    await expect(client.select('#country', 'US')).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });
    expect(gateway.evaluateCalls).toHaveLength(0);

    const lease = client.acquireControl();
    await tick();
    await lease;

    const p = client.select('#country', 'US');
    await tick();
    const r = await p;

    expect(r).toMatchObject({
      ok: true,
      ref: 'bgtest_0',
      values: ['US'],
      labels: ['United States'],
    });
    const selectCall = gateway.evaluateCalls.find(
      (c) => c['functionDeclaration'] === SELECT_SCRIPT,
    );
    expect(selectCall?.['args']).toEqual([{ ref: 'bgtest_0', options: [{ value: 'US' }] }]);
    // select() mutates through evaluate, not through input.*: no mouse or
    // key frame was sent for it, unlike click()/fill().
    expect(
      gateway.ws.sentJsonMessages().some((m) => m['t'] === 'input.mouse' || m['t'] === 'input.key'),
    ).toBe(false);
  });

  it('refuses the read verbs locally when the token lacks evaluate, without a round trip', async () => {
    const harness = createFakeGatewayHarness();
    const connectPromise = AutomationClient.connect(fixtureOptions(harness));
    await tick();
    const gateway = startScriptedGateway(harness);
    const client = await connectPromise;

    await expect(client.resolve('button')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'evaluate' },
    });
    expect(gateway.evaluateCalls).toHaveLength(0);
    client.close();
  });

  it('spends one step per locator verb, not one per composed sub-action', async () => {
    const harness = createFakeGatewayHarness();
    // Three: `acquireControl()` spends one of its own, then one per fill.
    const connectPromise = AutomationClient.connect(fixtureOptions(harness, { stepBudget: 3 }));
    await tick();
    const gateway = startScriptedGateway(harness, { granted: GRANTED });
    const client = await connectPromise;
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: {
        timedOut: false,
        result: wireResult([wireMatch({ tagName: 'input', editable: true, value: '' })]),
        waitedMs: 1,
        checks: 1,
        wakes: 0,
      },
      sizeBytes: 10,
    });

    const lease = client.acquireControl();
    await tick();
    await lease;

    // acquireControl does not consume a step; two fills do. A `fill` is a
    // wait, a click, a clear and a read-back, and it must still cost one.
    const first = client.fill('#a', 'x', { verify: false });
    await tick();
    await first;
    const second = client.fill('#b', 'y', { verify: false });
    await tick();
    await second;

    // The rejection is attached in the same tick it is produced: the
    // budget refusal happens before any await inside `run()`, so a handler
    // attached after a timer tick would be attached to an already-rejected
    // promise and Vitest would report it as unhandled.
    const third = expect(client.fill('#c', 'z', { verify: false })).rejects.toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    });
    await tick();
    await third;
    client.close();
  });
});

// ====================================================================
// Which JavaScript world the locator surface runs its scripts in.
//
// This is the one default in the whole surface where getting it wrong is
// silent AND consequential, so it is tested at both layers: at the engine,
// where the decision is made, and over the socket, where the decision has
// to survive the adapter and reach the wire.
//
// patchright's Python client defaults `isolatedContext=True` on every
// evaluate (`patchright/_impl/_page.py:452`), so every read a script
// written against it takes comes from an isolated world. A main world
// default here would not be a neutral swap: it would wake dead callback
// code in such scripts (captcha handling that reaches for
// `window.hcaptcha` inside empty catch blocks and is dead ONLY because the
// isolated world makes those globals undefined) and would make a submit
// blocker's `HTMLFormElement.prototype.submit` monkeypatch visible to the
// page.
// ====================================================================

describe('the world the locator engine evaluates in', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('runs every one of its own six fixed scripts in the isolated world', async () => {
    const { engine, rt } = engineWith();

    // RESOLVE_SCRIPT
    rt.resolveReplies = [wireResult([wireMatch()])];
    await engine.resolve('t1', 'button');

    // WAIT_SCRIPT
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    await engine.waitFor('t1', 'button');

    // DISPATCH_CLICK_SCRIPT
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    await engine.click('t1', 'button', { via: 'dispatch' });

    // CLEAR_SCRIPT and READ_SCRIPT
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([
          wireMatch({ tagName: 'input', editable: true, value: 'old', describe: 'input#email' }),
        ]),
        waitedMs: 1,
        checks: 1,
        wakes: 0,
      },
    ];
    rt.readReplies = [{ found: true, value: 'new' }];
    await engine.fill('t1', 'input', 'new');

    // SELECT_SCRIPT
    rt.waitReplies = [
      {
        timedOut: false,
        result: wireResult([wireMatch({ tagName: 'select', describe: 'select#country' })]),
        waitedMs: 1,
        checks: 1,
        wakes: 0,
      },
    ];
    rt.selectReply = { found: true, values: ['uk'], labels: ['United Kingdom'] };
    await engine.select('t1', 'select', 'uk');

    // Every script the engine owns, seen at least once, and every single
    // evaluation isolated. Asserted as "no evaluation was anything else"
    // rather than script by script, so a seventh script added later is
    // covered by this test on the day it is written.
    const seen = new Set(rt.evaluations.map((e) => e.source));
    expect(seen).toContain(RESOLVE_SCRIPT);
    expect(seen).toContain(WAIT_SCRIPT);
    expect(seen).toContain(DISPATCH_CLICK_SCRIPT);
    expect(seen).toContain(CLEAR_SCRIPT);
    expect(seen).toContain(READ_SCRIPT);
    expect(seen).toContain(SELECT_SCRIPT);
    expect(rt.evaluations.length).toBeGreaterThanOrEqual(6);
    expect(rt.evaluations.filter((e) => e.world !== 'isolated')).toEqual([]);
  });

  it("runs a click's verify predicate in the isolated world by default", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    rt.verifyReplies = [true];

    const r = await engine.click('t1', 'button', {
      verify: 'document.querySelector(".menu") !== null',
    });

    expect(r.verified).toBe(true);
    expect(rt.expressions).toHaveLength(1);
    expect(rt.expressions[0]?.world).toBe('isolated');
  });

  /**
   * The escape hatch, and the reason it is spelled out rather than
   * defaulted. A predicate reading a global the PAGE defined gets
   * `undefined` from the isolated world, which is indistinguishable from
   * "not set yet", so such a predicate would never pass and would never
   * say why. `verifyWorld: 'main'` is how a caller says it meant it.
   */
  it("honours verifyWorld: 'main' when a predicate genuinely needs a page global", async () => {
    const { engine, rt } = engineWith();
    rt.waitReplies = [
      { timedOut: false, result: wireResult([wireMatch()]), waitedMs: 1, checks: 1, wakes: 0 },
    ];
    rt.verifyReplies = [true];

    await engine.click('t1', 'button', {
      verify: 'window.__pageOpenedTheMenu === true',
      verifyWorld: 'main',
    });

    expect(rt.expressions[0]?.world).toBe('main');
    // And the engine's OWN script for the same click stayed isolated: the
    // opt out is scoped to the predicate, never to the surface.
    expect(rt.evaluations.filter((e) => e.world !== 'isolated')).toEqual([]);
  });

  it("puts world: 'isolated' on the page.evaluate.internal message the resolver actually sends", async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: wireResult([wireMatch()]),
      sizeBytes: 10,
    });

    const p = client.resolve('#submit');
    await tick();
    await p;

    const call = gateway.evaluateCalls.at(-1);
    expect(call?.['t']).toBe('page.evaluate.internal');
    expect(call?.['world']).toBe('isolated');
  });

  /**
   * The caller-facing `evaluate()` is deliberately NOT swept up by this
   * change. Its own default stays `'main'` (`EvaluateOptions.world`), and
   * a message with no `world` field means main server side. A caller who
   * asked for nothing must keep getting what they always got.
   */
  it('leaves the caller-facing evaluate() defaulting to the main world', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = () => ({
      t: 'page.evaluated',
      ok: true,
      resultType: 'value',
      value: 'ok',
      sizeBytes: 2,
    });

    const p = client.evaluate('document.title');
    await tick();
    await p;

    const call = gateway.evaluateCalls.at(-1);
    expect(call?.['t']).toBe('page.evaluate');
    expect(call?.['world']).toBeUndefined();
  });

  /**
   * The three SDK-authored scripts that were still reaching the main world
   * after the six fixed locator scripts were threaded, and were missed for
   * the same reason: they are built on the CALLER-FACING `evaluate` and
   * `waitForFunction`, whose main-world default is right for a caller and
   * wrong for a script this SDK wrote every character of.
   *
   * All three were measured leaking against real Chrome before the fix, on
   * a page that patched its own `innerText` and `outerHTML` getters and its
   * own `querySelectorAll`: `text()` moved the innerText counter 0 to 1,
   * `html()` moved outerHTML 0 to 1, and `waitForText` moved
   * querySelectorAll 0 to 1 ONCE PER POLL.
   */
  const evaluateResponderFor = (value: unknown) => () => ({
    t: 'page.evaluated' as const,
    ok: true,
    resultType: 'value' as const,
    value,
    sizeBytes: 2,
  });

  it('reads text() from the isolated world, because the SDK wrote that script', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = evaluateResponderFor('hello');

    const p = client.text();
    await tick();
    await p;

    expect(gateway.evaluateCalls.at(-1)?.['world']).toBe('isolated');
  });

  it('reads html() from the isolated world too', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = evaluateResponderFor('<html></html>');

    const p = client.html();
    await tick();
    await p;

    expect(gateway.evaluateCalls.at(-1)?.['world']).toBe('isolated');
  });

  it('polls waitForText in the isolated world, on every poll', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = evaluateResponderFor('some text');

    const p = client.waitForText('#h', 'some text');
    await tick();
    await p;

    const calls = gateway.evaluateCalls.filter((c) => c['t'] === 'page.evaluate');
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c['world'] !== 'isolated')).toEqual([]);
  });

  /**
   * The counterweight. `waitForFunction` takes a predicate the CALLER
   * wrote, so it keeps the caller-facing default and sends no `world`
   * field. Only the SDK's own predicates were moved.
   */
  it('leaves waitForFunction itself defaulting to the main world', async () => {
    const { client, gateway } = await grantedClient();
    gateway.evaluateResponder = evaluateResponderFor(true);

    const p = client.waitForFunction('window.__ready === true');
    await tick();
    await p;

    expect(gateway.evaluateCalls.at(-1)?.['world']).toBeUndefined();
  });
});
