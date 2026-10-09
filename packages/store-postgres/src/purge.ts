import type { PurgeableTable } from '@browserglass/protocol';
/**
 * Per-table purge semantics, ported from `store-sqlite`'s
 * `purge.ts`. `Store.purge(table, olderThan, limit)` carries one uniform
 * signature; the retention rule behind it is not uniform ("older than T"
 * does not describe "keep 5 per profile" or "staged and never committed
 * for 6 hours"), so each table's actual policy lives here, exactly as
 * `store-sqlite` already implements it: the semantics must match, only the placeholder syntax and
 * the query execution (`pg`'s async `query`, not `better-sqlite3`'s sync
 * `run`) differ. Postgres, like SQLite, has no `DELETE ... LIMIT`, so every
 * delete is bounded the same way: a subquery selecting at most `limit`
 * matching ids.
 */
import type { Pool, PoolClient } from 'pg';

/** How many snapshots `profile_snapshots` retains per profile by default. */
const SNAPSHOT_KEEP_PER_PROFILE = 5;

/**
 * Deletes at most `limit` rows from `table` per its own retention rule,
 * bounded additionally by `olderThan` where the rule is age based. Returns
 * the number of rows actually deleted.
 */
export async function purgeTable(
  db: Pool | PoolClient,
  table: PurgeableTable,
  olderThan: string,
  limit: number,
): Promise<number> {
  const run = async (sql: string, ...params: unknown[]): Promise<number> => {
    const result = await db.query(sql, params);
    return result.rowCount ?? 0;
  };

  switch (table) {
    case 'profile_leases':
      return run(
        `DELETE FROM profile_leases WHERE id IN (
           SELECT id FROM profile_leases WHERE released_at IS NOT NULL AND released_at < $1 LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'profile_snapshots':
      return run(
        `DELETE FROM profile_snapshots WHERE id IN (
           SELECT id FROM (
             SELECT id, created_at,
                    ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY created_at DESC) AS rn
             FROM profile_snapshots
           ) ranked
           WHERE rn > ${SNAPSHOT_KEEP_PER_PROFILE} AND created_at < $1
           LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'sessions':
      return run(
        `DELETE FROM sessions WHERE id IN (
           SELECT id FROM sessions WHERE status = 'ended' AND ended_at IS NOT NULL AND ended_at < $1 LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'viewers':
      return run(
        `DELETE FROM viewers WHERE id IN (
           SELECT id FROM viewers WHERE disconnected_at IS NOT NULL AND disconnected_at < $1 LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'control_leases':
      return run(
        `DELETE FROM control_leases WHERE id IN (
           SELECT id FROM control_leases WHERE released_at IS NOT NULL AND released_at < $1 LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'audit_events':
      return run(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events WHERE occurred_at < $1 LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'downloads':
      return run(
        `DELETE FROM downloads WHERE id IN (
           SELECT id FROM downloads WHERE status <> 'deleted' AND expires_at < $1 LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'uploads':
      return run(
        `DELETE FROM uploads WHERE id IN (
           SELECT id FROM uploads
           WHERE status <> 'deleted'
             AND (expires_at < $1 OR (status = 'staging' AND updated_at < $1))
           LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'attach_tickets':
      return run(
        'DELETE FROM attach_tickets WHERE id IN (SELECT id FROM attach_tickets WHERE expires_at < $1 LIMIT $2)',
        olderThan,
        limit,
      );

    case 'revocations':
      return run(
        'DELETE FROM revocations WHERE id IN (SELECT id FROM revocations WHERE expires_at < $1 LIMIT $2)',
        olderThan,
        limit,
      );

    case 'invites':
      return run(
        `DELETE FROM invites WHERE id IN (
           SELECT id FROM invites
           WHERE status IN ('exhausted', 'revoked', 'expired', 'dead') AND updated_at < $1
           LIMIT $2
         )`,
        olderThan,
        limit,
      );

    case 'placement_queue':
      return run(
        `DELETE FROM placement_queue WHERE id IN (
           SELECT id FROM placement_queue WHERE status IN ('placed', 'failed', 'abandoned') AND deadline_at < $1 LIMIT $2
         )`,
        olderThan,
        limit,
      );

    default: {
      const exhaustive: never = table;
      throw new Error(`purge: unhandled table ${String(exhaustive)}`);
    }
  }
}
