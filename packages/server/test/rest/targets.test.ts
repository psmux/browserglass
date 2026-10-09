/**
 * `routes/targets.ts`'s driving verbs and the CDP passthrough. Built
 * directly against `dispatchRest` with a hand-constructed `RestContext`
 * (rather than `createBrowserGlass`), because these routes need
 * `ctx.driver`/`ctx.cdp`, which nothing in `src/index.ts` wires yet (see
 * `rest/types.ts`'s `RestSessionDriver`/`RestCdpSender` doc comments). A
 * fake implementation of each is injected here so the routes' own logic
 * (parameter validation, capability gating, the CDP allowlist, the error
 * envelope) is exercised for real; `dispatch.test.ts` covers the
 * `createBrowserGlass`-wired path where those fields are absent.
 *
 * `ctx.getRouter()` returns a fake `BrowserRouter` (`fakeRouter`, below),
 * not a real one, because the property under test is that a driving
 * surface cannot act when the router refuses, and stubbing the router is
 * the direct way to prove it. This suite used to inject a fake `Store`
 * and let `resolveSessionId` read it directly, which hid the defect: none
 * of these routes had a router handle to call `describe()` through. Every
 * route here now resolves through `resolveDrive` -> `router.driveInstance` instead, and
 * `ctx.store` is never read by anything in this file.
 */

import type {
  Capability,
  NodeActionRequest,
  NodeActionResult,
  Principal,
  TargetSummary,
} from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import type { BrowserRouter, DriveResolution } from '@browserglass/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import type {
  DrivingContext,
  RestCdpSender,
  RestContext,
  RestSessionDriver,
} from '../../src/rest/types.js';

/** One instance's resolution state, as `fakeRouter` reports it. `gone`/`sessionId: null` mirror `BrowserRouter.driveInstance`'s own three way admission check exactly (`E_INSTANCE_GONE`/`E_INSTANCE_NOT_READY`), so this suite exercises the same error shapes the real gate throws. */
interface FakeInstance {
  readonly sessionId: string | null;
  readonly gone?: boolean;
  readonly nodeId?: string;
  readonly local?: boolean;
}

/**
 * A minimal `BrowserRouter` stand-in exposing only `driveInstance`/
 * `dispatchAction`, the two methods every route in `routes/targets.ts`
 * calls (`resolveDrive`, and `session/rest-driver.ts`'s forwarding path
 * for a non local `drive`). Cast through `unknown`, matching
 * `targets.test.ts`'s own former `fakeStore` pattern for a dependency
 * this suite exercises only through its declared contract.
 */
function fakeRouter(
  instances: ReadonlyMap<string, FakeInstance>,
  opts?: {
    readonly onDriveInstance?: (instanceId: string) => void;
    readonly dispatchAction?: (
      instanceId: string,
      req: NodeActionRequest,
      principal: Principal,
    ) => Promise<NodeActionResult>;
  },
): BrowserRouter {
  return {
    async driveInstance(instanceId: string, _principal: Principal): Promise<DriveResolution> {
      opts?.onDriveInstance?.(instanceId);
      const entry = instances.get(instanceId);
      if (!entry)
        throw {
          httpStatus: 404,
          code: 'E_INSTANCE_NOT_FOUND',
          message: `instance ${instanceId} not found`,
        };
      if (entry.gone)
        throw {
          httpStatus: 410,
          code: 'E_INSTANCE_GONE',
          message: `instance ${instanceId} is released`,
        };
      if (entry.sessionId === null) {
        throw {
          httpStatus: 409,
          code: 'E_INSTANCE_NOT_READY',
          message: `instance ${instanceId} is not ready`,
          retryAfterMs: 1000,
        };
      }
      return {
        instanceId,
        nodeId: entry.nodeId ?? 'nod_local',
        sessionId: entry.sessionId,
        local: entry.local ?? true,
      };
    },
    async dispatchAction(
      instanceId: string,
      req: NodeActionRequest,
      principal: Principal,
    ): Promise<NodeActionResult> {
      if (opts?.dispatchAction) return opts.dispatchAction(instanceId, req, principal);
      throw new Error('dispatchAction not stubbed in this test');
    },
  } as unknown as BrowserRouter;
}

function fakeTarget(overrides: Partial<TargetSummary> = {}): TargetSummary {
  return {
    targetId: 'tgt_1',
    kind: 'page',
    title: 'Example',
    url: 'https://example.com/',
    faviconUrl: null,
    index: 0,
    windowId: 1,
    active: true,
    audible: false,
    muted: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    openerTargetId: null,
    viewers: 0,
    createdAt: Date.now(),
    ...overrides,
  } as TargetSummary;
}

function fakeDriver(overrides: Partial<RestSessionDriver> = {}): RestSessionDriver {
  return {
    listTargets: async () => [fakeTarget()],
    createTarget: async (_drive, opts) => fakeTarget({ url: opts.url ?? 'about:blank' }),
    closeTarget: async () => undefined,
    navigate: async () => ({ url: 'https://example.com/', title: 'Example', loading: true }),
    screenshot: async () => ({ format: 'png', data: 'AAAA', width: 100, height: 100 }),
    click: async () => undefined,
    type: async () => undefined,
    setInputFiles: async (_drive, _targetId, req) => ({
      files: req.uploadIds.map((id) => `${id}.pdf`),
    }),
    ...overrides,
  };
}

function fakeCdp(overrides: Partial<RestCdpSender> = {}): RestCdpSender {
  return {
    send: async () => ({ ok: true }),
    ...overrides,
  };
}

/** One fully wired, in-process test harness: real EdDSA token issuance and verification, a fake router/driver/cdp injected directly into a hand-built `RestContext`. */
async function buildHarness(opts: {
  readonly instances?: ReadonlyMap<string, FakeInstance>;
  readonly driver?: RestSessionDriver;
  readonly cdp?: RestCdpSender;
  readonly routerOpts?: Parameters<typeof fakeRouter>[1];
}): Promise<{
  readonly ctx: RestContext;
  readonly tenantId: string;
  readonly appId: string;
  readonly issueToken: (caps: readonly Capability[]) => Promise<string>;
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

  const tokenApi = new TokenApiImpl({
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

  const hooks = new HookRegistry(undefined, {
    globalTimeoutMs: 5000,
    logger: resolved.logger.sink,
  });
  const router = fakeRouter(opts.instances ?? new Map(), opts.routerOpts);

  const ctx: RestContext = {
    config: resolved,
    getRouter: () => router,
    store: undefined,
    tokens: tokenApi,
    resolver,
    hooks,
    logger: resolved.logger.sink,
    isAccepting: () => true,
    isReady: () => true,
    driver: opts.driver,
    cdp: opts.cdp,
  };

  return {
    ctx,
    tenantId,
    appId,
    async issueToken(caps) {
      return tokenApi.issue({
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
  // `subPath` must be the bare path, no query string: `dispatchRest` matches
  // route patterns against it directly, and derives `rctx.query` separately
  // from `req.url` (which does carry the query string, via `request.url` above).
  await dispatchRest(ctx, req, res, new URL(request.url).pathname);
  const response = fetchResponseFromNode(await done);
  const status = response.status;
  const body = (await response.json()) as Record<string, unknown>;
  return { status, body };
}

describe('REST driving routes (routes/targets.ts)', () => {
  let instances: Map<string, FakeInstance>;

  beforeEach(() => {
    instances = new Map([['inst_1', { sessionId: 'sess_1' }]]);
  });

  describe('GET /v1/instances/:instanceId/targets', () => {
    it('happy path: lists targets via ctx.driver, capability view', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['view']);
      const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_1/targets', {
        token,
      });
      expect(status).toBe(200);
      expect(body['items']).toHaveLength(1);
      expect((body['items'] as TargetSummary[])[0]?.targetId).toBe('tgt_1');
    });

    it('capability denial: 403 without view', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['navigate']);
      const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_1/targets', {
        token,
      });
      expect(status).toBe(403);
      expect(body['error']).toMatchObject({
        code: 'E_FORBIDDEN',
        requestId: expect.stringMatching(/^req_/),
      });
    });

    it("error envelope: 503 E_DRIVER_UNAVAILABLE when ctx.driver is unset (this build's actual state)", async () => {
      const { ctx, issueToken } = await buildHarness({ instances });
      const token = await issueToken(['view']);
      const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_1/targets', {
        token,
      });
      expect(status).toBe(503);
      expect(body['error']).toMatchObject({ code: 'E_DRIVER_UNAVAILABLE' });
    });

    it('error envelope: 503 E_ROUTER_UNAVAILABLE when ctx.getRouter() is unset', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const routerlessCtx: RestContext = { ...ctx, getRouter: () => undefined };
      const token = await issueToken(['view']);
      const { status, body } = await callRest(
        routerlessCtx,
        'GET',
        '/v1/instances/inst_1/targets',
        { token },
      );
      expect(status).toBe(503);
      expect(body['error']).toMatchObject({ code: 'E_ROUTER_UNAVAILABLE' });
    });

    it('error envelope: 404 for an unknown instance (the router refuses, ctx.driver is never reached)', async () => {
      let driverCalled = false;
      const { ctx, issueToken } = await buildHarness({
        instances,
        driver: fakeDriver({
          listTargets: async () => {
            driverCalled = true;
            return [];
          },
        }),
      });
      const token = await issueToken(['view']);
      const { status, body } = await callRest(ctx, 'GET', '/v1/instances/does_not_exist/targets', {
        token,
      });
      expect(status).toBe(404);
      expect(body['error']).toMatchObject({ code: 'E_INSTANCE_NOT_FOUND' });
      expect(driverCalled).toBe(false);
    });

    it('error envelope: 409 for an instance with no live session yet', async () => {
      const { ctx, issueToken } = await buildHarness({
        instances: new Map([['inst_pending', { sessionId: null }]]),
        driver: fakeDriver(),
      });
      const token = await issueToken(['view']);
      const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_pending/targets', {
        token,
      });
      expect(status).toBe(409);
      expect(body['error']).toMatchObject({ code: 'E_INSTANCE_NOT_READY' });
    });

    it('error envelope: 410 for an already released instance, distinct from 409', async () => {
      const { ctx, issueToken } = await buildHarness({
        instances: new Map([['inst_gone', { sessionId: 'sess_x', gone: true }]]),
        driver: fakeDriver(),
      });
      const token = await issueToken(['view']);
      const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_gone/targets', {
        token,
      });
      expect(status).toBe(410);
      expect(body['error']).toMatchObject({ code: 'E_INSTANCE_GONE' });
    });
  });

  describe('POST /v1/instances/:instanceId/targets', () => {
    it('happy path: creates a target, capability tabs.manage', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['tabs.manage']);
      const { status, body } = await callRest(ctx, 'POST', '/v1/instances/inst_1/targets', {
        token,
        body: { url: 'https://example.com/' },
      });
      expect(status).toBe(201);
      expect(body['url']).toBe('https://example.com/');
    });

    it('capability denial: 403 without tabs.manage', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['view']);
      const { status } = await callRest(ctx, 'POST', '/v1/instances/inst_1/targets', {
        token,
        body: {},
      });
      expect(status).toBe(403);
    });
  });

  describe('DELETE /v1/instances/:instanceId/targets/:targetId', () => {
    it('happy path: closes a target, capability tabs.manage', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['tabs.manage']);
      const { status, body } = await callRest(ctx, 'DELETE', '/v1/instances/inst_1/targets/tgt_1', {
        token,
      });
      expect(status).toBe(200);
      expect(body['closed']).toBe(true);
    });

    it('capability denial: 403 without tabs.manage', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['view']);
      const { status } = await callRest(ctx, 'DELETE', '/v1/instances/inst_1/targets/tgt_1', {
        token,
      });
      expect(status).toBe(403);
    });
  });

  describe('POST /v1/instances/:instanceId/targets/:targetId/navigate', () => {
    it('happy path: navigates, capability navigate', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['navigate']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/navigate',
        {
          token,
          body: { url: 'https://example.com/' },
        },
      );
      expect(status).toBe(200);
      expect(body['url']).toBe('https://example.com/');
    });

    it('error envelope: 400 when kind is "goto" and url is missing', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['navigate']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/navigate',
        {
          token,
          body: {},
        },
      );
      expect(status).toBe(400);
      expect(body['error']).toMatchObject({ code: 'E_MISSING_PARAM' });
    });

    it('capability denial: 403 without navigate', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['view']);
      const { status } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/navigate',
        {
          token,
          body: { url: 'https://example.com/' },
        },
      );
      expect(status).toBe(403);
    });
  });

  describe('GET /v1/instances/:instanceId/targets/:targetId/screenshot', () => {
    it('happy path: screenshots, capability capture', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['capture']);
      const { status, body } = await callRest(
        ctx,
        'GET',
        '/v1/instances/inst_1/targets/tgt_1/screenshot',
        {
          token,
        },
      );
      expect(status).toBe(200);
      expect(body['format']).toBe('png');
      expect(body['data']).toBe('AAAA');
    });

    it('capability denial: 403 without capture', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['view']);
      const { status } = await callRest(
        ctx,
        'GET',
        '/v1/instances/inst_1/targets/tgt_1/screenshot',
        { token },
      );
      expect(status).toBe(403);
    });

    it('error envelope: 400 for an invalid format query param', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['capture']);
      const { status, body } = await callRest(
        ctx,
        'GET',
        '/v1/instances/inst_1/targets/tgt_1/screenshot?format=bmp',
        { token },
      );
      expect(status).toBe(400);
      expect(body['error']).toMatchObject({ code: 'E_INVALID_QUERY' });
    });
  });

  describe('POST /v1/instances/:instanceId/targets/:targetId/input', () => {
    it('happy path: click, capability control', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['control']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/input',
        {
          token,
          body: { action: 'click', x: 10, y: 20 },
        },
      );
      expect(status).toBe(200);
      expect(body['dispatched']).toBe(true);
    });

    it('happy path: type, capability control', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['control']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/input',
        {
          token,
          body: { action: 'type', text: 'hello' },
        },
      );
      expect(status).toBe(200);
      expect(body['dispatched']).toBe(true);
    });

    it('error envelope: 400 for an unknown action', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['control']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/input',
        {
          token,
          body: { action: 'scroll' },
        },
      );
      expect(status).toBe(400);
      expect(body['error']).toMatchObject({ code: 'E_INVALID_BODY' });
    });

    it('capability denial: 403 without control', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, driver: fakeDriver() });
      const token = await issueToken(['view']);
      const { status } = await callRest(ctx, 'POST', '/v1/instances/inst_1/targets/tgt_1/input', {
        token,
        body: { action: 'click', x: 1, y: 1 },
      });
      expect(status).toBe(403);
    });
  });

  describe('POST /v1/instances/:instanceId/targets/:targetId/cdp', () => {
    it('happy path: an allowlisted method reaches ctx.cdp, capability cdp', async () => {
      let received: { method: string; params: Record<string, unknown> } | undefined;
      const cdp = fakeCdp({
        send: async (_drive, _targetId, method, params) => {
          received = { method, params };
          return { screenshotBytes: 'AAAA' };
        },
      });
      const { ctx, issueToken } = await buildHarness({ instances, cdp });
      const token = await issueToken(['cdp']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/cdp',
        {
          token,
          body: { method: 'Page.captureScreenshot', params: { format: 'png' } },
        },
      );
      expect(status).toBe(200);
      expect(body['result']).toMatchObject({ screenshotBytes: 'AAAA' });
      expect(received).toMatchObject({
        method: 'Page.captureScreenshot',
        params: { format: 'png' },
      });
    });

    it('capability denial: 403 without the dedicated cdp capability, even holding devtools and automation', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, cdp: fakeCdp() });
      const token = await issueToken(['devtools', 'automation']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/cdp',
        {
          token,
          body: { method: 'Page.captureScreenshot' },
        },
      );
      expect(status).toBe(403);
      expect(body['error']).toMatchObject({ code: 'E_FORBIDDEN' });
    });

    it('refusal is the default: a method absent from the allowlist is refused holding cdp', async () => {
      let called = false;
      const cdp = fakeCdp({
        send: async () => {
          called = true;
          return {};
        },
      });
      const { ctx, issueToken } = await buildHarness({ instances, cdp });
      const token = await issueToken(['cdp']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/cdp',
        {
          token,
          body: { method: 'Page.someBrandNewMethodNobodyAddedYet' },
        },
      );
      expect(status).toBe(403);
      expect(body['error']).toMatchObject({ code: 'E_CDP_METHOD_NOT_ALLOWED' });
      expect(called).toBe(false);
    });

    it.each([
      ['Runtime.evaluate', 'arbitrary script execution'],
      ['Target.attachToTarget', 'reaches another target / browser-wide'],
      ['Browser.setDownloadBehavior', 'filesystem reach via downloads'],
      ['Page.setDownloadBehavior', 'filesystem reach via downloads'],
      ['Page.setBypassCSP', 'turns off a page protection'],
      ['Fetch.enable', 'full response interception'],
      ['Security.setIgnoreCertificateErrors', 'turns off TLS protections'],
    ])('explicitly refuses %s (%s) holding cdp, never reaching ctx.cdp', async (method) => {
      let called = false;
      const cdp = fakeCdp({
        send: async () => {
          called = true;
          return {};
        },
      });
      const { ctx, issueToken } = await buildHarness({ instances, cdp });
      const token = await issueToken(['cdp']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/cdp',
        {
          token,
          body: { method },
        },
      );
      expect(status).toBe(403);
      expect(body['error']).toMatchObject({ code: 'E_CDP_METHOD_NOT_ALLOWED' });
      expect(called).toBe(false);
    });

    it('error envelope: 400 when method is missing', async () => {
      const { ctx, issueToken } = await buildHarness({ instances, cdp: fakeCdp() });
      const token = await issueToken(['cdp']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/cdp',
        {
          token,
          body: {},
        },
      );
      expect(status).toBe(400);
      expect(body['error']).toMatchObject({ code: 'E_MISSING_PARAM' });
    });

    it("error envelope: 503 E_CDP_UNAVAILABLE when ctx.cdp is unset (this build's actual state)", async () => {
      const { ctx, issueToken } = await buildHarness({ instances });
      const token = await issueToken(['cdp']);
      const { status, body } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_1/targets/tgt_1/cdp',
        {
          token,
          body: { method: 'Page.captureScreenshot' },
        },
      );
      expect(status).toBe(503);
      expect(body['error']).toMatchObject({ code: 'E_CDP_UNAVAILABLE' });
    });
  });

  describe('the authority gate is called on every driving verb (idle reaper regression)', () => {
    // `navigate`/`screenshotTarget`/`sendCdp`/`clickTarget`/`typeTarget` are
    // named explicitly because these are exactly the five methods that
    // once never touched `onActivity`: an
    // instance driven only through one of them was force released by the
    // idle reaper mid use. `driveInstance` is what performs the throttled
    // `store.touchInstance` write that keeps the reaper away (proved at
    // the router level by `packages/router/test/router/drive.test.ts`);
    // this suite's job is only to prove every one of these REST verbs
    // actually reaches it, once per request, which it did not before.
    it('navigate, screenshot, cdp, click, and type each call router.driveInstance', async () => {
      const seen: string[] = [];
      const { ctx, issueToken } = await buildHarness({
        instances,
        driver: fakeDriver(),
        cdp: fakeCdp(),
        routerOpts: { onDriveInstance: (instanceId) => seen.push(instanceId) },
      });

      await callRest(ctx, 'POST', '/v1/instances/inst_1/targets/tgt_1/navigate', {
        token: await issueToken(['navigate']),
        body: { url: 'https://example.com/' },
      });
      await callRest(ctx, 'GET', '/v1/instances/inst_1/targets/tgt_1/screenshot', {
        token: await issueToken(['capture']),
      });
      await callRest(ctx, 'POST', '/v1/instances/inst_1/targets/tgt_1/cdp', {
        token: await issueToken(['cdp']),
        body: { method: 'Page.captureScreenshot' },
      });
      await callRest(ctx, 'POST', '/v1/instances/inst_1/targets/tgt_1/input', {
        token: await issueToken(['control']),
        body: { action: 'click', x: 1, y: 1 },
      });
      await callRest(ctx, 'POST', '/v1/instances/inst_1/targets/tgt_1/input', {
        token: await issueToken(['control']),
        body: { action: 'type', text: 'hi' },
      });

      expect(seen).toEqual(['inst_1', 'inst_1', 'inst_1', 'inst_1', 'inst_1']);
    });

    it('a router refusal is answered honestly and never reaches ctx.driver (the gate, not a bypass)', async () => {
      const driverSpy = vi.fn(async () => ({ url: 'x', title: 'x', loading: false }));
      const { ctx, issueToken } = await buildHarness({
        instances: new Map([['inst_pending', { sessionId: null }]]),
        driver: fakeDriver({ navigate: driverSpy }),
      });
      const { status } = await callRest(
        ctx,
        'POST',
        '/v1/instances/inst_pending/targets/tgt_1/navigate',
        {
          token: await issueToken(['navigate']),
          body: { url: 'https://example.com/' },
        },
      );
      expect(status).toBe(409);
      expect(driverSpy).not.toHaveBeenCalled();
    });
  });

  describe('N concurrent REST calls against different instances overlap in time', () => {
    // N concurrent REST calls against N different instances must run
    // concurrently, not serialize, and that is verified here rather than
    // assumed. `dispatchRest` awaits `route.handler` per call, and
    // Node's HTTP server already handles connections concurrently, but
    // that alone would not catch a driver, a lock, or some other shared
    // resource in the composition root accidentally serializing every
    // driving call regardless of which instance it targets. This proves
    // it empirically: two slow navigations against two different
    // instances, dispatched together, must both be in flight at once
    // (`maxInFlight` reaching 2) and must finish in roughly one delay's
    // worth of wall time, not two.
    it('two slow navigate calls against two different instances overlap rather than queue', async () => {
      const twoInstances = new Map([
        ['inst_a', { sessionId: 'sess_a' }],
        ['inst_b', { sessionId: 'sess_b' }],
      ]);
      const DELAY_MS = 60;
      let inFlight = 0;
      let maxInFlight = 0;
      const driver = fakeDriver({
        navigate: async (_drive, _targetId, _kind, params) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
          inFlight -= 1;
          return { url: params.url ?? 'https://example.com/', title: 'Example', loading: false };
        },
      });
      const { ctx, issueToken } = await buildHarness({ instances: twoInstances, driver });
      const [tokenA, tokenB] = await Promise.all([
        issueToken(['navigate']),
        issueToken(['navigate']),
      ]);

      const started = Date.now();
      const [resA, resB] = await Promise.all([
        callRest(ctx, 'POST', '/v1/instances/inst_a/targets/tgt_1/navigate', {
          token: tokenA,
          body: { kind: 'goto', url: 'https://example.com/a' },
        }),
        callRest(ctx, 'POST', '/v1/instances/inst_b/targets/tgt_1/navigate', {
          token: tokenB,
          body: { kind: 'goto', url: 'https://example.com/b' },
        }),
      ]);
      const elapsedMs = Date.now() - started;

      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      // Both handlers were mid `navigate` at the same instant: had they
      // serialized, `maxInFlight` would never exceed 1.
      expect(maxInFlight).toBe(2);
      // A serialized pair would take at least 2 * DELAY_MS; comfortably
      // under that (with headroom for scheduler jitter) proves overlap
      // rather than merely "not egregiously slow".
      expect(elapsedMs).toBeLessThan(DELAY_MS * 2 - 10);
    });
  });
});
