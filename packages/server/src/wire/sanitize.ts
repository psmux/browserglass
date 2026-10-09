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

/** What {@link redactServerPaths} puts in place of a filesystem path it removed. */
export const REDACTED_PATH = '<server path>';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Directories whose literal value is known to this process and is the
 * likeliest thing to leak: the home and temp directories carry the OS
 * username on every platform. Computed lazily and cached, so importing
 * this module never touches `node:os` in a context that cannot load it.
 */
let knownRoots: RegExp[] | null = null;
function knownRootPatterns(): RegExp[] {
  if (knownRoots !== null) return knownRoots;
  const roots: string[] = [];
  try {
    // `process.env` first so a test (or an operator) can see exactly which
    // value is in play; `os.homedir()`/`os.tmpdir()` read the same vars.
    const env = typeof process !== 'undefined' ? process.env : {};
    for (const key of ['HOME', 'USERPROFILE', 'TMPDIR', 'TEMP', 'TMP', 'LOCALAPPDATA', 'APPDATA']) {
      const v = env[key];
      if (typeof v === 'string' && v.length > 3) roots.push(v);
    }
  } catch {
    // No process env: fall through with whatever was collected.
  }
  knownRoots = roots
    .sort((a, b) => b.length - a.length)
    .map((r) => {
      // Match either separator style, since Node and Chrome both mix them on Windows.
      const pattern = escapeRegExp(r).replace(/\\\\|\//g, '[\\\\/]');
      return new RegExp(`${pattern}(?:[\\\\/][^\\s"'\`<>|]*)?`, 'gi');
    });
  return knownRoots;
}

/** `C:\...` or `C:/...`, not preceded by a letter or digit, so `https://` is never mistaken for a drive. */
const WINDOWS_DRIVE_PATH = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'`<>|]*/g;
/** `\\server\share\...`. */
const UNC_PATH = /\\\\[^\s\\"'`<>|]+\\[^\s"'`<>|]*/g;
/** An absolute POSIX path under a root that only ever names the server's own disk. Not preceded by a word character, a dot, a colon or a slash, so a URL's path (`https://host/home/x`) is left alone. */
const POSIX_SYSTEM_PATH =
  /(?<![\w.:/~-])\/(?:home|Users|tmp|var|private|root|opt|etc|usr|mnt|srv|run|proc|Volumes|data|workspace|app)(?=\/|\b)(?:\/[^\s"'`<>|]*)?/g;

/**
 * Removes absolute filesystem paths of the gateway host from a message
 * that is about to cross the wire. A Node `fs` error's message embeds the
 * full path it failed on (`ENOENT: no such file or directory, open
 * 'C:\Users\<name>\...'`), and that path routinely carries the OS username
 * and the deployment's directory layout, neither of which a client has any
 * business learning. The caller is expected to have logged the original,
 * unredacted message server side first; this only shapes what leaves the
 * process.
 */
export function redactServerPaths(value: string): string {
  let out = value;
  for (const re of knownRootPatterns()) out = out.replace(re, REDACTED_PATH);
  return out
    .replace(UNC_PATH, REDACTED_PATH)
    .replace(WINDOWS_DRIVE_PATH, REDACTED_PATH)
    .replace(POSIX_SYSTEM_PATH, REDACTED_PATH);
}

/** True for a Node system error (`fs`, `net`, `child_process`): one carrying an errno style `code` plus a `syscall`. Its message is built by Node, not by BrowserGlass, and is never shaped for a client. */
export function isNodeSystemError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err instanceof Error &&
    typeof (err as NodeJS.ErrnoException).code === 'string' &&
    typeof (err as NodeJS.ErrnoException).syscall === 'string'
  );
}

/**
 * The message to put on the wire for `err`: a Node system error becomes
 * `fallback` plus its errno code (the code is useful to a caller, the
 * path in the message is not), anything else keeps its own message with
 * every server path removed. Always sanitised and capped like any other
 * outbound message.
 */
export function clientSafeErrorMessage(err: unknown, fallback: string): string {
  if (isNodeSystemError(err)) return sanitizeMessage(`${fallback} (${err.code})`);
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : fallback;
  return sanitizeMessage(redactServerPaths(raw));
}
