import type { PurgeableTable } from '@browserglass/protocol';
/**
 * Per-table purge semantics. `Store.purge(table, olderThan, limit)`
 * carries one uniform signature; the retention rule behind it is not
 * uniform ("older than T" does not describe "keep 5 per profile" or
 * "staged and never committed for 6 hours"), so each table's actual policy
 * lives here, inside the adapter. Every delete is capped at `limit` rows via a bounded
 * subquery, since SQLite's `DELETE` does not support `LIMIT` directly.
 */
import type Database from 'better-sqlite3';

/** How many snapshots `profile_snapshots` retains per profile by default. */
const SNAPSHOT_KEEP_PER_PROFILE = 5;

/**
 * Deletes at most `limit` rows from `table` per its own retention rule,
 * bounded additionally by `olderThan` where the rule is age based. Returns
 * the number of rows actually deleted.
 */
export function purgeTable(
  db: Database.Database,
  table: PurgeableTable,
  olderThan: string,
  limit: number,
): number {
  const run = (sql: string, ...params: unknown[]): number =>
    (db.prepare(sql).run(...params) as { changes: number }).changes;

  switch (table) {
    case 'profile_leases':
      // Historical rows retained briefly for debugging, then deleted.
      return run(
        `DELETE FROM profile_leases WHERE id IN (
           SELECT id FROM profile_leases WHERE released_at IS NOT NULL AND released_at < ? LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'profile_snapshots':
      // Keep-N-per-profile, not purely age based; olderThan is an
      // additional safety bound so a snapshot never disappears the instant
      // it drops out of the top N.
      return run(
        `DELETE FROM profile_snapshots WHERE id IN (
           SELECT id FROM (
             SELECT id, created_at,
                    ROW_NUMBER() OVER (PARTITION BY profile_id ORDER BY created_at DESC) AS rn
             FROM profile_snapshots
           )
           WHERE rn > ${SNAPSHOT_KEEP_PER_PROFILE} AND created_at < ?
           LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'sessions':
      return run(
        `DELETE FROM sessions WHERE id IN (
           SELECT id FROM sessions WHERE status = 'ended' AND ended_at IS NOT NULL AND ended_at < ? LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'viewers':
      return run(
        `DELETE FROM viewers WHERE id IN (
           SELECT id FROM viewers WHERE disconnected_at IS NOT NULL AND disconnected_at < ? LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'control_leases':
      return run(
        `DELETE FROM control_leases WHERE id IN (
           SELECT id FROM control_leases WHERE released_at IS NOT NULL AND released_at < ? LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'audit_events':
      // Severity tiered retention is the caller's
      // concern: MaintenanceRunner calls this once per severity band with
      // that band's own olderThan. This adapter purges by age alone.
      return run(
        `DELETE FROM audit_events WHERE id IN (
           SELECT id FROM audit_events WHERE occurred_at < ? LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'downloads':
      // downloads.expires_at already encodes "7 days, or 24h after fetch"
      // (set by the caller when creating/updating the row), so purge is a
      // plain expiry sweep, matching idx_downloads_expiry.
      return run(
        `DELETE FROM downloads WHERE id IN (
           SELECT id FROM downloads WHERE status <> 'deleted' AND expires_at < ? LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'uploads':
      // Two conditions: the row's own expiry, or "staged and never
      // committed for 6 hours" (idx_uploads_stale).
      return run(
        `DELETE FROM uploads WHERE id IN (
           SELECT id FROM uploads
           WHERE status <> 'deleted'
             AND (expires_at < ? OR (status = 'staging' AND updated_at < ?))
           LIMIT ?
         )`,
        olderThan,
        olderThan,
        limit,
      );

    case 'attach_tickets':
      return run(
        'DELETE FROM attach_tickets WHERE id IN (SELECT id FROM attach_tickets WHERE expires_at < ? LIMIT ?)',
        olderThan,
        limit,
      );

    case 'revocations':
      return run(
        'DELETE FROM revocations WHERE id IN (SELECT id FROM revocations WHERE expires_at < ? LIMIT ?)',
        olderThan,
        limit,
      );

    case 'invites':
      return run(
        `DELETE FROM invites WHERE id IN (
           SELECT id FROM invites
           WHERE status IN ('exhausted', 'revoked', 'expired', 'dead') AND updated_at < ?
           LIMIT ?
         )`,
        olderThan,
        limit,
      );

    case 'placement_queue':
      return run(
        `DELETE FROM placement_queue WHERE id IN (
           SELECT id FROM placement_queue WHERE status IN ('placed', 'failed', 'abandoned') AND deadline_at < ? LIMIT ?
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
