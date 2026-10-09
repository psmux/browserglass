/**
 * The digest half of the plugin integrity rule: what is on disk is
 * verified against a digest on every load, before the module is imported,
 * and a mismatch refuses rather than warns. This file is the
 * whole of that check: one hash over one file, and a comparison of that
 * hash against the one recorded in `bgls-plugins.json`.
 *
 * One file and one hash is the entire verification
 * story: a plugin is required to be a single bundled module with zero
 * runtime dependencies, so the digest of that one file "covers every line
 * that will execute". There is no `node_modules` tree to walk and no
 * lockfile to trust; the file this module hashes is the file `import()`
 * will load.
 *
 * No network and no `import()` happen here. This file only reads bytes
 * from disk and hashes them, which is what makes it fully unit testable
 * with fixed input and a known expected digest.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The digest string format recorded in `bgls-plugins.json`'s `integrity`
 * field: `sha512-<base64>`, the same shape npm's own package-lock integrity
 * strings use. Exported so `record.ts` can shape-check a record's
 * `integrity` field against the same prefix rather than duplicating the
 * literal.
 */
export const DIGEST_PREFIX = 'sha512-';

/**
 * Hashes `filePath` with SHA-512 and returns the digest as `sha512-<base64>`.
 *
 * Base64 rather than hex because that is the format `bgls-plugins.json`
 * already commits to (an example record: `"integrity":
 * "sha512-Bm5w..."`) and the format npm's own integrity strings use, so a
 * plugin author comparing this output against `npm pack`'s own
 * `shasum`/`integrity` fields is comparing like with like.
 *
 * Reading the whole file into memory is deliberate, not an oversight: a
 * plugin entry file is required to be a single small bundle (tens of
 * kilobytes, not a tree walk over a `node_modules`), so there is
 * no streaming benefit worth the extra surface.
 */
export function hashPluginFile(filePath: string): string {
  const bytes = readFileSync(filePath);
  const digest = createHash('sha512').update(bytes).digest('base64');
  return `${DIGEST_PREFIX}${digest}`;
}

/**
 * Compares two `sha512-<base64>` digest strings for equality, in constant
 * time with respect to the digest bytes.
 *
 * WHY timing safe: this is a security check, not a cache key comparison.
 * `expected` came from a file `bgls-plugins.json` that is untrusted on read
 * (see `record.ts`), and `actual` was just computed from a plugin entry
 * file that is likewise untrusted: it is the exact thing being verified.
 * An ordinary `===`/string comparison on a security relevant digest is the
 * kind of shortcut that reads fine and is wrong, because a comparison that
 * returns on the first mismatched byte leaks, to anyone who can measure
 * response time, how many leading bytes of a guess were already correct.
 * That channel does not need to be practically exploitable here to be
 * worth closing at zero cost: `node:crypto`'s `timingSafeEqual` exists
 * for exactly this comparison and using it is free.
 *
 * Returns `false` (rather than throwing) for a malformed digest string, a
 * digest missing the `sha512-` prefix, or a length mismatch, since none of
 * those can ever legitimately equal a well formed digest and a length
 * mismatch would otherwise make `timingSafeEqual` throw.
 */
export function digestsMatch(expected: string, actual: string): boolean {
  if (!expected.startsWith(DIGEST_PREFIX) || !actual.startsWith(DIGEST_PREFIX)) {
    return false;
  }
  const expectedBytes = decodeBase64Payload(expected);
  const actualBytes = decodeBase64Payload(actual);
  if (expectedBytes === null || actualBytes === null) {
    return false;
  }
  if (expectedBytes.length !== actualBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, actualBytes);
}

/** Strict base64 (RFC 4648, standard alphabet, optional `=` padding). */
const BASE64_SHAPE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decodes the base64 payload after `sha512-`, or returns `null` if it is
 * empty or not well formed base64.
 *
 * WHY a shape check rather than trusting `Buffer.from(x, 'base64')`:
 * that call silently drops characters outside the base64 alphabet instead
 * of throwing, so a corrupted or truncated payload would decode to some
 * shorter buffer rather than failing, and a shorter buffer is exactly the
 * kind of malformed input {@link digestsMatch} must reject rather than
 * compare.
 */
function decodeBase64Payload(digest: string): Buffer | null {
  const payload = digest.slice(DIGEST_PREFIX.length);
  if (payload === '' || !BASE64_SHAPE.test(payload)) return null;
  return Buffer.from(payload, 'base64');
}

/**
 * Hashes `filePath` and reports whether it matches `expectedDigest`
 * (a `sha512-<base64>` string), in one call. The composition of
 * {@link hashPluginFile} and {@link digestsMatch} that every caller
 * actually wants: load.ts (stage 2) and `bgls plugins verify` (stage 3)
 * both need "does this file on disk still match what was recorded", not
 * the digest itself.
 */
export function verifyPluginFile(filePath: string, expectedDigest: string): boolean {
  const actual = hashPluginFile(filePath);
  return digestsMatch(expectedDigest, actual);
}
