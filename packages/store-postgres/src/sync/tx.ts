/**
 * The synchronous `StoreTx` implementation for Postgres, backed by
 * {@link SyncBridge}. Table and column names passed in are always literal
 * strings from this package's own `store.ts`, never user-supplied, so
 * building SQL by string interpolation for identifiers (never for a
 * value, which always travels as a `$N` parameter) is safe, matching
 * `store-sqlite`'s own `tx.ts`.
 */
import type { StoreTx } from '@browserglass/protocol';
import type { SyncBridge } from './bridge.js';

function whereClause(
  key: Record<string, unknown>,
  startIndex: number,
): { sql: string; params: unknown[] } {
  const cols = Object.keys(key);
  return {
    sql: cols.map((c, i) => `${c} = $${startIndex + i}`).join(' AND '),
    params: cols.map((c) => key[c]),
  };
}

/** `StoreTx` bound to one {@link SyncBridge}, valid only for the lifetime of the `Store.transaction()` call that constructs it. */
export class PgTx implements StoreTx {
  readonly kind = 'postgres' as const;

  constructor(private readonly bridge: SyncBridge) {}

  get<T>(table: string, key: Record<string, unknown>): T | null {
    const { sql, params } = whereClause(key, 1);
    const { rows } = this.bridge.query<T>(`SELECT * FROM ${table} WHERE ${sql}`, params);
    return rows[0] ?? null;
  }

  insert(table: string, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    this.bridge.query(
      `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`,
      cols.map((c) => row[c]),
    );
  }

  update(table: string, key: Record<string, unknown>, patch: Record<string, unknown>): number {
    const patchCols = Object.keys(patch);
    const setSql = patchCols.map((c, i) => `${c} = $${i + 1}`).join(', ');
    const { sql: whereSql, params: whereParams } = whereClause(key, patchCols.length + 1);
    const { rowCount } = this.bridge.query(`UPDATE ${table} SET ${setSql} WHERE ${whereSql}`, [
      ...patchCols.map((c) => patch[c]),
      ...whereParams,
    ]);
    return rowCount ?? 0;
  }

  delete(table: string, key: Record<string, unknown>): number {
    const { sql, params } = whereClause(key, 1);
    const { rowCount } = this.bridge.query(`DELETE FROM ${table} WHERE ${sql}`, params);
    return rowCount ?? 0;
  }

  raw<T>(sql: string, params: unknown[]): T[] {
    const { rows, rowCount, command } = this.bridge.query<T>(sql, params);
    // Matches `store-sqlite`'s `SqliteTx.raw`: a SELECT returns its rows
    // (correctly `[]` when zero rows match); a writer statement with no
    // `RETURNING` also comes back from `pg` as `rows: []`, and is reported
    // as `[{ changes: rowCount }]` instead, the same shape
    // `better-sqlite3`'s `.run()` info gives, for the one caller
    // (`rotateAppKey`) that issues a writer statement through `raw` and
    // ignores the return value, and any caller that might inspect it in
    // the future. `command` (`pg`'s own `'SELECT'`/`'UPDATE'`/...  tag) is
    // what distinguishes the two cases: without it, an empty SELECT result
    // and a writer statement's empty `rows` are indistinguishable, and
    // `redeemInvite`/`appendAuditChained` (`store.ts`) both depend on a
    // genuinely empty array meaning "no row found", not a fabricated
    // `{ changes: 0 }` object that is truthy at `rows[0]`.
    if (rows.length === 0 && command !== 'SELECT' && rowCount !== null)
      return [{ changes: rowCount } as unknown as T];
    return rows;
  }
}
