/**
 * `onInstanceLaunched`, `onInstanceReleased`, and `onQuotaExceeded`: the
 * three hooks that fire from `rest/routes/instances.ts`, all of them after
 * the REST response is already written (see `fireInstanceLaunched`'s own
 * doc for why: none of the three vetoes, `HOOK_TIMEOUTS`, so there is
 * nothing for the caller to wait on, and each does its own background
 * `HookRegistry.dispatch` call). Because firing happens in the background,
 * every test here waits on a promise that resolves when the handler
 * itself was called, rather than asserting immediately after the REST
 * response comes back.
 *
 * The fake router mirrors `test/rest/instances-affinity.test.ts`'s own
 * `fakeRouter`, extended with `describe()`, which neither `acquireInstance`
 * nor `releaseInstance` needed before hooks fired from them.
 */

import { type Capability, type Principal, newId } from '@browserglass/protocol';
import type {
  AcquireHandle,
  AcquireRequest,
  BrowserRouter,
  ReleaseOptions,
  ReleaseResult,
} from '@browserglass/router';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AppSigningKey,
  InProcessJtiCache,
  TokenApiImpl,
  generateEd25519KeyMaterial,
  jwtAuthResolver,
} from '../../src/auth/index.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { HookRegistry } from '../../src/hooks/dispatch.js';
import type {
  InstanceLaunchedEvent,
  InstanceReleasedEvent,
  QuotaExceededEvent,
} from '../../src/hooks/types.js';
import { fetchResponseFromNode, nodeRequestFromFetch } from '../../src/rest/fetch-bridge.js';
import { dispatchRest } from '../../src/rest/router.js';
import type { RestContext } from '../../src/rest/types.js';

interface Recorded {
  acquires: Array<{ req: AcquireRequest; principal: Principal }>;
  releases: Array<{ instanceId: string; opts: ReleaseOptions }>;
}

/** Resolves the promise the first time it is called; every later call is a no-op. Lets a test await "the background dispatch ran" without a fixed sleep. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function fakeRouter(
  recorded: Recorded,
  opts: {
    acquireThrows?: unknown;
    releaseResult?: Partial<ReleaseResult>;
  } = {},
): BrowserRouter {
  return {
    async acquire(req: AcquireRequest, principal: Principal): Promise<AcquireHandle> {
      recorded.acquires.push({ req, principal });
      if (opts.acquireThrows) throw opts.acquireThrows;
      const result = {
        instanceId: 'inst_1',
        sessionId: 'sess_1',
        state: 'ready',
        node: { nodeId: 'nod_1', region: null, labels: {} },
        profile: {
          profileId: 'prf_1',
          key: 'eph:inst_1',
          mode: 'ephemeral',
          created: true,
          sizeBytes: null,
        },
        reused: false,
        reuseReason: null,
        rejectedOverrides: [],
        effectiveSpec: { locale: 'en-US' },
        timings: { admissionMs: 1, placementMs: 2, profileMs: 3, launchMs: 40, totalMs: 50 },
        expiresAt: Date.now() + 60_000,
        fence: 1,
      } as unknown as AcquireHandle['result'];
      return { result, ready: Promise.resolve(result) };
    },
    async release(instanceId: string, opts2: ReleaseOptions): Promise<ReleaseResult> {
      recorded.releases.push({ instanceId, opts: opts2 });
      return {
        instanceId: instanceId as ReleaseResult['instanceId'],
        outcome: 'terminated',
        remainingViewers: 0,
        ...opts.releaseResult,
      };
    },
    async describe(instanceId: unknown) {
      return {
        instance: {
          id: instanceId,
          poolId: 'pool_1',
          subject: 'sub_1',
          sessionId: 'sess_1',
          acquiredAt: Date.now() - 5_000,
          metadata: { env: 'test' },
        },
      };
    },
  } as unknown as BrowserRouter;
}

async function buildHarness(
  router: BrowserRouter,
  hooks: HookRegistry,
): Promise<{ ctx: RestContext; issueToken: (caps: readonly Capability[]) => Promise<string> }> {
  const tenantId = newId('ten');
  const appId = newId('app');
  const keyMaterial = generateEd25519KeyMaterial();
  const signingKey: AppSigningKey = {
    kid: 'test-key',
    alg: 'EdDSA',
    publicKey: keyMaterial.publicKey,
    privateKey: keyMaterial.privateKey,
    status: 'active',
  };
  const resolved = resolveConfig({
    mode: 'gateway',
    tenantId,
    appId,
    router: { endpoint: 'https://router.example.com' },
    auth: { keys: [signingKey], issuer: appId },
  });
  const jtiCache = new InProcessJtiCache(resolved.auth.jtiCacheSize);
  const resolver = jwtAuthResolver({
    keys: resolved.auth.keys,
    tenantId: resolved.tenantId,
    appId: resolved.appId,
    issuer: resolved.auth.issuer,
    clockSkewSeconds: resolved.auth.clockSkewSeconds,
    jtiCache,
  });
  const tokens = new TokenApiImpl({
    keys: resolved.auth.keys,
    defaultTtlSeconds: resolved.auth.defaultTtlSeconds,
    maxTtlSeconds: resolved.auth.maxTtlSeconds,
    maxCaps: resolved.auth.maxCaps,
    tenantAllowedCaps: resolved.auth.maxCaps,
    clock: { now: () => Date.now() },
    tenantId: resolved.tenantId,
    appId: resolved.appId,
    issuer: resolved.auth.issuer,
    clockSkewSeconds: resolved.auth.clockSkewSeconds,
    jtiCache,
  });
  const ctx: RestContext = {
    config: resolved,
    getRouter: () => router,
    store: undefined,
    tokens,
    resolver,
    hooks,
    logger: resolved.logger.sink,
    isAccepting: () => true,
    isReady: () => true,
  };
  return {
    ctx,
    async issueToken(caps) {
      return tokens.issue({
        sub: newId('usr'),
        caps,
        scope: { kind: 'global' },
        tenantId,
        appId,
        ttlSeconds: 300,
      });
    },
  };
}

async function callRest(
  ctx: RestContext,
  method: string,
  path: string,
  opts?: { token?: string; body?: unknown },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers = new Headers();
  if (opts?.token !== undefined) headers.set('authorization', `Bearer ${opts.token}`);
  if (opts?.body !== undefined) headers.set('content-type', 'application/json');
  const request = new Request(`http://localhost${path}`, {
    method,
    headers,
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const { req, res, done } = nodeRequestFromFetch(request);
  await dispatchRest(ctx, req, res, new URL(request.url).pathname);
  const response = fetchResponseFromNode(await done);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function silentLogger() {
  const fn = () => undefined;
  return { trace: fn, debug: fn, info: fn, warn: fn, error: fn } as never;
}

describe('onInstanceLaunched: fire', () => {
  it('fires after the 201, with the real instanceId/sessionId/poolId/subject/metadata/timings', async () => {
    const hooks = new HookRegistry(undefined, { globalTimeoutMs: 2000, logger: silentLogger() });
    const seen = deferred<InstanceLaunchedEvent>();
    hooks.on('onInstanceLaunched', (e) => {
      seen.resolve(e);
    });
    const recorded: Recorded = { acquires: [], releases: [] };
    const { ctx, issueToken } = await buildHarness(fakeRouter(recorded), hooks);

    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await issueToken(['instance.create']),
      body: {},
    });
    expect(res.status).toBe(201);

    const event = await seen.promise;
    expect(event.instanceId).toBe('inst_1');
    expect(event.sessionId).toBe('sess_1');
    expect(event.nodeId).toBe('nod_1');
    expect(event.poolId).toBe('pool_1');
    expect(event.subject).toBe('sub_1');
    expect(event.reused).toBe(false);
    expect(event.metadata).toEqual({ env: 'test' });
    expect(event.timings).toEqual({ profileMs: 3, launchMs: 40, totalMs: 50 });
    expect(event.profile).toEqual({
      profileId: 'prf_1',
      key: 'eph:inst_1',
      mode: 'ephemeral',
      created: true,
    });
  });
});

describe('onInstanceReleased: fire', () => {
  it('fires after a terminating release, with sessionId and a positive durationMs', async () => {
    const hooks = new HookRegistry(undefined, { globalTimeoutMs: 2000, logger: silentLogger() });
    const seen = deferred<InstanceReleasedEvent>();
    hooks.on('onInstanceReleased', (e) => {
      seen.resolve(e);
    });
    const recorded: Recorded = { acquires: [], releases: [] };
    const { ctx, issueToken } = await buildHarness(fakeRouter(recorded), hooks);

    const res = await callRest(ctx, 'DELETE', '/v1/instances/inst_1', {
      token: await issueToken(['instance.destroy']),
    });
    expect(res.status).toBe(200);

    const event = await seen.promise;
    expect(event.instanceId).toBe('inst_1');
    expect(event.sessionId).toBe('sess_1');
    expect(event.durationMs).toBeGreaterThan(0);
    expect(event.profileAction).toBe('keep');
    // Honestly unavailable at this call site, documented at the call site
    // itself (`rest/routes/instances.ts`'s `fireInstanceReleased`).
    expect(event.profileBytes).toBeNull();
    expect(event.framesSent).toBe(0);
    expect(event.bytesSent).toBe(0);
  });

  it('does NOT fire when the outcome is "detached" (another viewer is still on it): nothing actually ended', async () => {
    const hooks = new HookRegistry(undefined, { globalTimeoutMs: 2000, logger: silentLogger() });
    let fired = false;
    hooks.on('onInstanceReleased', () => {
      fired = true;
    });
    const recorded: Recorded = { acquires: [], releases: [] };
    const { ctx, issueToken } = await buildHarness(
      fakeRouter(recorded, { releaseResult: { outcome: 'detached', remainingViewers: 2 } }),
      hooks,
    );

    const res = await callRest(ctx, 'DELETE', '/v1/instances/inst_1', {
      token: await issueToken(['instance.destroy']),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'detached' });
    // Give the (nonexistent) background dispatch a chance to run before
    // asserting a negative.
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(false);
  });
});

describe('onQuotaExceeded: fire', () => {
  it('fires on E_QUOTA_INSTANCES with the breached scope, limit name, and rejected action', async () => {
    const hooks = new HookRegistry(undefined, { globalTimeoutMs: 2000, logger: silentLogger() });
    const seen = deferred<QuotaExceededEvent>();
    hooks.on('onQuotaExceeded', (e) => {
      seen.resolve(e);
    });
    const recorded: Recorded = { acquires: [], releases: [] };
    const quotaErr = {
      httpStatus: 429,
      code: 'E_QUOTA_INSTANCES',
      message: 'quota exceeded at scope tenant',
      context: { scope: 'tenant', limit: 10, current: 10 },
    };
    const { ctx, issueToken } = await buildHarness(
      fakeRouter(recorded, { acquireThrows: quotaErr }),
      hooks,
    );

    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await issueToken(['instance.create']),
      body: { subject: 'alice' },
    });
    expect(res.status).toBe(429);

    const event = await seen.promise;
    expect(event.scope).toBe('tenant');
    expect(event.limit).toBe('maxInstances');
    expect(event.limitValue).toBe(10);
    expect(event.current).toBe(10);
    expect(event.subject).toBe('alice');
    expect(event.action).toBe('rejected');
  });

  it('does not fire for an unrelated router error', async () => {
    const hooks = new HookRegistry(undefined, { globalTimeoutMs: 2000, logger: silentLogger() });
    let fired = false;
    hooks.on('onQuotaExceeded', () => {
      fired = true;
    });
    const recorded: Recorded = { acquires: [], releases: [] };
    const otherErr = { httpStatus: 409, code: 'E_POOL_PAUSED', message: 'pool paused' };
    const { ctx, issueToken } = await buildHarness(
      fakeRouter(recorded, { acquireThrows: otherErr }),
      hooks,
    );

    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await issueToken(['instance.create']),
      body: {},
    });
    expect(res.status).toBe(409);
    await new Promise((r) => setTimeout(r, 20));
    expect(fired).toBe(false);
  });
});
