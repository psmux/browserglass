import type { AuditSink, BrowserRuntime, ProfileFs, Store } from '@browserglass/protocol';
import { createSqliteStore } from '@browserglass/store-sqlite';
import { describe, expect, it } from 'vitest';
import { ConfigError, resolveConfig } from '../../src/config/index.js';

describe('resolveConfig', () => {
  it('collects every simultaneous problem into one ConfigError', () => {
    let error: ConfigError | undefined;
    try {
      resolveConfig({
        mode: 'embedded',
        // (1) basePath missing leading slash
        basePath: 'browserglass',
        // no store, no runtime, no profiles.fs -> (2) (3) (4)
        auth: {
          // (5) maxTtlSeconds above the 900s hard ceiling
          maxTtlSeconds: 5000,
        },
      });
    } catch (err) {
      error = err as ConfigError;
    }

    expect(error).toBeInstanceOf(ConfigError);
    expect(error?.code).toBe('E_CONFIG_INVALID');
    expect(error!.problems.length).toBeGreaterThanOrEqual(5);

    const paths = error!.problems.map((p) => p.path);
    expect(paths).toContain('basePath');
    expect(paths).toContain('store');
    expect(paths).toContain('runtime');
    expect(paths).toContain('profiles.fs');
    expect(paths).toContain('auth.maxTtlSeconds');

    for (const problem of error!.problems) {
      expect(problem.path.length).toBeGreaterThan(0);
      expect(problem.expected.length).toBeGreaterThan(0);
      expect(problem.fix.length).toBeGreaterThan(0);
    }
  });

  it('applies defaults and freezes the result when config is valid', () => {
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    expect(resolved.basePath).toBe('/browserglass');
    expect(resolved.wsPath).toBe('/browserglass/socket');
    expect(resolved.auth.ticketTtlMs).toBe(30000);
    expect(resolved.auth.jtiCacheSize).toBe(200000);
    expect(resolved.limits.inputRatePerSec).toBe(300);
    expect(resolved.sessionLimits.idleTimeoutMs).toBe(1800000);
    expect(resolved.sessionLimits.maxDurationMs).toBe(14400000);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.auth)).toBe(true);
    expect(() => {
      // @ts-expect-error frozen at runtime too
      resolved.basePath = '/other';
    }).toThrow();
  });

  it('precedence: explicit config wins over env, env wins over default', () => {
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      basePath: '/explicit',
      env: { BGLS_BASE_PATH: '/from-env' },
    });
    expect(resolved.basePath).toBe('/explicit');

    const resolvedFromEnv = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      env: { BGLS_BASE_PATH: '/from-env' },
    });
    expect(resolvedFromEnv.basePath).toBe('/from-env');
  });

  it('clamps auth.ticketTtlMs to [5000, 300000]', () => {
    const tooLow = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      auth: { ticketTtlMs: 100 },
    });
    expect(tooLow.auth.ticketTtlMs).toBe(5000);

    const tooHigh = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      auth: { ticketTtlMs: 10_000_000 },
    });
    expect(tooHigh.auth.ticketTtlMs).toBe(300000);
  });

  it('defaults limits.maxInstances (200) and limits.maxInstancesPerSubject (50), swarm-friendly ceilings raised from the old 20/3', () => {
    // The old fallback of 3 for maxInstancesPerSubject was the single most
    // swarm-hostile default in the system: a fleet of agents sharing one
    // owner identity (the common shape for an automated swarm) stalled at
    // three live browsers. This asserts the new, raised fallbacks rather
    // than the old ones.
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    expect(resolved.limits.maxInstances).toBe(200);
    expect(resolved.limits.maxInstancesPerSubject).toBe(50);
  });

  it('BGLS_MAX_INSTANCES and BGLS_MAX_INSTANCES_PER_SUBJECT still override the raised defaults', () => {
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      env: { BGLS_MAX_INSTANCES: '500', BGLS_MAX_INSTANCES_PER_SUBJECT: '75' },
    });
    expect(resolved.limits.maxInstances).toBe(500);
    expect(resolved.limits.maxInstancesPerSubject).toBe(75);
  });

  it('honours the deprecated security.ticketTtlMs alias', () => {
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { ticketTtlMs: 45000 },
    });
    expect(resolved.auth.ticketTtlMs).toBe(45000);
  });

  it('rejects a malformed env value with a problem naming the var', () => {
    let error: ConfigError | undefined;
    try {
      resolveConfig({
        mode: 'gateway',
        router: { endpoint: 'https://router.example.com' },
        env: { BGLS_TOKEN_TTL_SECONDS: 'not-a-number' },
      });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = error!.problems.find((p) => p.env === 'BGLS_TOKEN_TTL_SECONDS');
    expect(problem).toBeDefined();
    expect(problem!.got).toBe('not-a-number');
  });

  it('peer.*: defaults to no identity, no peer link, and a path derived from basePath', () => {
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    expect(resolved.peer.nodeId).toBeNull();
    expect(resolved.peer.dataPlaneUrl).toBeNull();
    expect(resolved.peer.sharedSecret).toBeNull();
    expect(resolved.peer.path).toBe('/browserglass/node');

    const customBase = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      basePath: '/bgls',
    });
    expect(customBase.peer.path).toBe('/bgls/node');
  });

  it('peer.*: explicit config wins over env, matching every other section', () => {
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      peer: { nodeId: 'nod_explicit', sharedSecret: 'explicit-secret' },
      env: { BGLS_NODE_ID: 'nod_from_env', BGLS_PEER_SHARED_SECRET: 'env-secret' },
    });
    expect(resolved.peer.nodeId).toBe('nod_explicit');
    expect(resolved.peer.sharedSecret).toBe('explicit-secret');

    const fromEnv = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      env: {
        BGLS_NODE_ID: 'nod_from_env',
        BGLS_PEER_SHARED_SECRET: 'env-secret',
        BGLS_PEER_DATA_PLANE_URL: 'ws://gw-a:4000/browserglass/node',
      },
    });
    expect(fromEnv.peer.nodeId).toBe('nod_from_env');
    expect(fromEnv.peer.sharedSecret).toBe('env-secret');
    expect(fromEnv.peer.dataPlaneUrl).toBe('ws://gw-a:4000/browserglass/node');
  });

  it('peer.dataPlaneUrl set without peer.sharedSecret is a config error: an advertised peer address nothing can authenticate a connection to', () => {
    let error: ConfigError | undefined;
    try {
      resolveConfig({
        mode: 'gateway',
        router: { endpoint: 'https://router.example.com' },
        peer: { dataPlaneUrl: 'ws://gw-a:4000/browserglass/node' },
      });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    expect(error!.problems.map((p) => p.path)).toContain('peer.sharedSecret');

    // The same pairing with sharedSecret set is valid: the error is about
    // the missing secret specifically, not about setting dataPlaneUrl at
    // all.
    const ok = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      peer: { dataPlaneUrl: 'ws://gw-a:4000/browserglass/node', sharedSecret: 'shared' },
    });
    expect(ok.peer.dataPlaneUrl).toBe('ws://gw-a:4000/browserglass/node');
  });
});

/**
 * `session.control.mode` is the key that made shared control inert end to
 * end. It did not exist, the e2e harness set it anyway (through an
 * `as never` cast, because the type did not have it), `resolveConfig`
 * accepted it, and nothing ever read it. Ten e2e cases failed with the same
 * message, `{"granted":false,"queued":true,"position":1}`, which says
 * "somebody else is driving, you are queued" and gives no hint at all that
 * the mode was never selected.
 *
 * Two properties are pinned here, and the second matters more than the
 * first. One: the default is `'exclusive'`, which is a compatibility
 * promise, since `'shared'` removes exclusivity and some automation treats
 * exclusivity as a safety property. Two: a wrong VALUE is a loud
 * `ConfigError` from EITHER source, config field or env var. A config that
 * accepts `mode: 'shraed'` and quietly runs exclusive is the original
 * defect wearing a different hat.
 */
describe('resolveConfig: session.control.mode', () => {
  const base = { mode: 'gateway', router: { endpoint: 'https://router.example.com' } } as const;

  it("defaults to 'exclusive' so no existing deployment loses exclusivity by upgrading", () => {
    expect(resolveConfig({ ...base }).session.control.mode).toBe('exclusive');
  });

  it("carries an explicit 'shared' through to the resolved config", () => {
    const resolved = resolveConfig({ ...base, session: { control: { mode: 'shared' } } });
    expect(resolved.session.control.mode).toBe('shared');
  });

  it('reads BGLS_CONTROL_MODE, and explicit config still wins over it', () => {
    expect(
      resolveConfig({ ...base, env: { BGLS_CONTROL_MODE: 'shared' } }).session.control.mode,
    ).toBe('shared');
    expect(
      resolveConfig({
        ...base,
        session: { control: { mode: 'exclusive' } },
        env: { BGLS_CONTROL_MODE: 'shared' },
      }).session.control.mode,
    ).toBe('exclusive');
  });

  it('rejects a misspelled EXPLICIT value rather than silently running exclusive', () => {
    // The regression that matters. Before `resolve()` took a `validate`,
    // the explicit branch returned whatever it was handed, unchecked, on
    // the reasoning that TypeScript had already constrained it. That
    // reasoning fails for a JavaScript host, a JSON config file, or a cast
    // written to get around a key the types did not have yet.
    let error: ConfigError | undefined;
    try {
      resolveConfig({
        ...base,
        session: { control: { mode: 'shraed' as 'shared' } },
      });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = error!.problems.find((p) => p.path === 'session.control.mode');
    expect(problem).toBeDefined();
    expect(problem!.got).toBe('shraed');
    expect(problem!.expected).toBe("'exclusive' | 'shared'");
    expect(problem!.fix.length).toBeGreaterThan(0);
  });

  it('rejects a misspelled BGLS_CONTROL_MODE, naming the variable so an operator knows where to look', () => {
    let error: ConfigError | undefined;
    try {
      resolveConfig({ ...base, env: { BGLS_CONTROL_MODE: 'shraed' } });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = error!.problems.find((p) => p.path === 'session.control.mode');
    expect(problem).toBeDefined();
    expect(problem!.env).toBe('BGLS_CONTROL_MODE');
  });

  it('an empty BGLS_CONTROL_MODE is treated as unset, not as a bad value', () => {
    // Consistent with every other env-backed field here: an exported but
    // empty variable is how a shell says "not configured", and turning that
    // into a hard startup failure would break deployments that template
    // their env files.
    expect(resolveConfig({ ...base, env: { BGLS_CONTROL_MODE: '' } }).session.control.mode).toBe(
      'exclusive',
    );
  });
});

/**
 * `security.cdpProxyEnabled`, the raw CDP attach proxy's own opt-in gate
 * (`ws/cdp-upgrade.ts`, `rest/routes/cdp-discovery.ts`). Mirrors
 * `devtoolsEnabled`'s own test coverage above: off by default, explicit
 * config wins over env, and the env var name is exactly what the doc
 * comment on `SecurityConfig.cdpProxyEnabled` promises.
 */
describe('resolveConfig: security.cdpProxyEnabled and cdpProxyPath', () => {
  // `mode: 'gateway'` with a router endpoint, matching the `peer.*` suite
  // above: a valid, minimal config with none of `mode: 'embedded'`'s own
  // required `store`/`runtime`/`profiles.fs` fields, which this suite has
  // no reason to supply just to exercise one security.* flag.
  const gatewayBase = {
    mode: 'gateway' as const,
    router: { endpoint: 'https://router.example.com' },
  };

  it('defaults to false, and cdpProxyPath is derived from basePath', () => {
    const resolved = resolveConfig(gatewayBase);
    expect(resolved.security.cdpProxyEnabled).toBe(false);
    expect(resolved.cdpProxyPath).toBe('/browserglass/cdp');

    const customBase = resolveConfig({ ...gatewayBase, basePath: '/bgls' });
    expect(customBase.cdpProxyPath).toBe('/bgls/cdp');
  });

  it('explicit config turns it on', () => {
    const resolved = resolveConfig({
      ...gatewayBase,
      security: { cdpProxyEnabled: true },
    });
    expect(resolved.security.cdpProxyEnabled).toBe(true);
  });

  it('BGLS_CDP_PROXY_ENABLED turns it on from the environment', () => {
    const resolved = resolveConfig({
      ...gatewayBase,
      env: { BGLS_CDP_PROXY_ENABLED: 'true' },
    });
    expect(resolved.security.cdpProxyEnabled).toBe(true);
  });

  it('explicit config wins over the environment, matching every other security.* flag', () => {
    const resolved = resolveConfig({
      ...gatewayBase,
      security: { cdpProxyEnabled: false },
      env: { BGLS_CDP_PROXY_ENABLED: 'true' },
    });
    expect(resolved.security.cdpProxyEnabled).toBe(false);
  });

  it('an empty BGLS_CDP_PROXY_ENABLED is treated as unset, not as a bad value', () => {
    expect(
      resolveConfig({ ...gatewayBase, env: { BGLS_CDP_PROXY_ENABLED: '' } }).security
        .cdpProxyEnabled,
    ).toBe(false);
  });

  it('a malformed BGLS_CDP_PROXY_ENABLED is a collected ConfigError problem naming the env var', () => {
    let error: ConfigError | undefined;
    try {
      resolveConfig({ ...gatewayBase, env: { BGLS_CDP_PROXY_ENABLED: 'not-a-boolean' } });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = error!.problems.find((p) => p.path === 'security.cdpProxyEnabled');
    expect(problem).toBeDefined();
    expect(problem!.env).toBe('BGLS_CDP_PROXY_ENABLED');
  });

  it('peer.path colliding with the CDP proxy path is a collected ConfigError problem', () => {
    let error: ConfigError | undefined;
    try {
      resolveConfig({ ...gatewayBase, peer: { path: '/browserglass/cdp' } });
    } catch (err) {
      error = err as ConfigError;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const problem = error!.problems.find((p) => p.path === 'peer.path');
    expect(problem).toBeDefined();
    expect(problem!.expected).toContain('/browserglass/cdp');
  });

  it('cdpProxyPath is claimed regardless of whether cdpProxyEnabled is on: the flag only changes what handleCdpUpgrade does with a matching request, not whether the path is reserved', () => {
    const disabled = resolveConfig(gatewayBase);
    const enabled = resolveConfig({ ...gatewayBase, security: { cdpProxyEnabled: true } });
    expect(disabled.cdpProxyPath).toBe(enabled.cdpProxyPath);
  });
});

/**
 * `observability.auditSink` defaults to a store backed sink whenever a
 * `Store` is configured, so a deployment that configures nothing still
 * gets `audit_events` populated (`observability/store-audit-sink.ts`'s own
 * top comment has the full "why"). These pin the three cases that matter:
 * the default appears, an explicit operator sink always wins over it, and
 * no store means no default (nothing local to persist into).
 */
describe('resolveConfig: default observability.auditSink', () => {
  function embeddedConfigWith(store: Store) {
    return {
      mode: 'embedded' as const,
      tenantId: 'ten_1',
      appId: 'app_1',
      store,
      runtime: {
        list: async () => [],
        dispose: async () => undefined,
      } as unknown as BrowserRuntime,
      profiles: { dir: '/tmp/bgls-resolve-audit-test', fs: {} as unknown as ProfileFs },
    };
  }

  it('wires a real (non-noop) auditSink by default once a store is configured', async () => {
    const store = await createSqliteStore(':memory:', { memory: true });
    try {
      const resolved = resolveConfig(embeddedConfigWith(store));
      expect(resolved.observability.auditSink).toBeDefined();
      expect(typeof resolved.observability.auditSink?.emit).toBe('function');
      expect(typeof resolved.observability.auditSink?.flush).toBe('function');
    } finally {
      await store.close();
    }
  });

  it('an explicit observability.auditSink always wins over the default', async () => {
    const store = await createSqliteStore(':memory:', { memory: true });
    try {
      const explicit: AuditSink = { emit: () => undefined, flush: async () => undefined };
      const resolved = resolveConfig({
        ...embeddedConfigWith(store),
        observability: { auditSink: explicit },
      });
      expect(resolved.observability.auditSink).toBe(explicit);
    } finally {
      await store.close();
    }
  });

  it('no store configured means no default auditSink (gateway mode has nothing local to persist into)', () => {
    const resolved = resolveConfig({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    expect(resolved.observability.auditSink).toBeUndefined();
  });
});

describe('resolveConfig: limits.captureRatePerSec / captureBurst', () => {
  const base = { mode: 'gateway', router: { endpoint: 'https://router.example.com' } } as const;

  it('defaults to 5 per second with a burst of 10', () => {
    const resolved = resolveConfig({ ...base });
    expect(resolved.limits.captureRatePerSec).toBe(5);
    expect(resolved.limits.captureBurst).toBe(10);
  });

  it('reads BGLS_CAPTURE_RATE_PER_SEC and BGLS_CAPTURE_BURST', () => {
    const resolved = resolveConfig({
      ...base,
      env: { BGLS_CAPTURE_RATE_PER_SEC: '20', BGLS_CAPTURE_BURST: '50' },
    });
    expect(resolved.limits.captureRatePerSec).toBe(20);
    expect(resolved.limits.captureBurst).toBe(50);
  });

  it('explicit config wins over env', () => {
    const resolved = resolveConfig({
      ...base,
      limits: { captureRatePerSec: 2, captureBurst: 3 },
      env: { BGLS_CAPTURE_RATE_PER_SEC: '20', BGLS_CAPTURE_BURST: '50' },
    });
    expect(resolved.limits.captureRatePerSec).toBe(2);
    expect(resolved.limits.captureBurst).toBe(3);
  });

  it('setting only the rate scales the burst to twice the rate', () => {
    const resolved = resolveConfig({ ...base, limits: { captureRatePerSec: 30 } });
    expect(resolved.limits.captureBurst).toBe(60);
  });

  it('rejects a zero or non numeric rate', () => {
    expect(() => resolveConfig({ ...base, limits: { captureRatePerSec: 0 } })).toThrow(ConfigError);
    expect(() => resolveConfig({ ...base, env: { BGLS_CAPTURE_RATE_PER_SEC: 'fast' } })).toThrow(
      ConfigError,
    );
    expect(() => resolveConfig({ ...base, env: { BGLS_CAPTURE_BURST: '0' } })).toThrow(ConfigError);
  });
});
