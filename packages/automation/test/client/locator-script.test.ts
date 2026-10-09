// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIND_IN_PAGE_SCRIPT,
  LOCATOR_REF_ATTRIBUTE,
  RESOLVE_SCRIPT,
  SELECT_SCRIPT,
  WAIT_SCRIPT,
} from '../../src/locator/script.js';

/**
 * The page-side resolver, executed against a real DOM.
 *
 * This is the test that matters most in the locator work, because
 * `locator/script.ts` is authored as text and therefore gets no type
 * checking of its own (see its module doc for why it has to be). Everything
 * else in the suite asserts on what the client SENDS and what it does with
 * a scripted reply; this file asserts that the script itself does the right
 * thing when handed real elements.
 *
 * It is compiled exactly as the server compiles it
 * (`(<declaration>).call(globalThis, <arg>)`, `buildExpression` in
 * `packages/core/src/cdp/evaluate.ts`), so a syntax or scoping mistake
 * fails here rather than in a browser with a stack nobody can read.
 *
 * WHAT JSDOM CANNOT COVER, stated plainly rather than left to be
 * discovered:
 *
 *  * `getBoundingClientRect()` returns zeros for everything, so every
 *    element reads as invisible and the `visible`, `inViewport` and
 *    `stable` answers cannot be exercised here. `hitTestOk` follows,
 *    since the hit test is skipped for an invisible element (and jsdom has
 *    no `elementsFromPoint` either).
 *  * `scrollIntoView` does not exist, so the scroll branch is only
 *    proven not to throw.
 *  * `innerText` does not exist, so the `innerText` read falls through to
 *    its `textContent` path. That fallback is what is asserted below; the
 *    `innerText` path itself needs a real browser.
 *
 * Those five belong in the e2e suite against a real Chrome, and they are
 * the honest list of what is still unproven.
 */

// biome-ignore lint/suspicious/noExplicitAny: the scripts run untyped page side code; the tests read arbitrary fields off its input and output.
type AnySpec = Record<string, any>;
// biome-ignore lint/suspicious/noExplicitAny: the scripts run untyped page side code; the tests read arbitrary fields off its input and output.
type AnyResult = Record<string, any>;

const runResolve = new Function(`return (${RESOLVE_SCRIPT});`)() as (
  spec: AnySpec,
) => Promise<AnyResult>;
const runWait = new Function(`return (${WAIT_SCRIPT});`)() as (spec: AnySpec) => Promise<AnyResult>;
// Synchronous, unlike the two above: SELECT_SCRIPT does not span an
// animation frame the way the stability check does, so it needs no
// promise of its own.
const runSelect = new Function(`return (${SELECT_SCRIPT});`)() as (spec: AnySpec) => AnyResult;

/** A resolver spec with the defaults the client would have filled in, minus the measurements jsdom cannot produce. */
function spec(selector: string, over: AnySpec = {}): AnySpec {
  return {
    selector,
    limit: 50,
    stamp: true,
    stable: false,
    hitTest: false,
    scroll: false,
    scrollIndex: 0,
    refPrefix: 'bgtest',
    textLimit: 200,
    ...over,
  };
}

function html(markup: string): void {
  document.body.innerHTML = markup;
}

describe('the resolver script, against a real DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('matches CSS, returns document order, and reports total separately from what it returned', async () => {
    html('<button id="a">One</button><button id="b">Two</button><button id="c">Three</button>');

    const all = await runResolve(spec('button'));
    expect(all.matches.map((m: AnyResult) => m.id)).toEqual(['a', 'b', 'c']);
    expect(all.total).toBe(3);
    expect(all.truncated).toBe(false);

    const capped = await runResolve(spec('button', { limit: 2 }));
    expect(capped.matches).toHaveLength(2);
    // `total` is the real count, not the returned count. A caller reading
    // `.total` is asking what `.count()` asked, and a capped answer there
    // would be a wrong answer rather than a partial one.
    expect(capped.total).toBe(3);
    expect(capped.truncated).toBe(true);
  });

  it('is an ordinary answer, not an error, when nothing matches', async () => {
    html('<div></div>');
    const r = await runResolve(spec('#nothing'));
    expect(r.matches).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.scopeMissing).toBe(false);
  });

  it('stamps each match with an addressable ref, and the ref= engine finds it again', async () => {
    html('<input name="email"><input name="phone">');
    const first = await runResolve(spec('input'));
    const ref = first.matches[1].ref;
    expect(ref).toBe('bgtest_1');
    expect(document.querySelectorAll(`[${LOCATOR_REF_ATTRIBUTE}]`)).toHaveLength(2);

    const again = await runResolve(spec(`ref=${ref}`));
    expect(again.total).toBe(1);
    expect(again.matches[0].name).toBe('phone');
  });

  it('writes nothing at all when stamping is off', async () => {
    html('<button>Go</button>');
    const r = await runResolve(spec('button', { stamp: false }));
    expect(r.matches[0].ref).toBeNull();
    expect(document.querySelectorAll(`[${LOCATOR_REF_ATTRIBUTE}]`)).toHaveLength(0);
  });

  /**
   * The staleness contract, demonstrated rather than asserted in prose: a
   * ref survives as long as the element does and no longer. Nothing detects
   * the re-render; the only way to find out is to use the ref, which is why
   * every acting verb re-resolves as its first step and why a ref that no
   * longer resolves is reported as DETACHED rather than as a no-op.
   */
  it('leaves a ref pointing at nothing once the subtree re-renders', async () => {
    html('<div id="host"><input name="email"></div>');
    const r = await runResolve(spec('input'));
    const ref = r.matches[0].ref;
    expect((await runResolve(spec(`ref=${ref}`))).total).toBe(1);

    // What a framework does on every state change.
    (document.getElementById('host') as HTMLElement).innerHTML = '<input name="email">';

    expect((await runResolve(spec(`ref=${ref}`))).total).toBe(0);
  });

  it('chains CSS segments as descendants of the previous match, never as the match itself', async () => {
    html('<section id="s1"><span>a</span></section><section id="s2"><span>b</span></section>');
    const r = await runResolve(spec('#s1 >> span'));
    expect(r.total).toBe(1);
    expect(r.matches[0].text).toBe('a');

    // 'section >> section' must not match its own root.
    expect((await runResolve(spec('section >> section'))).total).toBe(0);
  });

  /**
   * The XPath real scripts need is almost always one of these two
   * shapes, and neither has a CSS spelling. This is the whole reason the
   * XPath engine exists and the whole reason it is chained-only.
   */
  it('evaluates a chained XPath segment relative to the match before it', async () => {
    html(
      '<label id="wrap">Email <input id="e"></label><label id="other">Other <input id="o"></label>',
    );

    const ancestor = await runResolve(spec('input#e >> xpath=ancestor::label[1]'));
    expect(ancestor.total).toBe(1);
    expect(ancestor.matches[0].id).toBe('wrap');

    const parent = await runResolve(spec('input#o >> xpath=..'));
    expect(parent.matches[0].id).toBe('other');
  });

  it('reports the engine of the LAST segment, which is the one that produced the matches', async () => {
    html('<label id="wrap">Email <input id="e"></label>');
    expect((await runResolve(spec('input#e'))).engine).toBe('css');
    expect((await runResolve(spec('input#e >> xpath=..'))).engine).toBe('xpath');
  });

  it('splits on >> the same way the client does, including inside a quoted attribute value', async () => {
    html('<div title="a >> b"><span>inner</span></div>');
    // What is asserted is the SEGMENT COUNT, not a match count. The >>
    // inside the quotes is data and the scanner is right to keep it in one
    // segment; jsdom's own CSS engine (nwsapi) then declines to match a
    // '>' inside an attribute value, which is jsdom's limitation and not
    // this script's. Segment count is the thing worth pinning here anyway:
    // it is where the page-side scanner and the client-side one would
    // first disagree.
    expect((await runResolve(spec('[title="a >> b"]'))).segments).toBe(1);
    expect((await runResolve(spec('[title="a >> b"] >> span'))).segments).toBe(2);
    expect((await runResolve(spec('div > span'))).segments).toBe(1);
    expect((await runResolve(spec('div >> span'))).matches[0].text).toBe('inner');
  });

  /**
   * `frame=`: see `LocatorEngine.enterFrame` (`../../src/locator/engine.ts`)
   * for the client-side half, exercised there against scripted wire
   * replies. What belongs HERE is what only a real DOM can answer: whether
   * `bglsEnterFrame` classifies a candidate correctly.
   *
   * One outcome CANNOT be reached from this file: a genuine same-process
   * entry (a real `<iframe>`, a real rect, matching inside its
   * `contentDocument`) needs `getBoundingClientRect()` to return something
   * other than zero, which jsdom never does (this file's own module doc).
   * Every candidate iframe created here is therefore always classified
   * `'too_small'`, which is asserted below as exactly that: the one
   * same-process outcome jsdom CAN prove, not a stand-in for the ones it
   * cannot. The full same-process walk (a real rect, entering
   * `contentDocument`, matching inside it, and the accumulated top-document
   * offset it writes into `rect`/`center`) and the cross-origin path
   * (`contentDocument` genuinely inaccessible, which jsdom's own iframes
   * never enforce) both belong in the e2e suite against a real Chrome.
   */
  describe('the frame= engine', () => {
    it('is the ordinary empty answer, not a boundary, when frame= matches nothing', async () => {
      html('<div></div>');
      const r = await runResolve(spec('frame=iframe#missing >> button'));
      expect(r.matches).toEqual([]);
      expect(r.total).toBe(0);
      expect(r.frameBoundary).toBeFalsy();
    });

    it('reports a boundary, not a match set, when frame= is ambiguous', async () => {
      html('<iframe id="a"></iframe><iframe id="b"></iframe>');
      const r = await runResolve(spec('frame=iframe >> button'));
      expect(r.matches).toEqual([]);
      expect(r.frameBoundary).toMatchObject({ atSegment: 0, reason: 'ambiguous', matchCount: 2 });
    });

    it('reports not_a_frame when frame= matches an element that is not an <iframe>/<frame>', async () => {
      html('<div id="x"></div>');
      const r = await runResolve(spec('frame=#x >> button'));
      expect(r.frameBoundary).toMatchObject({ atSegment: 0, reason: 'not_a_frame', matchCount: 1 });
    });

    it("reports too_small for a real <iframe>, the one same-process outcome jsdom can prove (see this describe block's own doc)", async () => {
      html('<iframe id="pay" src="https://pay.example.test/widget"></iframe>');
      const r = await runResolve(spec('frame=#pay >> button'));
      expect(r.frameBoundary).toMatchObject({ atSegment: 0, reason: 'too_small', matchCount: 1 });
    });

    it('indexes atSegment against the WHOLE chain, not just the frame= segment', async () => {
      html('<div class="form"><div id="x"></div></div>');
      const r = await runResolve(spec('div.form >> frame=#x >> button'));
      expect(r.frameBoundary).toMatchObject({ atSegment: 1, reason: 'not_a_frame' });
    });
  });

  describe('the text engine', () => {
    it('matches a substring case-insensitively and returns only the innermost match', async () => {
      html('<div id="outer"><p id="mid"><span id="inner">Submit application</span></p></div>');
      const r = await runResolve(spec('text=submit APPLICATION'));
      // Every ancestor contains the text too. Without the innermost rule a
      // text lookup returns html, body and every wrapper down to the one
      // the caller meant.
      expect(r.matches.map((m: AnyResult) => m.id)).toEqual(['inner']);
    });

    it('matches exactly when the needle is quoted', async () => {
      html('<span id="a">Save</span><span id="b">Save and continue</span>');
      expect((await runResolve(spec('text=Save'))).total).toBe(2);
      expect((await runResolve(spec('text="Save"'))).matches.map((m: AnyResult) => m.id)).toEqual([
        'a',
      ]);
    });

    it('ignores script, style and template content', async () => {
      html(
        '<script>var needle = "findme";</script><style>.findme{}</style><span id="real">findme</span>',
      );
      const r = await runResolve(spec('text=findme'));
      expect(r.matches.map((m: AnyResult) => m.id)).toEqual(['real']);
    });

    it('can be filtered by a chained segment', async () => {
      html('<div><button id="one">Apply</button></div><span id="two">Apply</span>');
      const r = await runResolve(spec('text=Apply >> css=button'));
      // The chained CSS segment looks INSIDE each text match, so a text
      // match that is itself the button does not survive it. This is the
      // descendant rule from the CSS chaining test, and it is the one part
      // of the dialect most likely to surprise: chain the other way round.
      expect(r.total).toBe(0);
      expect((await runResolve(spec('button >> text=Apply'))).total).toBe(0);
      // What a caller actually writes for this:
      expect((await runResolve(spec('button'))).matches[0].text).toBe('Apply');
    });
  });

  describe('the label= engine, which is four rules and not the ARIA computation', () => {
    it('reads aria-labelledby first', async () => {
      html(
        '<span id="lbl">Home address</span><input id="target" aria-labelledby="lbl" aria-label="ignored">',
      );
      expect((await runResolve(spec('label=Home address'))).matches[0].id).toBe('target');
    });

    it('falls to aria-label, then label[for], then a wrapping label, in that order', async () => {
      html('<input id="aria" aria-label="Given name">');
      expect((await runResolve(spec('label=Given name'))).matches[0].id).toBe('aria');

      html('<label for="forid">Family name</label><input id="forid">');
      expect((await runResolve(spec('label=Family name'))).matches[0].id).toBe('forid');

      html('<label>Phone number <input id="wrapped"></label>');
      expect((await runResolve(spec('label=Phone number'))).matches[0].id).toBe('wrapped');
    });

    it('matches on a substring, and exactly when quoted', async () => {
      html('<input id="a" aria-label="Email address"><input id="b" aria-label="Email">');
      expect((await runResolve(spec('label=Email'))).total).toBe(2);
      expect((await runResolve(spec('label="Email"'))).matches.map((m: AnyResult) => m.id)).toEqual(
        ['b'],
      );
    });
  });

  describe('the actionability reads jsdom can produce', () => {
    it('names why an element is disabled rather than only that it is', async () => {
      html('<button id="a" disabled>A</button>');
      expect((await runResolve(spec('#a'))).matches[0]).toMatchObject({
        enabled: false,
        disabledReason: 'element.disabled',
      });

      html('<div id="b" role="button" aria-disabled="true">B</div>');
      expect((await runResolve(spec('#b'))).matches[0]).toMatchObject({
        enabled: false,
        disabledReason: 'aria-disabled="true"',
      });

      html('<fieldset disabled><input id="c"></fieldset>');
      expect((await runResolve(spec('#c'))).matches[0]).toMatchObject({
        enabled: false,
        disabledReason: 'ancestor fieldset[disabled]',
      });

      html('<button id="d">D</button>');
      expect((await runResolve(spec('#d'))).matches[0]).toMatchObject({
        enabled: true,
        disabledReason: null,
      });
    });

    it('answers editable for the three things that are editable and refuses readOnly', async () => {
      html(
        '<input id="i"><textarea id="t"></textarea><div id="ce" contenteditable="true"></div><input id="ro" readonly><div id="plain"></div>',
      );
      const r = await runResolve(spec('#i, #t, #ce, #ro, #plain'));
      const byId = Object.fromEntries(r.matches.map((m: AnyResult) => [m.id, m.editable]));
      expect(byId).toEqual({ i: true, t: true, ce: true, ro: false, plain: false });
    });

    /**
     * `checked` is reported only where it means something. Every `<input>`
     * carries a boolean `checked` property, a text box included, so
     * reporting it unconditionally answers `checked: false` for an email
     * field, which is not false so much as meaningless, and a caller
     * branching on it would be branching on noise.
     */
    it('reads value back, and checked only where checked is a real answer', async () => {
      html(
        '<input id="v" value="typed"><input id="c" type="checkbox" checked><input id="r" type="radio"><div id="a" role="switch" aria-checked="true"></div><div id="p"></div>',
      );
      const r = await runResolve(spec('#v, #c, #r, #a, #p'));
      const byId = Object.fromEntries(r.matches.map((m: AnyResult) => [m.id, m.checked]));
      expect(byId).toEqual({ v: null, c: true, r: false, a: true, p: null });
      expect(r.matches[0].value).toBe('typed');
    });

    /**
     * The occlusion diagnostic's own spelling, checked here because it is
     * what a failure report shows a human. "Timeout 6000ms exceeded" tells
     * a caller nothing; "div[data-testid=click_filter]" is the
     * answer they actually need.
     */
    it('describes an element by what identifies it, not by what styles it', async () => {
      html('<div data-testid="click_filter" class="a b c d"></div>');
      expect((await runResolve(spec('div'))).matches[0].describe).toBe(
        'div[data-testid="click_filter"]',
      );

      html('<div class="overlay backdrop extra"></div>');
      // Nothing identifying, so it falls back to at most two classes
      // rather than dumping a Tailwind soup into an error message.
      expect((await runResolve(spec('div'))).matches[0].describe).toBe('div.overlay.backdrop');
    });
  });

  describe('the read that rides along on the resolver', () => {
    it('returns an attribute, a checked state and text in the same call that located the element', async () => {
      html(
        '<input id="c" type="checkbox" data-testid="agree" checked><p id="t">Terms  and\n conditions</p>',
      );

      const attr = await runResolve(
        spec('#c', { read: { what: 'attribute', name: 'data-testid' } }),
      );
      expect(attr.matches[0].readValue).toBe('agree');
      expect(attr.matches[0].readValue).not.toBeUndefined();

      const checked = await runResolve(spec('#c', { read: { what: 'checked' } }));
      expect(checked.matches[0].readValue).toBe(true);

      // jsdom has no innerText, so this exercises the textContent path the
      // script falls back to. The rendered-text path itself needs a browser.
      const text = await runResolve(spec('#t', { read: { what: 'innerText' } }));
      expect(String(text.matches[0].readValue)).toContain('Terms');
    });

    it('returns null for an attribute that is absent, which is not the same as no match', async () => {
      html('<input id="c">');
      const r = await runResolve(spec('#c', { read: { what: 'attribute', name: 'data-missing' } }));
      expect(r.total).toBe(1);
      expect(r.matches[0].readValue).toBeNull();
    });

    it('is null on every match when no read was asked for, never undefined', async () => {
      html('<button>x</button>');
      expect((await runResolve(spec('button'))).matches[0].readValue).toBeNull();
    });

    it("reads a <select>'s options (value, label, index, selected, disabled), and null for anything else", async () => {
      html(
        '<select id="s"><option value="us">United States</option><option value="mx" selected>Mexico</option><option value="ca" disabled>  Canada </option></select><button>not a select</button>',
      );
      const r = await runResolve(spec('#s', { read: { what: 'options' } }));
      expect(r.matches[0].readValue).toEqual([
        { value: 'us', label: 'United States', index: 0, selected: false, disabled: false },
        { value: 'mx', label: 'Mexico', index: 1, selected: true, disabled: false },
        { value: 'ca', label: 'Canada', index: 2, selected: false, disabled: true },
      ]);

      const notSelect = await runResolve(spec('button', { read: { what: 'options' } }));
      expect(notSelect.matches[0].readValue).toBeNull();
    });
  });

  describe('the within scope', () => {
    it('resolves inside a stamped container', async () => {
      html('<div id="one"><input name="a"></div><div id="two"><input name="b"></div>');
      const containers = await runResolve(spec('div'));
      const secondRef = containers.matches[1].ref;

      const scoped = await runResolve(spec('input', { withinRef: secondRef }));
      expect(scoped.total).toBe(1);
      expect(scoped.matches[0].name).toBe('b');
    });

    /**
     * A scope that is gone is staleness, not absence, and the two get
     * different errors on the client. Reporting "nothing matched" for a
     * container that re-rendered would send a caller looking at the wrong
     * selector.
     */
    it('reports a scope that no longer exists as scopeMissing rather than as an empty match list', async () => {
      html('<div id="one"><input name="a"></div>');
      const r = await runResolve(spec('input', { withinRef: 'bgtest_gone' }));
      expect(r.scopeMissing).toBe(true);
      expect(r.matches).toEqual([]);
    });
  });

  /**
   * The stability check spans two animation frames INSIDE one evaluation,
   * which is affordable only because `awaitPromise` defaults to true on
   * `PageEvaluate`. Two frames here rather than two round trips is the
   * whole reason "stable" is not the expensive check it looks like.
   *
   * The rect comparison itself cannot be exercised under jsdom (every rect
   * is zero, so every element compares equal to itself), so what is proven
   * here is that the two-frame path settles and produces a boolean rather
   * than hanging. A moving element needs a real browser.
   */
  it('settles the two-frame stability check rather than hanging on it', async () => {
    html('<button id="a">A</button>');
    const r = await runResolve(spec('#a', { stable: true }));
    expect(typeof r.matches[0].stable === 'boolean' || r.matches[0].stable === null).toBe(true);
  });

  it('reports a selector the page refuses as data on the resolve path too, not as a thrown page exception', async () => {
    html('<button>x</button>');
    const r = await runResolve(spec('button:!!not-a-selector'));
    expect(typeof r.selectorError).toBe('string');
    expect(r.matches).toEqual([]);
    // Not 'nothing matched'. A caller told zero would go looking at the
    // page; a caller told the selector is malformed goes looking at the
    // selector.
    expect(r.total).toBe(0);
  });

  it('does not throw when asked to scroll an element the environment cannot scroll', async () => {
    html('<button id="a">A</button>');
    const r = await runResolve(spec('#a', { scroll: true }));
    expect(r.total).toBe(1);
  });

  it('reports the page it read, so a failure can say where it was looking', async () => {
    html('<button>x</button>');
    const r = await runResolve(spec('button'));
    expect(typeof r.url).toBe('string');
    expect(r.viewport.w).toBeGreaterThan(0);
  });
});

describe('the wait script, against a real DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** The wait spec the client builds, with the polling pass measuring nothing jsdom cannot answer. */
  function waitSpec(
    selector: string,
    state: string,
    deadlineMs: number,
    over: AnySpec = {},
  ): AnySpec {
    return {
      check: spec(selector, { stamp: false }),
      stamp: spec(selector, { stamp: true }),
      state,
      deadlineMs,
      pollMs: 10,
      index: null,
      ...over,
    };
  }

  it('resolves as soon as a DOM mutation makes the predicate true, without waiting out the deadline', async () => {
    const started = Date.now();
    const waiting = runWait(waitSpec('#late', 'attached', 5000));
    setTimeout(() => {
      document.body.innerHTML = '<button id="late">Now</button>';
    }, 20);

    const r = await waiting;
    expect(r.timedOut).toBe(false);
    expect(r.result.total).toBe(1);
    // It came back on the mutation, nowhere near the 5 second deadline.
    expect(Date.now() - started).toBeLessThan(2000);
  });

  /**
   * The stamp is written exactly once, on the pass that won, and never on
   * the polling passes. A stamp is an attribute write, the observer would
   * see its own writes, and the wait would spin itself awake ten times a
   * second while scribbling on a page an anti-automation script is reading.
   */
  it('stamps only the winning pass', async () => {
    document.body.innerHTML = '<button id="here">Here</button>';
    const r = await runWait(waitSpec('#here', 'attached', 1000));
    expect(r.result.matches[0].ref).toBe('bgtest_0');
    expect(r.checks).toBeGreaterThanOrEqual(1);
  });

  it('resolves with timedOut and the last observation rather than throwing from the page', async () => {
    document.body.innerHTML = '<button id="stays">Stays</button>';
    const r = await runWait(waitSpec('#stays', 'detached', 60));
    // Not a rejection. A page-side throw would arrive as an exception with
    // a message and no state, and the client would have nothing to build a
    // useful error out of.
    expect(r.timedOut).toBe(true);
    expect(r.result.total).toBe(1);
    expect(r.waitedMs).toBeGreaterThanOrEqual(0);
  });

  it('sees an element leave, which is the detached case the acting verbs rely on', async () => {
    document.body.innerHTML = '<button id="going">Going</button>';
    const waiting = runWait(waitSpec('#going', 'detached', 5000));
    setTimeout(() => {
      document.body.innerHTML = '';
    }, 20);
    const r = await waiting;
    expect(r.timedOut).toBe(false);
    expect(r.result.total).toBe(0);
  });

  it('honours an index, so a sibling becoming ready does not release a wait aimed at another match', async () => {
    document.body.innerHTML = '<button id="a">A</button>';
    const waiting = runWait(waitSpec('button', 'attached', 5000, { index: 1 }));
    setTimeout(() => {
      document.body.insertAdjacentHTML('beforeend', '<button id="b">B</button>');
    }, 20);
    const r = await waiting;
    expect(r.timedOut).toBe(false);
    expect(r.result.matches[1].id).toBe('b');
  });

  /**
   * The failure this covers is not the error message, it is the hang. The
   * resolver runs from a MutationObserver callback and from an interval,
   * and a synchronous throw out of either is an uncaught page error that no
   * promise is watching: the wait would sit there until its deadline and
   * report a timeout, which is the wrong answer to "your selector is
   * malformed". The selector error therefore comes back as data.
   */
  it('reports a selector the page cannot parse straight away instead of hanging until the deadline', async () => {
    const started = Date.now();
    const r = await runWait(waitSpec('button:!!not-a-selector', 'attached', 5000));
    expect(r.failed).toBe(true);
    expect(String(r.error)).toMatch(/selector/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not read a malformed selector as "nothing matched", which would make a detached wait succeed', async () => {
    const r = await runWait(waitSpec('button:!!not-a-selector', 'detached', 200));
    expect(r.failed).toBe(true);
    expect(r.timedOut).toBe(false);
  });

  it('leaves no observer or interval running once it settles', async () => {
    document.body.innerHTML = '<button id="x">X</button>';
    await runWait(waitSpec('#x', 'attached', 1000));
    // Two mutations after the wait settled. If the observer were still
    // attached, or the interval still running, this would keep resolving
    // and the process would never be idle; there is nothing to assert on
    // directly, so what is checked is that a second wait behaves as a
    // first one does.
    document.body.innerHTML = '<button id="x">X</button>';
    const again = await runWait(waitSpec('#x', 'attached', 1000));
    expect(again.timedOut).toBe(false);
    expect(again.wakes).toBe(0);
  });
});

/**
 * `SELECT_SCRIPT`, against real `<select>`/`<option>` elements.
 *
 * Unlike the resolver above, this needs none of the measurements jsdom
 * cannot produce (no rect, no visibility, no hit test): a `<select>`'s
 * `.options`, `.value` and `.selected` are ordinary DOM properties jsdom
 * implements faithfully, so the matching and mutation logic this file
 * exists to prove is fully exercised here, not deferred to the e2e suite.
 *
 * Every case stamps the element with `LOCATOR_REF_ATTRIBUTE` by hand
 * rather than through the resolver, because that is exactly the contract
 * `select()` relies on: the ref already exists on the element by the time
 * `SELECT_SCRIPT` runs (written by a prior `waitFor()`/`resolve()` call),
 * and this script's only job is to find it again and act.
 */
describe('the select script, against a real DOM', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  function stampedSelect(markup: string, ref = 'r1'): HTMLSelectElement {
    document.body.innerHTML = `<select id="s">${markup}</select>`;
    const el = document.getElementById('s') as HTMLSelectElement;
    el.setAttribute(LOCATOR_REF_ATTRIBUTE, ref);
    return el;
  }

  it('selects by value, and reports back the value and label actually selected', () => {
    stampedSelect('<option value="US">United States</option><option value="MX">Mexico</option>');
    const r = runSelect({ ref: 'r1', options: [{ value: 'MX' }] });
    expect(r).toMatchObject({ found: true, values: ['MX'], labels: ['Mexico'] });
    expect((document.getElementById('s') as HTMLSelectElement).value).toBe('MX');
  });

  it('selects by visible label (normalised textContent), not by value', () => {
    stampedSelect(
      '<option value="us">  United   States </option><option value="mx">Mexico</option>',
    );
    const r = runSelect({ ref: 'r1', options: [{ label: 'United States' }] });
    expect(r).toMatchObject({ found: true, values: ['us'] });
  });

  it('selects by index', () => {
    stampedSelect(
      '<option value="a">A</option><option value="b">B</option><option value="c">C</option>',
    );
    const r = runSelect({ ref: 'r1', options: [{ index: 2 }] });
    expect(r).toMatchObject({ found: true, values: ['c'] });
  });

  it('dispatches both input and change, bubbling, so a listener on either sees the change', () => {
    const el = stampedSelect('<option value="a">A</option><option value="b">B</option>');
    const seen: string[] = [];
    document.body.addEventListener('input', () => seen.push('input'));
    document.body.addEventListener('change', () => seen.push('change'));
    runSelect({ ref: 'r1', options: [{ value: 'b' }] });
    expect(seen).toEqual(['input', 'change']);
    expect(el.selectedIndex).toBe(1);
  });

  it('selects every requested option on a <select multiple>, and leaves every other option deselected', () => {
    document.body.innerHTML =
      '<select id="s" multiple><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>';
    const el = document.getElementById('s') as HTMLSelectElement;
    el.setAttribute(LOCATOR_REF_ATTRIBUTE, 'r1');
    // Pre-select 'c' to prove the previous selection is cleared, not
    // merely added to: select() replaces the selection, it does not
    // extend it.
    el.options[2]!.selected = true;

    const r = runSelect({ ref: 'r1', options: [{ value: 'a' }, { value: 'c' }] });
    expect(r).toMatchObject({ found: true, values: ['a', 'c'], labels: ['A', 'C'] });
    expect(el.options[0]!.selected).toBe(true);
    expect(el.options[1]!.selected).toBe(false);
    expect(el.options[2]!.selected).toBe(true);
  });

  it('refuses more than one option on a <select> without multiple, and mutates nothing', () => {
    const el = stampedSelect('<option value="a" selected>A</option><option value="b">B</option>');
    const r = runSelect({ ref: 'r1', options: [{ value: 'a' }, { value: 'b' }] });
    expect(r).toMatchObject({ found: true, notMultiple: true });
    expect(el.value).toBe('a');
  });

  it('reports every requested option that did not match, plus every option the <select> actually offers, and mutates nothing', () => {
    const el = stampedSelect('<option value="a" selected>A</option><option value="b">B</option>');
    const r = runSelect({ ref: 'r1', options: [{ value: 'zz' }] });
    expect(r.found).toBe(true);
    expect(r.missing).toEqual([{ value: 'zz' }]);
    expect(r.available).toEqual([
      { value: 'a', label: 'A', index: 0 },
      { value: 'b', label: 'B', index: 1 },
    ]);
    // Nothing was mutated: a caller asking for two options where only one
    // exists must not end up with the one that does exist half-applied.
    expect(el.value).toBe('a');
  });

  it('reports not found for a ref that does not resolve, the same contract every ref-addressed script honours', () => {
    document.body.innerHTML = '<select id="s"><option value="a">A</option></select>';
    const r = runSelect({ ref: 'gone', options: [{ value: 'a' }] });
    expect(r).toEqual({ found: false });
  });
});

describe('the find-in-page script, against a real DOM', () => {
  const runFind = new Function(`return (${FIND_IN_PAGE_SCRIPT});`)() as (
    spec: AnySpec,
  ) => Promise<AnyResult>;

  let originalRect: typeof Element.prototype.getBoundingClientRect;

  beforeEach(() => {
    document.body.innerHTML = '';
    // jsdom's own getBoundingClientRect always returns zeros (this file's
    // module doc), which would make bglsIsVisible reject every element and
    // this script report zero matches on every test. Stubbed to a fixed
    // nonzero rect so the visibility FILTER, the thing this script adds
    // over a plain text search, can actually be exercised here; jsdom's own
    // getComputedStyle is real (it parses `style=`), so `display: none` and
    // `visibility: hidden` below are genuine CSS reads, not stubbed.
    originalRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function (this: Element) {
      // A real browser gives `display: none` a zero rect, and
      // `bglsIsVisible` leans on exactly that (its own zero-rect check,
      // not a `display` read of its own) to catch it. Mirrored here so
      // this test can actually exercise that path; every other element
      // gets a fixed nonzero rect, since jsdom's own measurement is
      // unconditionally zero (this file's module doc).
      const cs = window.getComputedStyle(this);
      if (cs.display === 'none') {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: 0,
          height: 0,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 100,
        bottom: 20,
        width: 100,
        height: 20,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
  });

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalRect;
  });

  function findSpec(over: AnySpec = {}): AnySpec {
    return {
      pattern: '',
      flags: 'gi',
      contextChars: 60,
      limit: 50,
      stamp: true,
      refPrefix: 'bgtest',
      ...over,
    };
  }

  it('finds a pattern, reports the matched text and a window of surrounding context', async () => {
    const raw = 'Order total: $45.00, shipping included.';
    html(`<p>${raw}</p>`);
    const r = await runFind(findSpec({ pattern: '\\$45\\.00', contextChars: 8 }));
    const matchIndex = raw.indexOf('$45.00');
    const expectedContext = raw
      .slice(Math.max(0, matchIndex - 8), matchIndex + '$45.00'.length + 8)
      .replace(/\s+/g, ' ')
      .trim();
    expect(r.total).toBe(1);
    expect(r.matches[0].text).toBe('$45.00');
    expect(r.matches[0].context).toBe(expectedContext);
    expect(r.matches[0].tagName).toBe('p');
  });

  it('is case-insensitive by default and finds every occurrence, not just the first', async () => {
    html('<p>apple, Apple, APPLE</p>');
    const r = await runFind(findSpec({ pattern: 'apple' }));
    expect(r.total).toBe(3);
    expect(r.matches.map((m: AnyResult) => m.text)).toEqual(['apple', 'Apple', 'APPLE']);
  });

  it('does not report text hidden by CSS, matching bglsIsVisible everywhere else in this file', async () => {
    html(
      '<p style="display: none">Secret total: $99</p><p style="visibility: hidden">Also hidden: $88</p><p>Visible: $77</p>',
    );
    const r = await runFind(findSpec({ pattern: '\\$\\d+' }));
    expect(r.matches.map((m: AnyResult) => m.text)).toEqual(['$77']);
  });

  it('skips script/style/noscript/template content', async () => {
    html('<script>var total = "$1";</script><style>.x { content: "$2"; }</style><p>Real: $3</p>');
    const r = await runFind(findSpec({ pattern: '\\$\\d' }));
    expect(r.matches.map((m: AnyResult) => m.text)).toEqual(['$3']);
  });

  it('restricts the search to a CSS scope, and reports scopeMissing when the scope matches nothing', async () => {
    html('<div id="a">Alpha total: $1</div><div id="b">Beta total: $2</div>');
    const scoped = await runFind(findSpec({ pattern: 'total', scope: '#b' }));
    expect(scoped.matches).toHaveLength(1);
    expect(scoped.matches[0].context).toContain('Beta');

    const missing = await runFind(findSpec({ pattern: 'total', scope: '#nope' }));
    expect(missing.scopeMissing).toBe(true);
    expect(missing.matches).toEqual([]);
  });

  it('stamps each match with a fresh ref by default, addressable the same way a resolved match is', async () => {
    html('<button id="b">Submit order</button>');
    const r = await runFind(findSpec({ pattern: 'Submit' }));
    expect(r.matches[0].ref).toBe('bgtest_0');
    expect(document.getElementById('b')?.getAttribute(LOCATOR_REF_ATTRIBUTE)).toBe('bgtest_0');
  });

  it('does not stamp when stamp: false', async () => {
    html('<button id="b">Submit order</button>');
    const r = await runFind(findSpec({ pattern: 'Submit', stamp: false }));
    expect(r.matches[0].ref).toBeNull();
    expect(document.getElementById('b')?.hasAttribute(LOCATOR_REF_ATTRIBUTE)).toBe(false);
  });

  it('caps returned matches at limit but still reports the real total', async () => {
    html('<p>a a a a a</p>');
    const r = await runFind(findSpec({ pattern: 'a', limit: 2 }));
    expect(r.matches).toHaveLength(2);
    expect(r.total).toBe(5);
    expect(r.truncated).toBe(true);
  });

  it('accepts a genuine regex pattern, not just an escaped literal', async () => {
    html('<p>call 555-0100 or 555-0199</p>');
    const r = await runFind(findSpec({ pattern: '555-01\\d\\d' }));
    expect(r.matches.map((m: AnyResult) => m.text)).toEqual(['555-0100', '555-0199']);
  });

  it('reports an invalid pattern as data, not as a thrown page exception', async () => {
    html('<p>hello</p>');
    const r = await runFind(findSpec({ pattern: '(unterminated' }));
    expect(r.total).toBe(0);
    expect(r.matches).toEqual([]);
    expect(typeof r.patternError).toBe('string');
  });
});
