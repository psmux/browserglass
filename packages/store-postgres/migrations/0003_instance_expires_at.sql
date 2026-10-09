-- 0003_instance_expires_at.sql (Postgres)
--
-- Ported from store-sqlite's migration of the same number and name;
-- identical column (as TIMESTAMPTZ here, matching this package's
-- timestamp convention, rather than TEXT), identical semantics: nullable,
-- no default, set only when transitionInstance's patch lands an instance
-- on 'live'. See that file for the full rationale.
ALTER TABLE instances ADD COLUMN expires_at TIMESTAMPTZ;
