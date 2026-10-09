/**
 * `routes/presence.ts`: `GET /v1/instances/:instanceId/viewers` and
 * `DELETE /v1/sessions/:sessionId/viewers/:viewerId`. Built the same way
 * `targets.test.ts`/`security-holes.test.ts` build their harnesses: a
 * hand constructed `RestContext` with fake `getRouter()`/`sessionRegistry`
 * implementations exercising the real route logic (capability gating,
 * tenant scoping, the response shape) against `dispatchRest`.
 */

import type { Capability, LeaseSummary, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
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
import type { SessionRegistry } from '../../src/session/registry.js';

/** A fake `ConnectionSink` (`session/types.ts`) recording every `sendEnvelope`/`close` call it receives. */
function fakeConnection(viewerId: string) {
  const sent: unknown[] = [];
  const closes: { code: number; reason: string }[] = [];
  return {
    viewerId,
    isOpen: () => true,
    bufferedAmount: () => 0,
    send: () => undefined,
    sendEnvelope: (env: unknown) => {
      sent.push(env);
    },
    close: (code: number, reason: string) => {
      closes.push({ code, reason });
    },
    sent,
    closes,
  };
}

type FakeConnection = ReturnType<typeof fakeConnection>;

/**
 * A fake `ManagedSession`, exposing only the public surface
 * `routes/presence.ts` actually calls (`sessionId`, `tenantId`,
 * `allConnections`, `connectionFor`, `leaseSummariesFor`, `listStreams`).
 * Cast through `unknown`, the same pattern `targets.test.ts`'s own
 * `fakeRouter` uses for a dependency this suite exercises only through
 * its declared contract.
 */
function fakeManagedSession(opts: {
  readonly sessionId: string;
  readonly tenantId: string;
  readonly connections: readonly FakeConnection[];
  /** viewerId -> targetId -> LeaseSummary, exactly `leaseSummariesFor`'s own per-recipient shape. */
  readonly leasesByViewer?: ReadonlyMap<string, Record<string, LeaseSummary>>;
  readonly streams?: readonly {
    readonly streamId: number;
    readonly targetId: string;
    readonly viewerId: string;
  }[];
}) {
  return {
    sessionId: opts.sessionId,
    tenantId: opts.tenantId,
    allConnections: () => opts.connections,
    connectionFor: (viewerId: string) => opts.connections.find((c) => c.viewerId === viewerId),
    leaseSummariesFor: (viewerId: string) => opts.leasesByViewer?.get(viewerId) ?? {},
    listStreams: () => opts.streams ?? [],
  };
}

function fakeSessionRegistry(
  byInstanceId: ReadonlyMap<string, ReturnType<typeof fakeManagedSession>>,
): SessionRegistry {
  return {
    get: (instanceId: string) => byInstanceId.get(instanceId),
    all: () => [...byInstanceId.values()],
  } as unknown as SessionRegistry;
}

function fakeDescribeRouter(
  instances: ReadonlyMap<
    string,
    { readonly nodeId: string | null; readonly sessionId: string | null }
  >,
): BrowserRouter {
  return {
    async describe(instanceId: string, _principal: Principal): Promise<InstanceView> {
      const entry = instances.get(instanceId);
      if (!entry)
        throw {
          httpStatus: 404,
          code: 'E_INSTANCE_NOT_FOUND',
          message: `instance ${instanceId} not found`,
        };
      return {
        instance: { id: instanceId, nodeId: entry.nodeId, sessionId: entry.sessionId } as never,
        live: null,
      };
    },
  } as unknown as BrowserRouter;
}

async function buildHarness(opts: {
  readonly router?: BrowserRouter;
  readonly sessionRegistry?: SessionRegistry;
  /** Fixed so a caller can build a `fakeManagedSession` with a MATCHING `tenantId` before the harness exists (the DELETE route's own tenant scoping check needs this to line up for a "happy path" test). Defaults to a fresh id. */
  readonly tenantId?: string;
}): Promise<{
  readonly ctx: RestContext;
  readonly tenantId: string;
  readonly issueToken: (caps: readonly Capability[]) => Promise<string>;
}> {
  const tenantId = opts.tenantId ?? newId('ten');
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
    getRouter: () => opts.router,
    store: undefined,
    tokens,
    resolver,
    hooks: new HookRegistry(undefined, { globalTimeoutMs: 5000, logger: resolved.logger.sink }),
    logger: resolved.logger.sink,
    isAccepting: () => true,
    isReady: () => true,
    sessionRegistry: opts.sessionRegistry,
  };
  return {
    ctx,
    tenantId,
    async issueToken(caps) {
      return tokens.issue({
        sub: newId('usr'),
        caps,
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

describe('GET /v1/instances/:instanceId/viewers', () => {
  it('happy path: multiple viewers, one target with two simultaneous controllers (contendedTargets)', async () => {
    const connA = fakeConnection('vwr_a');
    const connB = fakeConnection('vwr_b');
    const connC = fakeConnection('vwr_c');

    // vwr_a and vwr_b both hold `tgt_shared` (mode 'shared', holderCount 2);
    // vwr_c holds nothing and only watches.
    const sharedSummary = (holderViewerId: string): LeaseSummary => ({
      holderViewerId,
      holderLabel: holderViewerId,
      mode: 'shared',
      holderCount: 2,
      queueLength: 0,
      queuePosition: null,
      expiresAt: Date.now() + 60_000,
    });
    const managed = fakeManagedSession({
      sessionId: 'sess_1',
      tenantId: 'ten_1',
      connections: [connA, connB, connC],
      leasesByViewer: new Map([
        ['vwr_a', { tgt_shared: sharedSummary('vwr_a') }],
        ['vwr_b', { tgt_shared: sharedSummary('vwr_b') }],
        ['vwr_c', { tgt_shared: { ...sharedSummary('vwr_a'), holderViewerId: null } }],
      ]),
      streams: [
        { streamId: 1, targetId: 'tgt_shared', viewerId: 'vwr_a' },
        { streamId: 2, targetId: 'tgt_shared', viewerId: 'vwr_c' },
      ],
    });
    const router = fakeDescribeRouter(
      new Map([['inst_1', { nodeId: 'nod_local', sessionId: 'sess_1' }]]),
    );
    const sessionRegistry = fakeSessionRegistry(new Map([['inst_1', managed]]));
    const { ctx, issueToken } = await buildHarness({ router, sessionRegistry });
    const token = await issueToken(['view']);

    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_1/viewers', { token });

    expect(status).toBe(200);
    expect(body['live']).toBe(true);
    expect(body['viewerCount']).toBe(3);
    // vwr_a and vwr_b are controlling (holderViewerId === self); vwr_c is not.
    expect(body['controllingCount']).toBe(2);
    const viewers = body['viewers'] as Array<{
      viewerId: string;
      controlling: string[];
      watching: string[];
    }>;
    expect(viewers.find((v) => v.viewerId === 'vwr_a')?.controlling).toEqual(['tgt_shared']);
    expect(viewers.find((v) => v.viewerId === 'vwr_b')?.controlling).toEqual(['tgt_shared']);
    expect(viewers.find((v) => v.viewerId === 'vwr_c')?.controlling).toEqual([]);
    expect(viewers.find((v) => v.viewerId === 'vwr_a')?.watching).toEqual(['tgt_shared']);
    // Simultaneous control is obvious from the payload directly, not
    // something a caller has to derive by intersecting `controlling[]`.
    expect(body['contendedTargets']).toEqual([
      { targetId: 'tgt_shared', mode: 'shared', holderCount: 2 },
    ]);
  });

  it('cross-node / no live session on this gateway: honest live:false with an empty roster, never a guess', async () => {
    const router = fakeDescribeRouter(
      new Map([['inst_remote', { nodeId: 'nod_other', sessionId: 'sess_remote' }]]),
    );
    const sessionRegistry = fakeSessionRegistry(new Map()); // nothing local
    const { ctx, issueToken } = await buildHarness({ router, sessionRegistry });
    const token = await issueToken(['view']);

    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_remote/viewers', {
      token,
    });

    expect(status).toBe(200);
    expect(body['live']).toBe(false);
    expect(body['viewers']).toEqual([]);
    expect(body['viewerCount']).toBe(0);
    expect(body['nodeId']).toBe('nod_other');
  });

  it('capability denial: 403 without view', async () => {
    const router = fakeDescribeRouter(
      new Map([['inst_1', { nodeId: 'nod_local', sessionId: 'sess_1' }]]),
    );
    const { ctx, issueToken } = await buildHarness({
      router,
      sessionRegistry: fakeSessionRegistry(new Map()),
    });
    const token = await issueToken(['control']);
    const { status } = await callRest(ctx, 'GET', '/v1/instances/inst_1/viewers', { token });
    expect(status).toBe(403);
  });

  it('error envelope: 404 for an unknown instance', async () => {
    const router = fakeDescribeRouter(new Map());
    const { ctx, issueToken } = await buildHarness({
      router,
      sessionRegistry: fakeSessionRegistry(new Map()),
    });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/does_not_exist/viewers', {
      token,
    });
    expect(status).toBe(404);
    expect(body['error']).toMatchObject({ code: 'E_INSTANCE_NOT_FOUND' });
  });

  it('answers for a draining/non-drivable instance too (describe(), not driveInstance)', async () => {
    // `router.describe()` never checks lifecycle state the way
    // `driveInstance()` does; this fake simply has no state field at all,
    // proving the route never asks for one.
    const router = fakeDescribeRouter(
      new Map([['inst_draining', { nodeId: 'nod_local', sessionId: 'sess_1' }]]),
    );
    const managed = fakeManagedSession({
      sessionId: 'sess_1',
      tenantId: 'ten_1',
      connections: [fakeConnection('vwr_a')],
    });
    const sessionRegistry = fakeSessionRegistry(new Map([['inst_draining', managed]]));
    const { ctx, issueToken } = await buildHarness({ router, sessionRegistry });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_draining/viewers', {
      token,
    });
    expect(status).toBe(200);
    expect(body['live']).toBe(true);
    expect(body['viewerCount']).toBe(1);
  });
});

describe('DELETE /v1/sessions/:sessionId/viewers/:viewerId', () => {
  let sessionRegistry: SessionRegistry;
  let connA: FakeConnection;
  let ownerTenantId: string;

  beforeEach(() => {
    ownerTenantId = newId('ten');
    connA = fakeConnection('vwr_a');
    const managed = fakeManagedSession({
      sessionId: 'sess_1',
      tenantId: ownerTenantId,
      connections: [connA],
    });
    sessionRegistry = fakeSessionRegistry(new Map([['inst_1', managed]]));
  });

  it('happy path: disconnects the viewer, sends goodbye, closes with the given reason/code', async () => {
    const { ctx, issueToken } = await buildHarness({ sessionRegistry, tenantId: ownerTenantId });
    const token = await issueToken(['admin']);
    const { status, body } = await callRest(
      ctx,
      'DELETE',
      '/v1/sessions/sess_1/viewers/vwr_a?reason=misbehaving&code=4003',
      { token },
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ disconnected: true, sessionId: 'sess_1', viewerId: 'vwr_a' });
    expect(connA.closes).toEqual([{ code: 4003, reason: 'misbehaving' }]);
    expect(connA.sent).toHaveLength(1);
    expect(connA.sent[0]).toMatchObject({ t: 'goodbye', code: 4003 });
  });

  it('defaults reason/code when the body omits them', async () => {
    const { ctx, issueToken } = await buildHarness({ sessionRegistry, tenantId: ownerTenantId });
    const token = await issueToken(['admin']);
    const { status } = await callRest(ctx, 'DELETE', '/v1/sessions/sess_1/viewers/vwr_a', {
      token,
    });
    expect(status).toBe(200);
    expect(connA.closes).toEqual([{ code: 4003, reason: 'Disconnected by an administrator.' }]);
  });

  it('capability denial: 403 without admin (control alone is not enough)', async () => {
    const { ctx, issueToken } = await buildHarness({ sessionRegistry, tenantId: ownerTenantId });
    const token = await issueToken(['control']);
    const { status } = await callRest(ctx, 'DELETE', '/v1/sessions/sess_1/viewers/vwr_a', {
      token,
    });
    expect(status).toBe(403);
    expect(connA.closes).toEqual([]);
  });

  it('error envelope: 404 for an unknown viewerId on a real session', async () => {
    const { ctx, issueToken } = await buildHarness({ sessionRegistry, tenantId: ownerTenantId });
    const token = await issueToken(['admin']);
    const { status, body } = await callRest(
      ctx,
      'DELETE',
      '/v1/sessions/sess_1/viewers/vwr_ghost',
      { token },
    );
    expect(status).toBe(404);
    expect(body['error']).toMatchObject({ code: 'E_VIEWER_NOT_FOUND' });
  });

  it('error envelope: 404 for an unknown sessionId', async () => {
    const { ctx, issueToken } = await buildHarness({ sessionRegistry, tenantId: ownerTenantId });
    const token = await issueToken(['admin']);
    const { status, body } = await callRest(
      ctx,
      'DELETE',
      '/v1/sessions/sess_ghost/viewers/vwr_a',
      { token },
    );
    expect(status).toBe(404);
    expect(body['error']).toMatchObject({ code: 'E_SESSION_NOT_FOUND' });
  });

  it('SECURITY: a live session belonging to a different tenant answers 404, not 200 (never leaks cross-tenant existence)', async () => {
    // `sess_1`'s fake `ManagedSession` is tenant `ownerTenantId`; this
    // harness is deliberately built for a DIFFERENT, freshly generated
    // tenant (no `tenantId` override), so the caller's own bearer token
    // is never `ownerTenantId`.
    const { ctx, issueToken } = await buildHarness({ sessionRegistry });
    const token = await issueToken(['admin']);
    const { status } = await callRest(ctx, 'DELETE', '/v1/sessions/sess_1/viewers/vwr_a', {
      token,
    });
    expect(status).toBe(404);
    expect(connA.closes).toEqual([]);
  });
});
