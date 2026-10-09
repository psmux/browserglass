-- 0006_browser_spec_init_scripts.sql (Postgres)
--
-- Ported from store-sqlite's migration of the same number and name;
-- identical column (as JSONB here, matching this package's JSON
-- convention, rather than TEXT), identical semantics: nullable, no
-- default, NULL means "no init scripts recorded for this spec". See that
-- file for the full rationale.
ALTER TABLE browser_specs ADD COLUMN init_scripts JSONB;
