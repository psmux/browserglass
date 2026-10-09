-- 0009_browser_spec_remote_endpoint.sql (Postgres)
--
-- Ported from store-sqlite's migration of the same name (numbered 0007
-- there; this adapter's own numbering has already diverged at 0007/0008
-- for Postgres-only migrations); identical column, identical semantics.
-- See that file for the full rationale.
ALTER TABLE browser_specs ADD COLUMN remote_endpoint_name TEXT;
