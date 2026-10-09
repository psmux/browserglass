/**
 * The page-side half of the locator engine: one resolver, shared by every
 * verb, plus one waiter built on top of it.
 *
 * WHY THIS IS A STRING AND NOT A FUNCTION
 *
 * `page.evaluate` carries either an `expression` or a `functionDeclaration`
 * plus JSON `args`, and the server composes them as
 * `(<declaration>).call(globalThis, <literals>)`
 * (`packages/core/src/cdp/evaluate.ts`, `buildExpression`). A real
 * TypeScript function passed through `Function.prototype.toString()` would
 * work only as long as nothing in the build pipeline renamed a binding,
 * inlined a helper, or injected a `__name` shim, and it would silently
 * break the day tsup's settings changed. So the source is authored as text,
 * in plain ES5-ish JavaScript, and never compiled. The one cost is that
 * this file gets no type checking of its own; the mitigating factor is that
 * every shape it returns is declared once in `./types.ts` and asserted in
 * `test/client/locator.test.ts` against a scripted reply.
 *
 * WHY ONE RESOLVER RATHER THAN A VERB PER SCRIPT
 *
 * In a typical Playwright automation script, `.locator(`, `.count(`,
 * `.first`, `.nth(` and `.is_visible(` are all the same question asked
 * four times over a socket, because a Playwright locator is lazy and re-queries on every
 * property access. That design is right when the driver shares a process
 * with the browser and wrong when it does not. `bglsResolve` answers all of
 * it in one round trip: the caller gets every match, with its rect, its
 * five actionability answers and what is sitting on top of it, and then
 * chooses. Most of those call sites collapse into data the caller
 * already has.
 *
 * WHY THERE IS NO HANDLE
 *
 * `PageEvaluate` returns by value and never an `objectId`; that refusal is
 * deliberate and permanent (see its module doc, escalation path 5), and
 * `evaluateInSession` never reads one even when CDP offers it. So a
 * `Locator` object holding a live element reference cannot exist on this
 * wire at any price. What crosses instead is a `ref`: a token this script
 * stamps onto the element as `data-bgls-ref`, which later calls address as
 * an attribute selector. That is a trick hand written automation code
 * often invents for itself, including the same known
 * limitation: it goes stale when the subtree re-renders. See
 * `LOCATOR_REF_ATTRIBUTE`'s own note.
 */

/** The attribute a stamped match is addressed by. Kept in one place because both this script and the client-side `ref=` selector spelling have to agree on it. */
export const LOCATOR_REF_ATTRIBUTE = 'data-bgls-ref';

/**
 * Enumerates a `<select>`'s options: value, visible label, position, and
 * whether each is selected or disabled.
 *
 * Written once and interpolated into two otherwise-independent script
 * bodies, `RESOLVER_CORE` (so `resolve()` can read it via
 * `read: { what: 'options' }`, riding along on the resolver exactly like
 * `innerText`/`getAttribute`/`isChecked` already do) and `SELECT_SCRIPT`
 * (whose own option-not-found error already had to list every option the
 * `<select>` offers). One function text, not two copies of the same loop
 * free to drift apart on what "the options" means.
 *
 * Deliberately self-contained (its own whitespace-normaliser, rather than
 * calling `RESOLVER_CORE`'s `bglsNorm`): `SELECT_SCRIPT` does not include
 * `RESOLVER_CORE` at all, and coupling this helper to a function that is
 * not always present would make it unsafe to drop into either script
 * without also checking the other.
 */
const OPTION_LIST_HELPER = `
function bglsNormOptionText(s) {
  return (s === null || s === undefined ? '' : String(s)).replace(/\\s+/g, ' ').trim();
}
function bglsListOptions(el) {
  var options = el.options;
  var out = [];
  for (var i = 0; i < options.length; i++) {
    out.push({
      value: options[i].value,
      label: bglsNormOptionText(options[i].textContent),
      index: i,
      selected: options[i].selected,
      disabled: options[i].disabled,
    });
  }
  return out;
}
`;

/**
 * The shared body: every helper, and the `bglsResolve` entry point that
 * both exported scripts call. Concatenated into each script rather than
 * installed once on `window`, and the reason is not tidiness. A resolver
 * cached on the page would be a persistent, fingerprintable artefact that
 * outlives the call, on a page an anti-automation script is reading. This
 * way nothing survives the evaluation except the `data-bgls-ref`
 * attributes, which are opt-out (`stamp: false`).
 *
 * Written without template literals, arrow functions in hot paths, or
 * optional chaining so the text is legible in a CDP trace and safe on any
 * engine the gateway might drive.
 */
const RESOLVER_CORE = `
var BGLS_REF_ATTR = ${JSON.stringify(LOCATOR_REF_ATTRIBUTE)};
${OPTION_LIST_HELPER}
function bglsNorm(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\\s+/g, ' ').trim();
}

/**
 * Splits a selector on the '>>' chain combinator, ignoring one inside a
 * quoted string or inside brackets. CSS's own child combinator is a single
 * '>', so 'div > span' is untouched; '[value=">>"]' survives because the
 * scanner tracks quotes.
 */
function bglsSplitSegments(sel) {
  var out = [];
  var buf = '';
  var quote = null;
  var depth = 0;
  for (var i = 0; i < sel.length; i++) {
    var c = sel.charAt(i);
    if (quote !== null) {
      buf += c;
      if (c === quote && sel.charAt(i - 1) !== '\\\\') quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (depth <= 0 && c === '>' && sel.charAt(i + 1) === '>') { out.push(buf); buf = ''; i++; continue; }
    buf += c;
  }
  out.push(buf);
  var trimmed = [];
  for (var j = 0; j < out.length; j++) {
    var t = out[j].trim();
    if (t.length > 0) trimmed.push(t);
  }
  return trimmed;
}

/**
 * Reads the engine off one segment. An explicit 'engine=' prefix always
 * wins; with no prefix, a segment starting with '/' or '(' is XPath (the
 * same auto-detection Playwright uses, and the only unambiguous one) and
 * everything else is CSS. CSS being the unprefixed default is not a
 * coin toss: in real automation scripts nearly every '.locator(' argument
 * is either attribute CSS or a chained extra.
 */
function bglsParseSegment(seg) {
  var m = /^(css|text|xpath|label|ref|visible|frame)=([\\s\\S]*)$/.exec(seg);
  if (m) return { engine: m[1], value: m[2] };
  var c0 = seg.charAt(0);
  if (c0 === '/' || c0 === '(') return { engine: 'xpath', value: seg };
  return { engine: 'css', value: seg };
}

function bglsDocOrder(a, b) {
  if (a === b) return 0;
  var rel = a.compareDocumentPosition(b);
  if (rel & 4) return -1;
  if (rel & 2) return 1;
  return 0;
}

function bglsIsVisible(el) {
  if (!el || el.nodeType !== 1 || !el.isConnected) return false;
  var r = el.getBoundingClientRect();
  // display:none produces a zero rect, so it is covered here and needs no
  // separate test. A zero-area element is treated as invisible even when it
  // is technically rendered, which is what Playwright does and what a
  // caller means when it asks.
  if (r.width <= 0 || r.height <= 0) return false;
  var view = el.ownerDocument && el.ownerDocument.defaultView;
  var cs = view ? view.getComputedStyle(el) : null;
  if (!cs) return false;
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
  // opacity:0 is NOT counted as invisible, matching Playwright: it is
  // still hit-testable and still receives real clicks. The value is
  // reported in the state bag so a failure report can mention it.
  return true;
}

function bglsDisabledReason(el) {
  if (el.disabled === true) return 'element.disabled';
  if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return 'aria-disabled="true"';
  if (el.closest && el.closest('fieldset[disabled]')) return 'ancestor fieldset[disabled]';
  return null;
}

function bglsIsEditable(el) {
  if (el.readOnly === true) return false;
  var ce = el.getAttribute ? el.getAttribute('contenteditable') : null;
  if (ce === 'false') return false;
  var tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (ce !== null) return true;
  return el.isContentEditable === true;
}

/**
 * A short, human-readable description of an element, for the one place it
 * matters most: naming what took a click. 'Timeout 6000ms exceeded' tells
 * a caller nothing, and the answer they actually need is something like
 * 'div[data-testid="click_filter"]'. So the attributes preferred
 * here are the ones that identify a widget rather than style it.
 */
function bglsDescribe(el) {
  if (!el || el.nodeType !== 1) return null;
  var s = el.tagName.toLowerCase();
  if (el.id) s += '#' + el.id;
  var interesting = ['data-automation-id', 'data-testid', 'data-test-id', 'name', 'role', 'type', 'aria-label', 'placeholder'];
  for (var i = 0; i < interesting.length; i++) {
    var v = el.getAttribute ? el.getAttribute(interesting[i]) : null;
    if (v) s += '[' + interesting[i] + '="' + String(v).slice(0, 40) + '"]';
  }
  if (s === el.tagName.toLowerCase()) {
    var cls = el.getAttribute ? el.getAttribute('class') : null;
    if (cls) {
      var parts = bglsNorm(cls).split(' ');
      s += '.' + parts.slice(0, 2).join('.');
    }
  }
  return s.slice(0, 200);
}

/**
 * The receives-events check, and the source of the occlusion diagnostic.
 *
 * Walks the hit stack from the top down. An element that CONTAINS the
 * target is a wrapper, not an occluder, and is skipped: a positioned
 * ancestor is always in the stack and treating it as a blocker would fail
 * every click. The first entry that is neither the target, nor inside it,
 * nor an ancestor of it, is what would actually take the click.
 */
function bglsHitTest(el, cx, cy) {
  var doc = el.ownerDocument;
  var view = doc.defaultView;
  if (cx < 0 || cy < 0 || cx > view.innerWidth || cy > view.innerHeight) {
    return { ok: null, blocker: null, reason: 'point outside the viewport' };
  }
  var stack = doc.elementsFromPoint ? doc.elementsFromPoint(cx, cy) : [doc.elementFromPoint(cx, cy)];
  if (!stack || stack.length === 0) return { ok: false, blocker: null, reason: 'nothing is hit-testable at that point' };
  for (var i = 0; i < stack.length; i++) {
    var node = stack[i];
    if (!node) continue;
    if (node === el || el.contains(node)) return { ok: true, blocker: null, reason: null };
    if (node.contains(el)) continue;
    return { ok: false, blocker: bglsDescribe(node), reason: 'covered' };
  }
  return { ok: false, blocker: null, reason: 'the element is not in the hit stack at its own centre' };
}

/** The four-rule label read. Deliberately NOT the ARIA accessible-name computation: see 'label=' in the client-side docs for what it does and does not do. */
function bglsLabelText(el) {
  var doc = el.ownerDocument;
  var by = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
  if (by) {
    var ids = by.split(/\\s+/);
    var acc = [];
    for (var i = 0; i < ids.length; i++) {
      var ref = doc.getElementById(ids[i]);
      if (ref) acc.push(bglsNorm(ref.textContent));
    }
    var joined = bglsNorm(acc.join(' '));
    if (joined) return joined;
  }
  var aria = el.getAttribute ? el.getAttribute('aria-label') : null;
  if (aria && bglsNorm(aria)) return bglsNorm(aria);
  if (el.id) {
    var forLabels = doc.querySelectorAll('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
    if (forLabels.length > 0) {
      var ft = bglsNorm(forLabels[0].textContent);
      if (ft) return ft;
    }
  }
  var wrap = el.closest ? el.closest('label') : null;
  if (wrap) {
    var wt = bglsNorm(wrap.textContent);
    if (wt) return wt;
  }
  return null;
}

function bglsMatchesNeedle(haystack, value) {
  var exact = false;
  var needle = value;
  var q = /^"([\\s\\S]*)"$/.exec(value);
  if (q) { exact = true; needle = q[1]; }
  needle = bglsNorm(needle).toLowerCase();
  var hay = bglsNorm(haystack).toLowerCase();
  return exact ? hay === needle : (needle.length > 0 && hay.indexOf(needle) >= 0);
}

/** Resolves one segment against a list of roots, deduped and returned in document order. */
function bglsMatchSegment(parsed, roots) {
  var engine = parsed.engine;
  var value = parsed.value;

  if (engine === 'visible') {
    var want = value !== 'false';
    var kept = [];
    for (var v = 0; v < roots.length; v++) {
      if (roots[v].nodeType === 1 && bglsIsVisible(roots[v]) === want) kept.push(roots[v]);
    }
    return kept;
  }

  var out = [];
  var seen = [];
  function push(el) {
    if (!el || el.nodeType !== 1) return;
    if (seen.indexOf(el) >= 0) return;
    seen.push(el);
    out.push(el);
  }

  for (var r = 0; r < roots.length; r++) {
    var root = roots[r];
    if (engine === 'css' || engine === 'ref') {
      var css = engine === 'ref'
        ? '[' + BGLS_REF_ATTR + '="' + (window.CSS && CSS.escape ? CSS.escape(value) : value) + '"]'
        : value;
      var list = root.querySelectorAll(css);
      for (var i = 0; i < list.length; i++) push(list[i]);
      // A chained CSS segment addresses DESCENDANTS of the previous match,
      // which is what 'querySelectorAll' on that node already means. The
      // node itself is deliberately not tested against the segment: that
      // would make 'div >> div' match its own root, which is nobody's
      // intent.
    } else if (engine === 'xpath') {
      // Relative to 'root', which for a chained segment is the previous
      // match. This is the whole reason the XPath engine exists: the
      // common uses are 'ancestor::label[1]' and '..', and CSS has no
      // spelling for either.
      var doc = root.nodeType === 9 ? root : root.ownerDocument;
      var snap = doc.evaluate(value, root, null, 7, null);
      for (var x = 0; x < snap.snapshotLength; x++) push(snap.snapshotItem(x));
    } else if (engine === 'text') {
      var scope = root.nodeType === 9 ? (root.body || root.documentElement) : root;
      if (!scope) continue;
      var all = scope.querySelectorAll('*');
      var hits = [];
      for (var t = 0; t < all.length; t++) {
        var cand = all[t];
        var tn = cand.tagName;
        if (tn === 'SCRIPT' || tn === 'STYLE' || tn === 'NOSCRIPT' || tn === 'TEMPLATE') continue;
        // textContent, not innerText, on purpose: innerText forces layout
        // for every element in the document and would turn a text lookup
        // into the most expensive call on this surface. The cost is that
        // this sees text CSS has hidden; chain '>> visible=true' when that
        // matters.
        if (bglsMatchesNeedle(cand.textContent, value)) hits.push(cand);
      }
      // Innermost only. Every ancestor of a matching node also 'contains'
      // the text, so without this a text lookup returns html, body, and
      // every wrapper div down to the one the caller meant.
      for (var h = 0; h < hits.length; h++) {
        var inner = false;
        for (var k = 0; k < hits.length; k++) {
          if (hits[k] !== hits[h] && hits[h].contains(hits[k])) { inner = true; break; }
        }
        if (!inner) push(hits[h]);
      }
    } else if (engine === 'label') {
      var scope2 = root.nodeType === 9 ? (root.body || root.documentElement) : root;
      if (!scope2) continue;
      var cands = scope2.querySelectorAll('input,select,textarea,button,[contenteditable],[role]');
      for (var c = 0; c < cands.length; c++) {
        var lt = bglsLabelText(cands[c]);
        if (lt !== null && bglsMatchesNeedle(lt, value)) push(cands[c]);
      }
    }
  }

  out.sort(bglsDocOrder);
  return out;
}

/**
 * Below this, in CSS px, a matched iframe is refused as too small to
 * meaningfully enter: a 0x0 or 1x1 tracking pixel is never what a
 * 'frame=' segment meant, and entering it would still measure and click
 * against a frame nobody could see. Mirrors browser-use's own minimum
 * frame size gate (dom/service.py).
 */
var BGLS_MIN_FRAME_DIM = 4;

/**
 * Attempts to enter the ONE frame a 'frame=' segment's CSS value matches
 * against 'roots'. 'value' is matched as plain CSS, never as a nested
 * 'engine=value': an iframe is found by 'iframe#id'/'iframe[name=x]'
 * overwhelmingly, and a second engine prefix living inside a frame= value
 * would be a spelling nobody asked for.
 *
 * Three outcomes:
 *  - Zero matches: '{ roots: [] }'. NOT a boundary. Nothing downstream can
 *    match either, and the caller already treats an empty 'current' as the
 *    ordinary "nothing matched" answer every other engine gives it.
 *  - Exactly one match, same document/origin as this evaluate: '{ roots:
 *    [Document], offsetX, offsetY }'. The resolve loop keeps going, IN THIS
 *    SAME EVALUATION, against the entered document. This is the one round
 *    trip path: however many 'frame=' segments a selector chains, as long
 *    as each is same-process, the whole thing costs one 'page.evaluate',
 *    the same as a selector with none.
 *  - Anything else (more than one match, a non-frame element, a frame too
 *    small to be worth entering, or a frame whose 'contentDocument' this
 *    script cannot read because it is cross-origin or sandboxed without
 *    'allow-same-origin'): '{ boundary: {...} }'. The client decides what
 *    that means; see 'LocatorEngine.enterFrame' in '../locator/engine.ts'
 *    for the taxonomy each 'reason' maps to.
 */
function bglsEnterFrame(value, roots, atSegment, accX, accY) {
  var candidates = bglsMatchSegment({ engine: 'css', value: value }, roots);
  if (candidates.length === 0) return { roots: [], offsetX: accX, offsetY: accY };
  if (candidates.length > 1) {
    return { boundary: { atSegment: atSegment, reason: 'ambiguous', matchCount: candidates.length } };
  }
  var el = candidates[0];
  if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') {
    return { boundary: { atSegment: atSegment, reason: 'not_a_frame', matchCount: 1 } };
  }
  var rect = el.getBoundingClientRect();
  if (rect.width < BGLS_MIN_FRAME_DIM || rect.height < BGLS_MIN_FRAME_DIM) {
    return { boundary: { atSegment: atSegment, reason: 'too_small', matchCount: 1 } };
  }
  // The content box starts after the iframe's own border, and 'accX'/'accY'
  // is already the accumulated top-document offset of THIS frame's own
  // parent, so adding 'rect.left'/'rect.top' (this frame's position in that
  // parent's viewport) plus 'clientLeft'/'clientTop' (this frame's own
  // border width) walks the offset one level further out, exactly the
  // 'total_frame_offset' accumulation browser-use's own doc names
  // (dom/service.py:780-840). No DPR multiplier anywhere in this sum,
  // matching 'packages/core/src/input/coordinates.ts's own rule: CSS px in
  // a nested frame are 1:1 with CSS px in its parent, which holds as long
  // as nothing applies a CSS zoom/transform to the iframe box itself, a
  // case this does not attempt to correct for.
  var offX = accX + rect.left + (el.clientLeft || 0);
  var offY = accY + rect.top + (el.clientTop || 0);
  var innerDoc = null;
  try {
    innerDoc = el.contentDocument;
  } catch (e) {
    innerDoc = null;
  }
  if (!innerDoc) {
    // Cross-origin, or sandboxed without 'allow-same-origin': the IDL
    // getter itself answers 'null' for both (it never throws), which is
    // why one check covers what are, from here, indistinguishable cases.
    // 'el.src', the IDL property and NOT 'el.getAttribute("src")', is read
    // here on purpose: a URL-reflecting IDL attribute resolves against the
    // document's own base URL and always comes back absolute (or empty
    // string for no 'src' at all), so the client never has to guess which
    // document's base a relative 'src="/widget.html"' resolves against.
    // It is the one signal the client has to correlate this element with
    // an attached CDP target (see 'LocatorRuntime.listFrameTargets').
    return {
      boundary: {
        atSegment: atSegment,
        reason: 'cross_origin',
        matchCount: 1,
        candidateSrc: el.src || null,
        offsetX: offX,
        offsetY: offY,
      },
    };
  }
  return { roots: [innerDoc], offsetX: offX, offsetY: offY };
}

function bglsRectOf(el) {
  var r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function bglsSameRect(a, b) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

/**
 * One animation frame, or 50ms, whichever comes first.
 *
 * The race is load bearing. requestAnimationFrame does not fire in a
 * backgrounded tab, and a backgrounded tab is precisely the one an
 * unattended agent is most likely to be driving. Without the timeout a
 * stability check on such a tab would hang until the evaluate deadline
 * killed it, turning a 10ms read into a 30 second failure. When the timer
 * wins, the caller is told the stability answer is unknown rather than
 * being handed a guess.
 */
function bglsFrame() {
  return new Promise(function (resolve) {
    var settled = false;
    function done(byFrame) { if (settled) return; settled = true; resolve(byFrame); }
    requestAnimationFrame(function () { done(true); });
    setTimeout(function () { done(false); }, 50);
  });
}

/**
 * The single entry point. Returns a promise because the stability check
 * spans two animation frames, which is affordable only because
 * 'PageEvaluate.awaitPromise' defaults to true: two frames inside one
 * evaluate rather than two round trips.
 */
function bglsResolve(spec) {
  var selector = String(spec.selector);
  var limit = spec.limit === undefined || spec.limit === null ? 50 : spec.limit;
  var segments = bglsSplitSegments(selector);
  var parsed = [];
  for (var s = 0; s < segments.length; s++) parsed.push(bglsParseSegment(segments[s]));

  var roots = [document];
  if (spec.withinRef) {
    var scopeSel = '[' + BGLS_REF_ATTR + '="' + (window.CSS && CSS.escape ? CSS.escape(spec.withinRef) : spec.withinRef) + '"]';
    var scopeEl = document.querySelector(scopeSel);
    if (!scopeEl) {
      return Promise.resolve({
        matches: [], total: 0, truncated: false, engine: parsed.length > 0 ? parsed[0].engine : 'css',
        segments: segments.length, scopeMissing: true, selectorError: null, url: location.href, title: document.title,
        viewport: { w: window.innerWidth, h: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
      });
    }
    roots = [scopeEl];
  }

  // A selector the engine cannot parse is reported as DATA, not as a
  // thrown page exception, and the reason is the wait loop. bglsResolve
  // is called from a MutationObserver callback and from an interval there,
  // and a synchronous throw out of either is an uncaught error in the page
  // that no promise is watching: the wait would then hang until its
  // deadline and report a timeout, which is the wrong answer to "your
  // selector is malformed". Returning it means both callers get to say
  // something accurate immediately.
  var current = roots;
  // Accumulated top-document offset of whatever document 'current' is
  // rooted in, in CSS px. Zero for every selector with no 'frame=' segment,
  // which is the overwhelmingly common case and costs this loop nothing
  // extra to run through. See 'bglsEnterFrame' for how each hop grows it.
  var frameOffsetX = 0;
  var frameOffsetY = 0;
  var frameBoundary = null;
  try {
    for (var p = 0; p < parsed.length; p++) {
      if (parsed[p].engine === 'frame') {
        var entered = bglsEnterFrame(parsed[p].value, current, p, frameOffsetX, frameOffsetY);
        if (entered.boundary) {
          frameBoundary = entered.boundary;
          current = [];
          break;
        }
        current = entered.roots;
        frameOffsetX = entered.offsetX;
        frameOffsetY = entered.offsetY;
        if (current.length === 0) break;
        continue;
      }
      current = bglsMatchSegment(parsed[p], current);
      if (current.length === 0) break;
    }
  } catch (err) {
    return Promise.resolve({
      matches: [], total: 0, truncated: false, engine: parsed.length > 0 ? parsed[0].engine : 'css',
      segments: segments.length, scopeMissing: false,
      selectorError: String((err && err.message) || err),
      url: location.href, title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    });
  }

  if (frameBoundary) {
    // The chain cannot be finished in this evaluation: either it is
    // genuinely ambiguous, addressed something that is not a frame, or the
    // next hop is cross-origin/sandboxed and needs a different CDP target.
    // Reported as data, exactly like 'selectorError' above and for the
    // identical reason: this runs inside a MutationObserver callback with
    // nothing watching a thrown exception. 'LocatorEngine.enterFrame' is
    // the one place this becomes an 'AutomationError'.
    return Promise.resolve({
      matches: [], total: 0, truncated: false,
      engine: parsed.length > 0 ? parsed[parsed.length - 1].engine : 'css',
      segments: segments.length, scopeMissing: false, selectorError: null,
      url: location.href, title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
      frameBoundary: frameBoundary,
    });
  }

  var total = current.length;
  var els = current.slice(0, limit);

  // scrollIntoView runs HERE, before any measurement and inside the same
  // evaluation, and never as a separate call. The production failure this
  // prevents: a bounding box read while
  // the control was below the fold gave coordinates that pointed at
  // whatever happened to be at that spot on screen, and the mouse route
  // clicked empty page. A scroll in a previous round trip means measuring
  // a different page from the one that was scrolled.
  if (spec.scroll && els.length > 0) {
    var target = els[spec.scrollIndex !== undefined && spec.scrollIndex !== null ? spec.scrollIndex : 0];
    if (target && target.scrollIntoView) {
      try { target.scrollIntoView({ block: 'center', inline: 'center' }); } catch (e) { target.scrollIntoView(); }
    }
  }

  var wantStable = spec.stable !== false && els.length > 0;
  var first = null;

  function measure(sawFrames) {
    var out = [];
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var attached = el.isConnected === true;
      var rect = bglsRectOf(el);
      // 'cx'/'cy' are LOCAL to 'el.ownerDocument': the coordinate space
      // 'bglsHitTest' (and 'stable', which compares 'rect' pass to pass, and
      // 'inViewport' below) has to work in, because occlusion inside a frame
      // is a fact about that frame, not about the top page. What crosses the
      // wire as 'center'/'rect' is 'frameOffsetX/Y' ADDED on separately,
      // once, right before this element is pushed: the TOP-document point
      // real input dispatch needs, per this file's own module doc on why
      // there is no handle and 'engine.ts's 'enterFrame' doc on why dispatch
      // always targets the top-level page.
      var cx = rect.x + rect.w / 2;
      var cy = rect.y + rect.h / 2;
      var view = el.ownerDocument.defaultView;
      var cs = attached && view ? view.getComputedStyle(el) : null;
      var visible = bglsIsVisible(el);
      var disabledReason = bglsDisabledReason(el);
      var hit = spec.hitTest === false || !visible
        ? { ok: null, blocker: null, reason: spec.hitTest === false ? 'not requested' : 'not visible' }
        : bglsHitTest(el, cx, cy);
      var inViewLeft = rect.x + rect.w > 0 && rect.y + rect.h > 0;
      var inViewRight = view ? rect.x < view.innerWidth && rect.y < view.innerHeight : rect.x < window.innerWidth && rect.y < window.innerHeight;
      var stable = null;
      if (wantStable) {
        if (!sawFrames) stable = null;
        else stable = first !== null && first[i] !== undefined && bglsSameRect(first[i], rect);
      }
      var ref = null;
      if (spec.stamp !== false && attached && el.setAttribute) {
        ref = String(spec.refPrefix) + '_' + i;
        el.setAttribute(BGLS_REF_ATTR, ref);
      }
      var value = null;
      if (typeof el.value === 'string') value = el.value.slice(0, 2000);
      // Only where it means something. Every <input> has a boolean
      // 'checked' property, including a text field, so reporting it
      // unconditionally would answer 'checked: false' for an email box,
      // which is not false so much as meaningless. Checkboxes and radios
      // get the real property; anything else gets 'aria-checked' if it
      // claims to be checkable, and null otherwise.
      var checked = null;
      var inputType = el.tagName === 'INPUT' ? String(el.type || '').toLowerCase() : '';
      if (inputType === 'checkbox' || inputType === 'radio') {
        checked = el.checked === true;
      } else {
        var ariaChecked = el.getAttribute ? el.getAttribute('aria-checked') : null;
        if (ariaChecked !== null) checked = ariaChecked === 'true';
      }
      // The read verbs ride along on the resolver rather than making a
      // second call of their own. 'innerText', 'getAttribute' and
      // 'isChecked' are nearly always preceded by a locate in real
      // scripts; making them one round trip
      // instead of two is the same argument that produced 'resolve' in the
      // first place. innerText (not textContent) is used here on purpose:
      // it is what '.inner_text()' means, it is what a caller comparing
      // against what a person can see wants, and it is only paid for when
      // asked.
      var readValue = null;
      if (spec.read) {
        var what = spec.read.what;
        if (what === 'innerText') {
          readValue = typeof el.innerText === 'string' ? el.innerText : String(el.textContent || '');
          readValue = readValue.slice(0, spec.read.limit === undefined ? 20000 : spec.read.limit);
        } else if (what === 'attribute') {
          readValue = el.getAttribute ? el.getAttribute(spec.read.name) : null;
        } else if (what === 'checked') {
          readValue = checked;
        } else if (what === 'value') {
          readValue = typeof el.value === 'string' ? el.value : null;
        } else if (what === 'options') {
          // Only for a <select>: any other tag has no options to list, and
          // reporting null rather than an empty array keeps "this is not a
          // <select>" distinguishable from "this <select> has no options",
          // the same distinction 'checked' draws above for a non-checkable
          // element.
          readValue = el.tagName === 'SELECT' ? bglsListOptions(el) : null;
        }
      }
      out.push({
        index: i,
        ref: ref,
        tagName: el.tagName.toLowerCase(),
        type: el.getAttribute ? el.getAttribute('type') : null,
        id: el.id || null,
        name: el.getAttribute ? el.getAttribute('name') : null,
        role: el.getAttribute ? el.getAttribute('role') : null,
        // TOP-document CSS px: 'rect'/'center' cross the wire already
        // translated, so a caller (and 'engine.ts's own dispatch calls)
        // never has to know how many frames deep the match was found.
        rect: { x: rect.x + frameOffsetX, y: rect.y + frameOffsetY, w: rect.w, h: rect.h },
        center: { x: cx + frameOffsetX, y: cy + frameOffsetY },
        attached: attached,
        visible: visible,
        enabled: disabledReason === null,
        disabledReason: disabledReason,
        editable: bglsIsEditable(el),
        stable: stable,
        hitTestOk: hit.ok,
        occludedBy: hit.blocker,
        hitReason: hit.reason,
        inViewport: inViewLeft && inViewRight,
        opacity: cs ? Number(cs.opacity) : null,
        pointerEvents: cs ? cs.pointerEvents : null,
        text: bglsNorm(el.textContent).slice(0, spec.textLimit === undefined ? 200 : spec.textLimit) || null,
        value: value,
        checked: checked,
        readValue: readValue,
        describe: bglsDescribe(el),
      });
    }
    return {
      matches: out,
      total: total,
      truncated: total > els.length,
      engine: parsed.length > 0 ? parsed[parsed.length - 1].engine : 'css',
      segments: segments.length,
      scopeMissing: false,
      selectorError: null,
      url: location.href,
      title: document.title,
      viewport: { w: window.innerWidth, h: window.innerHeight, scrollX: window.scrollX, scrollY: window.scrollY },
    };
  }

  if (!wantStable) return Promise.resolve(measure(false));

  return bglsFrame().then(function () {
    first = [];
    for (var i = 0; i < els.length; i++) first.push(bglsRectOf(els[i]));
    return bglsFrame();
  }).then(function (sawFrame) {
    return measure(sawFrame);
  });
}

function bglsActionable(e) {
  // 'stable' and 'hitTestOk' being null means the answer could not be
  // determined (a tab that never painted, or the check was not requested)
  // and must not block: refusing to act on a tab that does not paint would
  // be strictly worse than acting.
  return e.attached && e.visible && e.enabled && e.hitTestOk !== false && e.stable !== false;
}

function bglsSatisfied(state, res, index) {
  var m = res.matches;
  // A caller that named an index is waiting for THAT element, not for any
  // element. Releasing it early because a sibling became ready first would
  // hand it a match it then has to reject on its own.
  if (index !== null && index !== undefined) {
    var one = m[index];
    if (state === 'detached') return one === undefined;
    if (one === undefined) return false;
    if (state === 'attached') return true;
    if (state === 'hidden') return !one.visible;
    if (state === 'visible') return one.visible;
    return bglsActionable(one);
  }
  if (state === 'detached') return res.total === 0;
  if (state === 'attached') return res.total > 0;
  if (state === 'hidden') {
    if (res.total === 0) return true;
    for (var h = 0; h < m.length; h++) if (m[h].visible) return false;
    return true;
  }
  if (state === 'visible') {
    for (var v = 0; v < m.length; v++) if (m[v].visible) return true;
    return false;
  }
  // 'actionable': at least one match passes every check that has an answer.
  for (var a = 0; a < m.length; a++) {
    if (bglsActionable(m[a])) return true;
  }
  return false;
}
`;

/**
 * `resolve(selector)`, the primitive every other verb is built on. One
 * argument, one round trip, all matches.
 */
export const RESOLVE_SCRIPT = `(spec) => {
${RESOLVER_CORE}
  return bglsResolve(spec);
}`;

/**
 * `waitFor(selector, state)` as ONE evaluate that holds for the whole
 * deadline, rather than a client-side poll loop.
 *
 * The arithmetic is the argument. An 8 second wait polled from the client
 * at 100ms is 80 round trips, and real click sites each carry
 * an explicit timeout, times however many fields a form has. Worse, a poll
 * loop cannot see a transition that opens and closes between two polls,
 * which is exactly the shape of a validation message or an autocomplete
 * list. Here the loop lives in the page: a MutationObserver wakes it the
 * instant the DOM changes, and it settles a promise that
 * `awaitPromise: true` is already waiting on.
 *
 * It does not pin the renderer. A reviewer will assume a long evaluate
 * spins; it does not. It awaits a promise, which costs one pending
 * microtask continuation and nothing else, and the in-page interval below
 * runs at 100ms whether or not anyone is waiting on it.
 *
 * It resolves rather than rejects on its own deadline, carrying the last
 * observation with it. A page-side throw would arrive as an exception with
 * a message and no state, and 'element not actionable' with no detail is
 * the single thing everyone hates about this class of library. The client
 * turns the returned observation into an error that names which check
 * failed and what the element looked like when it did.
 */
export const WAIT_SCRIPT = `(spec) => {
${RESOLVER_CORE}
  var check = spec.check;
  var stampSpec = spec.stamp;
  return new Promise(function (resolve) {
    var done = false;
    var observer = null;
    var interval = null;
    var timer = null;
    var inFlight = false;
    var last = null;
    var checks = 0;
    var wakes = 0;
    var startedAt = Date.now();

    function finish(payload) {
      if (done) return;
      done = true;
      try { if (observer) observer.disconnect(); } catch (e) { /* the document is gone; nothing to disconnect from */ }
      if (interval !== null) clearInterval(interval);
      if (timer !== null) clearTimeout(timer);
      payload.waitedMs = Date.now() - startedAt;
      payload.checks = checks;
      payload.wakes = wakes;
      resolve(payload);
    }

    function run() {
      if (done || inFlight) return;
      inFlight = true;
      bglsResolve(check).then(function (res) {
        inFlight = false;
        checks++;
        last = res;
        if (done) return;
        // A selector the page cannot parse is wrong on the first pass and
        // will be wrong on the last. Retrying it for the whole deadline
        // before reporting a SyntaxError that was true immediately wastes
        // the caller's time and buries the cause. It also must not be read
        // as 'nothing matched', which would make a 'detached' wait succeed
        // on a malformed selector.
        if (res.selectorError) { finish({ timedOut: false, failed: true, error: res.selectorError, result: res }); return; }
        // A frame boundary is decided on the FIRST check, never polled for:
        // nothing that happens later in this document changes whether the
        // next hop is cross-origin, and holding the deadline open to learn
        // that again ten times a second would only delay the client's own
        // hop. Mirrors the 'selectorError' exit immediately above.
        if (res.frameBoundary) { finish({ timedOut: false, result: res, frameBoundary: res.frameBoundary }); return; }
        if (!bglsSatisfied(spec.state, res, spec.index)) return;
        // The polling passes never stamp: a 'data-bgls-ref' write is an
        // attribute mutation, the observer below would see its own writes,
        // and the wait would spin itself awake ten times a second while
        // scribbling on the page an anti-automation script is reading.
        // The stamp happens exactly once, here, on the pass that won.
        if (!stampSpec) { finish({ timedOut: false, result: res }); return; }
        bglsResolve(stampSpec).then(function (stamped) {
          finish({ timedOut: false, result: stamped });
        }, function (err) {
          finish({ timedOut: false, result: res, stampError: String((err && err.message) || err) });
        });
      }, function (err) {
        inFlight = false;
        if (done) return;
        finish({ timedOut: false, failed: true, error: String((err && err.message) || err), result: last });
      });
    }

    try {
      observer = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          // Never wake on our own stamp. Nothing writes this attribute
          // during a wait, but a concurrent resolve on the same page can,
          // and one client's read must not drive another client's wait.
          if (records[i].type === 'attributes' && records[i].attributeName === BGLS_REF_ATTR) continue;
          wakes++;
          run();
          return;
        }
      });
      observer.observe(document.documentElement || document, {
        subtree: true, childList: true, attributes: true, characterData: true,
      });
    } catch (e) {
      observer = null;
    }

    // The backstop, and it is not redundant. A MutationObserver sees DOM
    // changes; it does not see a CSS transition finishing, an element
    // scrolling into view, a property assignment that does not reflect to
    // an attribute, or a resize. All four change the answer to 'is this
    // actionable'. Polling in the page costs nothing on the socket, which
    // is the only place polling is ever expensive here.
    interval = setInterval(run, spec.pollMs === undefined ? 100 : spec.pollMs);
    timer = setTimeout(function () { finish({ timedOut: true, result: last }); }, spec.deadlineMs);
    run();
  });
}`;

/**
 * Reads back one already-resolved element, addressed by ref. Kept separate
 * from the resolver because the read verbs (`innerText`, `getAttribute`,
 * `isChecked`) want none of the measurement: no rects, no frames, no hit
 * test, so no reason to pay two animation frames for a string.
 */
export const READ_SCRIPT = `(spec) => {
  var attr = ${JSON.stringify(LOCATOR_REF_ATTRIBUTE)};
  var sel = '[' + attr + '="' + (window.CSS && CSS.escape ? CSS.escape(spec.ref) : spec.ref) + '"]';
  var el = document.querySelector(sel);
  if (!el) return { found: false };
  var out = { found: true, tagName: el.tagName.toLowerCase() };
  if (spec.what === 'innerText') {
    out.value = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
  } else if (spec.what === 'attribute') {
    out.value = el.getAttribute(spec.name);
  } else if (spec.what === 'checked') {
    out.value = typeof el.checked === 'boolean' ? el.checked : (el.getAttribute('aria-checked') === 'true');
  } else if (spec.what === 'value') {
    out.value = typeof el.value === 'string' ? el.value : null;
  }
  return out;
}`;

/**
 * The last rung of the click ladder, and the reason it is last.
 *
 * `el.click()` produces an event with `isTrusted: false`. A dispatched
 * event is not a user gesture and some widgets ignore it, which is why
 * hand-built click ladders put this route last, and a port that
 * implemented `click(selector)` this way would look correct in a test and
 * fail on the sites that matter. It ships as an explicit
 * `via: 'dispatch'` opt-in and never as the default, which goes through
 * real CDP input.
 */
export const DISPATCH_CLICK_SCRIPT = `(spec) => {
  var attr = ${JSON.stringify(LOCATOR_REF_ATTRIBUTE)};
  var sel = '[' + attr + '="' + (window.CSS && CSS.escape ? CSS.escape(spec.ref) : spec.ref) + '"]';
  var el = document.querySelector(sel);
  if (!el) return { found: false };
  el.click();
  return { found: true };
}`;

/**
 * Clears an editable element without key events, the fallback path for a
 * field too long to clear with backspaces. Uses the native value setter
 * before dispatching, because React installs its own `value` property on
 * the element instance and assigning through it leaves React's internal
 * tracker believing nothing changed, which makes the subsequent `input`
 * event a no-op. This is the well-known controlled-input workaround and it
 * is needed here for the same reason it is needed everywhere else.
 */
export const CLEAR_SCRIPT = `(spec) => {
  var attr = ${JSON.stringify(LOCATOR_REF_ATTRIBUTE)};
  var sel = '[' + attr + '="' + (window.CSS && CSS.escape ? CSS.escape(spec.ref) : spec.ref) + '"]';
  var el = document.querySelector(sel);
  if (!el) return { found: false };
  var proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set && typeof el.value === 'string') {
    desc.set.call(el, '');
  } else if (el.isContentEditable) {
    el.textContent = '';
  } else {
    return { found: true, cleared: false };
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { found: true, cleared: true };
}`;

/**
 * Sets the selected `<option>`(s) on a `<select>` addressed by ref, the
 * page-side half of `select()`.
 *
 * WHY THIS EXISTS AT ALL, AFTER THIS METHOD WAS REFUSED IN AN EARLIER PASS
 *
 * The refusal this replaces argued that two call sites do not justify
 * shipping Playwright's `select_option` semantics, and that a caller could
 * write the whole thing as one `evaluate`. That is true of any single call
 * site considered alone, and false of the surface as a whole: every one of
 * those hand-rolled `evaluate` calls has to reinvent matching by value vs.
 * by visible label vs. by index, has to decide what happens when nothing
 * matches, and has to remember `input` AND `change`, both `bubbles: true`,
 * because a framework listening on only one of them silently does not see
 * the change. A caller that gets the option-not-found case wrong does not
 * find out until the option list changes under them in production. That is
 * exactly the class of bug a library exists to take off the table once,
 * rather than leaving forty callers to get it right independently, so this
 * pass ships it with the real semantics rather than the one-liner.
 *
 * WHY MATCHING AND MUTATING ARE ONE ROUND TRIP AND NOT TWO
 *
 * A `<select>`'s option list can be re-rendered by the very framework this
 * surface exists to drive (a filtered/async combobox backed by a native
 * `<select>` is rarer than the `<div role="listbox">` kind, but it exists,
 * and some enterprise form widgets use both). Matching in one evaluate and mutating in a second
 * would let the list change in between and silently select the WRONG
 * option at the index a first pass had already validated. So the whole
 * thing runs as one page-side function: read `el.options` once, resolve
 * every requested spec against that snapshot, and only then mutate it.
 *
 * WHY A MISSING OPTION IS REPORTED AS DATA, NOT THROWN FROM THE PAGE
 *
 * The same reason `bglsResolve`'s own selector failures are reported as
 * data (see this file's module doc): a thrown page exception loses the
 * partial context (which spec matched, which did not, what the `<select>`
 * actually offers), and `AutomationClient.select()` needs all of that to
 * build the option-not-found error the whole point of this method is to
 * get right. Nothing is mutated when anything is missing: a caller asking
 * for `['US', 'CA']` on a `<select multiple>` that only has `US` gets
 * neither selected, not `US` selected and a confusing partial failure.
 */
export const SELECT_SCRIPT = `(spec) => {
${OPTION_LIST_HELPER}
  var attr = ${JSON.stringify(LOCATOR_REF_ATTRIBUTE)};
  var sel = '[' + attr + '="' + (window.CSS && CSS.escape ? CSS.escape(spec.ref) : spec.ref) + '"]';
  var el = document.querySelector(sel);
  if (!el) return { found: false };
  var options = el.options;
  var wanted = spec.options;
  if (wanted.length > 1 && !el.multiple) return { found: true, notMultiple: true };

  var matchedIdx = [];
  var missing = [];
  for (var w = 0; w < wanted.length; w++) {
    var spec2 = wanted[w];
    var hit = -1;
    if (typeof spec2.index === 'number') {
      if (spec2.index >= 0 && spec2.index < options.length) hit = spec2.index;
    } else if (typeof spec2.value === 'string') {
      for (var i = 0; i < options.length; i++) {
        if (options[i].value === spec2.value) { hit = i; break; }
      }
    } else if (typeof spec2.label === 'string') {
      for (var j = 0; j < options.length; j++) {
        if (bglsNormOptionText(options[j].textContent) === spec2.label) { hit = j; break; }
      }
    }
    if (hit === -1) {
      missing.push(spec2);
    } else if (matchedIdx.indexOf(hit) === -1) {
      matchedIdx.push(hit);
    }
  }

  if (missing.length > 0) {
    // The same enumeration dropdownOptions() reads off the resolver,
    // projected down to the three fields this error has always reported:
    // 'selected'/'disabled' would be true of the OLD selection here, since
    // nothing has been mutated yet, and reporting them would say something
    // about a state this error is not describing.
    var full = bglsListOptions(el);
    var available = [];
    for (var k = 0; k < full.length; k++) {
      available.push({ value: full[k].value, label: full[k].label, index: full[k].index });
    }
    return { found: true, missing: missing, available: available };
  }

  for (var m = 0; m < options.length; m++) {
    options[m].selected = matchedIdx.indexOf(m) !== -1;
  }
  // Both events, both bubbling. A framework listening only on 'change'
  // (the native signal for a <select>) and one listening only on 'input'
  // (React's controlled-component signal) each see a select() that fired
  // the other one as a no-op; this is the same reasoning CLEAR_SCRIPT
  // above already applies to a cleared text field.
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  var values = [];
  var labels = [];
  for (var n = 0; n < options.length; n++) {
    if (options[n].selected) {
      values.push(options[n].value);
      labels.push(bglsNormOptionText(options[n].textContent));
    }
  }
  return { found: true, values: values, labels: labels };
}`;

/**
 * `findInPage()`'s page-side half: a full-text search over the page's
 * VISIBLE text (browser-use's `search_page`), as distinct from the `text=`
 * selector engine, which needs the caller to already know which ELEMENT
 * says something rather than merely what the page says.
 *
 * Walks `Text` nodes directly with a `TreeWalker` rather than matching
 * against `el.textContent` the way `text=` does. `textContent` concatenates
 * every descendant, so a page-wide search built on it would report the same
 * occurrence once per ancestor and could not say WHERE inside a long block
 * a match sits; a leaf text node has neither problem, and it is what
 * `context` is sliced out of.
 *
 * Filters on the SAME `bglsIsVisible` test `RESOLVER_CORE`'s own resolver
 * uses, so a match hidden by CSS is not reported as one, matching how every
 * other verb here treats visibility.
 *
 * Takes an already-compiled `pattern`/`flags` pair, never a raw literal
 * string to escape into one. Escaping a caller's literal search term into a
 * regex happens in `LocatorEngine`, real TypeScript with real type
 * checking; this file is authored as text and gets none (see this file's
 * module doc), and a hand-escaped character class living inside a template
 * literal is exactly the kind of thing that is easy to get subtly wrong and
 * hard to notice here.
 */
export const FIND_IN_PAGE_SCRIPT = `(spec) => {
${RESOLVER_CORE}
function bglsFindInPage(spec) {
  var scopeEl = spec.scope ? document.querySelector(spec.scope) : (document.body || document.documentElement);
  if (!scopeEl) {
    return { matches: [], total: 0, truncated: false, scopeMissing: !!spec.scope, patternError: null, url: location.href, title: document.title };
  }

  var contextChars = spec.contextChars === undefined || spec.contextChars === null ? 60 : spec.contextChars;
  var limit = spec.limit === undefined || spec.limit === null ? 50 : spec.limit;

  var regex;
  try {
    regex = new RegExp(spec.pattern, spec.flags);
  } catch (err) {
    return { matches: [], total: 0, truncated: false, scopeMissing: false, patternError: String((err && err.message) || err), url: location.href, title: document.title };
  }

  var walker = document.createTreeWalker(scopeEl, NodeFilter.SHOW_TEXT, null);
  var out = [];
  var total = 0;
  var node;
  while ((node = walker.nextNode())) {
    var parent = node.parentElement;
    if (!parent) continue;
    var tag = parent.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
    if (!bglsIsVisible(parent)) continue;
    var raw = node.nodeValue || '';
    regex.lastIndex = 0;
    var m;
    while ((m = regex.exec(raw)) !== null) {
      total++;
      if (out.length < limit) {
        var start = Math.max(0, m.index - contextChars);
        var end = Math.min(raw.length, m.index + m[0].length + contextChars);
        var ref = null;
        if (spec.stamp !== false && parent.setAttribute) {
          ref = String(spec.refPrefix) + '_' + out.length;
          parent.setAttribute(BGLS_REF_ATTR, ref);
        }
        out.push({
          text: m[0],
          context: bglsNorm(raw.slice(start, end)),
          tagName: tag.toLowerCase(),
          ref: ref,
        });
      }
      // A zero-length match (a regex like '(?:)' or a lookaround with no
      // consumed text) would otherwise pin 'lastIndex' and loop forever.
      if (m[0].length === 0) regex.lastIndex += 1;
    }
  }

  return {
    matches: out,
    total: total,
    truncated: total > out.length,
    scopeMissing: false,
    patternError: null,
    url: location.href,
    title: document.title,
  };
}
  return bglsFindInPage(spec);
}`;
