-- 0008_concurrent_quota_counters.sql (Postgres only)
--
-- `store-sqlite`'s own `reserveQuota`/`releaseQuota` (store.ts) keep the
-- live count for a `'concurrent'` window quota in an in-process `Map`,
-- with a comment stating plainly why: "the schema's `quotas` table
-- stores only the ceiling (`limit_value`), never a live usage counter, and
-- no other table in the schema tracks 'how many of metric X are
-- outstanding right now' generically. This is safe under `store-sqlite`'s
-- single writer, single process deployment model... A Postgres adapter
-- would use a real `SELECT ... FOR UPDATE` against a durable counter row
-- instead."
--
-- This table is that durable counter row, one per (tenant, scope, metric)
-- concurrency window, existing ONLY so `store-postgres`'s `reserveQuota`
-- can do exactly what that comment anticipates: a real, cross-process,
-- row-level-locked check-and-increment, instead of a JS `Map` that is
-- silently wrong the moment a second `bgls serve` process shares the same
-- database (the whole reason Postgres exists in this project). This is
-- additive: it does not rename, retype, or change the semantics of any
-- existing table.
CREATE TABLE concurrent_quota_counters (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  metric          TEXT NOT NULL,
  value           BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, scope, metric)
);
