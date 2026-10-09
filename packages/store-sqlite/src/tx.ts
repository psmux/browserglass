import type { StoreTx } from '@browserglass/protocol';
/**
 * The synchronous `StoreTx` implementation. Table names passed in are
 * always literal strings from this package's own `store.ts`, never
 * user-supplied, so building SQL by string interpolation for the table
 * name (never for a value) is safe.
 */
import type Database from 'better-sqlite3';

function whereClause(key: Record<string, unknown>): { sql: string; params: unknown[] } {
  const cols = Object.keys(key);
  return { sql: cols.map((c) => `${c} = ?`).join(' AND '), params: cols.map((c) => key[c]) };
}

/** `StoreTx` bound to one `better-sqlite3` connection, valid only for the lifetime of the `db.transaction()` callback that constructs it. */
export class SqliteTx implements StoreTx {
  readonly kind = 'sqlite' as const;

  constructor(private readonly db: Database.Database) {}

  get<T>(table: string, key: Record<string, unknown>): T | null {
    const { sql, params } = whereClause(key);
    const row = this.db.prepare(`SELECT * FROM ${table} WHERE ${sql}`).get(...params);
    return (row as T | undefined) ?? null;
  }

  insert(table: string, row: Record<string, unknown>): void {
    const cols = Object.keys(row);
    const placeholders = cols.map(() => '?').join(', ');
    this.db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders})`)
      .run(...cols.map((c) => row[c]));
  }

  update(table: string, key: Record<string, unknown>, patch: Record<string, unknown>): number {
    const patchCols = Object.keys(patch);
    const { sql: where, params: whereParams } = whereClause(key);
    const set = patchCols.map((c) => `${c} = ?`).join(', ');
    const info = this.db
      .prepare(`UPDATE ${table} SET ${set} WHERE ${where}`)
      .run(...patchCols.map((c) => patch[c]), ...whereParams);
    return info.changes;
  }

  delete(table: string, key: Record<string, unknown>): number {
    const { sql: where, params } = whereClause(key);
    const info = this.db.prepare(`DELETE FROM ${table} WHERE ${where}`).run(...params);
    return info.changes;
  }

  raw<T>(sql: string, params: unknown[]): T[] {
    const stmt = this.db.prepare(sql);
    if (stmt.reader) return stmt.all(...params) as T[];
    const info = stmt.run(...params);
    return [{ changes: info.changes } as unknown as T];
  }
}
