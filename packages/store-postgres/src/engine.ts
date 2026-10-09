/**
 * Postgres connection setup: the `pg.Pool` configuration this package
 * needs so a `pg` row looks, to every mapper in this package, exactly like
 * a `better-sqlite3` row already does in `store-sqlite` (`rows.ts`'s top
 * comment explains why that matters). `openPostgresPool` is the one place
 * that installs the type overrides; every caller that needs a second pool
 * or client against the same database (a second connection for a
 * concurrency test, the sync transaction bridge's worker) must go through
 * it too, never construct a bare `new Pool()`/`new Client()`, the same
 * rule `store-sqlite`'s `openSqlite` states for `foreign_keys = ON`.
 */
import { readFileSync } from 'node:fs';
import { Pool, types as pgTypes } from 'pg';
import type { PoolConfig } from 'pg';

/** Postgres OIDs this package's rows depend on reading back in a representation different from `pg`'s own default. */
const OID_TIMESTAMPTZ = 1184;
const OID_TIMESTAMP = 1114;
const OID_JSON = 114;
const OID_JSONB = 3802;
/** `int8`/`bigint`. `pg` returns this as a `string` by default (a JS `number` cannot losslessly hold the full 64-bit range), but every DDL column in this schema that is `BIGINT` (`size_bytes`, `fence`, `bytes_sent`, usage/quota counters, ...) is a SQLite `INTEGER` counterpart there and every mapper in this package (ported line for line from `store-sqlite`'s) expects a plain `number`, the same way `better-sqlite3` already hands one back. Values in this schema (byte counts, fence counters, quota limits) stay comfortably inside `Number.MAX_SAFE_INTEGER` in practice. */
const OID_INT8 = 20;

/** TLS options accepted by {@link PostgresPoolOptions.tls}. `sslmode`-shaped, not a raw `tls.ConnectionOptions`, so `--store-tls-*` CLI flags map onto it one for one. */
export interface PostgresTlsOptions {
  /** Enables TLS at all. `false` (the default) never sets `ssl` on the pool config, matching a bare `postgres://` connection string's own default. */
  enabled: boolean;
  /** Verifies the server certificate against the trusted CA list (system roots, or `caPath` below). Default `true`; set `false` only for a self-signed development database, never in production. */
  rejectUnauthorized?: boolean;
  /** PEM CA certificate path, for a server whose certificate is not signed by a system-trusted CA. */
  caPath?: string;
  /** PEM client certificate path, for mutual TLS. Requires `keyPath`. */
  certPath?: string;
  /** PEM client private key path, for mutual TLS. Requires `certPath`. */
  keyPath?: string;
}

/** Pool sizing, all optional; `pg`'s own defaults apply to anything omitted. */
export interface PostgresPoolSizeOptions {
  /** Minimum idle clients `pg.Pool` keeps warm. `pg` has no native `min`; this package enforces it by pre-warming that many connections at `openPostgresPool` time. */
  min?: number;
  /** Maximum clients the pool ever opens concurrently. `pg`'s own default is 10. */
  max?: number;
  /** Milliseconds an idle client sits in the pool before being closed. `pg`'s own default is 10000. */
  idleTimeoutMs?: number;
  /** Milliseconds to wait for a connection to be established before failing. `pg`'s own default is 0 (no timeout). */
  connectionTimeoutMs?: number;
}

/** Options accepted by {@link openPostgresPool}. */
export interface PostgresPoolOptions {
  /** A `postgres://user:pass@host:port/db` connection string. Required unless the caller instead constructs a `Pool` directly for dependency injection (tests). */
  connectionString: string;
  pool?: PostgresPoolSizeOptions;
  tls?: PostgresTlsOptions;
  /** Identifies this pool's connections in `pg_stat_activity.application_name`. Defaults to `'browserglass'`. */
  applicationName?: string;
}

/** A `TypeOverrides`-shaped object (`pg`'s `PoolConfig.types`), scoped to one pool rather than mutating `pg.types` globally, so a host process embedding this package alongside its own unrelated `pg` usage is never affected. */
export function buildTypeOverrides(): NonNullable<PoolConfig['types']> {
  return {
    getTypeParser(oid: number, format?: 'text' | 'binary') {
      if (oid === OID_TIMESTAMPTZ || oid === OID_TIMESTAMP) {
        // `pg`'s own parser returns a `Date`; every row shape and mapper in
        // this package expects the same ISO 8601 UTC string `store-sqlite`'s
        // `TEXT` timestamp columns already hand back (see `time.ts`'s top
        // comment), so this normalises at the one boundary that can see the
        // wire value, rather than converting back out of a `Date` (and its
        // implied local-timezone footguns) at every call site.
        return (value: string) => new Date(value).toISOString();
      }
      if (oid === OID_JSON || oid === OID_JSONB) {
        // `pg`'s own parser calls `JSON.parse` for us; this package's
        // `parseJsonColumn`/`toJsonColumn` (`json.ts`) do that themselves,
        // matching `store-sqlite`'s `TEXT` JSON columns, so every mapper is
        // a line for line port rather than two divergent implementations.
        return (value: string) => value;
      }
      if (oid === OID_INT8) {
        return (value: string) => Number(value);
      }
      // biome-ignore lint/suspicious/noExplicitAny: pg-types overloads getTypeParser on the format literal, and this override receives it as a plain string.
      return pgTypes.getTypeParser(oid as never, format as any);
    },
  };
}

function buildSsl(tls: PostgresTlsOptions | undefined): PoolConfig['ssl'] {
  if (!tls || !tls.enabled) return undefined;
  return {
    rejectUnauthorized: tls.rejectUnauthorized ?? true,
    ca: tls.caPath ? readFileSync(tls.caPath, 'utf8') : undefined,
    cert: tls.certPath ? readFileSync(tls.certPath, 'utf8') : undefined,
    key: tls.keyPath ? readFileSync(tls.keyPath, 'utf8') : undefined,
  };
}

/**
 * Opens a `pg.Pool` with this package's required type overrides, the
 * caller's pool sizing, and TLS options. Never throws synchronously on a
 * bad connection string or an unreachable server; `pg.Pool` connects
 * lazily, per checkout, so the first real failure surfaces from the first
 * query (`store.ts`'s `init()`/`ping()` are where a caller should look for
 * "can this store actually reach Postgres").
 */
export function openPostgresPool(opts: PostgresPoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: opts.connectionString,
    types: buildTypeOverrides(),
    application_name: opts.applicationName ?? 'browserglass',
    max: opts.pool?.max ?? 10,
    idleTimeoutMillis: opts.pool?.idleTimeoutMs ?? 10_000,
    connectionTimeoutMillis: opts.pool?.connectionTimeoutMs ?? 10_000,
    ssl: buildSsl(opts.tls),
  };
  const pool = new Pool(config);
  const min = opts.pool?.min ?? 0;
  if (min > 0) {
    // Best-effort pre-warm: `pg.Pool` has no native `min`, so this checks
    // out and immediately releases `min` clients, which is enough to make
    // `pg.Pool` actually open and idle that many connections up front
    // rather than lazily on the first `min` concurrent callers. Fire and
    // forget: a pre-warm failure (the server briefly unreachable at
    // startup) must not make `openPostgresPool` itself throw, since the
    // pool will simply connect lazily on first real use instead, exactly
    // as it would have with no pre-warm at all.
    void (async () => {
      const clients = await Promise.all(
        Array.from({ length: min }, () => pool.connect().catch(() => null)),
      );
      for (const client of clients) client?.release();
    })();
  }
  return pool;
}
