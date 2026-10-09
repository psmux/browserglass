-- bgls:no-transaction
-- 0007_gin_indexes.sql (Postgres only)
--
-- Realises the optimisation `store-sqlite`'s `migrations/pg-only/
-- p0003_jsonb_columns.sql` scaffold described but, being a comment-only
-- placeholder in a directory the SQLite runner skips entirely, never
-- built: GIN indexes on the two `jsonb` columns actually queried by their
-- contents rather than only ever read back whole.
--
--   * nodes.labels: `@browserglass/router`'s placement selectors match a
--     node by an arbitrary label key/value pair. `jsonb_path_ops` is enough
--     for containment (`labels @> '{"region":"us-east"}'`), which is the
--     only operator placement selection needs, and produces a smaller
--     index than the default `jsonb_ops`.
--   * audit_events.detail: operator investigation frequently searches
--     audit history by a detail field (an error code, a target url host)
--     that nothing else indexes. Same operator class, same
--     reasoning.
--
-- `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, hence
-- this file's `-- bgls:no-transaction` header (`migrate.ts` honours it
-- uniformly with `store-sqlite`'s runner): on a live deployment with rows
-- already in `nodes`/`audit_events`, a plain `CREATE INDEX` would hold an
-- ACCESS EXCLUSIVE-adjacent lock across the whole table for the build's
-- duration, which is exactly the kind of pause a concurrency focused
-- migration must not introduce.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_nodes_labels_gin
  ON nodes USING GIN (labels jsonb_path_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_audit_detail_gin
  ON audit_events USING GIN (detail jsonb_path_ops);
