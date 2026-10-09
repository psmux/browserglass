/**
 * Validates and normalises `AcquireRequest.metadata` before it reaches
 * `Store.createInstance`: the request's bookkeeping field.
 *
 * `metadata` is caller supplied and lands on every instance row a tenant
 * creates, so an unbounded free form map here is a denial-of-service
 * vector against the store: nothing stops a caller from sending a map with
 * thousands of keys, or a handful of megabyte-sized values, and both
 * `store-sqlite`'s `TEXT` column and `store-postgres`'s `JSONB` column pay
 * that cost on every read and write. The caps below exist for that reason,
 * not because the domain has any opinion on how long a name should be.
 *
 * CAPS CHOSEN: 16 keys, 64 characters per key, 512 characters per value.
 * The two keys this doc, `NewInstance.metadata`'s doc
 * (`packages/protocol/src/domain/store-types.ts`), and the REST inventory
 * route agree to treat as conventional, `name` and `description`, comfortably
 * fit inside a single key/value pair each (a `name` is realistically under
 * 64 characters; a `description` under 512). 16 keys leaves headroom for a
 * handful of additional operator-defined tags (environment, team, run id)
 * without turning the column into a general purpose datastore. Worst case
 * per row: 16 * (64 + 512) = 9,216 characters of JSON payload, small enough
 * that it does not need its own size ceiling beyond the per-field caps.
 *
 * `name` and `description` are a CONVENTION, not a constraint: `metadata`
 * stays a free form `Record<string, string>` at the type level (matching
 * `Instance.metadata`, `entities.ts`), and this function does not reject a
 * map that omits or renames them. Blessing two keys only fixes what the
 * REST inventory route (`packages/server/src/rest/**`)
 * looks for when it renders an instance list, so every caller has a
 * predictable place to put a human readable label without the store
 * needing a schema migration every time a new convention is invented.
 */

import type { Instance } from '@browserglass/protocol';

/** Maximum number of metadata keys accepted on one `acquire` call. */
export const MAX_METADATA_KEYS = 16;
/** Maximum length, in characters, of one metadata key. */
export const MAX_METADATA_KEY_LENGTH = 64;
/** Maximum length, in characters, of one metadata value. */
export const MAX_METADATA_VALUE_LENGTH = 512;

/**
 * The conventional keys `router` and the REST inventory route agree to
 * treat as an instance's human readable name/description. Not enforced:
 * see this module's top comment.
 */
export const CONVENTIONAL_METADATA_KEYS = Object.freeze(['name', 'description'] as const);

/** Thrown by {@link validateAcquireMetadata} when a caller's metadata exceeds the caps above. */
export class MetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataValidationError';
  }
}

/**
 * Validates `raw` against the caps above and returns a frozen, defensively
 * copied `Instance.metadata`. `undefined` (the common case: a caller who
 * does not set `metadata` at all) returns `{}`, never `undefined`: see
 * `NewInstance.metadata`'s doc for why this field must never be optional
 * again once it reaches the store.
 *
 * Throws {@link MetadataValidationError} rather than silently truncating:
 * a caller who asked for a 2,000 character description and got the first
 * 512 characters back with no error would have exactly the "accepted,
 * then silently altered" bug this validation exists to prevent, one step
 * removed.
 */
export function validateAcquireMetadata(
  raw: Readonly<Record<string, string>> | undefined,
): Instance['metadata'] {
  if (raw === undefined) return {};

  const keys = Object.keys(raw);
  if (keys.length > MAX_METADATA_KEYS) {
    throw new MetadataValidationError(
      `metadata has ${keys.length} keys, more than the ${MAX_METADATA_KEYS} allowed`,
    );
  }

  const out: Record<string, string> = {};
  for (const key of keys) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      throw new MetadataValidationError(
        `metadata key ${JSON.stringify(key)} is ${key.length} characters, more than the ${MAX_METADATA_KEY_LENGTH} allowed`,
      );
    }
    const value = raw[key] as string;
    if (typeof value !== 'string') {
      throw new MetadataValidationError(`metadata key ${JSON.stringify(key)} must be a string`);
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH) {
      throw new MetadataValidationError(
        `metadata value for key ${JSON.stringify(key)} is ${value.length} characters, more than the ${MAX_METADATA_VALUE_LENGTH} allowed`,
      );
    }
    out[key] = value;
  }
  return Object.freeze(out);
}
