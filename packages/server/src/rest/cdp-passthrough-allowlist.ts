/**
 * The method allowlist for `POST /v1/instances/:instanceId/targets/:targetId/cdp`
 * (`routes/targets.ts`'s `sendCdpCommand`), gated separately by the `cdp`
 * capability (`packages/protocol/src/wire/capabilities.ts`), off by default
 * and never folded into `devtools` or `automation`.
 *
 * Precedent: `packages/core/src/input/cdp-allowlist.ts` restricts the input
 * channel to seven `Input.*` methods, deny by default, same shape. This
 * file follows it: {@link CDP_PASSTHROUGH_ALLOWLIST} is the only source of
 * admission, and {@link isCdpMethodAllowed} checks it before anything else
 * runs, so a method absent from the list is refused with no further work.
 *
 * On top of the allowlist, {@link REFUSED_DOMAINS} and
 * {@link REFUSED_METHODS} are a hard denylist that wins regardless of the
 * allowlist's contents (see this module's `isCdpMethodAllowed` for why: a
 * future edit that carelessly widens the allowlist must not be able to
 * reopen one of these on its own). A raw passthrough hands the
 * caller the whole browser: arbitrary script execution, filesystem reach
 * through downloads, every other target in the process, and the ability to
 * turn off the very protections the capability model exists to enforce.
 * Each refusal below documents which of those four it closes.
 */

/**
 * Domains refused outright, no matter what a caller's method string names
 * within them. A caller holding `cdp` gets one target's page-level surface,
 * never the browser process or its other targets.
 */
const REFUSED_DOMAINS: ReadonlySet<string> = new Set([
  // Reaches other targets, or the browser process itself: `Target.attachToTarget`,
  // `Target.createTarget`, `Target.closeTarget` etc. would let a caller
  // scoped to one target pivot to every other target the Instance holds,
  // defeating "scoped to one target, never browser-wide" outright.
  'Target',
  // Browser-wide control (`Browser.close`) and `Browser.setDownloadBehavior`,
  // which points downloads at an arbitrary local filesystem path: the
  // filesystem-reach vector by itself.
  'Browser',
  // Raw stream read/close over file-backed handles (download streams,
  // `Page.printToPDF`'s stream mode): the other filesystem-reach vector.
  'IO',
  // `Runtime.evaluate`/`Runtime.callFunctionOn`/`Runtime.compileScript` are
  // arbitrary script execution in the page's own context, the exact thing
  // the allowlist exists to prevent. The whole domain is closed rather than
  // picking "safe" members of it: `Runtime.getProperties` on a live object
  // handle from `Runtime.evaluate` (unreachable here, but the CDP protocol
  // grants no per-domain sandboxing of its own to lean on) is adjacent
  // enough to eval that it is not worth the allowlist entry.
  'Runtime',
  // Breakpoints with side-effecting conditions and `Debugger.setScriptSource`
  // (hot-patches running script) are arbitrary code execution wearing a
  // debugger costume.
  'Debugger',
  // `Fetch.enable`/`Network.setRequestInterception` let a caller rewrite or
  // fabricate every response the page sees: effectively arbitrary code
  // injection (a rewritten script response) and a full protections bypass
  // (CSP, mixed-content, cert pinning all inspect the response CDP would be
  // handing the caller control over).
  'Fetch',
  // `Security.setIgnoreCertificateErrors` turns off TLS protections
  // directly; this domain has no member that is not that.
  'Security',
  // Process-level introspection (heap snapshots, sampling profiles, system
  // memory/OS info, trace capture) is out of scope for a single-target
  // driving surface and can leak cross-target/process data.
  'Profiler',
  'HeapProfiler',
  'Memory',
  'SystemInfo',
  'Tracing',
]);

/**
 * Individual methods refused even though their domain is otherwise open,
 * because the method itself defeats the capability model regardless of
 * what else in its domain is safe.
 */
const REFUSED_METHODS: ReadonlySet<string> = new Set([
  // Filesystem reach: points this target's downloads at an arbitrary local
  // path. (`Browser.setDownloadBehavior`, the instance-wide sibling, is
  // already closed via `REFUSED_DOMAINS`; `Page` carries its own
  // target-scoped copy of the same method.)
  'Page.setDownloadBehavior',
  // Protections bypass: disables Content-Security-Policy for this target.
  'Page.setBypassCSP',
  // Persistent arbitrary script injection: runs attacker-controlled script
  // on every future navigation this target makes, not just the current
  // page, which makes it strictly worse than a one-shot `Runtime.evaluate`
  // (already closed via the `Runtime` domain) rather than safer for being
  // in `Page`.
  'Page.addScriptToEvaluateOnNewDocument',
  'Page.removeScriptToEvaluateOnNewDocument',
  // Rewrites the page's document outright: arbitrary content injection
  // with the page's own privileges, the same class of risk as rewriting a
  // network response.
  'Page.setDocumentContent',
]);

/** Whether `method` is on {@link CDP_PASSTHROUGH_ALLOWLIST}, not in a refused domain, and not itself refused. Deny by default: an unrecognised method, or one whose domain lookup fails to parse, is refused. */
export function isCdpMethodAllowed(method: string): boolean {
  const domain = method.split('.', 1)[0];
  if (domain === undefined || domain.length === 0) return false;
  if (REFUSED_DOMAINS.has(domain)) return false;
  if (REFUSED_METHODS.has(method)) return false;
  return ALLOWED_SET.has(method);
}

/**
 * The full passthrough allowlist: page-level navigation and read state
 * (mirroring what `ManagedSession.navigate()` already sends directly),
 * screenshot capture, safe read-only DOM/page inspection, and the same
 * `Input.*` dispatch surface `packages/core/src/input/cdp-allowlist.ts`
 * already grants the input channel. The four `Input.*` entries below are
 * gated on the SAME control lease the WS input path is fenced against:
 * `ManagedSession.sendCdp()` (`session/managed-session.ts`) routes any
 * `Input.*` method through `withRestControl()`, which borrows the target's
 * lease under the synthetic `REST_VIEWER_ID` and throws immediately if
 * another viewer already holds it, so `cdp` grants no more input reach
 * than `control` already does over the WS input path. Every entry here
 * still passes through {@link REFUSED_DOMAINS}/{@link REFUSED_METHODS}
 * first; none of them are refused, but that check runs unconditionally so
 * a future addition here cannot silently skip it.
 */
export const CDP_PASSTHROUGH_ALLOWLIST = Object.freeze([
  'Page.navigate',
  'Page.reload',
  'Page.stopLoading',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getBoxModel',
  'DOM.getOuterHTML',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
  'Network.getResponseBody',
] as const);

const ALLOWED_SET: ReadonlySet<string> = new Set(CDP_PASSTHROUGH_ALLOWLIST);
