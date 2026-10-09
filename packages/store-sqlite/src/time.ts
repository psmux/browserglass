/**
 * Timestamp conversion helpers at the store boundary. The protocol's in memory
 * domain entities (`Tenant`, `Instance`, `Profile`, and so on, from
 * `@browserglass/protocol`) use epoch millisecond numbers throughout; every
 * DDL column that stores a timestamp is `TEXT`, an ISO 8601 UTC string with
 * millisecond precision. This module is the single place
 * that crosses that boundary, so every mapper agrees on the same rule.
 */

/** An ISO 8601 UTC millisecond precision timestamp string, matching `Iso` from `@browserglass/protocol`. */
export type Iso = string;

/** Converts an epoch millisecond number to the DDL's ISO 8601 UTC string form. */
export function toIso(epochMs: number): Iso {
  return new Date(epochMs).toISOString();
}

/** Returns the current instant as an ISO 8601 UTC string, for a `TEXT` timestamp column. */
export function nowIso(): Iso {
  return new Date().toISOString();
}

/** Converts a DDL `TEXT` ISO 8601 timestamp to the epoch millisecond number domain entities use. Returns `null` for a null column. */
export function fromIso(iso: string | null | undefined): number | null {
  if (iso === null || iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/** Same as {@link fromIso} but for a column that is `NOT NULL` in the schema, so a non-null result is guaranteed by the caller. */
export function fromIsoRequired(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new Error(`not a valid ISO 8601 timestamp: ${JSON.stringify(iso)}`);
  return ms;
}
