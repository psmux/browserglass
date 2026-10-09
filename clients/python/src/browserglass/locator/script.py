"""The page-side half of the locator engine: one resolver, shared by every
verb, plus one waiter built on top of it.

This is a byte-for-byte port of ``packages/automation/src/locator/script.ts``
from the TypeScript SDK: the SAME JavaScript source strings, sent through
``page.evaluate`` the same way. That is deliberate and not laziness. The
selector engine, the actionability checks, and the wait loop all run
IN THE BROWSER, not in this client process; porting this module to
"native" Python would mean either shipping a second, divergent
implementation of CSS/XPath/text matching that has to be kept in step
with the TypeScript one by hand, or losing the guarantee that a Python
caller and a TypeScript caller see identical matches for identical
selectors on identical pages. Sending the same script is what keeps the
two SDKs honest with each other.

See the TypeScript module's own doc for the full reasoning (why this is
text and not a compiled function, why there is one resolver rather than a
verb per script, why there is no element handle). It is not repeated
here; only the JavaScript source itself is.
"""

from __future__ import annotations

LOCATOR_REF_ATTRIBUTE = "data-bgls-ref"

#: The gateway's ceiling on one evaluate source, mirrored from
#: ``MAX_EVALUATE_SOURCE_BYTES`` in ``packages/protocol/src/wire/messages/evaluate.ts``.
MAX_EVALUATE_SOURCE_BYTES = 32768


def compact_page_script(source: str) -> str:
    """Shrinks a page side script before it goes on the wire.

    A line for line port of ``compactPageScript`` in
    ``packages/automation/src/locator/compact.ts``; see that file for the
    full reasoning. Change both together.

    The gateway refuses evaluate source over ``MAX_EVALUATE_SOURCE_BYTES``
    (32768). This drops blank lines, ``//`` comment lines and block comments
    that start a line, and strips each kept line's surrounding whitespace.
    It never edits inside a line and keeps the line breaks between kept
    lines. That is safe only when no literal spans a line break, so it
    raises on a backtick, on a line ending in a backslash, and on any block
    comment marker it cannot account for. A raise happens at import, so the
    test suite catches a script this cannot handle.
    """
    if "`" in source:
        raise ValueError("compact_page_script: the source contains a backtick; template literals can span lines and are not supported")
    kept: list[str] = []
    in_block_comment = False
    for i, raw in enumerate(source.split("\n")):
        line = raw.strip()
        if line.endswith("\\"):
            raise ValueError(f"compact_page_script: line {i + 1} ends in a backslash; a string continued across lines is not supported")
        if in_block_comment:
            close = line.find("*/")
            if close == -1:
                continue
            if line[close + 2 :].strip() != "":
                raise ValueError(f"compact_page_script: line {i + 1} has code after the end of a block comment")
            in_block_comment = False
            continue
        if line == "" or line.startswith("//"):
            continue
        if line.startswith("/*"):
            close = line.find("*/", 2)
            if close == -1:
                in_block_comment = True
                continue
            if line[close + 2 :].strip() != "":
                raise ValueError(f"compact_page_script: line {i + 1} has code after a block comment on the same line")
            continue
        if "/*" in line or "*/" in line:
            raise ValueError(f"compact_page_script: line {i + 1} has a block comment marker that does not start the line")
        kept.append(line)
    if in_block_comment:
        raise ValueError("compact_page_script: the source ends inside a block comment")
    return "\n".join(kept)


_RESOLVER_CORE = r"""
var BGLS_REF_ATTR = "data-bgls-ref";

function bglsNorm(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
}

function bglsSplitSegments(sel) {
  var out = [];
  var buf = '';
  var quote = null;
  var depth = 0;
  for (var i = 0; i < sel.length; i++) {
    var c = sel.charAt(i);
    if (quote !== null) {
      buf += c;
      if (c === quote && sel.charAt(i - 1) !== '\\') quote = null;
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

function bglsParseSegment(seg) {
  var m = /^(css|text|xpath|label|ref|visible)=([\s\S]*)$/.exec(seg);
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
  if (r.width <= 0 || r.height <= 0) return false;
  var view = el.ownerDocument && el.ownerDocument.defaultView;
  var cs = view ? view.getComputedStyle(el) : null;
  if (!cs) return false;
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
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

function bglsLabelText(el) {
  var doc = el.ownerDocument;
  var by = el.getAttribute ? el.getAttribute('aria-labelledby') : null;
  if (by) {
    var ids = by.split(/\s+/);
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
  var q = /^"([\s\S]*)"$/.exec(value);
  if (q) { exact = true; needle = q[1]; }
  needle = bglsNorm(needle).toLowerCase();
  var hay = bglsNorm(haystack).toLowerCase();
  return exact ? hay === needle : (needle.length > 0 && hay.indexOf(needle) >= 0);
}

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
    } else if (engine === 'xpath') {
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
        if (bglsMatchesNeedle(cand.textContent, value)) hits.push(cand);
      }
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

function bglsRectOf(el) {
  var r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function bglsSameRect(a, b) {
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

function bglsFrame() {
  return new Promise(function (resolve) {
    var settled = false;
    function done(byFrame) { if (settled) return; settled = true; resolve(byFrame); }
    requestAnimationFrame(function () { done(true); });
    setTimeout(function () { done(false); }, 50);
  });
}

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

  var current = roots;
  try {
    for (var p = 0; p < parsed.length; p++) {
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

  var total = current.length;
  var els = current.slice(0, limit);

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
      var cx = rect.x + rect.w / 2;
      var cy = rect.y + rect.h / 2;
      var view = el.ownerDocument.defaultView;
      var cs = attached && view ? view.getComputedStyle(el) : null;
      var visible = bglsIsVisible(el);
      var disabledReason = bglsDisabledReason(el);
      var hit = spec.hitTest === false || !visible
        ? { ok: null, blocker: null, reason: spec.hitTest === false ? 'not requested' : 'not visible' }
        : bglsHitTest(el, cx, cy);
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
      var checked = null;
      var inputType = el.tagName === 'INPUT' ? String(el.type || '').toLowerCase() : '';
      if (inputType === 'checkbox' || inputType === 'radio') {
        checked = el.checked === true;
      } else {
        var ariaChecked = el.getAttribute ? el.getAttribute('aria-checked') : null;
        if (ariaChecked !== null) checked = ariaChecked === 'true';
      }
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
        rect: rect,
        center: { x: cx, y: cy },
        attached: attached,
        visible: visible,
        enabled: disabledReason === null,
        disabledReason: disabledReason,
        editable: bglsIsEditable(el),
        stable: stable,
        hitTestOk: hit.ok,
        occludedBy: hit.blocker,
        hitReason: hit.reason,
        inViewport: rect.x + rect.w > 0 && rect.y + rect.h > 0 && rect.x < window.innerWidth && rect.y < window.innerHeight,
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
  return e.attached && e.visible && e.enabled && e.hitTestOk !== false && e.stable !== false;
}

function bglsSatisfied(state, res, index) {
  var m = res.matches;
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
  for (var a = 0; a < m.length; a++) {
    if (bglsActionable(m[a])) return true;
  }
  return false;
}
"""

RESOLVE_SCRIPT = compact_page_script("(spec) => {\n" + _RESOLVER_CORE + "\n  return bglsResolve(spec);\n}")

WAIT_SCRIPT = compact_page_script("(spec) => {\n" + _RESOLVER_CORE + r"""
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
      try { if (observer) observer.disconnect(); } catch (e) { }
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
        if (res.selectorError) { finish({ timedOut: false, failed: true, error: res.selectorError, result: res }); return; }
        if (!bglsSatisfied(spec.state, res, spec.index)) return;
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

    interval = setInterval(run, spec.pollMs === undefined ? 100 : spec.pollMs);
    timer = setTimeout(function () { finish({ timedOut: true, result: last }); }, spec.deadlineMs);
    run();
  });
}""")

READ_SCRIPT = compact_page_script(r"""(spec) => {
  var attr = "data-bgls-ref";
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
}""")

DISPATCH_CLICK_SCRIPT = compact_page_script(r"""(spec) => {
  var attr = "data-bgls-ref";
  var sel = '[' + attr + '="' + (window.CSS && CSS.escape ? CSS.escape(spec.ref) : spec.ref) + '"]';
  var el = document.querySelector(sel);
  if (!el) return { found: false };
  el.click();
  return { found: true };
}""")

CLEAR_SCRIPT = compact_page_script(r"""(spec) => {
  var attr = "data-bgls-ref";
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
}""")

SELECT_SCRIPT = compact_page_script(r"""(spec) => {
  var attr = "data-bgls-ref";
  var sel = '[' + attr + '="' + (window.CSS && CSS.escape ? CSS.escape(spec.ref) : spec.ref) + '"]';
  var el = document.querySelector(sel);
  if (!el) return { found: false };
  var options = el.options;
  var wanted = spec.options;
  if (wanted.length > 1 && !el.multiple) return { found: true, notMultiple: true };

  function normText(s) {
    return (s === null || s === undefined ? '' : String(s)).replace(/\s+/g, ' ').trim();
  }

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
        if (normText(options[j].textContent) === spec2.label) { hit = j; break; }
      }
    }
    if (hit === -1) {
      missing.push(spec2);
    } else if (matchedIdx.indexOf(hit) === -1) {
      matchedIdx.push(hit);
    }
  }

  if (missing.length > 0) {
    var available = [];
    for (var k = 0; k < options.length; k++) {
      available.push({ value: options[k].value, label: normText(options[k].textContent), index: k });
    }
    return { found: true, missing: missing, available: available };
  }

  for (var m = 0; m < options.length; m++) {
    options[m].selected = matchedIdx.indexOf(m) !== -1;
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));

  var values = [];
  var labels = [];
  for (var n = 0; n < options.length; n++) {
    if (options[n].selected) {
      values.push(options[n].value);
      labels.push(normText(options[n].textContent));
    }
  }
  return { found: true, values: values, labels: labels };
}""")
