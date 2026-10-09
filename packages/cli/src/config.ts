/**
 * `@browserglass/cli/config`: the `bgls.config.ts` shape. Every
 * field mirrors a `bgls serve` flag or its `BGLS_*` environment variable;
 * see `context.ts`/`commands/config-cmd.ts` for the precedence engine that
 * resolves a `BglsConfig` against defaults, the environment, and CLI flags.
 */

/** `store.pool.*`. Postgres store only; ignored for `sqlite:` urls. */
export interface BglsStorePoolConfig {
  /** Connections pre-warmed at startup. Default 0. */
  readonly min?: number;
  /** Maximum pool connections. Default 10. */
  readonly max?: number;
  /** Idle connection lifetime, in milliseconds. Default 10000. */
  readonly idleTimeoutMs?: number;
  /** Connection attempt timeout, in milliseconds. Default 10000. */
  readonly connectionTimeoutMs?: number;
}

/** `store.tls.*`. Postgres store only; ignored for `sqlite:` urls. */
export interface BglsStoreTlsConfig {
  readonly enabled?: boolean;
  /** `false` skips server certificate verification. Self-signed development databases only, never production. Default `true`. */
  readonly rejectUnauthorized?: boolean;
  /** PEM CA certificate path, for a server certificate not signed by a system-trusted CA. */
  readonly caPath?: string;
  /** PEM client certificate path, for mutual TLS. Requires `keyPath`. */
  readonly certPath?: string;
  /** PEM client private key path, for mutual TLS. Requires `certPath`. */
  readonly keyPath?: string;
}

/** `store.*`. */
export interface BglsStoreConfig {
  /** `sqlite:./path` or `postgres://...`. */
  readonly url?: string;
  /** Postgres store only. Mirrors `bgls serve --store-pool-*`/`BGLS_STORE_POOL_*`. */
  readonly pool?: BglsStorePoolConfig;
  /** Postgres store only. Mirrors `bgls serve --store-tls-*`/`BGLS_STORE_TLS_*`. */
  readonly tls?: BglsStoreTlsConfig;
}

/** `runtime.*`. */
export interface BglsRuntimeConfig {
  readonly kind?: 'host' | 'docker' | 'remote';
  readonly channel?: string;
  readonly headless?: boolean;
  readonly args?: readonly string[];
}

/** `profiles.snapshot.*`. */
export interface BglsProfileSnapshotConfig {
  readonly excludeCache?: boolean;
  readonly keep?: number;
  readonly autoIntervalMs?: number;
}

/** `profiles.gc.*`. */
export interface BglsProfileGcConfig {
  readonly olderThanMs?: number;
  readonly maxBytes?: number;
}

/** `profiles.*`. */
export interface BglsProfilesConfig {
  readonly dir?: string;
  readonly snapshot?: BglsProfileSnapshotConfig;
  readonly gc?: BglsProfileGcConfig;
}

/** `node.*`: this node's own capacity ceilings. */
export interface BglsNodeConfig {
  readonly maxInstances?: number;
  readonly maxMemoryMb?: number;
  readonly maxTier1Streams?: number;
}

/** `streaming.*`. */
export interface BglsStreamingConfig {
  readonly defaultLevel?: string;
  readonly maxResolution?: readonly [number, number];
  readonly tiers?: number;
}

/** `session.*`. */
export interface BglsSessionConfig {
  readonly idleTimeoutMs?: number;
  readonly maxDurationMs?: number;
}

/** `auth.*`. */
export interface BglsAuthConfig {
  readonly mode?: 'dev' | 'jwks' | 'hmac' | 'custom';
  readonly jwksUrl?: string;
}

/** `observability.metrics.*`. */
export interface BglsMetricsConfig {
  readonly enabled?: boolean;
  readonly path?: string;
}

/** `observability.logs.*`. */
export interface BglsLogsConfig {
  readonly level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  readonly format?: 'pretty' | 'json';
}

/** `observability.*`. */
export interface BglsObservabilityConfig {
  readonly metrics?: BglsMetricsConfig;
  readonly logs?: BglsLogsConfig;
}

/**
 * The full `bgls.config.{ts,js,mjs,json,toml}` shape. Loaded with `c12`
 * (TypeScript, `.env` merging, `extends` chains). Every field is optional;
 * the full precedence order this participates in is (built-in defaults, this file,
 * `BGLS_*` environment variables, CLI flags, in that increasing order of
 * priority for `bgls serve`/`bgls doctor`/`bgls inspect`).
 */
export interface BglsConfig {
  readonly listen?: string;
  readonly store?: BglsStoreConfig;
  readonly runtime?: BglsRuntimeConfig;
  readonly profiles?: BglsProfilesConfig;
  readonly node?: BglsNodeConfig;
  readonly streaming?: BglsStreamingConfig;
  readonly session?: BglsSessionConfig;
  readonly auth?: BglsAuthConfig;
  readonly observability?: BglsObservabilityConfig;
  /** A named preset to inherit from, e.g. `"@acme/bgls-preset"`, resolved by `c12`. */
  readonly extends?: string | readonly string[];
}

/**
 * Identity helper for authoring `bgls.config.ts` with full type checking
 * and editor completion: `export default defineConfig({ ... })`. Performs
 * no validation itself; `bgls config show --annotate` and `bgls serve`
 * both validate the resolved, merged configuration.
 */
export function defineConfig(config: BglsConfig): BglsConfig {
  return config;
}
