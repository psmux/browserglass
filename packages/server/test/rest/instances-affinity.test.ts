import { type Capability, type Principal, newId } from '@browserglass/protocol';
import type {
  AcquireHandle,
  AcquireRequest,
  BrowserRouter,
  ReleaseOptions,
  ReleaseResult,
} from '@browserglass/router';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppSigningKey,
  InProcessJtiCache,
  TokenApiImpl,
  generateEd25519KeyMaterial,
  jwtAuthResolver,
} from '../../src/auth/index.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { HookRegistry } from '../../src/hooks/dispatch.js';
import { fetchResponseFromNode, nodeRequestFromFetch } from '../../src/rest/fetch-bridge.js';
import { dispatchRest } from '../../src/rest/router.js';
import type { RestContext } from '../../src/rest/types.js';

/**
 * `POST /v1/instances`'s affinity selector, and `DELETE /v1/instances/:id`'s
 * release outcome.
 *
 * REST is the on-ramp every non-JavaScript caller uses, and its acquire
 * body has always been forwarded to `router.acquire` verbatim, so
 * `sticky` reached the router before this suite existed. What did not
 * exist was any check that the caller spelled it correctly: a `sticky`
 * that is a bare string, or one with no `subject`, produced a fresh
 * browser and a 201, which looks exactly like success and is exactly the
 * symptom the caller was trying to cure. These tests pin the 400s, and
 * pin that a well formed request still passes through untouched.
 *
 * The router here is a stand-in exposing only `acquire`/`release`, cast
 * through `unknown` in the same style as `targets.test.ts`'s own
 * `fakeRouter`: the point is what the route hands the router, not what a
 * real router then does with it.
 */
interface RecordedAcquire {
  readonly req: AcquireRequest;
  readonly principal: Principal;
}

function fakeRouter(
  recorded: {
    acquires: RecordedAcquire[];
    releases: Array<{ instanceId: string; opts: ReleaseOptions }>;
  },
  releaseResult?: Partial<ReleaseResult>,
): BrowserRouter {
  return {
    async acquire(req: AcquireRequest, principal: Principal): Promise<AcquireHandle> {
      recorded.acquires.push({ req, principal });
      return {
        result: {
          instanceId: 'inst_fake',
          sessionId: 'sess_fake',
          state: 'ready',
          reused: false,
          reuseReason: null,
        },
      } as unknown as AcquireHandle;
    },
    async release(instanceId: string, opts: ReleaseOptions): Promise<ReleaseResult> {
      recorded.releases.push({ instanceId, opts });
      return {
        instanceId: instanceId as ReleaseResult['instanceId'],
        outcome: 'terminated',
        remainingViewers: 0,
        ...releaseResult,
      };
    },
  } as unknown as BrowserRouter;
}

async function buildHarness(
  router: BrowserRouter,
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
    hooks: new HookRegistry(undefined, { globalTimeoutMs: 5000, logger: resolved.logger.sink }),
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

describe('POST /v1/instances affinity selector', () => {
  let recorded: {
    acquires: RecordedAcquire[];
    releases: Array<{ instanceId: string; opts: ReleaseOptions }>;
  };
  let ctx: RestContext;
  /**
   * A FRESH token per request, never one hoisted into `beforeEach`:
   * `InProcessJtiCache` enforces single use, so replaying one token across
   * two calls in the same test fails the second with a 401 that has
   * nothing to do with what is under test.
   */
  let token: () => Promise<string>;

  beforeEach(async () => {
    recorded = { acquires: [], releases: [] };
    const harness = await buildHarness(fakeRouter(recorded));
    ctx = harness.ctx;
    token = () => harness.issueToken(['instance.create', 'instance.destroy', 'view']);
  });

  it('passes a well formed sticky selector through to the router untouched', async () => {
    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await token(),
      body: { pool: 'default', sticky: { subject: 'alice', withinMs: 900_000 }, subject: 'alice' },
    });
    expect(res.status).toBe(201);
    expect(recorded.acquires).toHaveLength(1);
    expect(recorded.acquires[0]?.req.sticky).toEqual({ subject: 'alice', withinMs: 900_000 });
    expect(recorded.acquires[0]?.req.subject).toBe('alice');
  });

  it('accepts an ephemeral profile alongside sticky, the throwaway-but-mine case', async () => {
    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await token(),
      body: { profile: { mode: 'ephemeral' }, sticky: { subject: 'alice' }, subject: 'alice' },
    });
    expect(res.status).toBe(201);
    expect(recorded.acquires[0]?.req.profile).toEqual({ mode: 'ephemeral' });
  });

  it('a bare acquire reaches the router with no selector at all: the default is launch, not reuse', async () => {
    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await token(),
      body: { pool: 'default' },
    });
    expect(res.status).toBe(201);
    expect(recorded.acquires[0]?.req.sticky).toBeUndefined();
    expect(recorded.acquires[0]?.req.subject).toBeUndefined();
  });

  it('rejects sticky sent as a bare string rather than launching a browser and reporting success', async () => {
    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await token(),
      body: { sticky: 'alice' },
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatchObject({ code: 'E_INVALID_BODY' });
    // The router is never reached, so no browser is launched by a typo.
    expect(recorded.acquires).toHaveLength(0);
  });

  it('rejects sticky with a missing or empty subject', async () => {
    for (const sticky of [{}, { subject: '' }, { subject: 42 }, { withinMs: 1000 }]) {
      const res = await callRest(ctx, 'POST', '/v1/instances', {
        token: await token(),
        body: { sticky },
      });
      expect(res.status).toBe(400);
      expect(String((res.body['error'] as { message: string }).message)).toMatch(/sticky\.subject/);
    }
    expect(recorded.acquires).toHaveLength(0);
  });

  it('rejects a non-positive or non-numeric sticky.withinMs', async () => {
    for (const withinMs of [0, -1, 'soon']) {
      const res = await callRest(ctx, 'POST', '/v1/instances', {
        token: await token(),
        body: { sticky: { subject: 'alice', withinMs } },
      });
      expect(res.status).toBe(400);
      expect(String((res.body['error'] as { message: string }).message)).toMatch(/withinMs/);
    }
  });

  it('rejects an empty subject on its own', async () => {
    const res = await callRest(ctx, 'POST', '/v1/instances', {
      token: await token(),
      body: { subject: '' },
    });
    expect(res.status).toBe(400);
    expect(recorded.acquires).toHaveLength(0);
  });
});

describe('DELETE /v1/instances/:id release outcome', () => {
  it("reports the router's ReleaseResult, not a bare released flag", async () => {
    const recorded = {
      acquires: [] as RecordedAcquire[],
      releases: [] as Array<{ instanceId: string; opts: ReleaseOptions }>,
    };
    const harness = await buildHarness(fakeRouter(recorded));
    const token = () => harness.issueToken(['instance.destroy']);

    const res = await callRest(harness.ctx, 'DELETE', '/v1/instances/inst_1', {
      token: await token(),
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ released: true, outcome: 'terminated', remainingViewers: 0 });
  });

  it('reports released:false when the instance was only detached because other viewers remain', async () => {
    const recorded = {
      acquires: [] as RecordedAcquire[],
      releases: [] as Array<{ instanceId: string; opts: ReleaseOptions }>,
    };
    const harness = await buildHarness(
      fakeRouter(recorded, { outcome: 'detached', remainingViewers: 2 }),
    );
    const token = () => harness.issueToken(['instance.destroy']);

    const res = await callRest(harness.ctx, 'DELETE', '/v1/instances/inst_1', {
      token: await token(),
    });
    expect(res.body).toMatchObject({ released: false, outcome: 'detached', remainingViewers: 2 });
  });

  it('forwards ?force=true so a caller can end a shared instance deliberately', async () => {
    const recorded = {
      acquires: [] as RecordedAcquire[],
      releases: [] as Array<{ instanceId: string; opts: ReleaseOptions }>,
    };
    const harness = await buildHarness(fakeRouter(recorded));
    const token = () => harness.issueToken(['instance.destroy']);

    await callRest(harness.ctx, 'DELETE', '/v1/instances/inst_1?force=true', {
      token: await token(),
    });
    expect(recorded.releases[0]?.opts.force).toBe(true);

    await callRest(harness.ctx, 'DELETE', '/v1/instances/inst_1', { token: await token() });
    expect(recorded.releases[1]?.opts.force).toBeUndefined();
  });
});
