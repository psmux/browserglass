-- 0002_browser_spec_isolation.sql
--
-- Adds `browser_specs.isolation`, the durable form of `BrowserSpec.isolation`
-- (`'tab' | 'window'`): whether each streamed target of an instance launched
-- from this spec gets its own real OS window, or stays a tab of one shared
-- window, the historical behaviour. (Chromium composites only a
-- window's visible tab, so 'tab' isolation caps live streaming at one target
-- per Instance).
--
-- `NOT NULL DEFAULT 'tab'` on the ADD COLUMN applies that default to every
-- row already on disk, so a spec written before this column existed keeps
-- meaning exactly what it always meant: 'tab' is not a guess, it is the only
-- behaviour that ever existed prior to this migration.
ALTER TABLE browser_specs ADD COLUMN isolation TEXT NOT NULL DEFAULT 'tab'
  CHECK (isolation IN ('tab', 'window'));
