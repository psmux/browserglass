/**
 * Turning a caller-supplied filename into something safe to create on
 * disk, and proving the result stayed where it was put.
 *
 * THE THREAT, STATED PLAINLY
 *
 * A file upload feature ends with the gateway handing Chrome an absolute
 * path and saying "attach whatever is here to this form". If a caller can
 * influence that path, the caller can make the browser attach, and then
 * POST to a site of the caller's choosing, any file the gateway process
 * can read: the signing keys, the store database, another tenant's staged
 * invoice, `/etc/shadow`. That is a file-read-anything primitive with
 * exfiltration attached, and it is the single most likely way to get this
 * feature wrong.
 *
 * THE PRIMARY DEFENCE IS NOT THIS FILE
 *
 * The primary defence is that no API in this build accepts a path at all.
 * `POST /v1/instances/:id/targets/:tid/files` and the `files.set` wire
 * message both take `uploadIds` and nothing else. Each id is looked up in
 * a staging registry that the gateway populated itself, and the path that
 * reaches `DOM.setFileInputFiles` is one the gateway composed from a root
 * it owns, an id it minted, and a name it sanitised. There is no code path
 * from a request field to a path component. Traversal, symlinks and UNC
 * are all unreachable from the outside because the outside never names a
 * location.
 *
 * SO WHY SANITISE AT ALL
 *
 * Because the caller's filename still has to survive the trip: Chrome
 * reports `basename(path)` as `File.name`, and a form that receives
 * `a3f9c1.bin` instead of `invoice-2024-03.pdf` is broken in a way the caller
 * will not accept. The name is therefore the ONE piece of caller input
 * that becomes a real path component, in the one place it does so:
 * `<root>/<uploadId>/<name>`. Everything below exists to make that single
 * component inert, and {@link containedPath} exists to prove it stayed
 * inert even if something below is wrong.
 *
 * Belt and braces is deliberate here. A sanitiser is a blocklist wearing a
 * hat, and blocklists are wrong eventually. The containment check is the
 * part that does not depend on having enumerated every hostile string
 * correctly.
 */

import { resolve, sep } from 'node:path';

/**
 * The longest sanitised name, in UTF-8 bytes.
 *
 * Not a character count: a name of 255 emoji is 1020 bytes and every
 * mainstream filesystem measures its per-component limit in bytes (255 on
 * ext4, APFS and NTFS alike). 200 leaves room for the `<uploadId>`
 * directory and the staging root inside Windows' practical `MAX_PATH`
 * budget, which `runtime-host`'s `WINDOWS_MAX_PROFILE_ROOT_CHARS` already
 * had to reckon with for profile directories.
 */
export const MAX_SAFE_NAME_BYTES = 200;

/** The name used when a caller's filename sanitises down to nothing usable. */
export const FALLBACK_SAFE_NAME = 'upload.bin';

/**
 * Windows device names, which are reserved at EVERY directory level and
 * with ANY extension: `CON`, `con.txt` and `CON.pdf.gz` all resolve to the
 * console device rather than a file. Creating one does not fail cleanly,
 * it silently writes to a device, so these are renamed rather than
 * rejected. Kept as an explicit set because there is no pattern that
 * catches them without also catching legitimate names.
 */
const WINDOWS_RESERVED_NAMES: ReadonlySet<string> = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com0',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt0',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * Characters replaced with `_`. The union of what NTFS forbids
 * (`<>:"/\|?*`) and what POSIX forbids (`/` and NUL), plus the whole C0
 * control range and DEL.
 *
 * `:` is in the list for a reason worth naming: on Windows it opens an
 * NTFS alternate data stream, so `report.pdf:evil` writes to a hidden
 * stream of `report.pdf` rather than to a file called `report.pdf:evil`,
 * and a later reader of `report.pdf` sees content nobody staged.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the control range is the point. This pattern exists to STRIP control characters from a filename (NUL truncation being the classic one), so a rule forbidding their mention would forbid removing them.
const FORBIDDEN_CHARS = /[\u0000-\u001F\u007F<>:"/\\|?*]/g;

/** Truncates `name` to at most `maxBytes` UTF-8 bytes, keeping the extension if one fits. Splits no multi-byte character: `TextEncoder`/`TextDecoder` with `fatal: false` would emit a replacement character, so the cut point is walked back to a boundary instead. */
function truncateUtf8(name: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(name).byteLength <= maxBytes) return name;

  const dot = name.lastIndexOf('.');
  // A "." at position 0 is a leading dot, not an extension separator, and
  // an extension longer than 32 bytes is almost certainly not one.
  const ext = dot > 0 ? name.slice(dot) : '';
  const extBytes = encoder.encode(ext).byteLength;
  const keepExt = ext.length > 0 && extBytes <= 32 && extBytes < maxBytes;
  const stemBudget = keepExt ? maxBytes - extBytes : maxBytes;
  const stem = keepExt ? name.slice(0, dot) : name;

  let cut = stem.length;
  while (cut > 0 && encoder.encode(stem.slice(0, cut)).byteLength > stemBudget) cut -= 1;
  const truncated = stem.slice(0, cut) + (keepExt ? ext : '');
  return truncated.length > 0 ? truncated : FALLBACK_SAFE_NAME;
}

/**
 * Reduces a caller-supplied filename to a single, inert path component.
 *
 * The steps, each with the specific attack or platform quirk it answers:
 *
 * 1. **Keep only the last component.** Split on BOTH separators, not the
 *    platform's own: a POSIX gateway must still defuse `..\..\secret`,
 *    because the attacker picks the string, not the platform. This one
 *    step is what handles `../../../etc/passwd`, `C:\Windows\win.ini`, and
 *    `\\attacker\share\payload` (whose last component is `payload`), and
 *    it handles them by construction rather than by pattern matching for
 *    "..".
 * 2. **Replace forbidden characters.** See {@link FORBIDDEN_CHARS}.
 * 3. **Strip trailing dots and spaces.** Windows silently drops them when
 *    creating a file, so `report.pdf.` and `report.pdf ` both land on
 *    `report.pdf`. Two uploads whose names differ only by a trailing dot
 *    would collide, and a collision between two callers' files is exactly
 *    what per-upload directories exist to prevent. Normalising here means
 *    the name we record is the name that exists.
 * 4. **Rename reserved device names.** See {@link WINDOWS_RESERVED_NAMES}.
 * 5. **Reject `.` and `..` outright.** They survive every step above (no
 *    forbidden characters, not reserved) and mean "this directory" and
 *    "the parent directory". Nothing else in this function would stop
 *    them, so they are named explicitly.
 * 6. **Truncate to {@link MAX_SAFE_NAME_BYTES}.**
 *
 * Never throws. A name that sanitises to nothing becomes
 * {@link FALLBACK_SAFE_NAME}: refusing the upload over an unusable
 * filename would be a worse outcome than attaching the bytes under a
 * generic name, and the caller learns the substituted name from the
 * `upload.done`/`POST /v1/upload/init` reply either way.
 */
export function safeFileName(raw: string): string {
  // Step 1.
  const lastSlash = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'));
  let name = lastSlash >= 0 ? raw.slice(lastSlash + 1) : raw;

  // Step 2.
  name = name.replace(FORBIDDEN_CHARS, '_');

  // Step 3.
  name = name.replace(/[. ]+$/u, '');
  name = name.trim();

  // Step 5, before step 4: `.` and `..` are not reserved device names, and
  // checking them here keeps step 4's stem extraction from seeing an empty
  // stem for `..`.
  if (name === '.' || name === '..' || name.length === 0) return FALLBACK_SAFE_NAME;

  // Step 4. The device check is on the stem, since `CON.txt` is reserved
  // just as `CON` is.
  const dot = name.indexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  if (WINDOWS_RESERVED_NAMES.has(stem.toLowerCase())) name = `_${name}`;

  // Step 6.
  return truncateUtf8(name, MAX_SAFE_NAME_BYTES);
}

/** Thrown by {@link containedPath} when a composed path escaped the directory it was composed against. Reaching this means {@link safeFileName} let something through, so it is a bug report, not a user error, and the message says so. */
export class PathEscapeError extends Error {
  readonly code = 'E_PATH_ESCAPE';
  constructor(dir: string, name: string, resolved: string) {
    super(
      `refusing to use ${JSON.stringify(resolved)}: joining ${JSON.stringify(name)} onto ${JSON.stringify(dir)} left that directory. This is a sanitiser bug, not a caller error; safeFileName should have made this impossible.`,
    );
    this.name = 'PathEscapeError';
  }
}

/**
 * Joins `name` onto `dir` and proves the result is still strictly inside
 * `dir`, throwing {@link PathEscapeError} if it is not.
 *
 * This is the check that does not depend on having sanitised correctly.
 * `resolve()` collapses `..` segments and normalises separators, so
 * comparing the resolved child against the resolved parent catches any
 * escape the sanitiser missed, including one introduced by a future edit
 * to it.
 *
 * The comparison appends {@link sep} to the parent deliberately. Without
 * it, `/srv/uploads-evil` passes a naive `startsWith('/srv/uploads')`
 * prefix test, which is the classic way this check is written wrong.
 *
 * Case is NOT folded, even on Windows where the filesystem is case
 * insensitive. `dir` here is always a path this process just built from
 * its own root, so the two sides come from the same source and cannot
 * differ in case; folding would only add a way for the check to pass on a
 * pair that genuinely differs.
 *
 * What this does NOT check is symlinks: `resolve()` is pure string work
 * and never touches the filesystem, so a symlink already sitting at the
 * destination resolves to a path that looks contained and is not. That is
 * handled where it can be handled honestly, at open time, with an
 * exclusive create and an `lstat` verification; see
 * `upload-store.ts`'s `begin()` and `pathFor()`.
 */
export function containedPath(dir: string, name: string): string {
  const parent = resolve(dir);
  const child = resolve(parent, name);
  if (child === parent || !child.startsWith(parent.endsWith(sep) ? parent : parent + sep)) {
    throw new PathEscapeError(dir, name, child);
  }
  return child;
}
