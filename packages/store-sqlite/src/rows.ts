/**
 * Row shapes exactly as `better-sqlite3` returns them: one property per DDL
 * column, `snake_case`, `TEXT` as `string`, nullable columns as
 * `T | null`, `INTEGER` booleans as `0 | 1`. Kept separate from
 * `mappers.ts` so the two concerns (what SQLite hands back, and how it
 * becomes a `@browserglass/protocol` entity) are easy to read side by side.
 */

export interface TenantRow {
  id: string;
  name: string;
  status: 'active' | 'suspended' | 'deleting' | 'deleted';
  allowed_caps: string;
  node_pin: string | null;
  policy: string;
  audit_chain: 0 | 1;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface AppRow {
  id: string;
  tenant_id: string;
  name: string;
  max_caps: string;
  default_pool_id: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

export interface AppKeyRow {
  id: string;
  app_id: string;
  tenant_id: string;
  alg: 'EdDSA' | 'HS256';
  public_key: string | null;
  secret_enc: string | null;
  status: 'pending' | 'active' | 'retiring' | 'revoked';
  not_before: string;
  not_after: string | null;
  activated_at: string | null;
  retired_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface BrowserSpecRow {
  id: string;
  tenant_id: string;
  digest: string;
  engine: string;
  channel: string;
  headless: string;
  /** `'tab'` or `'window'`. `NOT NULL DEFAULT 'tab'` since migration 0002. */
  isolation: string;
  viewport_w: number;
  viewport_h: number;
  dpr: number;
  locale: string | null;
  timezone: string | null;
  user_agent: string | null;
  /** JSON `ClientHintsSpec | null`. Added by migration 0005; NULL for every row written before it, and for any row where the caller never set `clientHints`. */
  client_hints: string | null;
  /** JSON `{ name: string; source: string }[] | null`. Added by migration 0006; NULL for every row written before it, and for any row where the caller never set `initScripts`. */
  init_scripts: string | null;
  /** Plain string, not JSON: unlike `client_hints`/`init_scripts` this field has no nested structure. Added by migration 0007; NULL for every row written before it, and for any row where the caller never set `remoteEndpointName`. */
  remote_endpoint_name: string | null;
  proxy: string | null;
  args: string;
  extensions: string;
  stealth: string;
  limits: string;
  created_at: string;
}

export interface PoolRow {
  id: string;
  tenant_id: string;
  name: string;
  spec_id: string;
  min_warm: number;
  max_instances: number;
  placement: string;
  idle_timeout_ms: number;
  max_duration_ms: number;
  status: 'active' | 'draining' | 'deleted';
  created_at: string;
  updated_at: string;
}

export interface ProfileRow {
  id: string;
  tenant_id: string;
  app_id: string;
  key: string;
  mode: 'persistent' | 'ephemeral' | 'template';
  template_id: string | null;
  storage_path: string;
  home_node_id: string | null;
  size_bytes: number;
  size_measured_at: string | null;
  encryption_key_id: string | null;
  state: string;
  ttl_ms: number | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileLeaseRow {
  id: string;
  profile_id: string;
  tenant_id: string;
  instance_id: string | null;
  node_id: string;
  holder_pid: number | null;
  fence: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  released_at: string | null;
  release_reason: string | null;
}

export interface ProfileSnapshotRow {
  id: string;
  profile_id: string;
  tenant_id: string;
  label: string | null;
  storage_path: string;
  size_bytes: number;
  content_hash: string;
  encryption_key_id: string | null;
  created_by: string | null;
  status: 'creating' | 'ready' | 'deleting' | 'corrupt';
  created_at: string;
}

export interface NodeRow {
  id: string;
  name: string;
  region: string | null;
  zone: string | null;
  runtime: 'host' | 'docker' | 'k8s' | 'remote';
  address: string;
  data_address: string | null;
  registration_secret_enc: string;
  labels: string;
  tenant_pin: string | null;
  capacity: string;
  version: string | null;
  status: 'joining' | 'ready' | 'draining' | 'cordoned' | 'lost' | 'retired';
  status_since: string;
  created_at: string;
  updated_at: string;
}

export interface NodeHeartbeatRow {
  node_id: string;
  beat_at: string;
  seq: number;
  live_instances: number;
  mem_free_mib: number | null;
  cpu_load_pct: number | null;
  disk_free_mib: number | null;
  detail: string;
}

export interface InstanceRow {
  id: string;
  tenant_id: string;
  app_id: string;
  pool_id: string | null;
  spec_id: string;
  profile_id: string | null;
  node_id: string;
  epoch: number;
  cdp_endpoint: string | null;
  os_pid: number | null;
  container_id: string | null;
  status: 'launching' | 'warm' | 'live' | 'recovering' | 'draining' | 'released' | 'failed';
  status_since: string;
  status_detail: string | null;
  created_by_sub: string | null;
  created_by_jti: string | null;
  launched_at: string | null;
  first_viewer_at: string | null;
  last_active_at: string | null;
  released_at: string | null;
  release_reason: string | null;
  restart_count: number;
  peak_rss_mib: number | null;
  /** `0003_instance_expires_at.sql`. NULL until the instance's `'live'` transition sets it; `rowToInstance` falls back to `acquiredAt + 14_400_000` when NULL. */
  expires_at: string | null;
  /** `0004_instance_session_id.sql`. NULL until the instance's `'live'` transition sets it, and NULL forever on any row written before that migration. */
  session_id: string | null;
  /** `0008_instance_metadata_lifetime.sql`. JSON object, `TEXT NOT NULL DEFAULT '{}'`; use `parseJsonColumn`, not `JSON.parse` directly, to fail loudly on a corrupt value rather than propagate a bare `SyntaxError`. */
  metadata: string;
  /** `0008_instance_metadata_lifetime.sql`. `TEXT NOT NULL DEFAULT 'viewer-bound'`, CHECK constrained to the same two values `Instance.lifetime` allows. */
  lifetime: 'viewer-bound' | 'explicit';
  created_at: string;
  updated_at: string;
}

export interface SessionRowDb {
  id: string;
  tenant_id: string;
  instance_id: string;
  gateway_id: string | null;
  status: 'live' | 'recovering' | 'ended';
  peak_viewers: number;
  total_viewers: number;
  started_at: string;
  ended_at: string | null;
  end_reason: string | null;
  end_close_code: number | null;
}

export interface ViewerRow {
  id: string;
  tenant_id: string;
  session_id: string;
  instance_id: string;
  sub: string;
  sub_kind: string | null;
  display_name: string | null;
  caps: string;
  invite_id: string | null;
  token_jti: string | null;
  transport: 'gateway' | 'direct';
  node_id: string | null;
  remote_ip: string | null;
  user_agent: string | null;
  resume_token_hash: string | null;
  resumed_from: string | null;
  connected_at: string;
  disconnected_at: string | null;
  close_code: number | null;
  close_reason: string | null;
  bytes_sent: number;
  frames_sent: number;
  frames_dropped: number;
}

export interface ControlLeaseRowDb {
  id: string;
  tenant_id: string;
  session_id: string;
  target_id: string;
  viewer_id: string;
  sub: string;
  granted_at: string;
  released_at: string | null;
  release_reason: string | null;
  displaced: string | null;
  input_events: number;
}

export interface QuotaRow {
  tenant_id: string;
  scope: string;
  metric: string;
  limit_value: number;
  window: 'concurrent' | 'hour' | 'day' | 'month';
  soft_pct: number;
  action: 'reject' | 'queue' | 'throttle';
  updated_at: string;
}

export interface UsageCounterRow {
  tenant_id: string;
  bucket: string;
  granularity: 'hour' | 'day';
  metric: string;
  dim: string;
  value: number;
  updated_at: string;
}

export interface AuditEventRow {
  id: string;
  tenant_id: string;
  app_id: string | null;
  occurred_at: string;
  event_type: string;
  severity: string;
  actor_sub: string | null;
  actor_kind: string | null;
  actor_name: string | null;
  on_behalf_of: string | null;
  invite_id: string | null;
  instance_id: string | null;
  session_id: string | null;
  viewer_id: string | null;
  target_id: string | null;
  profile_id: string | null;
  node_id: string | null;
  remote_ip: string | null;
  user_agent: string | null;
  trace_id: string | null;
  token_jti: string | null;
  outcome: string;
  detail: string | null;
  prev_hash: string | null;
  hash: string | null;
}

export interface DownloadRow {
  id: string;
  tenant_id: string;
  instance_id: string;
  session_id: string | null;
  target_id: string | null;
  node_id: string;
  filename: string;
  suggested_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  content_hash: string | null;
  storage_path: string;
  source_url_host: string | null;
  status: 'in_progress' | 'complete' | 'failed' | 'fetched' | 'expired' | 'deleted';
  fetched_by: string | null;
  fetched_at: string | null;
  fetch_count: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface UploadRow {
  id: string;
  tenant_id: string;
  instance_id: string | null;
  viewer_id: string | null;
  node_id: string | null;
  filename: string;
  mime_type: string | null;
  declared_bytes: number;
  received_bytes: number;
  content_hash: string | null;
  storage_path: string;
  status: 'staging' | 'received' | 'committed' | 'aborted' | 'expired' | 'deleted';
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface InviteRow {
  id: string;
  tenant_id: string;
  app_id: string;
  instance_id: string;
  secret_hash: string;
  created_by: string;
  label: string | null;
  caps: string;
  scope: string;
  max_redemptions: number;
  redemptions: number;
  detach_from_creator: 0 | 1;
  status: 'active' | 'exhausted' | 'revoked' | 'expired' | 'dead';
  expires_at: string;
  created_at: string;
  updated_at: string;
}

export interface PlacementQueueRow {
  id: string;
  tenant_id: string;
  app_id: string;
  pool_id: string;
  spec_id: string;
  profile_key: string | null;
  priority: number;
  requested_by: string | null;
  status: 'queued' | 'claimed' | 'placed' | 'failed' | 'abandoned';
  claimed_by: string | null;
  claimed_at: string | null;
  instance_id: string | null;
  attempts: number;
  last_error: string | null;
  enqueued_at: string;
  deadline_at: string;
}
