-- 0010_instance_metadata_lifetime.sql (Postgres)
--
-- Ported from store-sqlite's migration of the same name (numbered 0008
-- there; this adapter's own numbering has already diverged for
-- Postgres-only migrations, see `0007_gin_indexes.sql`/
-- `0008_concurrent_quota_counters.sql`). `metadata` is `JSONB` here rather
-- than `TEXT`, matching this package's JSON convention (see `json.ts`'s
-- top comment); `lifetime` is a plain `TEXT` CHECK column, identical to
-- store-sqlite's. See that file for the full rationale: this is the fourth
-- occurrence of "accepted and validated, but no column to land in", after
-- `client_hints`, `init_scripts`, and `remote_endpoint_name`, this time on
-- `instances` rather than `browser_specs`.
ALTER TABLE instances ADD COLUMN metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE instances ADD COLUMN lifetime TEXT NOT NULL DEFAULT 'viewer-bound'
  CHECK (lifetime IN ('viewer-bound', 'explicit'));
