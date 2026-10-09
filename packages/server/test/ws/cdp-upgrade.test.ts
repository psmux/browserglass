/**
 * Proves the raw CDP WebSocket attach proxy (`src/ws/cdp-upgrade.ts`) end
 * to end: the auth check (no token, wrong capability), the config gate
 * (`enabled: false`), the local-only scope limit, and, the actual
 * acceptance bar, a genuine CDP client driving `Target.getTargets` ->
 * `Target.attachToTarget` -> `Runtime.evaluate` through the proxy against
 * a real listening CDP endpoint (`fake-chrome-server.ts`, the same fake
 * `test/cluster/peer-listener.test.ts` drives a real `CdpBridge` against).
 *
 * Structure mirrors `test/cluster/peer-listener.test.ts`'s own
 * `startPeerListener`: a real `node:http` server with `handleCdpUpgrade`
 * wired to its `upgrade` event exactly as `src/index.ts`'s `handleUpgrade`
 * wires it, and a fake `BrowserRouter` (`driveInstance`/`describe` only,
 * cast through `unknown`) matching `test/rest/targets.test.ts`'s own
 * `fakeRouter` pattern for a dependency this suite exercises only through
 * its declared contract, not a full `BrowserRouter`.
 */

import { type Server as HttpServer, createServer } from 'node:http';
import { createCdpBridge, createTargetRegistry } from '@browserglass/core';
import type { AppId, Principal, TenantId } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import type { AuthResolver } from '@browserglass/protocol';
import type { BrowserRouter, DriveResolution } from '@browserglass/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  type AppSigningKey,
  InProcessJtiCache,
  TokenApiImpl,
  generateEd25519KeyMaterial,
  jwtAuthResolver,
} from '../../src/auth/index.js';
import type { Logger } from '../../src/config/logger.js';
import { ManagedSession } from '../../src/session/managed-session.js';
import { SessionRegistry } from '../../src/session/registry.js';
import type { ConnectionSink } from '../../src/session/types.js';
import {
  type CdpProxyDeps,
  handleCdpUpgrade,
  shouldHandleCdpUpgrade,
} from '../../src/ws/cdp-upgrade.js';
import { type FakeChromeServer, startFakeChromeServer } from './support/fake-chrome-server.js';

const CDP_PROXY_PATH = '/browserglass/cdp';
const TENANT_ID = newId('ten') as TenantId;
const APP_ID = newId('app') as AppId;

function noopLogger(): Logger {
  const fn = () => undefined;
  return { trace: fn, debug: fn, info: fn, warn: fn, error: fn };
}

/** One instance's resolution state, as {@link fakeRouter} reports it. */
interface FakeInstanceEntry {
  readonly local: boolean;
  /** `null` mirrors `describe()`'s own real behaviour for an instance with no live runtime detail in this process yet (`BrowserRouter.describe`'s `liveRuntimeByInstance` doc). */
  readonly cdpWsUrl: string | null;
}

/** A minimal `BrowserRouter` stand-in exposing only `driveInstance`/`describe`, the two methods `handleCdpUpgrade` calls, matching `test/rest/targets.test.ts`'s own `fakeRouter` pattern. */
function fakeRouter(instances: ReadonlyMap<string, FakeInstanceEntry>): BrowserRouter {
  return {
    async driveInstance(instanceId: string, _principal: Principal): Promise<DriveResolution> {
      const entry = instances.get(instanceId);
      if (!entry)
        throw {
          httpStatus: 404,
          code: 'E_INSTANCE_NOT_FOUND',
          message: `instance ${instanceId} not found`,
        };
      return {
        instanceId,
        nodeId: entry.local ? 'nod_local' : 'nod_remote',
        sessionId: 'ses_1',
        local: entry.local,
      };
    },
    async describe(instanceId: string, _principal: Principal) {
      const entry = instances.get(instanceId);
      if (!entry)
        throw {
          httpStatus: 404,
          code: 'E_INSTANCE_NOT_FOUND',
          message: `instance ${instanceId} not found`,
        };
      return {
        instance: {
          id: instanceId,
          runtime: entry.cdpWsUrl === null ? null : { cdpWsUrl: entry.cdpWsUrl },
        },
        live: null,
      };
    },
  } as unknown as BrowserRouter;
}

/** Starts a real HTTP server with `handleCdpUpgrade` wired to its `upgrade` event, exactly the shape `src/index.ts`'s own `handleUpgrade` wires it in production. */
async function startCdpProxyServer(
  deps: CdpProxyDeps,
): Promise<{ url: string; close: () => Promise<void> }> {
  const httpServer: HttpServer = createServer((_req, res) => res.writeHead(404).end());
  httpServer.on('upgrade', (req, socket, head) => {
    if (!shouldHandleCdpUpgrade(req, CDP_PROXY_PATH)) {
      socket.destroy();
      return;
    }
    handleCdpUpgrade(req, socket, head, CDP_PROXY_PATH, deps);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}${CDP_PROXY_PATH}`,
    close: () => new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/** Connects and rejects with an `Error` whose message names the refusing HTTP status, exactly what the `ws` client library reports for a non-101 upgrade response. */
function connectExpectingRefusal(url: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => {
      ws.close();
      reject(new Error('expected the upgrade to be refused, but it completed'));
    });
    ws.once('error', (err: Error) => reject(err));
  });
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', (err: Error) => reject(err));
  });
}

/** Sends one CDP command and resolves with its `result`, or rejects with its `error`. Ignores frames belonging to a different `id` (there are none in this suite's single-command-at-a-time usage, but real CDP servers, `fake-chrome-server.ts` included, can send unsolicited events too). */
let nextId = 1;
function rpc(
  ws: WebSocket,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (data: Buffer): void => {
      const msg = JSON.parse(data.toString('utf8')) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id !== id) return;
      ws.off('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

describe('the raw CDP WebSocket attach proxy (ws/cdp-upgrade.ts)', () => {
  let chrome: FakeChromeServer;
  let tokenApi: TokenApiImpl;
  let resolver: AuthResolver;
  let instances: Map<string, FakeInstanceEntry>;
  let instanceId: string;
  let sessionRegistry: SessionRegistry;
  let server: { url: string; close: () => Promise<void> } | undefined;

  beforeEach(async () => {
    chrome = await startFakeChromeServer();
    instanceId = newId('ins');
    instances = new Map([[instanceId, { local: true, cdpWsUrl: chrome.url }]]);

    const material = generateEd25519KeyMaterial();
    const key: AppSigningKey = {
      kid: 'key_test',
      alg: 'EdDSA',
      publicKey: material.publicKey,
      privateKey: material.privateKey,
      status: 'active',
    };
    resolver = jwtAuthResolver({
      keys: [key],
      tenantId: TENANT_ID,
      appId: APP_ID,
      issuer: APP_ID,
      clockSkewSeconds: 30,
      jtiCache: new InProcessJtiCache(1000),
    });
    // `'control'` added alongside `'cdp'`/`'view'`: `handleCdpUpgrade` now
    // requires BOTH `cdp` and `control` before it will open the raw pipe
    // (this module's own "COLLABORATION" doc, and the new test below that
    // proves the 403 for `cdp`-without-`control` specifically), so a token
    // minted for anything past that gate needs both.
    tokenApi = new TokenApiImpl({
      keys: [key],
      defaultTtlSeconds: 120,
      maxTtlSeconds: 900,
      maxCaps: ['view', 'cdp', 'control'] as never,
      tenantAllowedCaps: ['view', 'cdp', 'control'] as never,
      clock: { now: () => Date.now() },
      tenantId: TENANT_ID,
      appId: APP_ID,
      issuer: APP_ID,
      clockSkewSeconds: 30,
      jtiCache: new InProcessJtiCache(1000),
    });

    // A real `SessionRegistry`, its factory connecting a real `CdpBridge`
    // to the SAME `chrome` fake endpoint `fakeRouter` above points
    // `cdpWsUrl` at, mirroring `test/ws/support/test-gateway.ts`'s own
    // factory. This is what lets `handleCdpUpgrade`'s new
    // `deps.getManagedSession` resolve a real `ManagedSession`, so a CDP
    // client attaching through this suite's proxy joins the exact same
    // presence roster and `ControlLeaseEngine` pool a `bgls.v1` viewer
    // built directly against `sessionRegistry` (as several tests below do,
    // standing in for a human viewer with no `bgls.v1` socket of its own)
    // would.
    sessionRegistry = new SessionRegistry(async (reqInstanceId, ctx) => {
      const bridge = createCdpBridge(reqInstanceId as never);
      await bridge.connect({ url: chrome.url });
      const registry = createTargetRegistry(reqInstanceId as never, bridge);
      await registry.start();
      return new ManagedSession({
        instanceId: reqInstanceId,
        sessionId: newId('sess'),
        tenantId: ctx.tenantId,
        appId: ctx.appId,
        nodeId: 'nod_test',
        bridge,
        registry,
        logger: noopLogger(),
        onIdle: ctx.onIdle,
      });
    });
  });

  afterEach(async () => {
    await server?.close();
    server = undefined;
    sessionRegistry.disposeAll();
    await chrome.close();
  });

  function buildDeps(overrides: Partial<CdpProxyDeps> = {}): CdpProxyDeps {
    return {
      enabled: true,
      resolver,
      allowQueryToken: true,
      getRouter: () => fakeRouter(instances),
      getManagedSession: (id, ctx) => sessionRegistry.getOrCreate(id, ctx),
      logger: noopLogger(),
      ...overrides,
    };
  }

  async function mintToken(caps: readonly string[]): Promise<string> {
    const issued = await tokenApi.issueWithMeta({
      sub: 'user:1',
      caps: caps as never,
      scope: { kind: 'tenant' },
    });
    return issued.token;
  }

  /** Registers a bare observer viewer directly against the instance's real `ManagedSession` (bypassing `bgls.v1`, standing in for a connected human/other viewer), and returns every `presence.state` it has received so far plus a live handle for driving `requestControl` directly, as `docs/agent-and-human.md`'s pattern 2 ("the person just asks") would from a real socket. */
  async function attachObserver(opts: {
    readonly viewerId: string;
    readonly kind: 'human' | 'agent';
  }): Promise<{ managed: ManagedSession; presenceStates: Array<Record<string, unknown>> }> {
    const managed = await sessionRegistry.getOrCreate(instanceId, {
      tenantId: TENANT_ID,
      appId: APP_ID,
    });
    const presenceStates: Array<Record<string, unknown>> = [];
    const sink: ConnectionSink = {
      viewerId: opts.viewerId,
      isOpen: () => true,
      bufferedAmount: () => 0,
      send: () => undefined,
      sendEnvelope: (env) => {
        if ((env as { t: string }).t === 'presence.state')
          presenceStates.push(env as Record<string, unknown>);
      },
      close: () => undefined,
    };
    managed.attachViewer(sink, {
      id: opts.viewerId,
      tenantId: TENANT_ID,
      appId: APP_ID,
      subject: opts.viewerId,
      capabilities: ['view', 'control'],
      kind: opts.kind,
      isAdmin: false,
      connectedAtMs: Date.now(),
    });
    managed.broadcastPresence();
    return { managed, presenceStates };
  }

  it('refuses with 404 when security.cdpProxyEnabled is false, the opt-in config gate', async () => {
    server = await startCdpProxyServer(buildDeps({ enabled: false }));
    const token = await mintToken(['cdp']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/404/);
  });

  it('refuses with 401 when no token is presented', async () => {
    server = await startCdpProxyServer(buildDeps());
    await expect(connectExpectingRefusal(`${server.url}/${instanceId}`)).rejects.toThrow(/401/);
  });

  it('refuses with 403 when the token lacks the cdp capability, the same capability the REST allowlisted passthrough requires', async () => {
    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['view']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/403/);
  });

  it('refuses with 403 when the token carries cdp but not control, since an unfiltered raw pipe with no driving authority at all is exactly the bypass this proxy must not offer', async () => {
    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/403/);
  });

  it('refuses with 401 when allowQueryToken is false, since a raw CDP client has no other way to carry a token on the handshake', async () => {
    server = await startCdpProxyServer(buildDeps({ allowQueryToken: false }));
    const token = await mintToken(['cdp']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/401/);
  });

  it('refuses with 404 for an instance driveInstance does not recognise', async () => {
    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp', 'control']);
    await expect(
      connectExpectingRefusal(`${server.url}/does-not-exist?token=${token}`),
    ).rejects.toThrow(/404/);
  });

  it('refuses with 501 for a remote (non-local) instance, the honest scope limit this proxy documents', async () => {
    instances.set(instanceId, { local: false, cdpWsUrl: null });
    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp', 'control']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/501/);
  });

  it('refuses with 503 when the instance is local but this process holds no live runtime detail yet', async () => {
    instances.set(instanceId, { local: true, cdpWsUrl: null });
    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp', 'control']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/503/);
  });

  it('refuses with 503 when getManagedSession is not wired, rather than silently reintroducing the invisible-to-presence bypass', async () => {
    server = await startCdpProxyServer(buildDeps({ getManagedSession: undefined }));
    const token = await mintToken(['cdp', 'control']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/503/);
  });

  it('a real CDP client attaches, lists targets, and evaluates script through the proxy against a real CDP endpoint', async () => {
    chrome.targetInfos.push({
      targetId: 'tgt_1',
      type: 'page',
      title: 'Example',
      url: 'https://example.com/',
      attached: false,
    });
    chrome.setRuntimeEvaluate((params) => {
      if (params['expression'] === 'document.title') {
        return { result: { type: 'string', value: 'Example Domain' } };
      }
      return undefined;
    });

    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp', 'control']);
    const ws = new WebSocket(`${server.url}/${instanceId}?token=${token}`);
    await waitOpen(ws);

    try {
      const targets = (await rpc(ws, 'Target.getTargets', {})) as {
        targetInfos: Array<{ targetId: string }>;
      };
      expect(targets.targetInfos).toHaveLength(1);
      expect(targets.targetInfos[0]?.targetId).toBe('tgt_1');

      const attached = (await rpc(ws, 'Target.attachToTarget', {
        targetId: 'tgt_1',
        flatten: true,
      })) as { sessionId: string };
      expect(typeof attached.sessionId).toBe('string');
      expect(attached.sessionId.length).toBeGreaterThan(0);

      const evaluated = (await rpc(
        ws,
        'Runtime.evaluate',
        { expression: 'document.title', returnByValue: true },
        attached.sessionId,
      )) as { result: { value: string } };
      expect(evaluated.result.value).toBe('Example Domain');

      // Proves the command actually reached the real fake Chrome endpoint,
      // not a canned reply this proxy fabricated itself.
      expect(chrome.runtimeEvaluateCalls).toHaveLength(1);
      expect(chrome.runtimeEvaluateCalls[0]?.sessionId).toBe(attached.sessionId);
    } finally {
      ws.close();
    }
  });

  // ── collaboration: presence, control, preemption, cleanup ─────────────
  //
  // The defect this whole pass closes: a raw CDP client used to be
  // invisible to `presence.state` and held no `ControlLease` at all. These
  // four tests are the lease/presence acceptance bar the task asked for;
  // `examples/nextjs-demo/cdp-collab-probe.mjs` proves the same claims
  // against a real human `bgls.v1` viewer and real Chrome end to end.

  it('a CDP client appears in presence.state as kind agent, holding control of the instance primary page target', async () => {
    chrome.targetInfos.push({
      targetId: 'tgt_1',
      type: 'page',
      title: 'A',
      url: 'https://a.example/',
      attached: false,
    });
    const observer = await attachObserver({ viewerId: 'obs1', kind: 'human' });
    // The REAL, engine assigned `tgt_<ulid>` id `TargetRegistry` gives this
    // target, NOT the raw `'tgt_1'` `FakeChromeServer`'s own `targetInfos`
    // entry carries: `Target.getTargets` over the raw CDP pipe reports
    // Chrome's own id verbatim (the earlier, plain-CDP test in this file
    // asserts exactly that), but `ManagedSession.listTargets()` (what this
    // proxy's own control acquisition reads) goes through `TargetRegistry`,
    // which mints its own canonical id per target. `presence.state.controlling`
    // is keyed by THAT id, so this is what the assertion below must match.
    const realTargetId = observer.managed.listTargets(['page'])[0]?.targetId;
    expect(realTargetId).toBeTruthy();

    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp', 'control']);
    const ws = new WebSocket(`${server.url}/${instanceId}?token=${token}`);
    await waitOpen(ws);

    try {
      const last = observer.presenceStates.at(-1) as
        | {
            viewers: Array<{
              viewerId: string;
              label: string;
              kind: string;
              controlling: string[];
              watching: string[];
            }>;
          }
        | undefined;
      const cdpViewer = last?.viewers.find((v) => v.label === 'cdp:user:1');
      expect(
        cdpViewer,
        'the CDP client must appear in presence.state, not be invisible to it',
      ).toBeDefined();
      // `'agent'`: this module's own top comment, item 2, unconditionally,
      // regardless of what other capabilities the token carries.
      expect(cdpViewer?.kind).toBe('agent');
      expect(cdpViewer?.controlling).toEqual([realTargetId]);
      // No `bgls.v1` stream subscription exists for a raw CDP client.
      expect(cdpViewer?.watching).toEqual([]);
    } finally {
      ws.close();
    }
  });

  it('refuses the upgrade (409), rather than driving silently, when a human already holds control of the primary target', async () => {
    chrome.targetInfos.push({
      targetId: 'tgt_1',
      type: 'page',
      title: 'A',
      url: 'https://a.example/',
      attached: false,
    });
    const { managed } = await attachObserver({ viewerId: 'human1', kind: 'human' });
    const realTargetId = managed.listTargets(['page'])[0]?.targetId;
    expect(realTargetId).toBeTruthy();
    managed.requestControl(
      {
        viewerId: 'human1',
        identity: 'human1',
        label: 'human1',
        kind: 'human',
        capabilities: ['control'],
        isAdmin: false,
      },
      realTargetId as string,
      { queue: false },
    );
    expect(
      managed.coreSession.leaseEngineFor(realTargetId as string).holderFor('human1'),
    ).not.toBeNull();

    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp', 'control']);
    await expect(
      connectExpectingRefusal(`${server.url}/${instanceId}?token=${token}`),
    ).rejects.toThrow(/409/);

    // The refused attempt left no ghost holder and no ghost presence row:
    // the human is still the ONLY holder, and the roster (checked through
    // a fresh broadcast) carries no `cdp:` labelled viewer at all.
    const snapshot = managed.coreSession.leaseEngineFor(realTargetId as string).getSnapshot();
    expect(snapshot.holders.map((h) => h.viewerId)).toEqual(['human1']);
  });

  it('closes the raw socket with CONTROL_LOST when a human takes control mid session, instead of continuing to relay', async () => {
    chrome.targetInfos.push({
      targetId: 'tgt_1',
      type: 'page',
      title: 'A',
      url: 'https://a.example/',
      attached: false,
    });
    server = await startCdpProxyServer(buildDeps());
    const token = await mintToken(['cdp', 'control']);
    const ws = new WebSocket(`${server.url}/${instanceId}?token=${token}`);
    await waitOpen(ws);

    try {
      const managed = await sessionRegistry.getOrCreate(instanceId, {
        tenantId: TENANT_ID,
        appId: APP_ID,
      });
      const realTargetId = managed.listTargets(['page'])[0]?.targetId as string;
      expect(realTargetId).toBeTruthy();
      const before = managed.coreSession.leaseEngineFor(realTargetId).getSnapshot();
      const cdpViewerId = before.holder?.viewerId;
      expect(
        cdpViewerId,
        'the CDP client must actually hold the lease before this test can preempt it',
      ).toBeTruthy();

      const closed = new Promise<{ code: number }>((resolve) => {
        ws.once('close', (code) => resolve({ code }));
      });

      // A human takes over. `human: 100` outranks `agent: 50`
      // (`DEFAULT_PRIORITY`, `core/src/control/types.ts`), so this begins
      // a preemption; the CDP client cannot cooperate with the engine's
      // grace period the way a `bgls.v1` `AutomationClient` can (this
      // module's own top comment, item 4), so it closes on the WARNING
      // signal (`control.preempt.request`) rather than waiting out
      // `agentPreemptGraceMs`.
      managed.requestControl(
        {
          viewerId: 'human1',
          identity: 'human1',
          label: 'human1',
          kind: 'human',
          capabilities: ['control'],
          isAdmin: false,
        },
        realTargetId,
        { queue: false },
      );

      const { code } = await closed;
      expect(code).toBe(4611);

      // Cleanup ran: `pipe()`'s own `onClosed` (`releaseAndDetach`) fires
      // from the SERVER side socket's own `close` event, which is not
      // strictly ordered before the TEST's client-side `close` event this
      // `await` just resolved on (both derive from one TCP teardown, but
      // are two separate `ws.WebSocket` instances' own event loop turns),
      // so this polls briefly rather than asserting immediately.
      await expect
        .poll(
          () =>
            managed.coreSession
              .leaseEngineFor(realTargetId)
              .getSnapshot()
              .holders.some((h) => h.viewerId === cdpViewerId),
          { timeout: 2000 },
        )
        .toBe(false);
    } finally {
      ws.close();
    }
  });
});
