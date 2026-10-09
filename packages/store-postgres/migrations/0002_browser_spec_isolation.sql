-- 0002_browser_spec_isolation.sql (Postgres)
--
-- Ported from store-sqlite's migration of the same number and name;
-- identical column, identical semantics. See that file for the full
-- rationale.
ALTER TABLE browser_specs ADD COLUMN isolation TEXT NOT NULL DEFAULT 'tab'
  CHECK (isolation IN ('tab', 'window'));
