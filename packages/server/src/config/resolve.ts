import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CAPABILITIES,
  type Capability,
  type LeaseMode,
  isCapability,
  newId,
} from '@browserglass/protocol';
import { createStoreAuditSink } from '../observability/store-audit-sink.js';
import { compact } from '../util/compact.js';
import {
  parseEnvBool,
  parseEnvDuration,
  parseEnvNumber,
  parseEnvSize,
  parseEnvStringList,
  snapshotEnv,
} from './env.js';
import { consoleLogger } from './logger.js';
import {
  type AppSigningKey,
  type BrowserGlassConfig,
  ConfigError,
  type ConfigProblem,
  type EnvSource,
  type PoolDefinition,
  type ResolvedConfig,
} from './types.js';

/** All 18 capabilities, used as the `auth.maxCaps` and `tenant.allowed_caps` default. */
const ALL_CAPABILITIES: readonly Capability[] = CAPABILITIES;

/**
 * The legal values of `session.control.mode`. Declared here rather than in
 * `@browserglass/protocol` because `LeaseMode` is a wire TYPE and this is a
 * runtime list: nothing on the wire needs to enumerate the modes, and
 * `resolveConfig` is the only place that has to check a value it was
 * handed against them. If a second package ever needs the same list, that
 * is the moment to promote it, not before.
 */
const LEASE_MODES: readonly LeaseMode[] = Object.freeze(['exclusive', 'shared'] as LeaseMode[]);

/** The `expected` text used for both `session.control.mode` problems and `BGLS_CONTROL_MODE` problems, so a caller sees the same vocabulary whichever source they set. */
const LEASE_MODE_EXPECTED = "'exclusive' | 'shared'";

/** Whether `value` is one of {@link LEASE_MODES}. Deliberately takes `unknown`: the whole point is catching a value TypeScript did not constrain, so narrowing the parameter to `LeaseMode` would defeat it. */
function isLeaseMode(value: unknown): value is LeaseMode {
  return typeof value === 'string' && (LEASE_MODES as readonly string[]).includes(value);
}

class ProblemCollector {
  readonly problems: ConfigProblem[] = [];

  add(problem: ConfigProblem): void {
    this.problems.push(problem);
  }

  /**
   * Resolves one scalar field: explicit config wins, then the env var
   * (parsed by `parse`), then `fallback`.
   *
   * `validate` is optional and, when given, is the ONLY thing that checks
   * the EXPLICIT branch. Everything else here validates the env branch
   * only, because `parse` is what turns a raw string into a `T` and a
   * `parse` returning `undefined` is how an env var reports "not a valid
   * one of these". An explicitly passed value is trusted, on the reasoning
   * that TypeScript already constrained it at the call site.
   *
   * That reasoning holds right up until the caller is not TypeScript: a
   * JavaScript host, a JSON config file, or a `as never` cast written to
   * get around a key the types did not have yet. `session.control.mode`
   * was found exactly that way. The e2e harness passed
   * `session: { control: { mode: 'shared' } } as never`, `resolveConfig`
   * accepted it (nothing rejects an unknown key), the key existed nowhere,
   * and shared control ran exclusive with no error, no warning, and ten
   * failing e2e cases whose only symptom was
   * `{"granted":false,"queued":true,"position":1}`.
   *
   * So for any field with a closed set of legal values, pass `validate` as
   * well as `parse`. A value that fails it becomes a collected
   * {@link ConfigProblem}, and `resolveConfig` throws `ConfigError` rather
   * than returning a config that quietly means something else. See this
   * module's own note on unknown KEYS, which remain accepted.
   */
  resolve<T>(opts: {
    readonly path: string;
    readonly explicit: T | undefined;
    readonly envKey?: string;
    readonly env: EnvSource;
    readonly parse: (raw: string) => T | undefined;
    readonly fallback: T;
    readonly expected: string;
    readonly validate?: (value: T) => boolean;
  }): T {
    if (opts.explicit !== undefined) {
      if (opts.validate !== undefined && !opts.validate(opts.explicit)) {
        this.add(
          compact({
            path: opts.path,
            got: opts.explicit,
            expected: opts.expected,
            fix: `Set config.${opts.path} to ${opts.expected}.`,
          }),
        );
      }
      return opts.explicit;
    }
    const raw = opts.envKey === undefined ? undefined : opts.env[opts.envKey];
    if (raw !== undefined && raw !== '') {
      const parsed = opts.parse(raw);
      // `parse` narrows the raw string to a `T`; `validate` is applied on
      // top of it so a field with a closed value set is checked identically
      // whichever source it came from.
      if (parsed !== undefined && (opts.validate === undefined || opts.validate(parsed))) {
        return parsed;
      }
      this.add(
        compact({
          path: opts.path,
          got: raw,
          expected: opts.expected,
          fix: `Set ${opts.envKey} to a valid ${opts.expected}, or pass config.${opts.path} directly.`,
          env: opts.envKey,
        }),
      );
    }
    return opts.fallback;
  }
}

/**
 * Keys whose value is a live, stateful object, not plain configuration
 * data: a real `HostRuntime` instance (`runtime`/`runtimes`) or a real
 * `ProfileFs` implementation (`profiles.fs`). `deepFreeze` still freezes
 * the *container* holding one of these fields, so the field itself can
 * never be reassigned, but must not walk into the live object's own
 * internals: recursing into a real `HostRuntime`'s own `StateFileStore`
 * (an own enumerable instance field, not a prototype method) freezes it
 * too, and a completely ordinary later `launch()` call then throws
 * `TypeError: Cannot assign to read only property` the moment it tries to
 * record the newly launched instance.
 */
const LIVE_OBJECT_KEYS: ReadonlySet<string> = new Set([
  'runtime',
  'runtimes',
  'fs',
  'stealthProfiles',
]);

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  try {
    Object.freeze(value);
  } catch {
    // Some host objects (`process.env`, typed arrays with elements) refuse
    // Object.freeze outright. `resolvedFromEnv` deliberately holds a
    // reference to `process.env` itself for exactly this reason: it is
    // not owned data to freeze, only a read-once snapshot reference.
    return value;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (LIVE_OBJECT_KEYS.has(key)) continue; // shallow only; see LIVE_OBJECT_KEYS's own comment
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Resolves a {@link BrowserGlassConfig} into a frozen {@link ResolvedConfig}.
 * Precedence: explicit config field, then its environment variable, then the
 * documented default. Every problem encountered (a malformed env value, an
 * out of range number, a cross field contradiction) is collected before
 * throwing, so `createBrowserGlass` reports every simultaneous mistake in
 * one {@link ConfigError} rather than one restart cycle each. Performs no
 * I/O: reading the environment and validating shapes only.
 *
 * ── What this function does NOT reject, stated plainly ──
 *
 * An unknown KEY is accepted and ignored. There is no allow-list of legal
 * paths anywhere in this module: `config` is walked field by field, and a
 * field nothing reads is simply never read. So
 * `sesion: { control: { mode: 'shared' } }` (note the typo) resolves
 * successfully, silently, to the full default config.
 *
 * That is not a defence of the behaviour, it is a warning label. It has
 * already cost real time: `session.control.mode` did not exist as a key,
 * the e2e harness set it anyway, resolution accepted it, and shared control
 * ran exclusive with nothing anywhere saying so. It is the third silent
 * discard of the same shape found in one day, alongside
 * `store-sqlite`'s `transitionInstance` dropping patch fields and a profile
 * lease lookup resolving through an always-null column.
 *
 * Rejecting unknown keys wholesale is a deliberate decision somebody should
 * make rather than something to slip in here: it is a breaking change for
 * any caller currently passing a key this version does not know (a config
 * written for a newer build, a shared config object carrying fields for
 * another tool), and it would need a deprecation path. Until that decision
 * is taken, the rule for anyone adding a key is the narrower one that IS
 * enforceable per field: if it has a closed set of legal values, pass
 * `validate` to {@link ProblemCollector.resolve} so a wrong VALUE is a
 * `ConfigError` even when it arrives through the explicit branch.
 * `session.control.mode` does this; `logger.level`, `mode`,
 * `store.migrate` and `preflight.mode` are the other closed-set fields and
 * currently validate the env branch only.
 */
export function resolveConfig(config: BrowserGlassConfig): ResolvedConfig {
  const env = snapshotEnv(config.env);
  const c = new ProblemCollector();
  const warnings: { readonly code: string; readonly message: string }[] = [];

  const mode = c.resolve({
    path: 'mode',
    explicit: config.mode,
    envKey: 'BGLS_MODE',
    env,
    parse: (r) => (r === 'embedded' || r === 'supervised' || r === 'gateway' ? r : undefined),
    fallback: 'embedded' as const,
    expected: "'embedded' | 'supervised' | 'gateway'",
  });

  const basePath = c.resolve({
    path: 'basePath',
    explicit: config.basePath,
    envKey: 'BGLS_BASE_PATH',
    env,
    parse: (r) => r,
    fallback: '/browserglass',
    expected: 'a string',
  });
  if (!basePath.startsWith('/')) {
    c.add({
      path: 'basePath',
      got: basePath,
      expected: 'a path starting with "/"',
      fix: `Set basePath to "/${basePath.replace(/^\/+/, '')}".`,
    });
  }
  if (basePath.length > 1 && basePath.endsWith('/')) {
    c.add({
      path: 'basePath',
      got: basePath,
      expected: 'a path not ending with "/" (except the root path "/")',
      fix: `Set basePath to "${basePath.replace(/\/+$/, '')}".`,
    });
  }

  const instanceName = c.resolve({
    path: 'instanceName',
    explicit: config.instanceName,
    envKey: 'BGLS_INSTANCE_NAME',
    env,
    parse: (r) => r,
    fallback: `${(() => {
      try {
        return hostname();
      } catch {
        return 'bgls';
      }
    })()}:${process.pid}`,
    expected: 'a string',
  });

  const tenantId = c.resolve({
    path: 'tenantId',
    explicit: config.tenantId,
    envKey: 'BGLS_TENANT_ID',
    env,
    parse: (r) => r as ResolvedConfig['tenantId'],
    fallback: 'ten_00000000000000000000000000' as ResolvedConfig['tenantId'],
    expected: 'a tenant id (ten_...)',
  });

  const appId = c.resolve({
    path: 'appId',
    explicit: config.appId,
    envKey: 'BGLS_APP_ID',
    env,
    parse: (r) => r as ResolvedConfig['appId'],
    fallback: 'app_00000000000000000000000000' as ResolvedConfig['appId'],
    expected: 'an app id (app_...)',
  });

  const publicUrl = c.resolve({
    path: 'publicUrl',
    explicit: config.publicUrl,
    envKey: 'BGLS_PUBLIC_URL',
    env,
    parse: (r) => r,
    fallback: null,
    expected: 'a URL string or null',
  });

  const trustProxy = config.trustProxy ?? parseEnvBool(env['BGLS_TRUST_PROXY']) ?? false;

  // ---- store ----
  const migrate = c.resolve({
    path: 'store.migrate',
    explicit: config.migrate,
    envKey: 'BGLS_STORE_MIGRATE',
    env,
    parse: (r) => (r === 'auto' || r === 'check' || r === 'off' ? r : undefined),
    fallback: 'auto' as const,
    expected: "'auto' | 'check' | 'off'",
  });
  const busyTimeoutMs = c.resolve({
    path: 'store.busyTimeoutMs',
    explicit: config.busyTimeoutMs,
    envKey: 'BGLS_STORE_BUSY_TIMEOUT_MS',
    env,
    parse: parseEnvDuration,
    fallback: 5000,
    expected: 'a duration (e.g. 5000 or "5s")',
  });

  if (mode === 'embedded' || mode === 'supervised') {
    if (!config.store) {
      c.add({
        path: 'store',
        got: undefined,
        expected: `a Store instance, required when mode is '${mode}'`,
        fix: 'Pass store: sqliteStore({ path: "./data/browserglass.db" }) or an equivalent Store implementation.',
      });
    }
  }
  if (mode === 'gateway') {
    if (config.store) {
      c.add({
        path: 'store',
        got: 'set',
        expected: "omitted when mode is 'gateway' (the remote router owns storage)",
        fix: 'Remove config.store, or set router.endpoint and switch mode to "embedded"/"supervised" if this process should own storage.',
      });
    }
    if (!config.router?.endpoint) {
      c.add({
        path: 'router.endpoint',
        got: undefined,
        expected: "a URL, required when mode is 'gateway'",
        fix: "Set router.endpoint to the remote router's URL.",
      });
    }
  }

  // ---- profiles ----
  const profilesDir = c.resolve({
    path: 'profiles.dir',
    explicit: config.profiles?.dir,
    envKey: 'BGLS_PROFILE_DIR',
    env,
    parse: (r) => r,
    fallback: './data/bgls-profiles',
    expected: 'a directory path',
  });
  const profilesFs = config.profiles?.fs;
  if ((mode === 'embedded' || mode === 'supervised') && profilesFs === undefined) {
    c.add({
      path: 'profiles.fs',
      got: undefined,
      expected: `a ProfileFs instance, required when mode is '${mode}' (ProfileService cannot be constructed without one)`,
      fix: 'Pass profiles: { dir: "...", fs: hostProfileFs({ root: "..." }) } (or an equivalent ProfileFs) from the runtime-host package.',
    });
  }
  if (mode === 'gateway' && profilesFs !== undefined) {
    c.add({
      path: 'profiles.fs',
      got: 'set',
      expected: "omitted when mode is 'gateway' (the remote router owns profile storage)",
      fix: 'Remove config.profiles.fs.',
    });
  }
  const minFreeBytes = c.resolve({
    path: 'profiles.minFreeBytes',
    explicit: config.profiles?.minFreeBytes,
    envKey: 'BGLS_PROFILE_MIN_FREE_BYTES',
    env,
    parse: parseEnvSize,
    fallback: 2_147_483_648,
    expected: 'a size (e.g. 2147483648 or "2gb")',
  });
  const maxBytesPerProfile = c.resolve({
    path: 'profiles.maxBytesPerProfile',
    explicit: config.profiles?.maxBytesPerProfile,
    envKey: 'BGLS_PROFILE_MAX_BYTES',
    env,
    parse: parseEnvSize,
    fallback: 5_368_709_120,
    expected: 'a size',
  });
  const gcIntervalMs = c.resolve({
    path: 'profiles.gcIntervalMs',
    explicit: config.profiles?.gcIntervalMs,
    envKey: 'BGLS_PROFILE_GC_INTERVAL_MS',
    env,
    parse: parseEnvDuration,
    fallback: 900_000,
    expected: 'a duration',
  });
  const encryptAtRest = c.resolve({
    path: 'profiles.encryptAtRest',
    explicit: config.profiles?.encryptAtRest,
    envKey: 'BGLS_PROFILE_ENCRYPT',
    env,
    parse: parseEnvBool,
    fallback: false,
    expected: 'a boolean',
  });
  const encryptionKey =
    config.profiles?.encryptionKey ?? env['BGLS_PROFILE_ENCRYPTION_KEY'] ?? null;
  if (encryptAtRest) {
    const len =
      encryptionKey === null
        ? 0
        : Buffer.isBuffer(encryptionKey)
          ? encryptionKey.length
          : Buffer.from(encryptionKey, 'base64').length;
    if (encryptionKey === null || len !== 32) {
      c.add({
        path: 'profiles.encryptionKey',
        got: encryptionKey === null ? null : `${len} bytes`,
        expected: 'exactly 32 bytes, base64 encoded, required when profiles.encryptAtRest is true',
        fix: 'Set profiles.encryptionKey (or BGLS_PROFILE_ENCRYPTION_KEY) to a 32 byte base64 key, or set profiles.encryptAtRest to false.',
      });
    }
  }

  // ---- runtime ----
  // config.runtime is always an already constructed BrowserRuntime (or
  // several), the same pattern as `store`. See config/types.ts's
  // RuntimeConfig TSDoc for why: server has no dependency edge on
  // runtime-host.
  const runtimes: readonly import('@browserglass/protocol').BrowserRuntime[] =
    config.runtime === undefined
      ? []
      : Array.isArray(config.runtime)
        ? config.runtime
        : [config.runtime];
  // Live objects with methods, exactly like `runtimes` above, and listed
  // in LIVE_OBJECT_KEYS for the same reason: `deepFreeze` must freeze the
  // container without walking into a profile's own internals.
  const stealthProfiles: readonly import('@browserglass/protocol').StealthProfile[] =
    config.stealthProfiles ?? [];
  if ((mode === 'embedded' || mode === 'supervised') && runtimes.length === 0) {
    c.add({
      path: 'runtime',
      got: undefined,
      expected: `at least one BrowserRuntime, required when mode is '${mode}'`,
      fix: 'Pass runtime: hostRuntime({ channel: "chrome", headless: "new" }) from the runtime-host package, or an equivalent BrowserRuntime.',
    });
  }

  // ---- peer (node identity and the cross gateway link, docs/scaling.md) ----
  const peerNodeId = c.resolve({
    path: 'peer.nodeId',
    explicit: config.peer?.nodeId,
    envKey: 'BGLS_NODE_ID',
    env,
    parse: (r) => r,
    fallback: null,
    expected: 'a stable node id, the same value across restarts (a fresh one is minted when unset)',
  });
  const peerDataPlaneUrl = c.resolve({
    path: 'peer.dataPlaneUrl',
    explicit: config.peer?.dataPlaneUrl,
    envKey: 'BGLS_PEER_DATA_PLANE_URL',
    env,
    parse: (r) => r,
    fallback: null,
    expected: 'a ws:// or wss:// URL other gateways in the deployment can reach this node at',
  });
  const peerPath = c.resolve({
    path: 'peer.path',
    explicit: config.peer?.path,
    envKey: 'BGLS_PEER_PATH',
    env,
    parse: (r) => r,
    fallback: `${basePath === '/' ? '' : basePath}/node`,
    expected: 'a path starting with "/"',
  });
  if (!peerPath.startsWith('/')) {
    c.add({
      path: 'peer.path',
      got: peerPath,
      expected: 'a path starting with "/"',
      fix: `Set peer.path to "/${peerPath.replace(/^\/+/, '')}".`,
    });
  }
  const peerSharedSecret = c.resolve({
    path: 'peer.sharedSecret',
    explicit: config.peer?.sharedSecret,
    envKey: 'BGLS_PEER_SHARED_SECRET',
    env,
    parse: (r) => r,
    fallback: null,
    expected: 'the shared secret configured identically on every gateway in the deployment',
  });
  if (peerDataPlaneUrl !== null && peerSharedSecret === null) {
    c.add({
      path: 'peer.sharedSecret',
      got: null,
      expected:
        'set when peer.dataPlaneUrl is set (an advertised peer address nothing can authenticate a connection to is actively misleading, not merely incomplete)',
      fix: 'Set peer.sharedSecret (or BGLS_PEER_SHARED_SECRET) to the same value on every gateway in the deployment, or remove peer.dataPlaneUrl.',
    });
  }

  // ---- router ----
  const defaultPool = c.resolve({
    path: 'router.defaultPool',
    explicit: config.router?.defaultPool,
    envKey: 'BGLS_DEFAULT_POOL',
    env,
    parse: (r) => r,
    fallback: 'default',
    expected: 'a pool name',
  });
  const pools: readonly PoolDefinition[] = config.router?.pools ?? [{ name: defaultPool }];
  const idempotencyWindowMs = c.resolve({
    path: 'router.idempotencyWindowMs',
    explicit: config.router?.idempotencyWindowMs,
    envKey: 'BGLS_IDEMPOTENCY_WINDOW_MS',
    env,
    parse: parseEnvDuration,
    fallback: 300_000,
    expected: 'a duration',
  });
  const routerLaunchTimeoutMs = c.resolve({
    path: 'router.launchTimeoutMs',
    explicit: config.router?.launchTimeoutMs,
    envKey: 'BGLS_ROUTER_LAUNCH_TIMEOUT_MS',
    env,
    parse: parseEnvDuration,
    fallback: 45_000,
    expected: 'a duration',
  });
  const reaperIntervalMs = c.resolve({
    path: 'router.reaperIntervalMs',
    explicit: config.router?.reaperIntervalMs,
    envKey: 'BGLS_REAPER_INTERVAL_MS',
    env,
    parse: parseEnvDuration,
    fallback: 30_000,
    expected: 'a duration',
  });
  const reconcileIntervalMs = c.resolve({
    path: 'router.reconcileIntervalMs',
    explicit: config.router?.reconcileIntervalMs,
    envKey: 'BGLS_RECONCILE_INTERVAL_MS',
    env,
    parse: parseEnvDuration,
    fallback: 15_000,
    expected: 'a duration',
  });
  const heartbeatIntervalMs = c.resolve({
    path: 'router.heartbeatIntervalMs',
    explicit: config.router?.heartbeatIntervalMs,
    envKey: 'BGLS_HEARTBEAT_INTERVAL_MS',
    env,
    parse: parseEnvDuration,
    fallback: 5_000,
    expected: 'a duration',
  });
  const nodeStaleMs = c.resolve({
    path: 'router.nodeStaleMs',
    explicit: config.router?.nodeStaleMs,
    envKey: 'BGLS_NODE_STALE_MS',
    env,
    parse: parseEnvDuration,
    fallback: 12_000,
    expected: 'a duration',
  });
  const warmSafetyFactor = c.resolve({
    path: 'router.warmSafetyFactor',
    explicit: config.router?.warmSafetyFactor,
    envKey: 'BGLS_WARM_SAFETY_FACTOR',
    env,
    parse: parseEnvNumber,
    fallback: 1.5,
    expected: 'a number',
  });
  const routerEndpoint = config.router?.endpoint ?? env['BGLS_ROUTER_ENDPOINT'] ?? null;
  const routerToken = config.router?.token ?? env['BGLS_ROUTER_TOKEN'] ?? null;

  // ---- limits ----
  //
  // `maxInstances` (200) and `maxInstancesPerSubject` (50): raised from
  // 20/3. The old per-subject fallback of 3 was the single most
  // swarm-hostile default in the system: a fleet of agents sharing one
  // owner identity (the common shape for an automated swarm, which has no
  // reason to mint a distinct subject per worker) stalled at three live
  // browsers regardless of how many the tenant ceiling allowed. 50 leaves
  // room for a real swarm (tens of parallel workers) while still being a
  // real rail: an identity asking for hundreds of browsers is almost
  // certainly a bug (a leak that never releases) rather than legitimate
  // parallelism, and BGLS_MAX_INSTANCES_PER_SUBJECT still overrides it
  // per deployment. 200 for the tenant-wide ceiling keeps it comfortably
  // above the per-subject number (so more than one subject can run a
  // swarm at once) while staying below `DEFAULT_QUOTA_LIMITS.maxInstances`
  // (1000, `store-sqlite/src/defaults.ts`), the "no quota row configured"
  // sentinel that is deliberately far more generous than any embedded
  // gateway's own operational default should be.
  const maxInstances = c.resolve({
    path: 'limits.maxInstances',
    explicit: config.limits?.maxInstances,
    envKey: 'BGLS_MAX_INSTANCES',
    env,
    parse: parseEnvNumber,
    fallback: 200,
    expected: 'a positive integer',
  });
  const maxInstancesPerSubject = c.resolve({
    path: 'limits.maxInstancesPerSubject',
    explicit: config.limits?.maxInstancesPerSubject,
    envKey: 'BGLS_MAX_INSTANCES_PER_SUBJECT',
    env,
    parse: parseEnvNumber,
    fallback: 50,
    expected: 'a positive integer',
  });
  const maxViewersPerSession = c.resolve({
    path: 'limits.maxViewersPerSession',
    explicit: config.limits?.maxViewersPerSession,
    envKey: 'BGLS_MAX_VIEWERS_PER_SESSION',
    env,
    parse: parseEnvNumber,
    fallback: 16,
    expected: 'a positive integer',
  });
  const maxStreamsPerSession = c.resolve({
    path: 'limits.maxStreamsPerSession',
    explicit: config.limits?.maxStreamsPerSession,
    envKey: 'BGLS_MAX_STREAMS_PER_SESSION',
    env,
    parse: parseEnvNumber,
    fallback: 8,
    expected: 'a positive integer',
  });
  const maxStreams = c.resolve({
    path: 'limits.maxStreams',
    explicit: config.limits?.maxStreams,
    envKey: 'BGLS_MAX_STREAMS',
    env,
    parse: parseEnvNumber,
    fallback: 4,
    expected: 'a positive integer',
  });
  const maxTargetsPerInstance = c.resolve({
    path: 'limits.maxTargetsPerInstance',
    explicit: config.limits?.maxTargetsPerInstance,
    envKey: 'BGLS_MAX_TARGETS_PER_INSTANCE',
    env,
    parse: parseEnvNumber,
    fallback: 24,
    expected: 'a positive integer',
  });
  const acquireRatePerMinute = c.resolve({
    path: 'limits.acquireRatePerMinute',
    explicit: config.limits?.acquireRatePerMinute,
    envKey: 'BGLS_ACQUIRE_RATE_PER_MINUTE',
    env,
    parse: parseEnvNumber,
    fallback: 30,
    expected: 'a positive integer',
  });
  const restRatePerMinute = c.resolve({
    path: 'limits.restRatePerMinute',
    explicit: config.limits?.restRatePerMinute,
    envKey: 'BGLS_REST_RATE_PER_MINUTE',
    env,
    parse: parseEnvNumber,
    fallback: 600,
    expected: 'a positive integer',
  });
  const uploadMaxBytes = c.resolve({
    path: 'limits.uploadMaxBytes',
    explicit: config.limits?.uploadMaxBytes,
    envKey: 'BGLS_UPLOAD_MAX_BYTES',
    env,
    parse: parseEnvSize,
    fallback: 104_857_600,
    expected: 'a size',
  });
  const downloadMaxBytes = c.resolve({
    path: 'limits.downloadMaxBytes',
    explicit: config.limits?.downloadMaxBytes,
    envKey: 'BGLS_DOWNLOAD_MAX_BYTES',
    env,
    parse: parseEnvSize,
    fallback: 524_288_000,
    expected: 'a size',
  });
  const downloadUrlTtlMs = c.resolve({
    path: 'limits.downloadUrlTtlMs',
    explicit: config.limits?.downloadUrlTtlMs,
    envKey: 'BGLS_DOWNLOAD_URL_TTL_MS',
    env,
    parse: parseEnvNumber,
    fallback: 60_000,
    expected: 'a positive integer',
  });
  const clipboardMaxBytes = c.resolve({
    path: 'limits.clipboardMaxBytes',
    explicit: config.limits?.clipboardMaxBytes,
    envKey: 'BGLS_CLIPBOARD_MAX_BYTES',
    env,
    parse: parseEnvSize,
    fallback: 262_144,
    expected: 'a size',
  });
  const maxRequestBodyBytes = c.resolve({
    path: 'limits.maxRequestBodyBytes',
    explicit: config.limits?.maxRequestBodyBytes,
    envKey: 'BGLS_MAX_REQUEST_BODY_BYTES',
    env,
    parse: parseEnvSize,
    fallback: 1_048_576,
    expected: 'a size',
  });
  // ---- uploads ----
  //
  // The staging root defaults under the system temp dir and is scoped to
  // this process id, because `UploadStore.dispose()` REMOVES the root
  // outright on `stop()`. Two gateways sharing one machine and one default
  // must not share one root, or the first to stop takes the second's
  // staged files with it.
  const uploadsDir = c.resolve({
    path: 'uploads.dir',
    explicit: config.uploads?.dir,
    envKey: 'BGLS_UPLOAD_DIR',
    env,
    parse: (r) => r,
    fallback: join(tmpdir(), 'bgls-uploads', String(process.pid)),
    expected: 'a directory path',
  });
  const uploadsStagingTtlMs = c.resolve({
    path: 'uploads.stagingTtlMs',
    explicit: config.uploads?.stagingTtlMs,
    envKey: 'BGLS_UPLOAD_STAGING_TTL_MS',
    env,
    parse: parseEnvNumber,
    fallback: 300_000,
    expected: 'a positive integer',
  });
  const uploadsRetentionMs = c.resolve({
    path: 'uploads.retentionMs',
    explicit: config.uploads?.retentionMs,
    envKey: 'BGLS_UPLOAD_RETENTION_MS',
    env,
    parse: parseEnvNumber,
    fallback: 1_800_000,
    expected: 'a positive integer',
  });
  const uploadsMaxConcurrent = c.resolve({
    path: 'uploads.maxConcurrent',
    explicit: config.uploads?.maxConcurrent,
    envKey: 'BGLS_UPLOAD_MAX_CONCURRENT',
    env,
    parse: parseEnvNumber,
    fallback: 256,
    expected: 'a positive integer',
  });
  const uploadsMaxTotalBytes = c.resolve({
    path: 'uploads.maxTotalBytes',
    explicit: config.uploads?.maxTotalBytes,
    envKey: 'BGLS_UPLOAD_MAX_TOTAL_BYTES',
    env,
    parse: parseEnvSize,
    fallback: 2_147_483_648,
    expected: 'a size',
  });

  // ---- downloads ----
  //
  // Same reasoning as `uploadsDir` immediately above, mirrored: scoped to
  // this process id because `DownloadStore` writes into it directly
  // (Chrome itself, via `Page.setDownloadBehavior`) and a sibling gateway
  // sharing one machine must not share one root.
  const downloadsDir = c.resolve({
    path: 'downloads.dir',
    explicit: config.downloads?.dir,
    envKey: 'BGLS_DOWNLOAD_DIR',
    env,
    parse: (r) => r,
    fallback: join(tmpdir(), 'bgls-downloads', String(process.pid)),
    expected: 'a directory path',
  });

  // ---- recordings ----
  //
  // Same reasoning as `downloadsDir` immediately above: scoped to this
  // process id because `DiskRecordingSink` writes into it directly, and a
  // sibling gateway sharing one machine must not share one root. A
  // recording is a more sensitive artifact than a download (it is a
  // durable capture of everything a target displayed, not one file a page
  // chose to hand out), so this gets its own directory rather than a
  // subdirectory of `downloadsDir`.
  const recordingsDir = c.resolve({
    path: 'recordings.dir',
    explicit: config.recordings?.dir,
    envKey: 'BGLS_RECORDING_DIR',
    env,
    parse: (r) => r,
    fallback: join(tmpdir(), 'bgls-recordings', String(process.pid)),
    expected: 'a directory path',
  });

  const inputRatePerSec = c.resolve({
    path: 'limits.inputRatePerSec',
    explicit: config.limits?.inputRatePerSec,
    envKey: 'BGLS_INPUT_RATE_LIMIT',
    env,
    parse: parseEnvNumber,
    fallback: 300,
    expected: 'a positive integer',
  });

  // ---- session limits ----
  const idleTimeoutMs = c.resolve({
    path: 'session.limits.idleTimeoutMs',
    explicit: config.session?.limits?.idleTimeoutMs,
    envKey: 'BGLS_SESSION_IDLE_MS',
    env,
    parse: parseEnvDuration,
    fallback: 1_800_000,
    expected: 'a duration',
  });
  const sessionMaxDurationMs = c.resolve({
    path: 'session.limits.maxDurationMs',
    explicit: config.session?.limits?.maxDurationMs,
    envKey: 'BGLS_SESSION_MAX_DURATION_MS',
    env,
    parse: parseEnvDuration,
    fallback: 14_400_000,
    expected: 'a duration',
  });
  const idleGraceMs = c.resolve({
    path: 'session.limits.idleGraceMs',
    explicit: config.session?.limits?.idleGraceMs,
    envKey: 'BGLS_IDLE_GRACE_MS',
    env,
    parse: parseEnvDuration,
    fallback: 600_000,
    expected: 'a duration',
  });
  const noViewerTimeoutMs = c.resolve({
    path: 'session.limits.noViewerTimeoutMs',
    explicit: config.session?.limits?.noViewerTimeoutMs,
    envKey: 'BGLS_NO_VIEWER_TIMEOUT_MS',
    env,
    parse: parseEnvDuration,
    fallback: 120_000,
    expected: 'a duration',
  });
  const warmIdleMs = c.resolve({
    path: 'session.limits.warmIdleMs',
    explicit: config.session?.limits?.warmIdleMs,
    envKey: 'BGLS_WARM_IDLE_MS',
    env,
    parse: parseEnvDuration,
    fallback: 600_000,
    expected: 'a duration',
  });
  if (idleTimeoutMs >= sessionMaxDurationMs) {
    c.add({
      path: 'session.limits.idleTimeoutMs',
      got: idleTimeoutMs,
      expected: `less than session.limits.maxDurationMs (${sessionMaxDurationMs})`,
      fix: 'Lower session.limits.idleTimeoutMs, or raise session.limits.maxDurationMs.',
    });
  }

  // ---- auth ----
  const authIssuer = c.resolve({
    path: 'auth.issuer',
    explicit: config.auth?.issuer,
    envKey: 'BGLS_TOKEN_ISSUER',
    env,
    parse: (r) => r as ResolvedConfig['appId'],
    fallback: appId,
    expected: 'an app id',
  });
  const defaultTtlSeconds = c.resolve({
    path: 'auth.defaultTtlSeconds',
    explicit: config.auth?.defaultTtlSeconds,
    envKey: 'BGLS_TOKEN_TTL_SECONDS',
    env,
    parse: parseEnvNumber,
    fallback: 120,
    expected: 'seconds, 60 to 300',
  });
  const maxTtlSeconds = c.resolve({
    path: 'auth.maxTtlSeconds',
    explicit: config.auth?.maxTtlSeconds,
    envKey: 'BGLS_TOKEN_MAX_TTL_SECONDS',
    env,
    parse: parseEnvNumber,
    fallback: 900,
    expected: 'seconds, at most 900',
  });
  if (maxTtlSeconds > 900) {
    c.add({
      path: 'auth.maxTtlSeconds',
      got: maxTtlSeconds,
      expected: 'at most 900 (the hard ceiling)',
      fix: 'Lower auth.maxTtlSeconds to 900 or below; it cannot be raised.',
    });
  }
  if (defaultTtlSeconds > maxTtlSeconds) {
    c.add({
      path: 'auth.defaultTtlSeconds',
      got: defaultTtlSeconds,
      expected: `at most auth.maxTtlSeconds (${maxTtlSeconds})`,
      fix: 'Lower auth.defaultTtlSeconds, or raise auth.maxTtlSeconds (up to 900).',
    });
  }
  const clockSkewSeconds = c.resolve({
    path: 'auth.clockSkewSeconds',
    explicit: config.auth?.clockSkewSeconds,
    envKey: 'BGLS_CLOCK_SKEW_SECONDS',
    env,
    parse: parseEnvNumber,
    fallback: 30,
    expected: 'a positive integer',
  });
  const allowQueryToken = c.resolve({
    path: 'auth.allowQueryToken',
    explicit: config.auth?.allowQueryToken,
    envKey: 'BGLS_ALLOW_QUERY_TOKEN',
    env,
    parse: parseEnvBool,
    fallback: false,
    expected: 'a boolean',
  });
  const jtiCacheSize = c.resolve({
    path: 'auth.jtiCacheSize',
    explicit: config.auth?.jtiCacheSize,
    envKey: 'BGLS_JTI_CACHE_SIZE',
    env,
    parse: parseEnvNumber,
    fallback: 200_000,
    expected: 'a positive integer',
  });
  const requireSubprotocolToken = c.resolve({
    path: 'auth.requireSubprotocolToken',
    explicit: config.auth?.requireSubprotocolToken,
    envKey: 'BGLS_REQUIRE_SUBPROTOCOL_TOKEN',
    env,
    parse: parseEnvBool,
    fallback: true,
    expected: 'a boolean',
  });
  const maxCapsExplicit =
    config.auth?.maxCaps ??
    (parseEnvStringList(env['BGLS_MAX_CAPS'], /[,\s]+/) as readonly Capability[] | undefined);
  const maxCaps: readonly Capability[] = maxCapsExplicit ?? ALL_CAPABILITIES;
  for (const cap of maxCaps) {
    if (!isCapability(cap)) {
      c.add({
        path: 'auth.maxCaps',
        got: cap,
        // The count is interpolated rather than written out. It read "18"
        // while the inventory was already 19, and went to 20 when the
        // `evaluate` capability landed, so a hardcoded number here has
        // been wrong more often than right. Deriving it means the next
        // capability cannot make this message lie.
        expected: `one of the ${ALL_CAPABILITIES.length} canonical capabilities: ${ALL_CAPABILITIES.join(', ')}`,
        fix: `Remove "${cap}" from auth.maxCaps, or fix its spelling.`,
        env: 'BGLS_MAX_CAPS',
      });
    }
  }
  // auth.ticketTtlMs default 30000, security.ticketTtlMs is a deprecated alias.
  const ticketTtlRaw =
    config.auth?.ticketTtlMs ??
    parseEnvDuration(env['BGLS_TICKET_TTL_MS']) ??
    (() => {
      if (config.security?.ticketTtlMs !== undefined) {
        // eslint-disable-next-line no-console
        console.warn(
          'BrowserGlass: security.ticketTtlMs is deprecated, use auth.ticketTtlMs. Read once at startup.',
        );
        return config.security.ticketTtlMs;
      }
      return undefined;
    })() ??
    30000;
  const ticketTtlMs = Math.min(300_000, Math.max(5_000, ticketTtlRaw));

  // ---- security ----
  const blockPrivateRanges = c.resolve({
    path: 'security.blockPrivateRanges',
    explicit: config.security?.blockPrivateRanges,
    envKey: 'BGLS_BLOCK_PRIVATE_RANGES',
    env,
    parse: parseEnvBool,
    fallback: true,
    expected: 'a boolean',
  });
  const allowedOriginsRaw =
    config.security?.allowedOrigins ??
    (env['BGLS_ALLOWED_ORIGINS'] === '*'
      ? '*'
      : parseEnvStringList(env['BGLS_ALLOWED_ORIGINS'], /[,\s]+/));
  // Safe default: no CROSS ORIGIN caller is allowed, on REST or on the WS
  // upgrade, until an operator configures one explicitly
  // (`security.allowedOrigins` or `BGLS_ALLOWED_ORIGINS`).
  //
  // This does NOT mean "nobody can connect with no config", which is the
  // regression an earlier version of this default caused: `src/index.ts`'s
  // `handleUpgrade` only ever consults this list for a genuinely CROSS
  // ORIGIN request (an `Origin` header present and naming a different
  // host than the one the client dialed); a same origin browser request
  // and a non-browser caller with no `Origin` header at all (the CLI, MCP,
  // the Python client, any server-to-server automation client) bypass
  // this list entirely and always work, by design, matching the pattern
  // browsers themselves use `Origin` for in the first place. See that
  // function's own doc comment, and `rest/cors.ts`'s, for the two call
  // sites this one list feeds.
  const allowedOrigins: readonly string[] | '*' = allowedOriginsRaw ?? [];
  const corsCredentials = c.resolve({
    path: 'security.corsCredentials',
    explicit: config.security?.corsCredentials,
    envKey: 'BGLS_CORS_CREDENTIALS',
    env,
    parse: parseEnvBool,
    fallback: false,
    expected: 'a boolean',
  });
  const devtoolsEnabled = c.resolve({
    path: 'security.devtoolsEnabled',
    explicit: config.security?.devtoolsEnabled,
    envKey: 'BGLS_DEVTOOLS_ENABLED',
    env,
    parse: parseEnvBool,
    fallback: false,
    expected: 'a boolean',
  });
  // W_DEVTOOLS_CAP_INERT: a warning, not a config
  // error, so it does not join `c.problems` (that would make the
  // documented "max_caps defaults to all 18" default self-contradictory
  // with the documented "devtoolsEnabled defaults to false").
  if (!devtoolsEnabled && maxCaps.includes('devtools')) {
    warnings.push({
      code: 'W_DEVTOOLS_CAP_INERT',
      message:
        "auth.maxCaps includes 'devtools' but security.devtoolsEnabled is false, so no token can ever be granted it. Set security.devtoolsEnabled to true, or remove 'devtools' from auth.maxCaps.",
    });
  }
  // The raw CDP attach proxy's own opt-in gate. OFF by default: see
  // `SecurityConfig.cdpProxyEnabled`'s doc comment (`config/types.ts`) for
  // the full policy argument (this proxy cannot allowlist `Target.*`/
  // `Runtime.*` and still bootstrap a real driver library, so enabling it
  // is a deliberate relaxation of `cdp-passthrough-allowlist.ts`'s refusal
  // list, not a bug in it).
  const cdpProxyEnabled = c.resolve({
    path: 'security.cdpProxyEnabled',
    explicit: config.security?.cdpProxyEnabled,
    envKey: 'BGLS_CDP_PROXY_ENABLED',
    env,
    parse: parseEnvBool,
    fallback: false,
    expected: 'a boolean',
  });
  const uploadAllowedMimeTypes =
    config.security?.uploadAllowedMimeTypes ??
    parseEnvStringList(env['BGLS_UPLOAD_MIME_ALLOW'], /[,\s]+/) ??
    null;
  const urlAllow =
    config.security?.urlAllow ?? parseEnvStringList(env['BGLS_URL_ALLOW'], /[,\s]+/) ?? [];
  const urlDeny =
    config.security?.urlDeny ?? parseEnvStringList(env['BGLS_URL_DENY'], /[,\s]+/) ?? [];

  // ---- session (protocol) ----
  const pingIntervalMs = c.resolve({
    path: 'session.pingIntervalMs',
    explicit: config.session?.pingIntervalMs,
    envKey: 'BGLS_PING_INTERVAL_MS',
    env,
    parse: parseEnvDuration,
    fallback: 25_000,
    expected: 'a duration',
  });
  const pongTimeoutMs = c.resolve({
    path: 'session.pongTimeoutMs',
    explicit: config.session?.pongTimeoutMs,
    envKey: 'BGLS_PONG_TIMEOUT_MS',
    env,
    parse: parseEnvDuration,
    fallback: 20_000,
    expected: 'a duration',
  });
  const resumeWindowMs = c.resolve({
    path: 'session.resumeWindowMs',
    explicit: config.session?.resumeWindowMs,
    envKey: 'BGLS_RESUME_WINDOW_MS',
    env,
    parse: parseEnvDuration,
    fallback: 120_000,
    expected: 'a duration',
  });
  const controlMode = c.resolve<LeaseMode>({
    path: 'session.control.mode',
    explicit: config.session?.control?.mode,
    envKey: 'BGLS_CONTROL_MODE',
    env,
    // `parse` only has to narrow the raw string; `validate` below is what
    // actually rejects, and it rejects the explicitly configured value too.
    // Written this way rather than as a `parse` that returns `undefined`
    // for a bad value, because a `parse`-only rejection leaves the
    // EXPLICIT branch unguarded, which is precisely how
    // `session: { control: { mode: 'shared' } }` was accepted and dropped.
    parse: (raw) => raw as LeaseMode,
    validate: isLeaseMode,
    fallback: 'exclusive',
    expected: LEASE_MODE_EXPECTED,
  });
  const controlLeaseMs = c.resolve({
    path: 'session.control.leaseMs',
    explicit: config.session?.control?.leaseMs,
    envKey: 'BGLS_CONTROL_LEASE_MS',
    env,
    parse: parseEnvDuration,
    fallback: 60_000,
    expected: 'a duration',
  });
  const controlGraceMs = c.resolve({
    path: 'session.control.graceMs',
    explicit: config.session?.control?.graceMs,
    envKey: 'BGLS_CONTROL_GRACE_MS',
    env,
    parse: parseEnvDuration,
    fallback: 30_000,
    expected: 'a duration',
  });
  const controlQueueMax = c.resolve({
    path: 'session.control.queueMax',
    explicit: config.session?.control?.queueMax,
    envKey: 'BGLS_CONTROL_QUEUE_MAX',
    env,
    parse: parseEnvNumber,
    fallback: 8,
    expected: 'a positive integer',
  });
  const allowForceClaim = c.resolve({
    path: 'session.control.allowForceClaim',
    explicit: config.session?.control?.allowForceClaim,
    envKey: 'BGLS_ALLOW_FORCE_CLAIM',
    env,
    parse: parseEnvBool,
    fallback: true,
    expected: 'a boolean',
  });
  const maxEventsPerSecond = c.resolve({
    path: 'session.input.maxEventsPerSecond',
    explicit: config.session?.input?.maxEventsPerSecond,
    envKey: 'BGLS_INPUT_RATE_LIMIT',
    env,
    parse: parseEnvNumber,
    fallback: inputRatePerSec,
    expected: 'a positive integer',
  });

  // ---- logger ----
  const level = c.resolve({
    path: 'logger.level',
    explicit: config.logger?.level,
    envKey: 'BGLS_LOG_LEVEL',
    env,
    parse: (r) =>
      r === 'trace' || r === 'debug' || r === 'info' || r === 'warn' || r === 'error'
        ? r
        : undefined,
    fallback: 'info' as const,
    expected: "'trace' | 'debug' | 'info' | 'warn' | 'error'",
  });
  const format = c.resolve({
    path: 'logger.format',
    explicit: config.logger?.format,
    envKey: 'BGLS_LOG_FORMAT',
    env,
    parse: (r) => (r === 'pretty' || r === 'json' ? r : undefined),
    fallback: process.stdout.isTTY ? ('pretty' as const) : ('json' as const),
    expected: "'pretty' | 'json'",
  });
  const redact = config.logger?.redact ??
    parseEnvStringList(env['BGLS_LOG_REDACT'], /[,\s]+/) ?? [
      'token',
      'ticket',
      'cookie',
      'authorization',
      'password',
    ];
  const loggerSink = config.logger?.sink ?? null;

  // ---- observability ----
  const metricsPrefix = c.resolve({
    path: 'observability.metricsPrefix',
    explicit: config.observability?.metricsPrefix,
    envKey: 'BGLS_METRICS_PREFIX',
    env,
    parse: (r) => r,
    fallback: 'bgls_',
    expected: 'a string',
  });
  const auditInputBatchWindowMs = c.resolve({
    path: 'observability.auditInputBatchWindowMs',
    explicit: config.observability?.auditInputBatchWindowMs,
    envKey: 'BGLS_AUDIT_INPUT_WINDOW_MS',
    env,
    parse: parseEnvDuration,
    fallback: 5000,
    expected: 'a duration',
  });
  const healthPath = c.resolve({
    path: 'observability.healthPath',
    explicit: config.observability?.healthPath,
    envKey: 'BGLS_HEALTH_PATH',
    env,
    parse: (r) => r,
    fallback: '/healthz',
    expected: 'a path or null',
  });
  const readyPath = c.resolve({
    path: 'observability.readyPath',
    explicit: config.observability?.readyPath,
    envKey: 'BGLS_READY_PATH',
    env,
    parse: (r) => r,
    fallback: '/readyz',
    expected: 'a path or null',
  });

  // ---- preflight ----
  const preflightEnabled = c.resolve({
    path: 'preflight.enabled',
    explicit: config.preflight?.enabled,
    envKey: 'BGLS_PREFLIGHT',
    env,
    parse: parseEnvBool,
    fallback: true,
    expected: 'a boolean',
  });
  const preflightMode = c.resolve({
    path: 'preflight.mode',
    explicit: config.preflight?.mode,
    envKey: 'BGLS_PREFLIGHT_MODE',
    env,
    parse: (r) => (r === 'fail' || r === 'warn' ? r : undefined),
    fallback: 'fail' as const,
    expected: "'fail' | 'warn'",
  });
  const preflightSkip =
    config.preflight?.skip ?? parseEnvStringList(env['BGLS_PREFLIGHT_SKIP'], /[,\s]+/) ?? [];
  const preflightTimeoutMs = c.resolve({
    path: 'preflight.timeoutMs',
    explicit: config.preflight?.timeoutMs,
    envKey: 'BGLS_PREFLIGHT_TIMEOUT_MS',
    env,
    parse: parseEnvDuration,
    fallback: 10_000,
    expected: 'a duration',
  });

  const hooksTimeoutMs = c.resolve({
    path: 'hooks.timeoutMs',
    explicit: config.hooks?.timeoutMs,
    envKey: 'BGLS_HOOK_TIMEOUT_MS',
    env,
    parse: parseEnvDuration,
    fallback: 0,
    expected: "a duration (0 means use each hook's own default)",
  });

  const wsPath = `${basePath === '/' ? '' : basePath}/socket`;
  const cdpProxyPath = `${basePath === '/' ? '' : basePath}/cdp`;

  // `src/index.ts`'s `handleUpgrade` checks the peer path before the
  // viewer path (`ws/peer-upgrade.ts`'s own top comment explains why
  // they must be two distinct claimed paths, never multiplexed): a
  // `peer.path` that collided with the viewer's own `wsPath` would make
  // the viewer socket permanently unreachable at that path, silently,
  // for anyone who ever configured `mode: 'gateway'`-adjacent peer
  // settings without noticing the collision. Caught here instead.
  if (peerPath === wsPath) {
    c.add({
      path: 'peer.path',
      got: peerPath,
      expected: `a path distinct from the viewer WS path ("${wsPath}")`,
      fix: 'Set peer.path to something other than basePath + "/socket" (the default "/node" under basePath is fine), or change basePath/wsPath so the two no longer collide.',
    });
  }
  // Same collision class, for the CDP proxy's own claimed prefix
  // (`cdpProxyPath`, not independently configurable, so the only way this
  // ever fires is `peer.path` explicitly set to `${basePath}/cdp`).
  if (peerPath === cdpProxyPath) {
    c.add({
      path: 'peer.path',
      got: peerPath,
      expected: `a path distinct from the CDP proxy path ("${cdpProxyPath}")`,
      fix: 'Set peer.path to something other than basePath + "/cdp".',
    });
  }

  if (c.problems.length > 0) {
    throw new ConfigError(c.problems);
  }

  // Default `observability.auditSink`, store backed, whenever a `Store` is
  // configured and the operator did not supply their own. Without this,
  // `audit_events` (`store-sqlite/migrations/0001_initial.sql`) stays
  // empty forever: `BrowserRouter` already calls `this.audit.emit(...)`
  // for `instance.acquired`/`instance.drive`/`instance.released`
  // (`packages/router/src/router/BrowserRouter.ts`), but `wiring.ts`'s
  // `audit: config.observability.auditSink ?? noopAuditSink` silently
  // discarded every one of them when nothing was configured. `??` below,
  // not a fallback INSIDE `createStoreAuditSink`, so an explicit operator
  // sink always wins outright and this default is never even constructed
  // for one: `config.observability?.auditSink` is read once, here, before
  // deciding whether to build anything.
  //
  // No store means no default: a `gateway` mode process forwarding to a
  // remote router has nothing local to persist into, and `wiring.ts`'s
  // `noopAuditSink` stays the right fallback for that case exactly as it
  // was before this change.
  //
  // Constructing this here, inside `resolveConfig`, is consistent with
  // every other field on `ResolvedConfig`: `store`, `logger.sink`, and
  // `profiles.fs` are already live, stateful objects the caller passed in
  // or this function built, not descriptions of objects to build later.
  // It has no observable side effect on its own: `createStoreAuditSink`
  // arms no timer until its first `emit()` call (see that function's own
  // comment), so calling `resolveConfig` repeatedly (tests do) never
  // leaves a background timer running for a config nothing ever used.
  const auditSink =
    config.observability?.auditSink ??
    (config.store !== undefined
      ? createStoreAuditSink({
          store: config.store,
          tenantId,
          appId,
          logger: loggerSink ?? consoleLogger({ level, format, redact }),
        })
      : undefined);

  const resolved: ResolvedConfig = {
    mode,
    basePath,
    wsPath,
    cdpProxyPath,
    instanceName,
    tenantId,
    appId,
    publicUrl,
    trustProxy,

    store: config.store,
    migrate,
    busyTimeoutMs,

    profiles: {
      dir: profilesDir,
      fs: profilesFs,
      minFreeBytes,
      maxBytesPerProfile,
      gcIntervalMs,
      encryptAtRest,
      encryptionKey,
    },

    runtimes,
    stealthProfiles,

    peer: {
      nodeId: peerNodeId,
      dataPlaneUrl: peerDataPlaneUrl,
      path: peerPath,
      sharedSecret: peerSharedSecret,
    },

    router: {
      defaultPool,
      pools,
      placement: config.router?.placement,
      idempotencyWindowMs,
      launchTimeoutMs: routerLaunchTimeoutMs,
      reaperIntervalMs,
      reconcileIntervalMs,
      heartbeatIntervalMs,
      nodeStaleMs,
      warmSafetyFactor,
      endpoint: routerEndpoint,
      token: routerToken,
    },

    limits: {
      maxInstances,
      maxInstancesPerSubject,
      maxViewersPerSession,
      maxStreamsPerSession,
      maxStreams,
      maxTargetsPerInstance,
      acquireRatePerMinute,
      restRatePerMinute,
      uploadMaxBytes,
      downloadMaxBytes,
      downloadUrlTtlMs,
      clipboardMaxBytes,
      maxRequestBodyBytes,
      inputRatePerSec,
    },

    uploads: {
      dir: uploadsDir,
      stagingTtlMs: uploadsStagingTtlMs,
      retentionMs: uploadsRetentionMs,
      maxConcurrent: uploadsMaxConcurrent,
      maxTotalBytes: uploadsMaxTotalBytes,
    },

    downloads: {
      dir: downloadsDir,
    },

    recordings: {
      dir: recordingsDir,
    },

    sessionLimits: {
      idleTimeoutMs,
      maxDurationMs: sessionMaxDurationMs,
      idleGraceMs,
      noViewerTimeoutMs,
      warmIdleMs,
    },

    auth: {
      resolver: config.auth?.resolver,
      keys: config.auth?.keys ?? [],
      issuer: authIssuer,
      defaultTtlSeconds,
      maxTtlSeconds,
      clockSkewSeconds,
      allowQueryToken,
      jtiCacheSize,
      requireSubprotocolToken,
      maxCaps,
      ticketTtlMs,
    },

    security: {
      navigationPolicy: config.security?.navigationPolicy,
      urlAllow,
      urlDeny,
      blockPrivateRanges,
      allowedOrigins,
      corsCredentials,
      devtoolsEnabled,
      uploadAllowedMimeTypes,
      cdpProxyEnabled,
    },

    session: {
      pingIntervalMs,
      pongTimeoutMs,
      resumeWindowMs,
      control: {
        mode: controlMode,
        leaseMs: controlLeaseMs,
        graceMs: controlGraceMs,
        queueMax: controlQueueMax,
        allowForceClaim,
      },
      input: { maxEventsPerSecond },
    },

    logger: {
      sink: loggerSink,
      level,
      format,
      redact,
    },

    observability: {
      metricsSink: config.observability?.metricsSink,
      metricsPrefix,
      auditSink,
      auditInputBatchWindowMs,
      healthPath,
      readyPath,
    },

    preflight: {
      enabled: preflightEnabled,
      mode: preflightMode,
      skip: preflightSkip,
      timeoutMs: preflightTimeoutMs,
    },

    hooks: { ...config.hooks, timeoutMs: hooksTimeoutMs },

    resolvedFromEnv: env,
    configWarnings: warnings,
  };

  return deepFreeze(resolved);
}

/** Builds the {@link Logger} a `ResolvedConfig` should use: the configured sink, or a console fallback. */
export function loggerFor(resolved: ResolvedConfig) {
  return resolved.logger.sink ?? consoleLogger(resolved.logger);
}

// Re-exported so callers of `resolveConfig` can construct a fresh id without a second protocol import.
export { newId };
