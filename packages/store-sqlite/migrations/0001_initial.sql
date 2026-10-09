-- 0001_initial.sql
--
-- The full 24 table BrowserGlass control plane schema. This file is written
-- to run unchanged on SQLite 3.38+ and Postgres 14+, which is why it sticks
-- to a portable subset: TEXT for every id,
-- timestamp, and JSON blob; INTEGER 0/1 for booleans; no stored procedures,
-- no triggers, no SERIAL.
--
-- Table CREATE order matters: `browser_specs` comes before `pools`
-- (pools.spec_id references browser_specs) and `nodes` before `profiles`
-- (profiles.home_node_id references nodes), so every REFERENCES target
-- exists before the table that names it, which SQLite requires when
-- `PRAGMA foreign_keys = ON` is set for the connection that runs this
-- migration.
--
-- migrations table itself is created last; the runner inserts this
-- migration's own row after running the statements above it.

-- ─────────────────────────────────────────────────────────────────────────
-- tenants
-- Growth: one row per customer. Tens to low thousands. Effectively static.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deleting','deleted')),
  allowed_caps    TEXT NOT NULL DEFAULT '[]',     -- JSON array, the tenant-wide cap ceiling
  node_pin        TEXT,                            -- JSON array of node ids, NULL = shared
  policy          TEXT NOT NULL DEFAULT '{}',      -- JSON: url policy, retention, egress
  audit_chain     INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  deleted_at      TEXT
);
CREATE INDEX idx_tenants_status ON tenants(status) WHERE status <> 'deleted';

-- ─────────────────────────────────────────────────────────────────────────
-- nodes
-- Growth: one per machine. Tens to hundreds. Static-ish.
-- Created before apps/profiles/instances because profiles.home_node_id
-- references it (see the ordering note in the file header).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE nodes (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  region          TEXT,
  zone            TEXT,
  runtime         TEXT NOT NULL
                    CHECK (runtime IN ('host','docker','k8s','remote')),
  address         TEXT NOT NULL,                   -- control channel URL
  data_address    TEXT,                            -- direct-attach URL, NULL if not offered
  registration_secret_enc TEXT NOT NULL,           -- encrypted, used for attach ticket MACs
  labels          TEXT NOT NULL DEFAULT '{}',      -- JSON, used by placement selectors
  tenant_pin      TEXT,                            -- JSON array of tenant ids, NULL = shared
  capacity        TEXT NOT NULL DEFAULT '{}',      -- JSON: maxInstances, memMiB, cpus
  version         TEXT,
  status          TEXT NOT NULL DEFAULT 'joining'
                    CHECK (status IN ('joining','ready','draining','cordoned','lost','retired')),
  status_since    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_nodes_status ON nodes(status, region);

-- ─────────────────────────────────────────────────────────────────────────
-- apps
-- Growth: a handful per tenant. Static.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE apps (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  max_caps        TEXT NOT NULL DEFAULT '[]',      -- JSON array, ceiling for tokens this app signs
  default_pool_id TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_apps_tenant ON apps(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- app_keys
-- Growth: 2 to 4 live per app, plus revoked history. Trivial.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE app_keys (
  id              TEXT PRIMARY KEY,               -- key_...  == JWT kid
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alg             TEXT NOT NULL CHECK (alg IN ('EdDSA','HS256')),
  public_key      TEXT,                            -- SPKI base64, EdDSA only
  secret_enc      TEXT,                            -- encrypted shared secret, HS256 only
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','retiring','revoked')),
  not_before      TEXT NOT NULL,
  not_after       TEXT,
  activated_at    TEXT,
  retired_at      TEXT,
  revoked_at      TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_app_keys_app     ON app_keys(app_id, status);
CREATE INDEX idx_app_keys_lookup  ON app_keys(id, status);

-- Note: secret_enc holds an HS256 shared secret encrypted with the
-- deployment root key. EdDSA keys store only the public half. A row must
-- never have both public_key and secret_enc non-null: enforced in the
-- application layer (createAppKey), not via CHECK, because SQLite and
-- Postgres report cross-column CHECK violations differently.

-- ─────────────────────────────────────────────────────────────────────────
-- browser_specs
-- Growth: one per distinct launch configuration. Content-addressed by digest,
-- so identical specs collapse. Tens per tenant.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE browser_specs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  digest          TEXT NOT NULL,                   -- sha256 of the canonical JSON
  engine          TEXT NOT NULL DEFAULT 'chromium',
  channel         TEXT NOT NULL DEFAULT 'chrome'
                    CHECK (channel IN ('chrome','chrome-beta','chromium',
                                       'chromium-headless-shell','msedge',
                                       'brave','bundled')),
  headless        TEXT NOT NULL DEFAULT 'new'      -- three modes, not a boolean
                    CHECK (headless IN ('off','new','xvfb-headful')),
  viewport_w      INTEGER NOT NULL DEFAULT 1920,
  viewport_h      INTEGER NOT NULL DEFAULT 1080,
  dpr             REAL    NOT NULL DEFAULT 1.0,
  locale          TEXT,
  timezone        TEXT,
  user_agent      TEXT,
  proxy           TEXT,                            -- JSON, password field encrypted.
                                                   -- A spec referenced by a pool
                                                   -- must carry server and bypass
                                                   -- only, never credentials.
  args            TEXT NOT NULL DEFAULT '[]',      -- JSON array, validated allow-list
  extensions      TEXT NOT NULL DEFAULT '[]',      -- JSON array
  stealth         TEXT NOT NULL DEFAULT 'off'
                    CHECK (stealth IN ('off','basic','full')),
  limits          TEXT NOT NULL DEFAULT '{}',      -- JSON: memMiB, cpus, pids, diskMiB
  created_at      TEXT NOT NULL,
  UNIQUE (tenant_id, digest)
);

-- ─────────────────────────────────────────────────────────────────────────
-- pools
-- Growth: a few per tenant. Static.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE pools (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  spec_id         TEXT NOT NULL REFERENCES browser_specs(id),
  min_warm        INTEGER NOT NULL DEFAULT 0,
  max_instances   INTEGER NOT NULL DEFAULT 10,
  placement       TEXT NOT NULL DEFAULT '{}',      -- JSON: strategy, node selectors, affinity
  idle_timeout_ms INTEGER NOT NULL DEFAULT 900000,
  max_duration_ms INTEGER NOT NULL DEFAULT 14400000,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','draining','deleted')),
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_pools_tenant ON pools(tenant_id, status);
-- Pool name is UNIQUE PER TENANT, NOT per (tenant, app). Deliberate: a warm
-- pool's value comes from amortizing launch cost across consumers.

-- ─────────────────────────────────────────────────────────────────────────
-- profiles
-- Growth: one row per persistent profile. Hundreds to low thousands per
-- tenant. Rows are small; the bytes are on disk.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE profiles (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,                   -- canonical stored key, never null
  mode            TEXT NOT NULL
                    CHECK (mode IN ('persistent','ephemeral','template')),
  template_id     TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  storage_path    TEXT NOT NULL,                   -- relative to the profile root
  home_node_id    TEXT REFERENCES nodes(id) ON DELETE SET NULL,  -- NULL if on shared storage
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  size_measured_at TEXT,
  encryption_key_id TEXT,
  state           TEXT NOT NULL DEFAULT 'creating'
                    CHECK (state IN ('creating','free','leased','snapshotting',
                                     'migrating','quarantined','deleting','deleted')),
  ttl_ms          INTEGER,                         -- ephemeral and template instantiations
  expires_at      TEXT,
  last_used_at    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (tenant_id, app_id, key)
);
-- UNIQUE (tenant_id, app_id, key) creates the index that serves the acquire
-- path's lookup, in that column order. Do not add a second index over the
-- same three columns.
CREATE INDEX idx_profiles_tenant_state  ON profiles(tenant_id, state);
CREATE INDEX idx_profiles_tenant_app    ON profiles(tenant_id, app_id);
CREATE INDEX idx_profiles_expiry        ON profiles(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_profiles_lru           ON profiles(tenant_id, last_used_at);
CREATE INDEX idx_profiles_node          ON profiles(home_node_id) WHERE home_node_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- profile_leases
-- Growth: at most one live row per profile. Historical rows retained briefly
-- for debugging then deleted. Small.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE profile_leases (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id     TEXT,                            -- may be NULL during acquire
  node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  holder_pid      INTEGER,
  fence            INTEGER NOT NULL,               -- monotonic per profile, see below
  acquired_at     TEXT NOT NULL,
  heartbeat_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  released_at     TEXT,
  release_reason  TEXT
);
CREATE UNIQUE INDEX idx_profile_lease_live
  ON profile_leases(profile_id) WHERE released_at IS NULL;
CREATE INDEX idx_profile_lease_expiry ON profile_leases(expires_at) WHERE released_at IS NULL;
CREATE INDEX idx_profile_lease_node   ON profile_leases(node_id) WHERE released_at IS NULL;

-- The partial unique index idx_profile_lease_live IS the mutual exclusion
-- mechanism: at most one unreleased lease per profile, enforced by the
-- database, not an in-process lock.
--
-- fence is a monotonically increasing token per profile: every lease
-- acquisition takes max(fence) + 1. Fence counters must never go backwards,
-- even across a restore.

-- ─────────────────────────────────────────────────────────────────────────
-- profile_snapshots
-- Growth: bounded per profile by retention policy (default: keep 5).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE profile_snapshots (
  id              TEXT PRIMARY KEY,                -- snp_...
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label           TEXT,
  storage_path    TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,                   -- sha256 of the archive
  encryption_key_id TEXT,
  created_by      TEXT,                            -- sub of the actor
  status          TEXT NOT NULL DEFAULT 'creating'
                    CHECK (status IN ('creating','ready','deleting','corrupt')),
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_snapshots_profile ON profile_snapshots(profile_id, created_at DESC);
CREATE INDEX idx_snapshots_tenant  ON profile_snapshots(tenant_id, created_at DESC);

-- Snapshot status is its own four value set and is NOT ProfileState. A
-- snapshot is an inert archive, so it has no lease, no quarantine and no
-- migration.
--   'creating'  row inserted, archive being written. THE DEFAULT, not
--               'ready'. A crash mid-write must leave a row the sweeper
--               can find and finish, not a row that lies about safety.
--   'ready'     archive complete, content_hash verified, safe to restore.
--   'deleting'  marked for removal, bytes not yet gone.
--   'corrupt'   content_hash mismatch or unreadable archive. Never restored
--               from, never garbage collected without an operator saying so.

-- ─────────────────────────────────────────────────────────────────────────
-- node_heartbeats
-- Growth: HIGH WRITE RATE. One upsert per node per 5 seconds. Single row
-- per node, updated in place, so it does NOT grow. Deliberately a separate
-- table from nodes so the hot write never touches the configuration row.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE node_heartbeats (
  node_id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  beat_at         TEXT NOT NULL,
  seq             INTEGER NOT NULL,
  live_instances  INTEGER NOT NULL DEFAULT 0,
  mem_free_mib    INTEGER,
  cpu_load_pct    REAL,
  disk_free_mib   INTEGER,
  detail          TEXT NOT NULL DEFAULT '{}'       -- JSON
);
CREATE INDEX idx_heartbeat_stale ON node_heartbeats(beat_at);

-- ─────────────────────────────────────────────────────────────────────────
-- instances
-- Growth: one row per browser launched. Retained after termination for the
-- usage and audit window, then deleted. 500/day/deployment in the sizing
-- exercise below.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE instances (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  pool_id         TEXT REFERENCES pools(id) ON DELETE SET NULL,
  spec_id         TEXT NOT NULL REFERENCES browser_specs(id),
  profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,

  epoch           INTEGER NOT NULL DEFAULT 1,      -- bumped on every relaunch, fences tickets
  cdp_endpoint    TEXT,
  os_pid          INTEGER,
  container_id    TEXT,

  status          TEXT NOT NULL DEFAULT 'launching'
                    CHECK (status IN ('launching','warm','live','recovering','draining','released','failed')),
  status_since    TEXT NOT NULL,
  status_detail   TEXT,

  created_by_sub  TEXT,
  created_by_jti  TEXT,
  launched_at     TEXT,
  first_viewer_at TEXT,
  last_active_at  TEXT,
  released_at     TEXT,
  release_reason  TEXT,

  restart_count   INTEGER NOT NULL DEFAULT 0,
  peak_rss_mib    INTEGER,

  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_instances_tenant_status ON instances(tenant_id, status);
CREATE INDEX idx_instances_node_live     ON instances(node_id, status)
  WHERE status IN ('launching','warm','live','recovering','draining');
CREATE INDEX idx_instances_pool_warm     ON instances(pool_id, status)
  WHERE status = 'warm';
CREATE INDEX idx_instances_profile       ON instances(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX idx_instances_released      ON instances(released_at) WHERE released_at IS NOT NULL;
-- Sticky resolution: "the browser this user had last time".
CREATE INDEX idx_instances_sticky        ON instances(tenant_id, app_id, created_by_sub, id DESC)
  WHERE created_by_sub IS NOT NULL;

-- Critical FK behavior facts (do not change these without understanding
-- the reasoning below):
-- * instances.app_id is NOT NULL with ON DELETE RESTRICT (not SET NULL, not
--   CASCADE). SET NULL would collapse orphaned instance rows into one null
--   bucket, letting sticky resolution accidentally hand app B's user app
--   A's instance and profile. CASCADE would destroy audit history. RESTRICT
--   forces an explicit drain procedure before an app can be deleted.
-- * instances.pool_id stays ON DELETE SET NULL: a pool is a capacity
--   grouping, not an owner.
-- * The partial index on status = 'warm' is what claimWarmInstance hits.

-- ─────────────────────────────────────────────────────────────────────────
-- sessions
-- Growth: one row per session. A session is created when the first viewer
-- attaches and closed when the last leaves (plus a grace). Roughly 1 to 3
-- per instance.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  gateway_id      TEXT,                            -- which process owns it right now
  status          TEXT NOT NULL DEFAULT 'live'
                    CHECK (status IN ('live','recovering','ended')),
  peak_viewers    INTEGER NOT NULL DEFAULT 0,
  total_viewers   INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  end_reason      TEXT,
  end_close_code  INTEGER
);
CREATE INDEX idx_sessions_instance ON sessions(instance_id, started_at DESC);
CREATE INDEX idx_sessions_tenant   ON sessions(tenant_id, started_at DESC);
CREATE INDEX idx_sessions_live     ON sessions(gateway_id, status) WHERE status <> 'ended';

-- ─────────────────────────────────────────────────────────────────────────
-- viewers
-- Growth: HIGHEST of the durable tables. One row per socket connection,
-- including every reconnect. 5 viewers x 500 instances x reconnects.
-- Short retention.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE viewers (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,

  sub             TEXT NOT NULL,
  sub_kind        TEXT,
  display_name    TEXT,
  caps            TEXT NOT NULL,                   -- JSON array, the effective set
  invite_id       TEXT,
  token_jti       TEXT,

  transport       TEXT NOT NULL DEFAULT 'gateway'
                    CHECK (transport IN ('gateway','direct')),
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  remote_ip       TEXT,                            -- truncated
  user_agent      TEXT,

  resume_token_hash TEXT,
  resumed_from    TEXT,                            -- previous viewer id, on resume

  connected_at    TEXT NOT NULL,
  disconnected_at TEXT,
  close_code      INTEGER,
  close_reason    TEXT,

  bytes_sent      INTEGER NOT NULL DEFAULT 0,
  frames_sent     INTEGER NOT NULL DEFAULT 0,
  frames_dropped  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_viewers_session   ON viewers(session_id, connected_at DESC);
CREATE INDEX idx_viewers_tenant_t  ON viewers(tenant_id, connected_at DESC);
CREATE INDEX idx_viewers_sub       ON viewers(tenant_id, sub, connected_at DESC);
CREATE INDEX idx_viewers_live      ON viewers(session_id) WHERE disconnected_at IS NULL;

-- Write pattern for viewers: counters (bytes_sent, frames_sent,
-- frames_dropped) are written once, at disconnect, with the accumulated
-- total, never continuously. During the connection they live in memory.

-- ─────────────────────────────────────────────────────────────────────────
-- control_leases
-- Growth: this table records lease HISTORY for audit. The live lease is in
-- memory (see durability section above). One row per grant. Short
-- retention; the durable record of who had control lives in audit_events.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE control_leases (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL,
  viewer_id       TEXT NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  sub             TEXT NOT NULL,
  granted_at      TEXT NOT NULL,
  released_at     TEXT,
  release_reason  TEXT,                            -- voluntary|expired|revoked|forced|caps_lost|disconnect
  displaced       TEXT,                            -- viewer id taken from, on force claim
  input_events    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_leases_session ON control_leases(session_id, granted_at DESC);
CREATE INDEX idx_leases_tenant  ON control_leases(tenant_id, granted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- quotas
-- Growth: a handful of rows per tenant. Static.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE quotas (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,                   -- 'tenant' | 'pool:<id>' | 'app:<id>'
  metric          TEXT NOT NULL,                   -- see the usage section
  limit_value     INTEGER NOT NULL,
  window          TEXT NOT NULL DEFAULT 'concurrent'
                    CHECK (window IN ('concurrent','hour','day','month')),
  soft_pct        INTEGER NOT NULL DEFAULT 80,     -- warn threshold
  action          TEXT NOT NULL DEFAULT 'reject'
                    CHECK (action IN ('reject','queue','throttle')),
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, scope, metric, window)
);

-- ─────────────────────────────────────────────────────────────────────────
-- usage_counters
-- Growth: one row per (tenant, metric, hour bucket). With 12 metrics and
-- 100 tenants that is 1,200 rows per hour, 28,800 per day. Aggregated to
-- daily after 45 days.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE usage_counters (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket          TEXT NOT NULL,                   -- '2026-08-22T14' hour, or '2026-08-22' day
  granularity     TEXT NOT NULL CHECK (granularity IN ('hour','day')),
  metric          TEXT NOT NULL,
  dim             TEXT NOT NULL DEFAULT '',        -- optional sub-dimension: pool id, app id
  value           INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (tenant_id, bucket, granularity, metric, dim)
);
CREATE INDEX idx_usage_bucket ON usage_counters(bucket, granularity);

-- usage_counters is the second-highest write-rate table (~20/s at 100
-- tenants/12 metrics). Access pattern is pure increment on a known key: a
-- PRIMARY KEY upsert, never read-then-write.

-- ─────────────────────────────────────────────────────────────────────────
-- audit_events
-- Owned by the migration runner. Growth: the largest table by far.
-- No foreign keys, deliberately. An audit row must survive deletion of the
-- instance/session/viewer it describes; referential integrity here would
-- destroy the audit trail exactly when it matters.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  app_id          TEXT,
  occurred_at     TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  severity        TEXT NOT NULL DEFAULT 'info',
  actor_sub       TEXT,
  actor_kind      TEXT,
  actor_name      TEXT,
  on_behalf_of    TEXT,
  invite_id       TEXT,
  instance_id     TEXT,
  session_id      TEXT,
  viewer_id       TEXT,
  target_id       TEXT,
  profile_id      TEXT,
  node_id         TEXT,
  remote_ip       TEXT,
  user_agent      TEXT,
  trace_id        TEXT,
  token_jti       TEXT,
  outcome         TEXT NOT NULL DEFAULT 'ok',
  detail          TEXT,
  prev_hash       TEXT,
  hash            TEXT
);
CREATE INDEX idx_audit_tenant_time  ON audit_events(tenant_id, occurred_at DESC);
CREATE INDEX idx_audit_tenant_actor ON audit_events(tenant_id, actor_sub, occurred_at DESC);
CREATE INDEX idx_audit_tenant_inst  ON audit_events(tenant_id, instance_id, occurred_at DESC);
CREATE INDEX idx_audit_tenant_type  ON audit_events(tenant_id, event_type, occurred_at DESC);
CREATE INDEX idx_audit_invite       ON audit_events(invite_id, occurred_at DESC)
  WHERE invite_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- downloads
-- Growth: one row per file the browser downloads. Retained until the file
-- is deleted plus the audit window.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE downloads (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  session_id      TEXT,
  target_id       TEXT,
  node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  suggested_name  TEXT,
  mime_type       TEXT,
  size_bytes      INTEGER,
  content_hash    TEXT,
  storage_path    TEXT NOT NULL,
  source_url_host TEXT,                            -- host only, never the full URL
  status          TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','complete','failed','fetched','expired','deleted')),
  fetched_by      TEXT,
  fetched_at      TEXT,
  fetch_count     INTEGER NOT NULL DEFAULT 0,
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_downloads_instance ON downloads(instance_id, created_at DESC);
CREATE INDEX idx_downloads_expiry   ON downloads(expires_at) WHERE status <> 'deleted';
CREATE INDEX idx_downloads_tenant   ON downloads(tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- uploads
-- Growth: one row per file pushed into a browser. Same shape, opposite
-- direction. Orphan risk is higher (a client can start and vanish).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE uploads (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id     TEXT REFERENCES instances(id) ON DELETE SET NULL,
  viewer_id       TEXT,
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT,
  declared_bytes  INTEGER NOT NULL,
  received_bytes  INTEGER NOT NULL DEFAULT 0,
  content_hash    TEXT,
  storage_path    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'staging'
                    CHECK (status IN ('staging','received','committed','aborted','expired','deleted')),
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_uploads_instance ON uploads(instance_id, created_at DESC);
CREATE INDEX idx_uploads_expiry   ON uploads(expires_at) WHERE status <> 'deleted';
CREATE INDEX idx_uploads_stale    ON uploads(status, updated_at) WHERE status = 'staging';

-- ─────────────────────────────────────────────────────────────────────────
-- attach_tickets
-- Single-use enforcement for direct-attach tickets.
-- Growth: written once per attach, swept every 4 minutes. Steady state tiny.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE attach_tickets (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  instance_id     TEXT NOT NULL,
  viewer_id       TEXT NOT NULL,
  epoch           INTEGER NOT NULL,
  issued_at       TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  redeemed_at     TEXT
);
CREATE INDEX idx_tickets_expiry ON attach_tickets(expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- revocations
-- Durable revocation, consulted at handshake.
-- Growth: rare writes, swept at 15 minutes. Tiny.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE revocations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('sub','jti','kid','invite','viewer')),
  value           TEXT NOT NULL,
  reason          TEXT,
  issued_by       TEXT,
  effective_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_revocations_lookup ON revocations(tenant_id, kind, value);
CREATE INDEX idx_revocations_expiry ON revocations(expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- invites
-- Delegation records.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE invites (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  secret_hash     TEXT NOT NULL,                   -- sha256 of the 192-bit secret
  created_by      TEXT NOT NULL,
  label           TEXT,
  caps            TEXT NOT NULL,                   -- JSON array
  scope           TEXT NOT NULL,                   -- JSON
  max_redemptions INTEGER NOT NULL DEFAULT 1,
  redemptions     INTEGER NOT NULL DEFAULT 0,
  detach_from_creator INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','exhausted','revoked','expired','dead')),
  expires_at      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_invites_instance ON invites(instance_id, status);
CREATE INDEX idx_invites_expiry   ON invites(expires_at) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────
-- placement_queue
-- Postgres only in the multi-node deployment; on SQLite the queue is
-- in-process and this table is unused (single-node, no queue needed).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE placement_queue (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  pool_id         TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  spec_id         TEXT NOT NULL REFERENCES browser_specs(id),
  profile_key     TEXT,                            -- full storedKey, prefixed,
                                                   -- NULL when no profile is named
  priority        INTEGER NOT NULL DEFAULT 100,
  requested_by    TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','claimed','placed','failed','abandoned')),
  claimed_by      TEXT,                            -- router process id
  claimed_at      TEXT,
  instance_id     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  enqueued_at     TEXT NOT NULL,
  deadline_at     TEXT NOT NULL
);
CREATE INDEX idx_queue_ready ON placement_queue(status, priority, enqueued_at)
  WHERE status = 'queued';
CREATE INDEX idx_queue_tenant ON placement_queue(tenant_id, status);
CREATE INDEX idx_queue_app    ON placement_queue(tenant_id, app_id, status);

-- profile_key design note: the app is carried TWICE deliberately, once as
-- app_id (real FK, joinable/indexable/enforceable) and once inside
-- profile_key as the full prefixed storedKey. The dequeue path MUST assert
-- the app_id column and the a: segment of profile_key agree, and fail the
-- row to 'failed' with E_QUEUE_ROW_INCONSISTENT if not.

-- ─────────────────────────────────────────────────────────────────────────
-- migrations
-- Schema version tracking.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE migrations (
  version         INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  checksum        TEXT NOT NULL,                   -- sha256 of the migration SQL
  applied_at      TEXT NOT NULL,
  applied_by      TEXT,                            -- hostname:pid
  duration_ms     INTEGER NOT NULL
);
