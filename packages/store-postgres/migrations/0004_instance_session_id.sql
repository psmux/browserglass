-- 0004_instance_session_id.sql (Postgres)
--
-- Ported from store-sqlite's migration of the same number and name;
-- identical column, identical FK behavior (ON DELETE SET NULL), identical
-- semantics. See that file for the full rationale.
ALTER TABLE instances ADD COLUMN session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL;
