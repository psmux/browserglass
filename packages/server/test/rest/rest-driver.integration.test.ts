/**
 * Integration coverage for `session/rest-driver.ts`: the piece
 * `rest/routes/targets.ts`'s own module doc names as missing
 * (`ctx.driver`/`ctx.cdp`, "nothing in `src/index.ts` wires yet"). This
 * suite proves the wiring is now real, over the same fake Chrome harness
 * `test/ws/support/fake-chrome-server.ts` provides for `core`/`ws` suites
 * (`test-gateway.ts`'s own pattern for a real `CdpBridge` connected to it
 * without a real `BrowserRouter`), not the 37 tests `test/rest/targets.test.ts`
 * already has against injected fakes (parameter validation, capability
 * gating, the CDP allowlist): those are unchanged and untouched here.
 *
 * `ctx.getRouter()` returns a fake `BrowserRouter` (`fakeRouter`), not a
 * real one, matching `targets.test.ts`'s own choice: this suite's own
 * job is proving `createRestSessionDriver`/`createRestCdpSender`
 * themselves resolve local vs. remote correctly and forward through
 * `dispatchAction` when non local, not re-proving `driveInstance`'s own
 * admission/activity/audit contract (that is `packages/router/test/router/drive.test.ts`'s
 * job).
 */

import { createCdpBridge, createTargetRegistry } from '@browserglass/core';
import {
  type Capability,
  type NodeActionRequest,
  type NodeActionResult,
  type Principal,
  type TargetSummary,
  newId,
} from '@browserglass/protocol';
import type { BrowserRouter, DriveResolution } from '@browserglass/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppSigningKey,
  InProcessJtiCache,
  TokenApiImpl,
  generateEd25519KeyMaterial,
  jwtAuthResolver,
} from '../../src/auth/index.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { HookRegistry } from '../../src/hooks/dispatch.js';
import { createBrowserGlass } from '../../src/index.js';
import { fetchResponseFromNode, nodeRequestFromFetch } from '../../src/rest/fetch-bridge.js';
import { dispatchRest } from '../../src/rest/router.js';
import type { RestContext } from '../../src/rest/types.js';
import {
  ManagedSession,
  SessionRegistry,
  createRestCdpSender,
  createRestSessionDriver,
} from '../../src/session/index.js';
import { type FakeChromeServer, startFakeChromeServer } from '../ws/support/fake-chrome-server.js';

/** One instance's resolution state, matching `targets.test.ts`'s own `FakeInstance`. */
interface FakeInstance {
  readonly sessionId: string | null;
  readonly gone?: boolean;
  readonly nodeId?: string;
  readonly local?: boolean;
}

/** A minimal `BrowserRouter` stand-in exposing only `driveInstance`/`dispatchAction`, matching `targets.test.ts`'s own `fakeRouter` helper (duplicated rather than imported: the two suites want independent fixtures, the same reason `rest-driver.ts`'s own module doc gives for not sharing `findManaged` with `session-api.ts`). */
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

/** Matches `targets.test.ts`'s own `callRest` helper exactly: a real `dispatchRest` call through the fetch bridge. */
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
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

describe('REST driving routes, wired for real (session/rest-driver.ts)', () => {
  let chrome: FakeChromeServer;
  let sessionRegistry: SessionRegistry;
  let tenantId: string;
  let appId: string;
  let instanceId: string;
  let ctx: RestContext;
  let driveInstanceCalls: string[];
  let issueToken: (caps: readonly Capability[]) => Promise<string>;

  beforeEach(async () => {
    chrome = await startFakeChromeServer();
    // Bypasses `BrowserRouter` the same way `test-gateway.ts` does: a real
    // `CdpBridge` connected straight to the fake Chrome socket. Called
    // directly here (`getOrCreate`), not through a WS `hello`: nothing
    // about `session/rest-driver.ts`'s own logic needs a socket, only a
    // live entry in `SessionRegistry`.
    sessionRegistry = new SessionRegistry(async (reqInstanceId, sctx) => {
      const bridge = createCdpBridge(reqInstanceId as never);
      await bridge.connect({ url: chrome.url });
      const registry = createTargetRegistry(reqInstanceId as never, bridge);
      await registry.start();
      return new ManagedSession({
        instanceId: reqInstanceId,
        sessionId: newId('sess'),
        tenantId: sctx.tenantId,
        appId: sctx.appId,
        nodeId: 'nod_test',
        bridge,
        registry,
      });
    });

    tenantId = newId('ten');
    appId = newId('app');
    instanceId = newId('inst');
    const managed = await sessionRegistry.getOrCreate(instanceId, { tenantId, appId });

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

    driveInstanceCalls = [];
    const router = fakeRouter(
      new Map([[instanceId, { sessionId: managed.sessionId, local: true }]]),
      {
        onDriveInstance: (id) => driveInstanceCalls.push(id),
      },
    );

    // `session/rest-driver.ts`'s two factories, the exact ones
    // `src/index.ts`'s composition root now calls: the piece under test.
    ctx = {
      config: resolved,
      getRouter: () => router,
      store: undefined,
      tokens: tokenApi,
      resolver,
      hooks,
      logger: resolved.logger.sink,
      isAccepting: () => true,
      isReady: () => true,
      driver: createRestSessionDriver(sessionRegistry, () => router),
      cdp: createRestCdpSender(sessionRegistry, () => router),
    };
    issueToken = (caps) =>
      tokenApi.issue({
        sub: newId('usr'),
        caps,
        scope: { kind: 'instance', instanceId, targets: '*' },
        tenantId,
        appId,
        ttlSeconds: 300,
      });
  });

  afterEach(async () => {
    sessionRegistry.disposeAll();
    await chrome.close();
  });

  it('drives one target end to end: create, list, navigate, screenshot, click, type, cdp passthrough, close', async () => {
    const created = await callRest(ctx, 'POST', `/v1/instances/${instanceId}/targets`, {
      token: await issueToken(['tabs.manage']),
      body: { url: 'https://example.com/' },
    });
    expect(created.status).toBe(201);
    const targetId = (created.body as unknown as TargetSummary).targetId;
    expect(typeof targetId).toBe('string');
    // Proves this went all the way to the real fake Chrome socket, not just
    // to a `ManagedSession` method that happened to return without error:
    // `TargetSummary.targetId` is `core`'s own `newId('tgt')`, not Chrome's
    // raw id, so the only way to see the real request Chrome received is
    // through the fake server's own call log.
    expect(chrome.createTargetCalls).toContainEqual(
      expect.objectContaining({ url: 'https://example.com/' }),
    );

    const listed = await callRest(ctx, 'GET', `/v1/instances/${instanceId}/targets`, {
      token: await issueToken(['view']),
    });
    expect(listed.status).toBe(200);
    expect((listed.body['items'] as TargetSummary[]).some((t) => t.targetId === targetId)).toBe(
      true,
    );

    const navigated = await callRest(
      ctx,
      'POST',
      `/v1/instances/${instanceId}/targets/${targetId}/navigate`,
      {
        token: await issueToken(['navigate']),
        body: { kind: 'goto', url: 'https://example.org/' },
      },
    );
    expect(navigated.status).toBe(200);

    const shot = await callRest(
      ctx,
      'GET',
      `/v1/instances/${instanceId}/targets/${targetId}/screenshot`,
      {
        token: await issueToken(['capture']),
      },
    );
    expect(shot.status).toBe(200);
    expect(shot.body['format']).toBe('png');
    // The fake Chrome server's fixed one-pixel JPEG, base64, returned
    // verbatim by `Page.captureScreenshot` regardless of the requested
    // format: proves the bytes travelled through `screenshotTarget()`'s
    // real `bridge.send()` call, not a stub.
    expect(shot.body['data']).toBe(
      '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=',
    );

    const clicked = await callRest(
      ctx,
      'POST',
      `/v1/instances/${instanceId}/targets/${targetId}/input`,
      {
        token: await issueToken(['control']),
        body: { action: 'click', x: 10, y: 10 },
      },
    );
    expect(clicked.status).toBe(200);
    expect(clicked.body['dispatched']).toBe(true);

    const typed = await callRest(
      ctx,
      'POST',
      `/v1/instances/${instanceId}/targets/${targetId}/input`,
      {
        token: await issueToken(['control']),
        body: { action: 'type', text: 'hello' },
      },
    );
    expect(typed.status).toBe(200);
    expect(typed.body['dispatched']).toBe(true);

    const cdp = await callRest(ctx, 'POST', `/v1/instances/${instanceId}/targets/${targetId}/cdp`, {
      token: await issueToken(['cdp']),
      body: { method: 'Page.captureScreenshot', params: { format: 'png' } },
    });
    expect(cdp.status).toBe(200);
    expect((cdp.body['result'] as { data?: string }).data).toEqual(expect.any(String));

    const closed = await callRest(
      ctx,
      'DELETE',
      `/v1/instances/${instanceId}/targets/${targetId}`,
      {
        token: await issueToken(['tabs.manage']),
      },
    );
    expect(closed.status).toBe(200);
    expect(closed.body['closed']).toBe(true);

    // The idle reaper regression, at the real
    // production wiring level (`createRestSessionDriver`/`createRestCdpSender`,
    // not `targets.test.ts`'s simpler injected-driver harness): every one
    // of the seven driving calls above, including the three
    // (`navigate`/`screenshot`/`cdp`) that once never touched activity,
    // reached `router.driveInstance`, which is what performs
    // the throttled `lastActivityAt` touch that keeps the idle reaper
    // away (proved at the router level by `router/test/router/drive.test.ts`).
    expect(driveInstanceCalls).toEqual(Array(driveInstanceCalls.length).fill(instanceId));
    expect(driveInstanceCalls.length).toBeGreaterThanOrEqual(7);
  });

  it('a click that lands twice in a row both times reaches CDP (control lease borrowed and released per call, not held)', async () => {
    const created = await callRest(ctx, 'POST', `/v1/instances/${instanceId}/targets`, {
      token: await issueToken(['tabs.manage']),
      body: {},
    });
    const targetId = (created.body as unknown as TargetSummary).targetId;
    // A fresh token per call: tokens are single-use (jti replay cache), same
    // as every other call in this suite issuing one per request.
    for (let i = 0; i < 2; i += 1) {
      const clicked = await callRest(
        ctx,
        'POST',
        `/v1/instances/${instanceId}/targets/${targetId}/input`,
        {
          token: await issueToken(['control']),
          body: { action: 'click', x: 1, y: 1 },
        },
      );
      expect(clicked.status).toBe(200);
    }
  });

  it('honest 409, not 503, when the router names a sessionId with no live ManagedSession in this process', async () => {
    const router = fakeRouter(
      new Map([['inst_orphan', { sessionId: 'sess_not_live', local: true }]]),
    );
    const orphanCtx: RestContext = { ...ctx, getRouter: () => router };
    const { status, body } = await callRest(orphanCtx, 'GET', '/v1/instances/inst_orphan/targets', {
      token: await issueToken(['view']),
    });
    expect(status).toBe(409);
    expect(body['error']).toMatchObject({ code: 'E_SESSION_NOT_LIVE' });
  });

  it("a remote instance (nodeId != this process's node) is forwarded through router.dispatchAction rather than refused with 409", async () => {
    const remoteNodeId = 'nod_remote';
    let dispatchedTo: string | undefined;
    const router = fakeRouter(
      new Map([['inst_remote', { sessionId: 'sess_remote', local: false, nodeId: remoteNodeId }]]),
      {
        dispatchAction: async (_instanceId, req) => {
          dispatchedTo = remoteNodeId;
          expect(req).toMatchObject({
            kind: 'screenshot',
            instanceId: 'inst_remote',
            targetId: 'tgt_remote',
          });
          return { kind: 'screenshot', format: 'png', data: 'BBBB', width: 50, height: 60 };
        },
      },
    );
    // `ctx.driver` was built in `beforeEach` closed over the OUTER
    // `router`; `createRestSessionDriver`'s own `getRouter` parameter is a
    // closure precisely because it is captured once at construction time
    // (matching `restContext.getRouter`'s own pattern in `src/index.ts`),
    // so overriding only `RestContext.getRouter` here would leave the
    // driver still forwarding to the outer router. Rebuilding `driver`
    // against the new one is what actually exercises the forwarding path.
    const remoteCtx: RestContext = {
      ...ctx,
      getRouter: () => router,
      driver: createRestSessionDriver(sessionRegistry, () => router),
    };
    const { status, body } = await callRest(
      remoteCtx,
      'GET',
      '/v1/instances/inst_remote/targets/tgt_remote/screenshot',
      {
        token: await issueToken(['capture']),
      },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ format: 'png', data: 'BBBB', width: 50, height: 60 });
    expect(dispatchedTo).toBe(remoteNodeId);
  });

  it('an unreachable owning node yields 503 E_NODE_LOST, distinct from the local "session not live" 409', async () => {
    const router = fakeRouter(
      new Map([['inst_remote', { sessionId: 'sess_remote', local: false, nodeId: 'nod_remote' }]]),
      {
        dispatchAction: async () => {
          throw {
            httpStatus: 503,
            code: 'E_NODE_LOST',
            message: 'node nod_remote is unreachable',
            retryAfterMs: 1000,
          };
        },
      },
    );
    const remoteCtx: RestContext = {
      ...ctx,
      getRouter: () => router,
      driver: createRestSessionDriver(sessionRegistry, () => router),
    };
    const { status, body } = await callRest(
      remoteCtx,
      'POST',
      '/v1/instances/inst_remote/targets/tgt_remote/input',
      {
        token: await issueToken(['control']),
        body: { action: 'click', x: 1, y: 1 },
      },
    );
    expect(status).toBe(503);
    expect(body['error']).toMatchObject({ code: 'E_NODE_LOST' });
  });
});

describe('createBrowserGlass() wires ctx.driver/ctx.cdp itself', () => {
  it('a driving route gets past the driver check now: 503 E_ROUTER_UNAVAILABLE (the next honest guard), never E_DRIVER_UNAVAILABLE', async () => {
    // 'gateway' mode has no local router wiring in this build
    // (`lifecycle/start.ts`: only 'embedded'/'supervised' call
    // `buildRouterWiring`), so `ctx.getRouter()` stays `undefined` here.
    // This is not standing up a full instance/session, only proving
    // `createBrowserGlass`'s own `restContext.driver` is populated
    // (`requireDriver` runs before `resolveDrive`'s `requireRouter`, per
    // `routes/targets.ts`), which is exactly the wiring `src/index.ts`
    // previously left undone.
    const keyMaterial = generateEd25519KeyMaterial();
    const signingKey: AppSigningKey = {
      kid: 'test-key',
      alg: 'EdDSA',
      publicKey: keyMaterial.publicKey,
      privateKey: keyMaterial.privateKey,
      status: 'active',
    };
    const tenantId = newId('ten');
    const appId = newId('app');
    const bg = createBrowserGlass({
      mode: 'gateway',
      tenantId,
      appId,
      router: { endpoint: 'https://router.example.com' },
      auth: { keys: [signingKey], issuer: appId },
    });
    const token = await bg.tokens.issue({
      sub: newId('usr'),
      caps: ['view'],
      scope: { kind: 'global' },
      tenantId,
      appId,
      ttlSeconds: 300,
    });
    const res = await bg.fetch(
      new Request(`http://localhost/browserglass/v1/instances/${newId('inst')}/targets`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('E_ROUTER_UNAVAILABLE');
  });
});
