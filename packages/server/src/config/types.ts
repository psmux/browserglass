import type {
  AppId,
  AuditSink,
  AuthResolver,
  BrowserRuntime,
  Capability,
  LeaseMode,
  MetricsSink,
  NavigationPolicy,
  PlacementPolicy,
  ProfileFs,
  StealthProfile,
  Store,
  TenantId,
} from '@browserglass/protocol';
import type { Hooks } from '../hooks/types.js';
import type { Logger } from './logger.js';

/**
 * A signing or verification keypair for one App, as consumed by
 * {@link BrowserGlassConfig.auth}. Public and, where present, private key
 * material is always the raw 32 byte Ed25519 key encoded base64url (no PEM,
 * no DER): this keeps the config surface a plain string with no ASN.1
 * parsing anywhere in the hot path. `HS256` keys carry the shared secret in
 * `publicKey` and never populate `privateKey`.
 */
export interface AppSigningKey {
  /** Key id, goes in the JWT header `kid` and is looked up at verification time. */
  readonly kid: string;
  /** App this key belongs to. Falls back to {@link BrowserGlassConfig.appId} when omitted. */
  readonly appId?: AppId;
  /** Algorithm this `kid` is permitted to use. The header's `alg` is checked against this, never used to select it. */
  readonly alg: 'EdDSA' | 'HS256';
  /** Base64url raw Ed25519 public key (32 bytes), or the HS256 shared secret, base64url encoded. */
  readonly publicKey: string;
  /** Base64url raw Ed25519 private key seed (32 bytes). Required to sign with this key; absent on a verify only key. */
  readonly privateKey?: string;
  /** Lifecycle state. `active` signs and verifies; `retiring` verifies only; `revoked` never verifies. */
  readonly status?: 'pending' | 'active' | 'retiring' | 'revoked';
}

/** A named boolean|number|string knob accepted from an environment variable, prior to type coercion. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Per pool creation entry applied idempotently at {@link BrowserGlass.start}.
 * Mirrors the fields `router.pools` accepts.
 */
export interface PoolDefinition {
  readonly name: string;
  readonly specId?: string;
  readonly minWarm?: number;
  readonly maxInstances?: number;
}

/** Identity and topology, `config.*`. */
export interface TopologyConfig {
  readonly mode?: 'embedded' | 'supervised' | 'gateway';
  readonly basePath?: string;
  readonly instanceName?: string;
  readonly tenantId?: TenantId;
  readonly appId?: AppId;
  readonly publicUrl?: string | null;
  readonly trustProxy?: boolean | number | readonly string[];
}

/** Storage, `store.*` and `profiles.*`. */
export interface StoreConfig {
  readonly store?: Store;
  readonly migrate?: 'auto' | 'check' | 'off';
  readonly busyTimeoutMs?: number;
  readonly poolMax?: number;
  readonly statementTimeoutMs?: number;
}

/**
 * Profile filesystem knobs, `profiles.*`. `fs` is an already constructed
 * `ProfileFs` (from `@browserglass/runtime-host`, typically), the same
 * pattern as `store` and `runtime`: `@browserglass/server` has no
 * dependency edge on `@browserglass/runtime-host` and so cannot build a
 * default implementation itself. Required in `embedded`/`supervised` mode
 * because `@browserglass/router`'s `ProfileService` cannot be constructed
 * without one.
 */
export interface ProfilesConfig {
  readonly dir?: string;
  readonly fs?: ProfileFs;
  readonly minFreeBytes?: number;
  readonly maxBytesPerProfile?: number;
  readonly gcIntervalMs?: number;
  readonly encryptAtRest?: boolean;
  readonly encryptionKey?: string | Buffer | null;
}

/**
 * Runtime selection, `runtime.*`. This field is always an already constructed {@link BrowserRuntime} (or several), the
 * same pattern as `store`: `@browserglass/server` has no dependency edge
 * on `@browserglass/runtime-host`, so Chrome
 * binary discovery, flag composition, and launch timeouts are entirely
 * that runtime's own concern.
 */
export interface RuntimeConfig {
  readonly runtime?: BrowserRuntime | readonly BrowserRuntime[];
  /**
   * The same `StealthProfile` objects this process handed its
   * `HostRuntimeConfig.stealthProfiles`, injected here for the one job the
   * launching runtime cannot do on its own: applying a profile's
   * `initScripts(spec)` and `onTargetAttached` to a live CDP session.
   *
   * Why this exists at all. `StealthProfile` carries live FUNCTIONS, and
   * only metadata crosses from the runtime to the gateway
   * (`Instance.runtime.stealthProfile` is `{name, level, version}` and
   * nothing else, `@browserglass/protocol`'s `runtime.ts`). Before this
   * field, `session/factory.ts` therefore built its `TargetRegistry` with
   * no stealth hooks at all, so a registered profile's `launchArgs` ran
   * and its `initScripts`/`onTargetAttached` silently did not. Nobody was
   * told; the launch reported the profile as having run.
   *
   * The match is on name AND version, both exact, and a mismatch is a
   * refusal rather than a downgrade: two processes that disagree about
   * what a profile name means is exactly the case where quietly running
   * the wrong patches is worse than running none. See
   * `resolveStealthHooks` in `session/factory.ts`.
   *
   * Same injection pattern, and same reason, as `runtime` above: server
   * has no dependency edge on `@browserglass/runtime-host` and so cannot
   * construct a profile itself. Leaving this unset is correct for every
   * deployment whose specs use `stealth: 'off'`, which is the only level
   * enabled by default.
   */
  readonly stealthProfiles?: readonly StealthProfile[];
}

/**
 * Node identity and the peer link to other gateway processes, `peer.*`.
 * See `docs/scaling.md` for what a two gateway deployment needs these
 * for; every field here is about a gateway reaching (or being reached by)
 * ANOTHER gateway process, distinct from `router.endpoint`/`router.token`
 * (this process acting as a `mode: 'gateway'` client of a remote control
 * plane, a different axis entirely).
 */
export interface PeerConfig {
  /**
   * This process's own durable node id. Unset (the default): a fresh id
   * is minted every start, fine for a single node deployment, but a node
   * that restarts then registers as a brand new node, orphaning
   * `Instance.nodeId` rows that pointed at its old id. A deployment that
   * wants a restarting node to keep its identity, and keep the instances
   * it already owns reachable through `resolveNode()`, must set this to
   * the same value across restarts (persisted by the operator, outside
   * this process: nothing here writes it back anywhere).
   */
  readonly nodeId?: string;
  /**
   * The `ws://`/`wss://` URL a peer gateway's `WebSocketNodeTransport`
   * should dial to reach THIS node's peer listener
   * (`ws/peer-upgrade.ts`'s claimed path, `peer.path` below). There is no
   * way for a process to learn its own externally reachable address (a
   * NAT, a load balancer, a container network all sit between "the port
   * this process bound" and "what a peer can actually dial"), so this is
   * never inferred, only accepted verbatim from the operator. Unset (the
   * default): this node still runs a peer LISTENER whenever `sharedSecret`
   * is set, it simply never tells other gateways an address to reach it
   * at, so nothing can place an instance expecting to dial back to it.
   */
  readonly dataPlaneUrl?: string;
  /** The upgrade path this node's peer listener claims, alongside (never multiplexed onto) the `bgls.v1` viewer socket path. Default `${basePath}/node`. */
  readonly path?: string;
  /**
   * The shared secret every gateway in the deployment must be configured
   * with identically. Required for this node to run a peer listener at
   * all, or to dial another node's peer listener as a `WebSocketNodeTransport`
   * client: unset (the default) means this node neither accepts nor
   * originates peer connections, and `resolveNode()` still works (it only
   * ever reads the store), it simply never gets used by anything cross
   * node. See `@browserglass/router`'s `nodeAuth.ts` for exactly what this
   * secret protects and what it does not (in short: it stops an arbitrary
   * network client from impersonating a second router node; it does not
   * add transport encryption, per node identity, or secretless rotation).
   */
  readonly sharedSecret?: string;
}

/** Router pass-through knobs, `router.*`. */
export interface RouterSectionConfig {
  readonly defaultPool?: string;
  readonly pools?: readonly PoolDefinition[];
  readonly placement?: PlacementPolicy;
  readonly idempotencyWindowMs?: number;
  readonly launchTimeoutMs?: number;
  readonly reaperIntervalMs?: number;
  readonly reconcileIntervalMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly nodeStaleMs?: number;
  readonly warmSafetyFactor?: number;
  readonly endpoint?: string | null;
  readonly token?: string | null;
}

/** Pre-router admission ceilings, `limits.*`. */
export interface LimitsConfig {
  readonly maxInstances?: number;
  readonly maxInstancesPerSubject?: number;
  readonly maxViewersPerSession?: number;
  readonly maxStreamsPerSession?: number;
  readonly maxStreams?: number;
  readonly maxTargetsPerInstance?: number;
  readonly acquireRatePerMinute?: number;
  readonly restRatePerMinute?: number;
  readonly uploadMaxBytes?: number;
  readonly downloadMaxBytes?: number;
  /** How long a `download.ready.url` stays fetchable before `bgls.error.download.expired`. Default 60000 (60s). Referenced by name in `@browserglass/protocol`'s own error catalog doc, `packages/protocol/src/wire/errors.ts`, well before anything resolved it. */
  readonly downloadUrlTtlMs?: number;
  readonly clipboardMaxBytes?: number;
  readonly maxRequestBodyBytes?: number;
  readonly inputRatePerSec?: number;
  /**
   * Screenshots (`target.capture`), PDFs (`page.pdf.get`) and
   * `recording.start` allowed per second, per connection per target.
   * Default 5. Env `BGLS_CAPTURE_RATE_PER_SEC`.
   */
  readonly captureRatePerSec?: number;
  /**
   * How many of those may arrive back to back before the steady rate
   * applies. Default 10, or twice `captureRatePerSec` when only the rate is
   * set. Env `BGLS_CAPTURE_BURST`.
   */
  readonly captureBurst?: number;
}

/**
 * File upload staging, `uploads.*`.
 *
 * Where a caller's bytes land on the machine that runs Chrome, and how
 * long they are kept. The per-file ceiling is NOT here: it is
 * `limits.uploadMaxBytes`, which already existed, is already advertised to
 * clients as `welcome.limits.maxUploadBytes`, and would be two places to
 * look if duplicated.
 */
export interface UploadsConfig {
  /**
   * The directory the gateway stages uploads in. Owned outright: it is
   * created on demand and REMOVED on `stop()`, so it must not be shared
   * with anything else. Defaults to a per-process directory under the
   * system temp dir.
   */
  readonly dir?: string;
  /** How long an incomplete upload may sit before it is swept. Default 5 minutes. */
  readonly stagingTtlMs?: number;
  /**
   * How long a completed upload is kept once staged. Default 30 minutes,
   * and deliberately long: Chrome reads an attached file lazily, when the
   * page finally submits the form, so a short window here produces uploads
   * that report success and then submit nothing. See
   * `files/upload-store.ts`.
   */
  readonly retentionMs?: number;
  /** Ceiling on simultaneously staged uploads, so a swarm cannot open unbounded numbers of them. Default 256. */
  readonly maxConcurrent?: number;
  /** Ceiling on total staged bytes, so a swarm cannot fill the disk with individually legal files. Default 2 GiB. */
  readonly maxTotalBytes?: number;
}

/**
 * Download staging, `downloads.*`: where a completed download lands on the
 * machine running Chrome before `download-store.ts` hashes it and mints a
 * one-shot URL for it. The per-file ceiling and URL lifetime are NOT here,
 * for the same reason `UploadsConfig`'s own doc gives: they are
 * `limits.downloadMaxBytes` (already existed) and `limits.downloadUrlTtlMs`
 * (this feature's own addition, alongside it), not duplicated under a
 * second name here.
 */
export interface DownloadsConfig {
  /**
   * The directory `Session.startDownloadCapture` arms `Page.setDownloadBehavior`
   * with and `DownloadStore` owns outright: created on demand, never shared
   * with anything else. Defaults to a per-process directory under the
   * system temp dir, mirroring `UploadsConfig.dir`'s own default exactly
   * (`uploads.dir`'s doc explains why the default is scoped to
   * `process.pid`).
   */
  readonly dir?: string;
}

/**
 * Recording storage, `recordings.*`: where a `recording.start` session's
 * frames and sidecar index land on the machine driving Chrome
 * (`../recording/disk-recording-sink.ts`). One subdirectory per
 * `recordingId`, owned outright by that sink, same shape as
 * `DownloadsConfig` immediately above.
 */
export interface RecordingsConfig {
  /**
   * Root directory `DiskRecordingSink` creates `<recordingId>/` under.
   * Defaults to a per-process directory under the system temp dir,
   * mirroring `DownloadsConfig.dir`'s own default (per-process, not
   * shared: a recording is a durable, sensitive artifact, and two
   * gateways sharing one machine and one default root must not share it).
   */
  readonly dir?: string;
}

/** Session lifetime ceilings, folded from `limits.session*`. */
export interface SessionLimitsConfig {
  readonly idleTimeoutMs?: number;
  readonly maxDurationMs?: number;
  readonly idleGraceMs?: number;
  readonly noViewerTimeoutMs?: number;
  readonly warmIdleMs?: number;
}

/** Authentication and token issuance, `auth.*`. */
export interface AuthConfig {
  readonly resolver?: AuthResolver;
  readonly keys?: readonly AppSigningKey[];
  readonly issuer?: AppId;
  readonly defaultTtlSeconds?: number;
  readonly maxTtlSeconds?: number;
  readonly clockSkewSeconds?: number;
  readonly allowQueryToken?: boolean;
  readonly jtiCacheSize?: number;
  readonly requireSubprotocolToken?: boolean;
  readonly maxCaps?: readonly Capability[];
  /** Default 30000, clamped [5000, 300000]. */
  readonly ticketTtlMs?: number;
}

/** Origin, navigation, and ticket security policy, `security.*`. */
export interface SecurityConfig {
  readonly navigationPolicy?: NavigationPolicy;
  readonly urlAllow?: readonly string[];
  readonly urlDeny?: readonly string[];
  readonly blockPrivateRanges?: boolean;
  readonly allowedOrigins?: readonly string[] | '*';
  readonly corsCredentials?: boolean;
  readonly devtoolsEnabled?: boolean;
  readonly uploadAllowedMimeTypes?: readonly string[] | null;
  /** Deprecated alias for `auth.ticketTtlMs`, logged once. */
  readonly ticketTtlMs?: number;
  /**
   * Enables the raw CDP WebSocket attach proxy: `GET/Upgrade {basePath}/cdp/:instanceId`
   * (`ws/cdp-upgrade.ts`) plus its `GET /json/version` and `GET /json/list`
   * discovery routes. OFF by default; must be turned on deliberately.
   *
   * What turning this on actually means, stated plainly because it is a
   * real relaxation of this gateway's own safety posture. A caller
   * authenticated with the `cdp` capability gets Chrome's REAL DevTools
   * Protocol over the proxied socket, not the allowlisted, one-command-per-
   * request passthrough `POST .../targets/:targetId/cdp` enforces
   * (`rest/cdp-passthrough-allowlist.ts`). That passthrough hard-refuses
   * `Target.*`, `Runtime.*`, `Browser.*`, `Debugger.*`, `Fetch.*`, `IO.*`
   * and more (see that file's own `REFUSED_DOMAINS` doc for what each one
   * closes); this proxy cannot refuse them and still be useful, because
   * every real CDP driver library (Playwright, Puppeteer, chromedp, ...)
   * opens a session with `Target.attachToTarget` and drives the page with
   * `Runtime.evaluate`. There is no per-method filtering on this path:
   * once attached, a caller has full browser control, arbitrary script
   * execution in the page's own origin, and the ability to read the exact
   * things the allowlist exists to keep out of reach.
   *
   * Only enable this for a deployment that already trusts every holder of
   * the `cdp` capability with that much, the same trust an operator
   * already extends to a bare Chrome started with
   * `--remote-debugging-port` open on a network they control. Issue `cdp`
   * to as few tokens as the workload allows, and pair this with
   * `auth.allowQueryToken: true`: a WebSocket handshake carries no
   * `Authorization` header for a client that cannot set one (most CDP
   * client libraries), so the proxy authenticates via `?token=` on the
   * upgrade request, the same carrier `auth.allowQueryToken` already
   * gates for the viewer socket.
   *
   * Env: `BGLS_CDP_PROXY_ENABLED`.
   */
  readonly cdpProxyEnabled?: boolean;
}

/** Session and control defaults, `session.*`. */
export interface SessionConfig {
  readonly pingIntervalMs?: number;
  readonly pongTimeoutMs?: number;
  readonly resumeWindowMs?: number;
  readonly control?: {
    /**
     * How many people may drive one Target at once, `'exclusive'` (one
     * holder, everybody else queues) or `'shared'` (N concurrent holders,
     * no queue and no waiting). Default `'exclusive'`, and that default is
     * a compatibility promise, not an accident: `'shared'` removes
     * exclusivity, some automation treats exclusivity as a safety
     * property, and nobody should lose it by upgrading.
     *
     * Chosen server side and per deployment rather than per
     * `control.request`, for the reason `ControlLeaseEngineOptions.mode`
     * (`@browserglass/core`) sets out: arbitration has to be single valued
     * for a contended resource, since "Alice holds exclusively, Bob asks
     * for shared" has no honest answer. What a viewer chooses for
     * themselves is whether to ask for control at all, which they already
     * express by sending `control.request` or not.
     *
     * Env: `BGLS_CONTROL_MODE`. An unrecognised value is a hard config
     * error, from either source; see `resolve.ts`'s handling.
     */
    readonly mode?: LeaseMode;
    readonly leaseMs?: number;
    readonly graceMs?: number;
    readonly queueMax?: number;
    readonly allowForceClaim?: boolean;
  };
  readonly input?: { readonly maxEventsPerSecond?: number };
}

/** Structured logging, `logs.*` (named `logs.*`, not `logger.*`). */
export interface LoggerConfig {
  readonly sink?: Logger | null;
  readonly level?: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  readonly format?: 'pretty' | 'json';
  readonly redact?: readonly string[];
}

/** Observability sinks, `metrics.*` and `audit.*`. */
export interface ObservabilityConfig {
  readonly metricsSink?: MetricsSink;
  readonly metricsPrefix?: string;
  readonly auditSink?: AuditSink;
  readonly auditInputBatchWindowMs?: number;
  readonly healthPath?: string | null;
  readonly readyPath?: string | null;
}

/** Startup self checks, `preflight.*`. */
export interface PreflightConfig {
  readonly enabled?: boolean;
  readonly mode?: 'fail' | 'warn';
  readonly skip?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * `hooks.*`: the nine lifecycle hook functions themselves (`Hooks`, from
 * `../hooks/types.js`) plus one config knob, `timeoutMs`, a global
 * override for every hook's own default timeout.
 */
export interface HooksConfigSection extends Hooks {
  readonly timeoutMs?: number;
}

/**
 * The full input shape accepted by {@link createBrowserGlass}. Every field is
 * optional; unset fields fall back to an environment variable, then a
 * documented default. The shape has eight namespaces (`leases.*` is folded into `control.*` here, under
 * `session.control`).
 */
export interface BrowserGlassConfig extends TopologyConfig, StoreConfig, RuntimeConfig {
  readonly profiles?: ProfilesConfig;
  readonly peer?: PeerConfig;
  readonly router?: RouterSectionConfig;
  readonly limits?: LimitsConfig;
  readonly uploads?: UploadsConfig;
  readonly downloads?: DownloadsConfig;
  readonly recordings?: RecordingsConfig;
  readonly session?: SessionConfig & { readonly limits?: SessionLimitsConfig };
  readonly auth?: AuthConfig;
  readonly security?: SecurityConfig;
  readonly logger?: LoggerConfig;
  readonly observability?: ObservabilityConfig;
  readonly preflight?: PreflightConfig;
  readonly hooks?: HooksConfigSection;
  /** Test-only escape hatch: an explicit env snapshot instead of `process.env`, so tests never mutate global state. */
  readonly env?: EnvSource;
}

/**
 * `config`, `store`, `profiles`, `router`, `limits`, `session`, `auth`,
 * `security`, `logger`, `observability`, `preflight` after precedence
 * resolution (explicit config over env var over default) and validation.
 * Deeply frozen: nothing under `start()` may mutate it.
 */
export interface ResolvedConfig {
  readonly mode: 'embedded' | 'supervised' | 'gateway';
  readonly basePath: string;
  readonly wsPath: string;
  /** The path prefix the raw CDP attach proxy claims, `${basePath}/cdp`; the full upgrade path for one instance is `${cdpProxyPath}/${instanceId}` (`ws/cdp-upgrade.ts`). Claimed unconditionally, mirroring `wsPath`/`peer.path`, regardless of whether `security.cdpProxyEnabled` is on: `handleUpgrade` checks the flag itself, so a disabled gateway still refuses a matching upgrade explicitly (404) rather than falling through to some other handler that happens to claim the same path. */
  readonly cdpProxyPath: string;
  readonly instanceName: string;
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly publicUrl: string | null;
  readonly trustProxy: boolean | number | readonly string[];

  readonly store: Store | undefined;
  readonly migrate: 'auto' | 'check' | 'off';
  readonly busyTimeoutMs: number;

  readonly profiles: Required<Omit<ProfilesConfig, 'encryptionKey' | 'fs'>> & {
    readonly fs: ProfileFs | undefined;
    readonly encryptionKey: string | Buffer | null;
  };

  readonly runtimes: readonly BrowserRuntime[];
  /** See {@link RuntimeConfig.stealthProfiles}. Empty when none were injected. */
  readonly stealthProfiles: readonly StealthProfile[];

  readonly peer: {
    readonly nodeId: string | null;
    readonly dataPlaneUrl: string | null;
    readonly path: string;
    readonly sharedSecret: string | null;
  };

  readonly router: Required<Omit<RouterSectionConfig, 'placement' | 'pools'>> & {
    readonly placement: PlacementPolicy | undefined;
    readonly pools: readonly PoolDefinition[];
  };

  readonly limits: Required<LimitsConfig>;
  readonly uploads: Required<UploadsConfig>;
  readonly downloads: Required<DownloadsConfig>;
  readonly recordings: Required<RecordingsConfig>;
  readonly sessionLimits: Required<SessionLimitsConfig>;

  readonly auth: {
    readonly resolver: AuthResolver | undefined;
    readonly keys: readonly AppSigningKey[];
    readonly issuer: AppId;
    readonly defaultTtlSeconds: number;
    readonly maxTtlSeconds: number;
    readonly clockSkewSeconds: number;
    readonly allowQueryToken: boolean;
    readonly jtiCacheSize: number;
    readonly requireSubprotocolToken: boolean;
    readonly maxCaps: readonly Capability[];
    readonly ticketTtlMs: number;
  };

  readonly security: Required<Omit<SecurityConfig, 'navigationPolicy' | 'ticketTtlMs'>> & {
    readonly navigationPolicy: NavigationPolicy | undefined;
  };

  readonly session: {
    readonly pingIntervalMs: number;
    readonly pongTimeoutMs: number;
    readonly resumeWindowMs: number;
    readonly control: Required<NonNullable<SessionConfig['control']>>;
    readonly input: Required<NonNullable<SessionConfig['input']>>;
  };

  readonly logger: {
    readonly sink: Logger | null;
    readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
    readonly format: 'pretty' | 'json';
    readonly redact: readonly string[];
  };

  readonly observability: {
    readonly metricsSink: MetricsSink | undefined;
    readonly metricsPrefix: string;
    readonly auditSink: AuditSink | undefined;
    readonly auditInputBatchWindowMs: number;
    readonly healthPath: string | null;
    readonly readyPath: string | null;
  };

  readonly preflight: Required<PreflightConfig>;
  readonly hooks: Hooks & { readonly timeoutMs: number };

  /** The raw env snapshot resolution consulted, captured once at construction. Never re-read. */
  readonly resolvedFromEnv: EnvSource;

  /**
   * Non-fatal config observations, distinct from `ConfigError.problems`:
   * these do not stop `createBrowserGlass` from returning, but a caller
   * (or `start()`) should still surface them. For example
   * `W_DEVTOOLS_CAP_INERT`.
   */
  readonly configWarnings: readonly { readonly code: string; readonly message: string }[];
}

/** One collected config problem. Every field is populated: what failed, the observed value, and the fix. */
export interface ConfigProblem {
  readonly path: string;
  readonly got: unknown;
  readonly expected: string;
  readonly fix: string;
  readonly env?: string;
}

/**
 * Thrown by {@link createBrowserGlass} when one or more config fields are
 * invalid. Carries every problem found, not just the first: a config with
 * five simultaneous mistakes reports all five in one `ConfigError`.
 */
export class ConfigError extends Error {
  readonly code = 'E_CONFIG_INVALID' as const;
  readonly problems: readonly ConfigProblem[];

  constructor(problems: readonly ConfigProblem[]) {
    super(
      `BrowserGlass config is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'}): ${problems
        .map(
          (p) => `${p.path}: got ${JSON.stringify(p.got)}, expected ${p.expected}. Fix: ${p.fix}`,
        )
        .join(' | ')}`,
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}
