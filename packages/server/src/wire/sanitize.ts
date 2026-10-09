/**
 * Untrusted content handling for page-derived strings crossing the wire:
 * byte caps on `title`/`url`/`message`/`console.entry.text`/`suggestedName`,
 * control-character stripping, bidi-override normalisation, and the
 * `suggestedName` path-traversal rule. Every field here can originate from
 * the remote page (a hostile `document.title`, a crafted download filename),
 * never from BrowserGlass itself, so this module is the one place that
 * content crosses from "attacker controlled" to "safe to put on the wire".
 */

/** Byte caps for untrusted page-derived strings. */
export const CONTENT_CAPS = Object.freeze({
  titleBytes: 512,
  urlBytes: 4096,
  messageBytes: 4096,
  consoleTextBytes: 8192,
  suggestedNameBytes: 255,
});

/**
 * U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F: every C0 control
 * character except tab (U+0009), LF (U+000A), and CR (U+000D), plus DEL.
 * Built from `String.fromCharCode` ranges rather than a literal regex
 * character class, so the exact codepoints stay unambiguous in source form
 * (no literal control bytes embedded in this file).
 */
function buildCharClassSource(ranges: ReadonlyArray<readonly [number, number]>): string {
  return ranges
    .map(
      ([lo, hi]) => `\\u${lo.toString(16).padStart(4, '0')}-\\u${hi.toString(16).padStart(4, '0')}`,
    )
    .join('');
}

const CONTROL_CHAR_RE = new RegExp(
  `[${buildCharClassSource([
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x7f, 0x7f],
  ])}]`,
  'g',
);

/** U+202A-U+202E (the classic bidi overrides) plus U+2066-U+2069 (the isolate forms). */
const BIDI_OVERRIDE_RE = new RegExp(
  `[${buildCharClassSource([
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ])}]`,
  'g',
);

/** Strips control characters (U+0000-U+0008, U+000B, U+000C, U+000E-U+001F, U+007F) and bidi override characters (U+202A-U+202E, U+2066-U+2069). */
export function stripUnsafeChars(value: string): string {
  return value.replace(CONTROL_CHAR_RE, '').replace(BIDI_OVERRIDE_RE, '');
}

/** Truncates `value` to at most `maxBytes` UTF-8 bytes, never splitting a surrogate pair. */
export function capUtf8Bytes(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let end = maxBytes;
  // Never split a UTF-8 continuation byte sequence: back off while the next
  // byte looks like a continuation byte (top two bits `10`).
  while (end > 0 && ((encoded[end] as number) & 0b1100_0000) === 0b1000_0000) {
    end -= 1;
  }
  return new TextDecoder().decode(encoded.subarray(0, end));
}

/** Strips unsafe characters, then caps to `maxBytes`. The one function every page-derived string field goes through before it reaches an outbound envelope. */
export function sanitizeContent(value: string, maxBytes: number): string {
  return capUtf8Bytes(stripUnsafeChars(value), maxBytes);
}

/** {@link sanitizeContent} at {@link CONTENT_CAPS.titleBytes}. */
export function sanitizeTitle(value: string): string {
  return sanitizeContent(value, CONTENT_CAPS.titleBytes);
}

/** {@link sanitizeContent} at {@link CONTENT_CAPS.urlBytes}. */
export function sanitizeUrl(value: string): string {
  return sanitizeContent(value, CONTENT_CAPS.urlBytes);
}

/** {@link sanitizeContent} at {@link CONTENT_CAPS.messageBytes}. */
export function sanitizeMessage(value: string): string {
  return sanitizeContent(value, CONTENT_CAPS.messageBytes);
}

/** {@link sanitizeContent} at {@link CONTENT_CAPS.consoleTextBytes}. */
export function sanitizeConsoleText(value: string): string {
  return sanitizeContent(value, CONTENT_CAPS.consoleTextBytes);
}

/**
 * Validates and sanitises a `download.started`-style `suggestedName`.
 * Returns `null` when the name contains a path separator (`/` or `\`) or a
 * `..` segment (path traversal), which the protocol says MUST be rejected;
 * a caller falls back to a safe generated name rather than surfacing the
 * rejected one.
 */
export function sanitizeSuggestedName(value: string): string | null {
  const cleaned = sanitizeContent(value, CONTENT_CAPS.suggestedNameBytes);
  if (cleaned.length === 0) return null;
  if (cleaned.includes('/') || cleaned.includes('\\')) return null;
  if (cleaned.split(/[/\\]/).includes('..')) return null;
  return cleaned;
}
