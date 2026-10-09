/**
 * `routes/inventory.ts`: `GET /v1/instances/inventory` and
 * `GET /v1/instances/:instanceId/history`, the confirm-before-destroy
 * surface. Harness built the same way `presence.test.ts`/
 * `security-holes.test.ts` build theirs: a hand constructed `RestContext`
 * with fake `getRouter()`/`store`/`sessionRegistry` implementations
 * exercising the real route logic against `dispatchRest`.
 */

import { type Capability, type Instance, newId } from '@browserglass/protocol';
import type { BrowserRouter, InstanceView } from '@browserglass/router';
import { describe, expect, it } from 'vitest';
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

const SECRET_CDP_WS_URL = 'ws://127.0.0.1:9222/devtools/browser/secret-full-control';

function fakeInstance(id: string, overrides?: Partial<Instance>): Instance {
  return {
    id,
    tenantId: 'ten_x',
    appId: 'app_x',
    poolId: null,
    subject: 'usr_alice',
    state: 'ready',
    stateReason: null,
    stateChangedAt: 1_700_000_000_000,
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
      startedAt: 1_700_000_000_000,
      stealthProfile: null,
    } as never,
    acquiredAt: 1_700_000_000_000,
    readyAt: 1_700_000_001_000,
    releasedAt: null,
    expiresAt: 1_700_003_600_000,
    lastActivityAt: 1_700_000_002_000,
    metadata: { name: 'checkout-bot', description: 'runs the nightly checkout smoke test' },
    incidents: [],
    lifetime: 'explicit',
    firstViewerAt: null,
    releaseReason: null,
    restartCount: 0,
    peakRssMib: null,
    osPid: null,
    ...overrides,
  } as Instance;
}

function fakeListRouter(instances: readonly Instance[]): BrowserRouter {
  return {
    async list(): Promise<InstanceView[]> {
      return instances.map((instance) => ({ instance, live: null }));
    },
  } as unknown as BrowserRouter;
}

function fakeManagedSessionWithTargets(targets: readonly unknown[]) {
  return { listTargets: () => targets } as unknown;
}

function fakeSessionRegistry(byInstanceId: ReadonlyMap<string, unknown>): SessionRegistry {
  return {
    get: (instanceId: string) => byInstanceId.get(instanceId),
    all: () => [...byInstanceId.values()],
  } as unknown as SessionRegistry;
}

interface FakeStoreOpts {
  readonly instancesById?: ReadonlyMap<string, Instance>;
  readonly auditByInstanceId?: ReadonlyMap<string, readonly Record<string, unknown>[]>;
}

function fakeStore(opts: FakeStoreOpts) {
  return {
    async getInstance(_tenantId: string, id: string) {
      return opts.instancesById?.get(id) ?? null;
    },
    async queryAudit(_tenantId: string, q: { instanceId?: string }) {
      return { events: opts.auditByInstanceId?.get(q.instanceId ?? '') ?? [], nextCursor: null };
    },
  } as unknown as RestContext['store'];
}

async function buildHarness(opts: {
  readonly router?: BrowserRouter;
  readonly sessionRegistry?: SessionRegistry;
  readonly store?: RestContext['store'];
}): Promise<{
  readonly ctx: RestContext;
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
    store: opts.store,
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
    async issueToken(caps) {
      return tokens.issue({
        sub: newId('usr'),
        caps,
        iUnderstandAdmin: caps.includes('admin'),
        // `{ kind: 'tenant' }`, not `{ kind: 'global' }` (which other
        // suites in this package use as a convenience against fakes that
        // never scope-check): `getInstanceHistory`'s own
        // `scopeAllowsInstance` mirrors `BrowserRouter`'s real narrowing,
        // which treats an unrecognised scope kind as "covers nothing"
        // (`BrowserRouter.ts`'s own comment), so this suite needs the
        // actual widest real scope to exercise the "row found" branch.
        scope: { kind: 'tenant' },
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
  opts?: { readonly token?: string },
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const headers = new Headers();
  if (opts?.token !== undefined) headers.set('authorization', `Bearer ${opts.token}`);
  const request = new Request(`http://localhost${path}`, { method, headers });
  const { req, res, done } = nodeRequestFromFetch(request);
  await dispatchRest(ctx, req, res, new URL(request.url).pathname);
  const response = fetchResponseFromNode(await done);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('GET /v1/instances/inventory', () => {
  it('happy path: two open instances, one with a live session (targets+staleness), one without; totalCount answers "how many are open"', async () => {
    const live = fakeInstance('inst_live', { id: 'inst_live', state: 'ready' });
    const cold = fakeInstance('inst_cold', {
      id: 'inst_cold',
      state: 'launching',
      subject: 'usr_bob',
      metadata: {},
    });
    const router = fakeListRouter([live, cold]);
    const targets = [
      {
        targetId: 'tgt_1',
        kind: 'page',
        title: 'Example Domain',
        url: 'https://example.com/',
        faviconUrl: null,
        index: 0,
        windowId: 1,
        active: true,
      },
    ];
    const sessionRegistry = fakeSessionRegistry(
      new Map([['inst_live', fakeManagedSessionWithTargets(targets)]]),
    );
    const { ctx, issueToken } = await buildHarness({ router, sessionRegistry });
    const token = await issueToken(['view']);

    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inventory', { token });

    expect(status).toBe(200);
    expect(body['totalCount']).toBe(2);
    const items = body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2);

    const liveRow = items.find((r) => r['instanceId'] === 'inst_live') as Record<string, unknown>;
    expect(liveRow['targetsLive']).toBe(true);
    expect(liveRow['targets']).toEqual(targets);
    expect(typeof liveRow['targetsObservedAt']).toBe('number');
    expect(liveRow['createdBy']).toBe('usr_alice');
    expect(liveRow['metadata']).toEqual({
      name: 'checkout-bot',
      description: 'runs the nightly checkout smoke test',
    });
    expect(liveRow['lifetime']).toBe('explicit');
    expect(liveRow['status']).toBe('ready');
    expect(liveRow['nodeId']).toBe('nod_local');

    const coldRow = items.find((r) => r['instanceId'] === 'inst_cold') as Record<string, unknown>;
    expect(coldRow['targetsLive']).toBe(false);
    expect(coldRow['targets']).toEqual([]);
    expect(coldRow['targetsObservedAt']).toBeNull();
  });

  it('redaction: cdpWsUrl/cdpPort never appear anywhere in the inventory response', async () => {
    const router = fakeListRouter([fakeInstance('inst_1')]);
    const { ctx, issueToken } = await buildHarness({
      router,
      sessionRegistry: fakeSessionRegistry(new Map()),
    });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inventory', { token });
    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET_CDP_WS_URL);
    expect(serialized).not.toContain('9222');
  });

  it('a state outside the open set (released/failed) is refused rather than silently returning an empty page', async () => {
    const router = fakeListRouter([fakeInstance('inst_1')]);
    const { ctx, issueToken } = await buildHarness({
      router,
      sessionRegistry: fakeSessionRegistry(new Map()),
    });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inventory?state=released', {
      token,
    });
    expect(status).toBe(400);
    expect(body['error']).toMatchObject({ code: 'E_INVALID_QUERY' });
  });

  it('capability denial: 403 without view', async () => {
    const router = fakeListRouter([fakeInstance('inst_1')]);
    const { ctx, issueToken } = await buildHarness({
      router,
      sessionRegistry: fakeSessionRegistry(new Map()),
    });
    const token = await issueToken(['control']);
    const { status } = await callRest(ctx, 'GET', '/v1/instances/inventory', { token });
    expect(status).toBe(403);
  });

  it('the literal /v1/instances/inventory path is not swallowed by GET /v1/instances/:instanceId', async () => {
    // If routing order were wrong, this would hit `getInstance` with
    // `instanceId: "inventory"` and 404 (no router.describe wired on this
    // fake), instead of `listOpenInstances`'s 200 + `items`/`totalCount` shape.
    const router = fakeListRouter([fakeInstance('inst_1')]);
    const { ctx, issueToken } = await buildHarness({
      router,
      sessionRegistry: fakeSessionRegistry(new Map()),
    });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inventory', { token });
    expect(status).toBe(200);
    expect(body).toHaveProperty('totalCount');
    expect(body).toHaveProperty('items');
  });
});

describe('GET /v1/instances/:instanceId/history', () => {
  it('happy path: an instances row that still exists, with the audit trail folded in', async () => {
    const instance = fakeInstance('inst_gone', {
      id: 'inst_gone',
      state: 'released',
      releasedAt: 1_700_000_500_000,
    });
    const store = fakeStore({
      instancesById: new Map([['inst_gone', instance]]),
      auditByInstanceId: new Map([
        ['inst_gone', [{ eventType: 'instance.released', occurredAt: '2023-11-14T00:00:00Z' }]],
      ]),
    });
    const { ctx, issueToken } = await buildHarness({ store });
    const token = await issueToken(['view']);

    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_gone/history', {
      token,
    });

    expect(status).toBe(200);
    expect(body['instanceRecordFound']).toBe(true);
    expect(body['status']).toBe('released');
    expect(body['releasedAt']).toBe(1_700_000_500_000);
    expect(body['createdBy']).toBe('usr_alice');
    expect(body['metadata']).toEqual({
      name: 'checkout-bot',
      description: 'runs the nightly checkout smoke test',
    });
    expect(body['lifetime']).toBe('explicit');
    expect(body['historyFieldsUnavailable']).toEqual([
      'firstViewerAt',
      'releaseReason',
      'restartCount',
      'peakRssMib',
      'osPid',
    ]);
    expect(body['auditEvents']).toEqual([
      { eventType: 'instance.released', occurredAt: '2023-11-14T00:00:00Z' },
    ]);
  });

  it('redaction: cdpWsUrl/cdpPort never appear in the history response', async () => {
    const instance = fakeInstance('inst_gone');
    const store = fakeStore({ instancesById: new Map([['inst_gone', instance]]) });
    const { ctx, issueToken } = await buildHarness({ store });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_gone/history', {
      token,
    });
    expect(status).toBe(200);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET_CDP_WS_URL);
    expect(serialized).not.toContain('9222');
  });

  it('the instances row is gone (past retention) but the audit trail survives it: answered from audit alone, not 404', async () => {
    const store = fakeStore({
      instancesById: new Map(),
      auditByInstanceId: new Map([
        ['inst_ancient', [{ eventType: 'instance.launched' }, { eventType: 'instance.released' }]],
      ]),
    });
    const { ctx, issueToken } = await buildHarness({ store });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_ancient/history', {
      token,
    });
    expect(status).toBe(200);
    expect(body['instanceRecordFound']).toBe(false);
    expect(body['auditEvents']).toEqual([
      { eventType: 'instance.launched' },
      { eventType: 'instance.released' },
    ]);
  });

  it('neither the instances row nor any audit_events row exists: 404, not a fabricated empty history', async () => {
    const store = fakeStore({ instancesById: new Map(), auditByInstanceId: new Map() });
    const { ctx, issueToken } = await buildHarness({ store });
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/does_not_exist/history', {
      token,
    });
    expect(status).toBe(404);
    expect(body['error']).toMatchObject({ code: 'E_INSTANCE_NOT_FOUND' });
  });

  it('capability denial: 403 without view', async () => {
    const store = fakeStore({ instancesById: new Map([['inst_1', fakeInstance('inst_1')]]) });
    const { ctx, issueToken } = await buildHarness({ store });
    const token = await issueToken(['control']);
    const { status } = await callRest(ctx, 'GET', '/v1/instances/inst_1/history', { token });
    expect(status).toBe(403);
  });

  it('503 when this gateway has no store wired', async () => {
    const { ctx, issueToken } = await buildHarness({});
    const token = await issueToken(['view']);
    const { status, body } = await callRest(ctx, 'GET', '/v1/instances/inst_1/history', { token });
    expect(status).toBe(503);
    expect(body['error']).toMatchObject({ code: 'E_STORE_UNAVAILABLE' });
  });
});
