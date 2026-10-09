/**
 * Regression tests for the two live security holes a security audit found
 * in `packages/server/src/rest/**`, both fixed alongside the presence
 * (viewer visibility) REST work in this same change:
 *
 *  - HOLE 1: `GET /v1/instances/:instanceId` and `GET /v1/instances`
 *    handed `instance.runtime.cdpWsUrl` (documented "Secret. Leaking this
 *    is full browser control.", `@browserglass/protocol`'s `entities.ts`)
 *    straight to any `view` capable caller. Fixed by `rest/redact.ts`.
 *  - HOLE 2: `POST /v1/tokens` was `capability: null` (skips the
 *    membership check, still resolves a Principal) and forwarded the
 *    request body straight to `ctx.tokens.issueWithMeta`, which clamps
 *    only against server wide `auth.maxCaps` and reads `tenantId`/`appId`
 *    from the body: any valid token, `view` only included, could mint
 *    itself `admin` for an arbitrary tenant. Fixed by gating the route
 *    `capability: 'admin'` and clamping the requested `caps`/`role`
 *    against the caller's own `principal.caps` in `routes/tokens.ts`.
 *
 * Both tests are written to FAIL against the pre-fix code (a `view`-only
 * token reading `cdpWsUrl` verbatim; a `view`-only token successfully
 * minting `admin`), not merely to assert the current, already-fixed
 * behaviour.
 */

import { type Capability, type Principal, newId } from '@browserglass/protocol';
import type { BrowserRouter, InstanceView } from '@browserglass/router';
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

const SECRET_CDP_WS_URL = 'ws://127.0.0.1:9222/devtools/browser/secret-full-control';

function fakeInstanceView(instanceId: string): InstanceView {
  return {
    instance: {
      id: instanceId,
      tenantId: 'ten_x',
      appId: 'app_x',
      poolId: null,
      subject: null,
      state: 'ready',
      stateReason: null,
      stateChangedAt: Date.now(),
      nodeId: 'nod_local',
      fence: 0,
      spec: {} as never,
      profileSpec: {} as never,
      profileId: null,
      sessionId: 'sess_x',
      runtime: {
        kind: 'host',
        pid: 1234,
        containerId: null,
        podName: null,
        cdpWsUrl: SECRET_CDP_WS_URL,
        cdpPort: 9222,
        chromeVersion: '120.0.0.0',
        profilePath: '/tmp/profile',
        startedAt: Date.now(),
        stealthProfile: null,
      } as never,
      acquiredAt: Date.now(),
      readyAt: Date.now(),
      releasedAt: null,
      expiresAt: Date.now() + 3_600_000,
      lastActivityAt: Date.now(),
      metadata: {},
      incidents: [],
      lifetime: 'viewer-bound',
    } as never,
    live: null,
  };
}

function fakeDescribeRouter(instanceId: string): BrowserRouter {
  const view = fakeInstanceView(instanceId);
  return {
    async describe(): Promise<InstanceView> {
      return view;
    },
    async list(): Promise<InstanceView[]> {
      return [view];
    },
  } as unknown as BrowserRouter;
}

async function buildHarness(router?: BrowserRouter): Promise<{
  ctx: RestContext;
  issueBearerToken: (caps: readonly Capability[]) => Promise<string>;
}> {
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
    async issueBearerToken(caps) {
      return tokens.issue({
        sub: newId('usr'),
        caps,
        // In-process, unbounded mint (the embedding host's own first
        // token) - deliberately not going through the REST route this
        // suite is testing.
        iUnderstandAdmin: caps.includes('admin'),
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
  opts?: { readonly token?: string; readonly body?: unknown },
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
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

describe('security audit: HOLE 1, cdpWsUrl redaction', () => {
  it('GET /v1/instances/:instanceId never hands cdpWsUrl to a view-only token', async () => {
    const { ctx, issueBearerToken } = await buildHarness(fakeDescribeRouter('inst_1'));
    const token = await issueBearerToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_1', { token });
    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET_CDP_WS_URL);
    expect((body['instance'] as Record<string, unknown>)?.['runtime']).toMatchObject({
      cdpWsUrl: expect.not.stringContaining('secret-full-control'),
    });
  });

  it('GET /v1/instances (list) never hands cdpWsUrl to a view-only token', async () => {
    const { ctx, issueBearerToken } = await buildHarness(fakeDescribeRouter('inst_1'));
    const token = await issueBearerToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances', { token });
    expect(status).toBe(200);
    expect(JSON.stringify(body)).not.toContain(SECRET_CDP_WS_URL);
  });

  /**
   * The two tests above passed while the hole was still open, which is why
   * this one exists. Redacting `cdpWsUrl` and leaving `cdpPort` closes
   * nothing: Chrome serves its own unauthenticated `/json/version` on that
   * port and returns the whole URL, browser GUID included. Verified live
   * against this gateway, taking ONLY `cdpPort` from an otherwise redacted
   * response:
   *
   *     $ curl http://127.0.0.1:51738/json/version
   *     "webSocketDebuggerUrl": "ws://127.0.0.1:51738/devtools/browser/94374977-..."
   *
   * So the assertion that matters is not "the URL string is absent", it is
   * "nothing in this payload leads back to the debug socket".
   */
  it('GET /v1/instances/:instanceId never hands cdpPort either, since /json/version turns a port back into the URL', async () => {
    const { ctx, issueBearerToken } = await buildHarness(fakeDescribeRouter('inst_1'));
    const token = await issueBearerToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_1', { token });
    expect(status).toBe(200);
    const runtime = (body['instance'] as Record<string, unknown>)?.['runtime'] as Record<
      string,
      unknown
    >;
    expect(runtime['cdpPort']).toBeNull();
  });

  it('GET /v1/instances (list) never hands cdpPort either', async () => {
    const { ctx, issueBearerToken } = await buildHarness(fakeDescribeRouter('inst_1'));
    const token = await issueBearerToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances', { token });
    expect(status).toBe(200);
    for (const row of body['items'] as Array<Record<string, unknown>>) {
      const runtime = (row['instance'] as Record<string, unknown>)?.['runtime'] as Record<
        string,
        unknown
      > | null;
      if (runtime !== null && runtime !== undefined) expect(runtime['cdpPort']).toBeNull();
    }
  });
});

describe('security audit: HOLE 2, POST /v1/tokens capability escalation', () => {
  let ctx: RestContext;
  let issueBearerToken: (caps: readonly Capability[]) => Promise<string>;

  beforeEach(async () => {
    const harness = await buildHarness();
    ctx = harness.ctx;
    issueBearerToken = harness.issueBearerToken;
  });

  it('a view-only token cannot reach the route at all (403, capability gate)', async () => {
    const token = await issueBearerToken(['view']);
    const { status, body } = await callRest(ctx, 'POST', '/v1/tokens', {
      token,
      body: { sub: 'victim', scope: { kind: 'global' }, caps: ['admin'] },
    });
    expect(status).toBe(403);
    expect(body['error']).toMatchObject({ code: 'E_FORBIDDEN' });
  });

  it('an admin-capable caller cannot mint a capability it does not itself hold (clamped, not merely gated)', async () => {
    // Holds `admin` (reaches the route) but not `cdp`/`evaluate`.
    const token = await issueBearerToken(['admin', 'view']);
    const { status, body } = await callRest(ctx, 'POST', '/v1/tokens', {
      token,
      body: {
        sub: 'victim',
        scope: { kind: 'global' },
        caps: ['admin', 'view', 'cdp', 'evaluate'],
        iUnderstandAdmin: true,
      },
    });
    expect(status).toBe(201);
    const issuedCaps = body['caps'] as string[];
    expect(issuedCaps.sort()).toEqual(['admin', 'view']);
    expect(issuedCaps).not.toContain('cdp');
    expect(issuedCaps).not.toContain('evaluate');
  });

  it('the role bundle path is clamped too, not only the explicit caps array', async () => {
    // `owner` expands to all 21 capabilities; this caller holds only two.
    const token = await issueBearerToken(['admin', 'view']);
    const { status, body } = await callRest(ctx, 'POST', '/v1/tokens', {
      token,
      body: { sub: 'victim', scope: { kind: 'global' }, role: 'owner', iUnderstandAdmin: true },
    });
    expect(status).toBe(201);
    const issuedCaps = (body['caps'] as string[]).sort();
    expect(issuedCaps).toEqual(['admin', 'view']);
  });

  it("tenantId/appId in the body are ignored: the minted token is scoped to the caller's own tenant", async () => {
    const token = await issueBearerToken(['admin']);
    const { status, body } = await callRest(ctx, 'POST', '/v1/tokens', {
      token,
      body: {
        sub: 'victim',
        scope: { kind: 'global' },
        caps: ['admin'],
        iUnderstandAdmin: true,
        tenantId: 'ten_someone_elses_tenant',
        appId: 'app_someone_elses_app',
      },
    });
    expect(status).toBe(201);
    // Decode the JWT payload (base64url, second segment) to inspect tid/aid directly.
    const jwt = body['token'] as string;
    const payload = JSON.parse(
      Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8'),
    ) as {
      tid: string;
      aid: string;
    };
    expect(payload.tid).not.toBe('ten_someone_elses_tenant');
    expect(payload.aid).not.toBe('app_someone_elses_app');
  });

  it('a broad "app credential" caller (the legitimate flow) can still mint a narrower token for an end user', async () => {
    const token = await issueBearerToken([
      'admin',
      'view',
      'control',
      'navigate',
      'tabs.manage',
      'automation',
    ]);
    const { status, body } = await callRest(ctx, 'POST', '/v1/tokens', {
      token,
      body: { sub: 'end_user', scope: { kind: 'global' }, caps: ['view', 'control'] },
    });
    expect(status).toBe(201);
    expect((body['caps'] as string[]).sort()).toEqual(['control', 'view']);
  });
});
