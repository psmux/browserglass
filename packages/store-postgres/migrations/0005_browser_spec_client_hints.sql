-- 0005_browser_spec_client_hints.sql (Postgres)
--
-- Ported from store-sqlite's migration of the same number and name;
-- identical column (as JSONB here, matching this package's JSON
-- convention, rather than TEXT), identical semantics: nullable, no
-- default, NULL means "no client hints recorded for this spec". See that
-- file for the full rationale.
ALTER TABLE browser_specs ADD COLUMN client_hints JSONB;
