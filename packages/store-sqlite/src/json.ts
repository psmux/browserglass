/**
 * JSON column helpers. Every DDL `TEXT` column documented as `-- JSON` in
 * the schema round-trips through these two functions, so a malformed
 * stored value fails loudly at the read site rather than propagating a
 * `SyntaxError` with no context.
 */

/** Parses a `TEXT` JSON column. Returns `fallback` for a `NULL` column. */
export function parseJsonColumn<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new Error(`corrupt JSON column value: ${JSON.stringify(value)}`, { cause });
  }
}

/** Serialises a value for a `TEXT` JSON column. */
export function toJsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}
