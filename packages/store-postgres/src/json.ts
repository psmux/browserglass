/**
 * JSON column helpers. Every DDL column documented as `-- JSON` in the
 * schema is a `jsonb` column here (Postgres's native binary JSON type,
 * chosen over the SQLite adapter's `TEXT` compromise so `jsonb_path_ops`
 * GIN indexes are possible where a column is actually queried, see
 * `migrations/0007_gin_indexes.sql`). `engine.ts` installs a type parser
 * that hands every `json`/`jsonb` column back as the raw, unparsed text the
 * server sent, not an already-parsed JS value, so this module's two
 * functions round-trip a column exactly the way `store-sqlite`'s do: a
 * malformed stored value fails loudly at the read site rather than
 * propagating a `SyntaxError` with no context, or silently succeeding
 * because `pg` parsed it before this module ever saw it.
 */

/** Parses a `jsonb`/`json` column read back as raw text. Returns `fallback` for a `NULL` column. */
export function parseJsonColumn<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch (cause) {
    throw new Error(`corrupt JSON column value: ${JSON.stringify(value)}`, { cause });
  }
}

/** Serialises a value for a `jsonb`/`json` column. Postgres casts the text parameter to `jsonb` implicitly against the target column's type. */
export function toJsonColumn(value: unknown): string {
  return JSON.stringify(value ?? null);
}
