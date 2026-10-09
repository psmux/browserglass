/**
 * Id generation for `store-postgres`. `@browserglass/protocol`'s `newId()`
 * is generic over `IdPrefix`, the 23 prefix union the protocol's canonical id
 * table defines (`ID_PREFIXES` in `wire/ids.ts`). Four DDL tables this
 * package owns have no entry in that union: `downloads`, `uploads`,
 * `revocations`, and `placement_queue`. Their `Store` types (`Download.id`,
 * `Upload.id`, `NewRevocation.id`, `PlacementRow.id`) are plain `string`,
 * not a branded `Id<P>`, precisely because no prefix was reserved for
 * them, so this module mints same-shaped but unbranded ids locally rather
 * than widening the protocol layer's `IdPrefix` union for a storage-layer
 * concern. Identical to `store-sqlite`'s own `ids.ts`, duplicated here
 * because the two adapters do not share an implementation package.
 */
import { newId } from '@browserglass/protocol';
import type { IdPrefix } from '@browserglass/protocol';

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeUlidTime(timeMs: number): string {
  let time = timeMs;
  let out = '';
  for (let i = 0; i < 10; i++) {
    const mod = time % 32;
    out = CROCKFORD_ALPHABET[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeUlidRandom(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += CROCKFORD_ALPHABET[(bytes[i] as number) % 32];
  }
  return out;
}

/**
 * Mints an id shaped like `@browserglass/protocol`'s `newId()` output
 * (`<prefix>_<26 char Crockford base32 ULID>`) for a prefix outside the
 * protocol layer's branded `IdPrefix` union. Used only for the four DDL
 * tables noted in this module's top comment.
 */
export function newRawId(prefix: 'dl' | 'ul' | 'rev' | 'plc'): string {
  return `${prefix}_${encodeUlidTime(Date.now())}${encodeUlidRandom()}`;
}

/** Re-exported for mapper convenience so callers only import id helpers from this one module. */
export function newBrandedId<P extends IdPrefix>(prefix: P): string {
  return newId(prefix);
}
