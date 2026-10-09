-- 0001_initial.sql (Postgres)
--
-- The full 24 table BrowserGlass control plane schema, ported from
-- `store-sqlite`'s `migrations/0001_initial.sql`. Column names, table
-- names, constraints, and indexes are IDENTICAL to that file: a reader of
-- both should see the same model. Two
-- physical, not logical, differences, both Postgres-native types replacing
-- a SQLite compromise:
--
--   * every `TEXT` timestamp column is `TIMESTAMPTZ` here. `store-postgres`'s
--     `engine.ts` installs a type parser that hands a `TIMESTAMPTZ` value
--     back as the same ISO 8601 UTC string `store-sqlite`'s `TEXT` column
--     already returns, so every mapper (`mappers.ts`) reads identically
--     regardless of which adapter wrote the row.
--   * every `-- JSON` `TEXT` column is `JSONB` here, so a column actually
--     queried by its contents (`nodes.labels`, `audit_events.detail`) can
--     carry a GIN index (`0007_gin_indexes.sql`) and Postgres's own jsonb
--     operators, not just opaque text. `engine.ts` installs a type parser
--     that hands a `jsonb` value back as raw, unparsed text, matching
--     `store-sqlite`'s `TEXT` JSON columns, so `json.ts`'s
--     `parseJsonColumn`/`toJsonColumn` round-trip it exactly the same way.
--
-- Table CREATE order matches `store-sqlite`'s own file for the same
-- reason stated there: every REFERENCES target must exist before the
-- table that names it. `migrations` is created last; the runner inserts
-- this migration's own row after running the statements above it.

-- ─────────────────────────────────────────────────────────────────────────
-- tenants
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','suspended','deleting','deleted')),
  allowed_caps    JSONB NOT NULL DEFAULT '[]',
  node_pin        JSONB,
  policy          JSONB NOT NULL DEFAULT '{}',
  audit_chain     INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  deleted_at      TIMESTAMPTZ
);
CREATE INDEX idx_tenants_status ON tenants(status) WHERE status <> 'deleted';

-- ─────────────────────────────────────────────────────────────────────────
-- nodes
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE nodes (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  region          TEXT,
  zone            TEXT,
  runtime         TEXT NOT NULL
                    CHECK (runtime IN ('host','docker','k8s','remote')),
  address         TEXT NOT NULL,
  data_address    TEXT,
  registration_secret_enc TEXT NOT NULL,
  labels          JSONB NOT NULL DEFAULT '{}',
  tenant_pin      JSONB,
  capacity        JSONB NOT NULL DEFAULT '{}',
  version         TEXT,
  status          TEXT NOT NULL DEFAULT 'joining'
                    CHECK (status IN ('joining','ready','draining','cordoned','lost','retired')),
  status_since    TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_nodes_status ON nodes(status, region);

-- ─────────────────────────────────────────────────────────────────────────
-- apps
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE apps (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  max_caps        JSONB NOT NULL DEFAULT '[]',
  default_pool_id TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','disabled')),
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_apps_tenant ON apps(tenant_id);

-- ─────────────────────────────────────────────────────────────────────────
-- app_keys
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE app_keys (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  alg             TEXT NOT NULL CHECK (alg IN ('EdDSA','HS256')),
  public_key      TEXT,
  secret_enc      TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','active','retiring','revoked')),
  not_before      TIMESTAMPTZ NOT NULL,
  not_after       TIMESTAMPTZ,
  activated_at    TIMESTAMPTZ,
  retired_at      TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_app_keys_app     ON app_keys(app_id, status);
CREATE INDEX idx_app_keys_lookup  ON app_keys(id, status);

-- A row must never have both public_key and secret_enc non-null: enforced
-- in the application layer (createAppKey), not via CHECK, matching
-- store-sqlite's own note on this table.

-- ─────────────────────────────────────────────────────────────────────────
-- browser_specs
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE browser_specs (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  digest          TEXT NOT NULL,
  engine          TEXT NOT NULL DEFAULT 'chromium',
  channel         TEXT NOT NULL DEFAULT 'chrome'
                    CHECK (channel IN ('chrome','chrome-beta','chromium',
                                       'chromium-headless-shell','msedge',
                                       'brave','bundled')),
  headless        TEXT NOT NULL DEFAULT 'new'
                    CHECK (headless IN ('off','new','xvfb-headful')),
  viewport_w      INTEGER NOT NULL DEFAULT 1920,
  viewport_h      INTEGER NOT NULL DEFAULT 1080,
  dpr             REAL    NOT NULL DEFAULT 1.0,
  locale          TEXT,
  timezone        TEXT,
  user_agent      TEXT,
  proxy           JSONB,
  args            JSONB NOT NULL DEFAULT '[]',
  extensions      JSONB NOT NULL DEFAULT '[]',
  stealth         TEXT NOT NULL DEFAULT 'off'
                    CHECK (stealth IN ('off','basic','full')),
  limits          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, digest)
);

-- ─────────────────────────────────────────────────────────────────────────
-- pools
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE pools (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  spec_id         TEXT NOT NULL REFERENCES browser_specs(id),
  min_warm        INTEGER NOT NULL DEFAULT 0,
  max_instances   INTEGER NOT NULL DEFAULT 10,
  placement       JSONB NOT NULL DEFAULT '{}',
  idle_timeout_ms INTEGER NOT NULL DEFAULT 900000,
  max_duration_ms INTEGER NOT NULL DEFAULT 14400000,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','draining','deleted')),
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX idx_pools_tenant ON pools(tenant_id, status);

-- ─────────────────────────────────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE profiles (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  mode            TEXT NOT NULL
                    CHECK (mode IN ('persistent','ephemeral','template')),
  template_id     TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  storage_path    TEXT NOT NULL,
  home_node_id    TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  size_measured_at TIMESTAMPTZ,
  encryption_key_id TEXT,
  state           TEXT NOT NULL DEFAULT 'creating'
                    CHECK (state IN ('creating','free','leased','snapshotting',
                                     'migrating','quarantined','deleting','deleted')),
  ttl_ms          BIGINT,
  expires_at      TIMESTAMPTZ,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL,
  UNIQUE (tenant_id, app_id, key)
);
CREATE INDEX idx_profiles_tenant_state  ON profiles(tenant_id, state);
CREATE INDEX idx_profiles_tenant_app    ON profiles(tenant_id, app_id);
CREATE INDEX idx_profiles_expiry        ON profiles(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX idx_profiles_lru           ON profiles(tenant_id, last_used_at);
CREATE INDEX idx_profiles_node          ON profiles(home_node_id) WHERE home_node_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- profile_leases
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE profile_leases (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id     TEXT,
  node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  holder_pid      INTEGER,
  fence           BIGINT NOT NULL,
  acquired_at     TIMESTAMPTZ NOT NULL,
  heartbeat_at    TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT
);
CREATE UNIQUE INDEX idx_profile_lease_live
  ON profile_leases(profile_id) WHERE released_at IS NULL;
CREATE INDEX idx_profile_lease_expiry ON profile_leases(expires_at) WHERE released_at IS NULL;
CREATE INDEX idx_profile_lease_node   ON profile_leases(node_id) WHERE released_at IS NULL;

-- The partial unique index idx_profile_lease_live IS the mutual exclusion
-- mechanism, identical in intent to store-sqlite's: at most one unreleased
-- lease per profile, enforced by the database. On Postgres this also
-- arbitrates real, engine level concurrency: two separate connections'
-- INSERTs racing this index are resolved by Postgres's own MVCC/unique
-- index machinery, not by any application level lock.

-- ─────────────────────────────────────────────────────────────────────────
-- profile_snapshots
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE profile_snapshots (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label           TEXT,
  storage_path    TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  content_hash    TEXT NOT NULL,
  encryption_key_id TEXT,
  created_by      TEXT,
  status          TEXT NOT NULL DEFAULT 'creating'
                    CHECK (status IN ('creating','ready','deleting','corrupt')),
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_snapshots_profile ON profile_snapshots(profile_id, created_at DESC);
CREATE INDEX idx_snapshots_tenant  ON profile_snapshots(tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- node_heartbeats
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE node_heartbeats (
  node_id         TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  beat_at         TIMESTAMPTZ NOT NULL,
  seq             BIGINT NOT NULL,
  live_instances  INTEGER NOT NULL DEFAULT 0,
  mem_free_mib    INTEGER,
  cpu_load_pct    REAL,
  disk_free_mib   INTEGER,
  detail          JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_heartbeat_stale ON node_heartbeats(beat_at);

-- ─────────────────────────────────────────────────────────────────────────
-- instances
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE instances (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  pool_id         TEXT REFERENCES pools(id) ON DELETE SET NULL,
  spec_id         TEXT NOT NULL REFERENCES browser_specs(id),
  profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  node_id         TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,

  epoch           INTEGER NOT NULL DEFAULT 1,
  cdp_endpoint    TEXT,
  os_pid          INTEGER,
  container_id    TEXT,

  status          TEXT NOT NULL DEFAULT 'launching'
                    CHECK (status IN ('launching','warm','live','recovering','draining','released','failed')),
  status_since    TIMESTAMPTZ NOT NULL,
  status_detail   TEXT,

  created_by_sub  TEXT,
  created_by_jti  TEXT,
  launched_at     TIMESTAMPTZ,
  first_viewer_at TIMESTAMPTZ,
  last_active_at  TIMESTAMPTZ,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT,

  restart_count   INTEGER NOT NULL DEFAULT 0,
  peak_rss_mib    INTEGER,

  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_instances_tenant_status ON instances(tenant_id, status);
CREATE INDEX idx_instances_node_live     ON instances(node_id, status)
  WHERE status IN ('launching','warm','live','recovering','draining');
CREATE INDEX idx_instances_pool_warm     ON instances(pool_id, status)
  WHERE status = 'warm';
CREATE INDEX idx_instances_profile       ON instances(profile_id) WHERE profile_id IS NOT NULL;
CREATE INDEX idx_instances_released      ON instances(released_at) WHERE released_at IS NOT NULL;
CREATE INDEX idx_instances_sticky        ON instances(tenant_id, app_id, created_by_sub, id DESC)
  WHERE created_by_sub IS NOT NULL;

-- Critical FK behavior facts, identical to store-sqlite's 0001_initial.sql:
-- instances.app_id is NOT NULL with ON DELETE RESTRICT (never SET NULL,
-- never CASCADE, for the reasons stated there); instances.pool_id stays ON
-- DELETE SET NULL; the partial index on status = 'warm' is what
-- claimWarmInstance's SELECT ... FOR UPDATE SKIP LOCKED hits.

-- ─────────────────────────────────────────────────────────────────────────
-- sessions
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  gateway_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'live'
                    CHECK (status IN ('live','recovering','ended')),
  peak_viewers    INTEGER NOT NULL DEFAULT 0,
  total_viewers   INTEGER NOT NULL DEFAULT 0,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  end_reason      TEXT,
  end_close_code  INTEGER
);
CREATE INDEX idx_sessions_instance ON sessions(instance_id, started_at DESC);
CREATE INDEX idx_sessions_tenant   ON sessions(tenant_id, started_at DESC);
CREATE INDEX idx_sessions_live     ON sessions(gateway_id, status) WHERE status <> 'ended';

-- ─────────────────────────────────────────────────────────────────────────
-- viewers
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE viewers (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,

  sub             TEXT NOT NULL,
  sub_kind        TEXT,
  display_name    TEXT,
  caps            JSONB NOT NULL,
  invite_id       TEXT,
  token_jti       TEXT,

  transport       TEXT NOT NULL DEFAULT 'gateway'
                    CHECK (transport IN ('gateway','direct')),
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  remote_ip       TEXT,
  user_agent      TEXT,

  resume_token_hash TEXT,
  resumed_from    TEXT,

  connected_at    TIMESTAMPTZ NOT NULL,
  disconnected_at TIMESTAMPTZ,
  close_code      INTEGER,
  close_reason    TEXT,

  bytes_sent      BIGINT NOT NULL DEFAULT 0,
  frames_sent     BIGINT NOT NULL DEFAULT 0,
  frames_dropped  BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_viewers_session   ON viewers(session_id, connected_at DESC);
CREATE INDEX idx_viewers_tenant_t  ON viewers(tenant_id, connected_at DESC);
CREATE INDEX idx_viewers_sub       ON viewers(tenant_id, sub, connected_at DESC);
CREATE INDEX idx_viewers_live      ON viewers(session_id) WHERE disconnected_at IS NULL;

-- ─────────────────────────────────────────────────────────────────────────
-- control_leases
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE control_leases (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  target_id       TEXT NOT NULL,
  viewer_id       TEXT NOT NULL REFERENCES viewers(id) ON DELETE CASCADE,
  sub             TEXT NOT NULL,
  granted_at      TIMESTAMPTZ NOT NULL,
  released_at     TIMESTAMPTZ,
  release_reason  TEXT,
  displaced       TEXT,
  input_events    BIGINT NOT NULL DEFAULT 0
);
CREATE INDEX idx_leases_session ON control_leases(session_id, granted_at DESC);
CREATE INDEX idx_leases_tenant  ON control_leases(tenant_id, granted_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- quotas
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE quotas (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope           TEXT NOT NULL,
  metric          TEXT NOT NULL,
  limit_value     BIGINT NOT NULL,
  "window"        TEXT NOT NULL DEFAULT 'concurrent'
                    CHECK ("window" IN ('concurrent','hour','day','month')),
  soft_pct        INTEGER NOT NULL DEFAULT 80,
  action          TEXT NOT NULL DEFAULT 'reject'
                    CHECK (action IN ('reject','queue','throttle')),
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, scope, metric, "window")
);

-- ─────────────────────────────────────────────────────────────────────────
-- usage_counters
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE usage_counters (
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bucket          TEXT NOT NULL,
  granularity     TEXT NOT NULL CHECK (granularity IN ('hour','day')),
  metric          TEXT NOT NULL,
  dim             TEXT NOT NULL DEFAULT '',
  value           BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, bucket, granularity, metric, dim)
);
CREATE INDEX idx_usage_bucket ON usage_counters(bucket, granularity);

-- usage_counters is accessed by a PRIMARY KEY upsert, never read-then-write,
-- same as store-sqlite; on Postgres the upsert is
-- INSERT ... ON CONFLICT DO UPDATE SET value = usage_counters.value + EXCLUDED.value,
-- a genuine atomic increment (store.ts's incrementUsage), where
-- store-sqlite needed only its own single writer lock to make the
-- equivalent read-modify-write safe.

-- ─────────────────────────────────────────────────────────────────────────
-- audit_events
-- No foreign keys, deliberately, matching store-sqlite: an audit row must
-- survive deletion of the instance/session/viewer it describes.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE audit_events (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  app_id          TEXT,
  occurred_at     TIMESTAMPTZ NOT NULL,
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
  detail          JSONB,
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
  size_bytes      BIGINT,
  content_hash    TEXT,
  storage_path    TEXT NOT NULL,
  source_url_host TEXT,
  status          TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','complete','failed','fetched','expired','deleted')),
  fetched_by      TEXT,
  fetched_at      TIMESTAMPTZ,
  fetch_count     INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_downloads_instance ON downloads(instance_id, created_at DESC);
CREATE INDEX idx_downloads_expiry   ON downloads(expires_at) WHERE status <> 'deleted';
CREATE INDEX idx_downloads_tenant   ON downloads(tenant_id, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- uploads
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE uploads (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  instance_id     TEXT REFERENCES instances(id) ON DELETE SET NULL,
  viewer_id       TEXT,
  node_id         TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  filename        TEXT NOT NULL,
  mime_type       TEXT,
  declared_bytes  BIGINT NOT NULL,
  received_bytes  BIGINT NOT NULL DEFAULT 0,
  content_hash    TEXT,
  storage_path    TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'staging'
                    CHECK (status IN ('staging','received','committed','aborted','expired','deleted')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_uploads_instance ON uploads(instance_id, created_at DESC);
CREATE INDEX idx_uploads_expiry   ON uploads(expires_at) WHERE status <> 'deleted';
CREATE INDEX idx_uploads_stale    ON uploads(status, updated_at) WHERE status = 'staging';

-- ─────────────────────────────────────────────────────────────────────────
-- attach_tickets
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE attach_tickets (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  node_id         TEXT NOT NULL,
  instance_id     TEXT NOT NULL,
  viewer_id       TEXT NOT NULL,
  epoch           INTEGER NOT NULL,
  issued_at       TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  redeemed_at     TIMESTAMPTZ
);
CREATE INDEX idx_tickets_expiry ON attach_tickets(expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- revocations
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE revocations (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('sub','jti','kid','invite','viewer')),
  value           TEXT NOT NULL,
  reason          TEXT,
  issued_by       TEXT,
  effective_at    TIMESTAMPTZ NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX idx_revocations_lookup ON revocations(tenant_id, kind, value);
CREATE INDEX idx_revocations_expiry ON revocations(expires_at);

-- ─────────────────────────────────────────────────────────────────────────
-- invites
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE invites (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  instance_id     TEXT NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  secret_hash     TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  label           TEXT,
  caps            JSONB NOT NULL,
  scope           JSONB NOT NULL,
  max_redemptions INTEGER NOT NULL DEFAULT 1,
  redemptions     INTEGER NOT NULL DEFAULT 0,
  detach_from_creator INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','exhausted','revoked','expired','dead')),
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_invites_instance ON invites(instance_id, status);
CREATE INDEX idx_invites_expiry   ON invites(expires_at) WHERE status = 'active';

-- ─────────────────────────────────────────────────────────────────────────
-- placement_queue
-- On Postgres this table is the REAL multi-node placement queue (unlike
-- store-sqlite, where it exists but goes unused, since SQLite's
-- deployment model is single-node/single-writer): claimPlacements uses
-- SELECT ... FOR UPDATE SKIP LOCKED against idx_queue_ready below, so N
-- router processes can each claim a disjoint batch of rows concurrently,
-- with no shared lock and no busy-wait.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE placement_queue (
  id              TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  app_id          TEXT NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  pool_id         TEXT NOT NULL REFERENCES pools(id) ON DELETE CASCADE,
  spec_id         TEXT NOT NULL REFERENCES browser_specs(id),
  profile_key     TEXT,
  priority        INTEGER NOT NULL DEFAULT 100,
  requested_by    TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                    CHECK (status IN ('queued','claimed','placed','failed','abandoned')),
  claimed_by      TEXT,
  claimed_at      TIMESTAMPTZ,
  instance_id     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  enqueued_at     TIMESTAMPTZ NOT NULL,
  deadline_at     TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_queue_ready ON placement_queue(status, priority, enqueued_at)
  WHERE status = 'queued';
CREATE INDEX idx_queue_tenant ON placement_queue(tenant_id, status);
CREATE INDEX idx_queue_app    ON placement_queue(tenant_id, app_id, status);

-- profile_key design note, identical to store-sqlite's: the app is carried
-- TWICE deliberately, once as app_id (real FK) and once inside profile_key
-- as the full prefixed storedKey. The dequeue path MUST assert the app_id
-- column and the a: segment of profile_key agree.

-- ─────────────────────────────────────────────────────────────────────────
-- migrations
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE migrations (
  version         INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  checksum        TEXT NOT NULL,
  applied_at      TIMESTAMPTZ NOT NULL,
  applied_by      TEXT,
  duration_ms     INTEGER NOT NULL
);
