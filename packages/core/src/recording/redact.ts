/**
 * Redaction discipline for anything this package's recorder persists.
 * Ported (the URL-secret regex, translated verbatim to TypeScript) from
 * browser-harness's `recorder.py`, which strips OAuth codes, tokens, and
 * session state out of every URL it writes, and masks typed passwords, on
 * the reasoning that a session recording of a logged-in browser is a far
 * more dangerous artifact than a live stream nobody stores.
 *
 * BrowserGlass's own capture path (`RawFrame` / `RawFrameMeta`, see
 * `../stream/types.ts`) never carries a URL, typed keystrokes, or DOM
 * content: it is pixels plus frame-sequencing numbers, so there is nothing
 * in `FrameRecorder`'s frame-write path to scrub today. This module exists
 * for the two places that DO need it:
 *
 *   1. `RecordingMeta` (`./types.ts`) deliberately never carries a raw
 *      `sessionId` or `viewerId`; `FrameRecorder` never puts one there.
 *      `redactMeta()` is the enforcement point for `FrameRecorderOptions.extraMeta`,
 *      a caller-supplied bag `FrameRecorder` cannot otherwise guarantee is
 *      clean.
 *   2. `RecordedFrameEntry.intent` (`./types.ts`) is reserved for a future
 *      action-sampled sidecar. Once that lands it will carry exactly what
 *      browser-harness's event log carries today: URLs and typed text, and
 *      MUST be passed through `redactMeta()` before it is written. Built
 *      and tested now so that future wiring has no excuse to skip it.
 */

/**
 * Matches an OAuth/session-bearing query or fragment parameter: the same
 * credential-shaped key list `recorder.py`'s `_URL_SECRETS` uses (auth
 * codes, tokens of every flavour, client secrets, session state, api
 * keys, signatures, and password/authorization params), case-insensitive.
 */
const URL_SECRET_PARAM =
  /([?&#](?:code|access_token|id_token|refresh_token|token|assertion|client_secret|client_info|session_state|api_?key|sig|signature|auth|authorization|password|secret)=)[^&#]+/gi;

/** Loose check for "this string looks like a URL", to decide whether a metadata value is worth running {@link redactUrl} over. */
const LOOKS_LIKE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Replaces the value of every credential-shaped query/fragment param in `url` with `REDACTED`. Non-URL input passes through unchanged (the regex simply finds nothing to match). */
export function redactUrl(url: string): string {
  return url.replace(URL_SECRET_PARAM, '$1REDACTED');
}

/**
 * Metadata keys this module never writes verbatim, matched case
 * insensitively against every key `redactMeta()` sees. `sessionId` and
 * `viewerId` are BrowserGlass's own bearer-shaped identifiers (see
 * `@browserglass/protocol`'s `wire/ids.ts`); the rest mirror what
 * `recorder.py` treats as credential-shaped.
 */
export const REDACTED_META_KEYS: readonly string[] = Object.freeze([
  'sessionid',
  'viewerid',
  'cookie',
  'cookies',
  'authorization',
  'password',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'secret',
  'clientsecret',
  'apikey',
]);

/**
 * Returns a new object with every key in {@link REDACTED_META_KEYS}
 * (case-insensitive) dropped, and {@link redactUrl} applied to every
 * remaining string value that looks like a URL. Never mutates `meta`.
 */
export function redactMeta(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const blocked = new Set(REDACTED_META_KEYS);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (blocked.has(key.toLowerCase())) {
      continue;
    }
    out[key] = typeof value === 'string' && LOOKS_LIKE_URL.test(value) ? redactUrl(value) : value;
  }
  return out;
}
