/**
 * A tiny real HTTP server serving the pages the parallel control suite
 * drives. Real HTTP, not a `data:` URL: a `data:` document is an opaque
 * origin whose inline script Chrome treats differently from an ordinary
 * page, and every assertion here depends on that script running exactly
 * the way it would on a normal site.
 *
 * The pages report what happened back through an on-page element whose
 * `aria-label` is what `target.probe` returns, so nothing in this suite
 * needs a side channel into Chrome that a real BrowserGlass client would
 * not have. See {@link interactivePage} for why the report band, and not
 * the page title, is what the assertions read.
 */
import { type Server, createServer } from 'node:http';

/** The literal string every fixture page puts in its selectable block. */
export const MARKER = 'SELECTABLEMARKER';

/** One running fixture server. */
export interface FixtureServer {
  readonly origin: string;
  /** An interactive page: a full width input on top, a selectable block below. `label` distinguishes one tab's page from another's. */
  pageUrl(label: string): string;
  /** A page whose response body never completes, so the tab stays in `loading: true` until something stops it. */
  slowUrl(label: string): string;
  /**
   * A page that repaints continuously, for suites that measure frame rate.
   *
   * Chrome's screencast is change driven: it emits a frame when the
   * compositor produces one, and a page that is merely sitting there
   * produces none. So a static page reports zero frames per second whether
   * streaming is perfectly healthy or completely broken, and cannot tell
   * the two apart. The window isolation spike's measurement page has an
   * animated element for the same reason.
   *
   * Anything measuring fps wants this. Anything measuring input effects
   * wants `pageUrl`, whose bands are static on purpose.
   */
  animatedUrl(label: string): string;
  /**
   * A page that produces diagnostics on demand: console lines at every
   * level, an uncaught error, and network requests that both succeed and
   * fail. Everything it emits carries `label`, so a suite driving several
   * targets at once can prove that each target's diagnostics arrived on
   * that target and nowhere else.
   */
  diagnosticsUrl(label: string): string;
  /** The `/api/echo` path this server answers, for asserting on a captured network row's url. */
  echoPath(label: string): string;
  /**
   * The shared control page: a page that publishes what it currently has
   * HELD, continuously, rather than only what last happened to it.
   *
   * Every other page here reports events. That is enough while one viewer
   * drives, because the interesting question is "did my click land". With
   * several drivers on one tab the interesting question is the opposite
   * one: "is anything still pressed that nobody is pressing any more", and
   * an event log cannot answer it. A button left down or a modifier left
   * held produces no event at all; it produces an absence, and the only
   * way to measure an absence is to publish the live state on a timer and
   * read it. See {@link collabPage} for the exact report grammar.
   */
  collabUrl(label: string): string;
  close(): Promise<void>;
}

/**
 * The interactive page. Three absolutely positioned bands, each filling a
 * whole slice of the viewport, so a click anywhere inside a band hits the
 * element that band is for; this suite tests that input reaches the right
 * tab of the right browser, not pixel accurate hit testing, which
 * `coordinate/roundtrip.test.ts` already owns.
 *
 *   0 to 30%    `#box`, a text input
 *   35 to 60%   `#marker`, the selectable block
 *   65 to 100%  `#echo`, the report band
 *
 * `#echo` is how every assertion in this suite reads an effect back. Its
 * `aria-label` is what `target.probe` returns as `label` (see
 * `ManagedSession.probe`), which makes it readable through the ordinary
 * client API, with no test-only channel into Chrome:
 *
 * - `input` on the box reports the box's exact value as `V:<value>`.
 * - `selectionchange` reports a non-empty selection as `S:<text>`, and
 *   ignores an empty one, so merely clicking into the box (which does fire
 *   `selectionchange` for the caret) never overwrites a `V:` report.
 *
 * The title is set too, and is genuinely correct in Chrome, but is NOT what
 * this suite asserts on: Chrome emits `Target.targetInfoChanged` on a URL
 * change and never on a title change, so a title only reaches a
 * BrowserGlass client on the registry's own periodic resync.
 */
function interactivePage(label: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>READY:${label}</title></head>
<body style="margin:0;background:#fff;font-family:monospace">
<input id="box" style="position:absolute;left:0;top:0;width:100%;height:30%;font-size:34px;box-sizing:border-box" />
<div id="marker" style="position:absolute;left:0;top:35%;width:100%;height:25%;font-size:34px">${MARKER}</div>
<div id="echo" aria-label="READY:${label}" style="position:absolute;left:0;top:65%;width:100%;height:35%;font-size:34px;background:#eee">READY:${label}</div>
<script>
var box = document.getElementById('box');
var echo = document.getElementById('echo');
function report(text) {
  echo.setAttribute('aria-label', text);
  echo.textContent = text;
  document.title = text;
}
box.addEventListener('input', function () { report('V:' + box.value); });
document.addEventListener('selectionchange', function () {
  var s = String(window.getSelection() || '');
  if (s.length > 0 && s.indexOf('${MARKER}') !== -1) report('S:' + s);
});
</script>
</body>
</html>`;
}

/**
 * A page whose load genuinely cannot finish on its own, built so that
 * stopping it has a visible, unambiguous effect rather than merely an
 * absence of one.
 *
 * A reporter at the top of the body publishes `document.readyState` into
 * the report band on a short interval. Below it, a `<script src="/hang">`
 * blocks the parser forever, so while the load is in flight the band
 * reads `RS:loading` and stays there.
 *
 * `Page.stopLoading` aborts the pending request AND the parser with it
 * (verified directly against real Chrome: the script sitting after the
 * blocking one never runs, so it cannot be the signal), but the document
 * is then finished, and `readyState` goes to `complete`. The already
 * running reporter publishes that, so `RS:complete` in the band is proof
 * the stop reached this tab and did what stopping is for.
 *
 * Waiting and seeing nothing would have proved only that a page which
 * never loads never loads.
 */
function slowPage(label: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>SLOW:${label}</title></head>
<body style="margin:0;background:#fff;font-family:monospace">
<div id="echo" aria-label="SLOWSTART:${label}" style="position:absolute;left:0;top:65%;width:100%;height:35%;font-size:34px;background:#eee">SLOWSTART:${label}</div>
<script>
var e = document.getElementById('echo');
setInterval(function () {
  var t = 'RS:' + document.readyState + ':${label}';
  e.setAttribute('aria-label', t);
  e.textContent = t;
  document.title = t;
}, 100);
</script>
<script src="/hang"></script>
</body>
</html>`;
}

/**
 * The animated page. A `requestAnimationFrame` loop repainting a full
 * viewport canvas every frame, so there is always a new compositor frame
 * for the screencast to carry and a stalled stream is unambiguous rather
 * than merely quiet. The label is painted into the page and into the title
 * so a frame can be traced back to the tab it came from by eye when a
 * measurement looks wrong.
 */
function animatedPage(label: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>ANIM:${label}</title></head>
<body style="margin:0;background:#111">
<canvas id="c" style="display:block;width:100vw;height:100vh"></canvas>
<script>
var c = document.getElementById('c');
c.width = window.innerWidth;
c.height = window.innerHeight;
var ctx = c.getContext('2d');
var x = 0;
function draw() {
  x = (x + 4) % c.width;
  ctx.fillStyle = 'hsl(' + (x % 360) + ', 80%, 45%)';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(x, c.height / 2, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = '28px monospace';
  ctx.fillText('${label}', 16, 40);
  requestAnimationFrame(draw);
}
draw();
</script>
</body>
</html>`;
}

/**
 * The diagnostics page.
 *
 * Every line it logs and every request it makes is stamped with `label`.
 * That is the whole design: the interesting failure for parallel
 * diagnostics is not "nothing arrived", it is "target A's console line was
 * delivered to target B", and only a per-target marker can catch it.
 *
 * It emits on a timer rather than once at load, so a suite that subscribes
 * after the page is already up still sees traffic without having to
 * reload. `SEQ` counts up so a test can tell fresh output from a replay of
 * something buffered earlier.
 */
function diagnosticsPage(label: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>DIAG:${label}</title></head>
<body style="margin:0;background:#fff;font-family:monospace">
<div id="echo" aria-label="DIAG:${label}" style="position:absolute;left:0;top:65%;width:100%;height:35%;font-size:28px;background:#eee">DIAG:${label}</div>
<canvas id="c" style="position:absolute;left:0;top:0;width:100%;height:60%"></canvas>
<script>
// A repainting canvas, for the same reason the animated page has one:
// Chrome's screencast is change driven, so a page that only mutates an
// aria-label produces no frames at all, and an "is this target still
// streaming" assertion against it would measure nothing. An earlier version
// of this page had no canvas and read a flat zero fps on a healthy stream.
// (No backticks in this comment on purpose: it lives inside a template
// literal, where a backtick would end the string.)
var canvasEl = document.getElementById('c');
canvasEl.width = 480; canvasEl.height = 300;
var ctx = canvasEl.getContext('2d');
var t = 0;
(function paint() {
  t = (t + 3) % 480;
  ctx.fillStyle = 'hsl(' + (t % 360) + ', 70%, 45%)';
  ctx.fillRect(0, 0, 480, 300);
  ctx.fillStyle = '#fff';
  ctx.font = '24px monospace';
  ctx.fillText('${label}', 16, 40);
  requestAnimationFrame(paint);
})();
var SEQ = 0;
function burst() {
  SEQ += 1;
  console.log('CONSOLE-LOG:${label}:' + SEQ);
  console.warn('CONSOLE-WARN:${label}:' + SEQ);
  console.error('CONSOLE-ERROR:${label}:' + SEQ);
  // A request that succeeds, and one that cannot: both are things a
  // network panel has to be able to show.
  fetch('/api/echo?label=${label}&seq=' + SEQ).catch(function () {});
  fetch('/api/missing?label=${label}&seq=' + SEQ).catch(function () {});
  document.getElementById('echo').setAttribute('aria-label', 'DIAG:${label}:' + SEQ);
  // Out of band so it cannot stop the interval that called us.
  setTimeout(function () { throw new Error('PAGE-ERROR:${label}:' + SEQ); }, 0);
}
burst();
setInterval(burst, 700);
// An uncaught error on EVERY burst, not once at load.
//
// It used to be a single setTimeout at 300ms. That raced: a suite only
// turns the errors feed on after navigate and stream.subscribe have
// completed for every pane, and if that round trip took longer than 300ms
// for any one pane, that pane's only error had already been thrown and was
// missed forever. Throwing on the same timer as everything else means a
// subscriber that arrives late still sees one shortly after.
setTimeout(function () { throw new Error('PAGE-ERROR:${label}'); }, 0);
</script>
</body>
</html>`;
}

/**
 * The shared control page.
 *
 * Three absolutely positioned bands, the same trick every other page here
 * uses so a coordinate anywhere inside a band hits the element that band is
 * for:
 *
 *   0 to 30%     `#box`, a text input
 *   30 to 50%    `#marker`, the selectable block
 *   50 to 95%    `#state`, the live report band
 *   95 to 100%   `#pulse`, a strip that moves every animation frame
 *
 * `#state`'s `aria-label` is what `target.probe` returns, so everything
 * below is readable through the ordinary client API with no test-only
 * channel into Chrome.
 *
 * The report grammar, republished every 80ms whether or not anything
 * happened:
 *
 *   `C:w=<innerWidth>;b=<buttons>;k=<codes>;v=<value>;d=<trail>;sel=<0|1>`
 *
 * - `w` is CSS pixels, so an assertion about WHERE a press landed can be
 *   written against the page's own coordinate space rather than against
 *   the frame dimensions, which the stream is free to scale.
 * - `b` is the live `MouseEvent.buttons` mask, taken from the last
 *   `mousedown` or `mouseup` the document saw. A driver who presses and
 *   then vanishes leaves this non-zero forever unless something releases
 *   the button on their behalf, which is the entire point of measuring it.
 * - `k` is every `KeyboardEvent.code` with an unmatched `keydown`, sorted
 *   and joined with `+`. Two drivers holding two DIFFERENT modifiers show
 *   up as two distinct codes, so "A's key was released and B's was not"
 *   is a statement this band can actually make. A single shared mouse
 *   button cannot be attributed that way (the page has one pointer, not
 *   one per viewer), which is why the per driver assertions use keys.
 * - `d` is the trail of the last 8 `mousedown` positions as `x,y`, in CSS
 *   pixels. Two drivers pressing at two different places both appear, in
 *   order, so "both mice reached this one page" is measurable rather than
 *   inferred from one press that could have come from either of them.
 * - `sel` goes to 1 when a selection containing {@link MARKER} exists, and
 *   back to 0 on every `mousedown`, because a press collapses the
 *   selection anyway. So it reports what the CURRENT gesture achieved
 *   rather than accumulating across a whole test file.
 */
function collabPage(label: string): string {
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>COLLAB:${label}</title></head>
<body style="margin:0;background:#fff;font-family:monospace">
<input id="box" style="position:absolute;left:0;top:0;width:100%;height:30%;font-size:30px;box-sizing:border-box" />
<div id="marker" style="position:absolute;left:0;top:30%;width:100%;height:20%;font-size:30px">${MARKER}</div>
<div id="state" aria-label="C:w=0;b=0;k=;v=;d=;sel=0" style="position:absolute;left:0;top:50%;width:100%;height:45%;font-size:22px;background:#eee">C:</div>
<div id="pulse" style="position:absolute;left:0;top:95%;width:40px;height:5%;background:#c00"></div>
<script>
var box = document.getElementById('box');
var state = document.getElementById('state');
// A strip that moves on every animation frame, in the bottom 5% of the
// page and nowhere near any band a probe reads.
//
// Chrome's screencast is change driven: it emits a frame when the
// compositor produces one, and a page that is merely sitting there
// produces none, so a static page reads a hard zero frames per second
// whether streaming is perfectly healthy or completely broken.
// The parallel live streams suite measured exactly that against a working
// pipeline before its own page grew a repainting canvas. This page has to
// serve both purposes at once (measurable input effects AND a measurable
// frame rate), so the animation is deliberately confined to a strip that
// no assertion here ever probes.
// (No backticks in this comment on purpose: it lives inside a template
// literal, where a backtick would end the string.)
var pulse = document.getElementById('pulse');
var px = 0;
(function move() {
  px = (px + 7) % Math.max(1, window.innerWidth - 40);
  pulse.style.left = px + 'px';
  requestAnimationFrame(move);
})();
var buttons = 0;
var keys = {};
var downs = [];
var sel = 0;
document.addEventListener('mousedown', function (e) {
  buttons = e.buttons;
  sel = 0;
  downs.push(Math.round(e.clientX) + ',' + Math.round(e.clientY));
  if (downs.length > 8) downs.shift();
});
// On mouseup, MouseEvent.buttons already excludes the button being
// released, so this is the mask AFTER the release and needs no arithmetic.
document.addEventListener('mouseup', function (e) { buttons = e.buttons; });
document.addEventListener('keydown', function (e) { keys[e.code] = 1; });
document.addEventListener('keyup', function (e) { delete keys[e.code]; });
document.addEventListener('selectionchange', function () {
  var s = String(window.getSelection() || '');
  if (s.length > 0 && s.indexOf('${MARKER}') !== -1) sel = 1;
});
function publish() {
  var codes = [];
  for (var c in keys) { if (Object.prototype.hasOwnProperty.call(keys, c)) codes.push(c); }
  codes.sort();
  var t = 'C:w=' + window.innerWidth +
          ';b=' + buttons +
          ';k=' + codes.join('+') +
          ';v=' + box.value +
          ';d=' + downs.join('|') +
          ';sel=' + sel;
  state.setAttribute('aria-label', t);
  state.textContent = t;
  document.title = t;
}
publish();
setInterval(publish, 80);
</script>
</body>
</html>`;
}

/** Starts a fixture server on an ephemeral loopback port. */
export async function startFixtureServer(): Promise<FixtureServer> {
  /** Every still-open `/slow` response, ended on `close()` so the server can actually shut down. */
  const openSlow = new Set<{ end(): void }>();

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const label = url.searchParams.get('label') ?? 'x';

    if (url.pathname === '/hang') {
      // Never answers. Held open so the parser of whatever requested it
      // stays blocked until something aborts the load.
      const entry = { end: () => res.end() };
      openSlow.add(entry);
      res.on('close', () => openSlow.delete(entry));
      return;
    }

    if (url.pathname === '/diagnostics') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(diagnosticsPage(label));
      return;
    }

    if (url.pathname === '/api/echo') {
      // A small, boring 200 with a known body size, so a captured network
      // row has something stable to assert on.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, label }));
      return;
    }

    if (url.pathname === '/api/missing') {
      // A deliberate 404, so the suite can tell a failed request from a
      // successful one in whatever the network feed reports.
      res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: false, label }));
      return;
    }

    if (url.pathname === '/collab') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(collabPage(label));
      return;
    }

    if (url.pathname === '/animated') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(animatedPage(label));
      return;
    }

    if (url.pathname === '/slow') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(slowPage(label));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
    res.end(interactivePage(label));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const origin = `http://127.0.0.1:${port}`;

  return {
    origin,
    pageUrl: (label) => `${origin}/page?label=${encodeURIComponent(label)}`,
    slowUrl: (label) => `${origin}/slow?label=${encodeURIComponent(label)}`,
    animatedUrl: (label) => `${origin}/animated?label=${encodeURIComponent(label)}`,
    diagnosticsUrl: (label) => `${origin}/diagnostics?label=${encodeURIComponent(label)}`,
    echoPath: (label) => `/api/echo?label=${encodeURIComponent(label)}`,
    collabUrl: (label) => `${origin}/collab?label=${encodeURIComponent(label)}`,
    async close() {
      for (const entry of openSlow) entry.end();
      openSlow.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
