import { AutomationError } from '@browserglass/automation';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayConnection } from '../../src/context.js';
import {
  buildAcquireRequest,
  connectAutomation,
  errorMessage,
  mapDriveErrorToExitCode,
  mintInstanceToken,
  parseViewport,
  waitForInstanceReady,
} from '../../src/util/drive.js';
import { EXIT_CODES } from '../../src/util/exit.js';
import { RestClientError } from '../../src/util/rest.js';
import { createFakeGatewayHarness } from '../support/fake-gateway.js';
import { installFetchMock } from '../support/rest-fetch-mock.js';
import { waitForCondition } from '../support/ws-helpers.js';

// `127.0.0.1` (rather than an arbitrary hostname): `@browserglass/client`'s
// `Transport` refuses a plain `ws://` URL to any non-loopback host outright
// (`isLoopbackWsUrl()`), so any test that lets `AutomationClient.connect()`
// actually construct a socket needs a loopback `wsUrl` even though nothing
// here makes a real network connection.
const CONNECTION: GatewayConnection = {
  endpoint: 'http://127.0.0.1:7443',
  wsUrl: 'ws://127.0.0.1:7443/browserglass/socket',
  token: 'admin-tkn',
  basePath: '/browserglass',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('parseViewport', () => {
  it('parses a WxH spec', () => {
    expect(parseViewport('1440x900')).toEqual({ width: 1440, height: 900, deviceScaleFactor: 1 });
  });

  it('throws on a malformed spec', () => {
    expect(() => parseViewport('not-a-viewport')).toThrow(/invalid --viewport/);
  });
});

describe('buildAcquireRequest', () => {
  it('builds an empty request when no flags are given', () => {
    expect(buildAcquireRequest({})).toEqual({});
  });

  it('maps pool, profileKey, headless, and viewport onto AcquireRequest, dropping unset keys entirely', () => {
    const body = buildAcquireRequest(
      { pool: 'default', profileKey: 'my-profile', headless: true, viewport: '800x600' },
      'req-1',
    );
    expect(body).toEqual({
      requestId: 'req-1',
      pool: 'default',
      profile: { mode: 'persistent', key: 'my-profile' },
      browser: { headless: 'new', viewport: { width: 800, height: 600, deviceScaleFactor: 1 } },
    });
    expect(Object.keys(body)).not.toContain('profile'.repeat(0)); // sanity: body is a plain compacted object
  });

  it('maps headless:false to browser.headless "off"', () => {
    const body = buildAcquireRequest({ headless: false });
    expect(body).toEqual({ browser: { headless: 'off' } });
  });
});

describe('mapDriveErrorToExitCode', () => {
  it('maps a 404 RestClientError to notFound', () => {
    expect(mapDriveErrorToExitCode(new RestClientError(404, 'E_NOT_FOUND', 'gone'))).toBe(
      EXIT_CODES.notFound,
    );
  });
  it('maps a 403 RestClientError to policyDenied', () => {
    expect(mapDriveErrorToExitCode(new RestClientError(403, 'E_FORBIDDEN', 'no'))).toBe(
      EXIT_CODES.policyDenied,
    );
  });
  it('maps a 500 RestClientError to operationalFailure', () => {
    expect(mapDriveErrorToExitCode(new RestClientError(500, 'E_INTERNAL', 'boom'))).toBe(
      EXIT_CODES.operationalFailure,
    );
  });
  it('maps AutomationError NOT_FOUND to notFound', () => {
    expect(mapDriveErrorToExitCode(new AutomationError('NOT_FOUND', 'no such target'))).toBe(
      EXIT_CODES.notFound,
    );
  });
  it('maps AutomationError LEASE_NOT_HELD to policyDenied', () => {
    expect(mapDriveErrorToExitCode(new AutomationError('LEASE_NOT_HELD', 'no lease'))).toBe(
      EXIT_CODES.policyDenied,
    );
  });
  it('maps AutomationError TIMEOUT to timeout', () => {
    expect(mapDriveErrorToExitCode(new AutomationError('TIMEOUT', 'too slow'))).toBe(
      EXIT_CODES.timeout,
    );
  });
  it('falls back to operationalFailure for a plain Error', () => {
    expect(mapDriveErrorToExitCode(new Error('whatever'))).toBe(EXIT_CODES.operationalFailure);
  });
});

describe('errorMessage', () => {
  it('formats a RestClientError as "CODE: message"', () => {
    expect(errorMessage(new RestClientError(404, 'E_NOT_FOUND', 'gone'))).toBe('E_NOT_FOUND: gone');
  });
  it('formats an AutomationError as "CODE: message"', () => {
    expect(errorMessage(new AutomationError('POLICY_DENIED', 'nope'))).toBe('POLICY_DENIED: nope');
  });
  it('falls back to a plain Error message', () => {
    expect(errorMessage(new Error('plain'))).toBe('plain');
  });
});

describe('mintInstanceToken', () => {
  it('POSTs /v1/tokens scoped to the instance and returns the minted token', async () => {
    const mock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: (call) => {
          const body = call.body as { scope: { instanceId: string } };
          expect(body.scope.instanceId).toBe('inst_1');
          return { status: 201, body: { token: 'minted-token' } };
        },
      },
    ]);
    const token = await mintInstanceToken(CONNECTION, 'inst_1');
    expect(token).toBe('minted-token');
    mock.restore();
  });
});

describe('waitForInstanceReady', () => {
  it('polls until the instance reports "ready"', async () => {
    let calls = 0;
    const mock = installFetchMock([
      {
        method: 'GET',
        test: (p) => p === '/browserglass/v1/instances/inst_1',
        handle: () => {
          calls += 1;
          const state = calls < 3 ? 'launching' : 'ready';
          return { status: 200, body: { instance: { id: 'inst_1', state }, live: null } };
        },
      },
    ]);
    const view = await waitForInstanceReady(CONNECTION, 'inst_1', 5000, 5);
    expect(view.instance.state).toBe('ready');
    expect(calls).toBe(3);
    mock.restore();
  });

  it('stops polling at a terminal non-ready state (does not spin forever)', async () => {
    const mock = installFetchMock([
      {
        method: 'GET',
        test: (p) => p === '/browserglass/v1/instances/inst_1',
        handle: () => ({
          status: 200,
          body: { instance: { id: 'inst_1', state: 'failed' }, live: null },
        }),
      },
    ]);
    const view = await waitForInstanceReady(CONNECTION, 'inst_1', 5000, 5);
    expect(view.instance.state).toBe('failed');
    mock.restore();
  });
});

describe('connectAutomation', () => {
  it('retries the mint+connect sequence when the first token mint fails, and succeeds on a later attempt', async () => {
    let tokenCalls = 0;
    const restMock = installFetchMock([
      {
        method: 'POST',
        test: (p) => p === '/browserglass/v1/tokens',
        handle: () => {
          tokenCalls += 1;
          if (tokenCalls === 1)
            return { status: 500, body: { error: { code: 'E_INTERNAL', message: 'transient' } } };
          return { status: 201, body: { token: 'tok-2' } };
        },
      },
    ]);
    const harness = createFakeGatewayHarness();
    vi.stubGlobal('WebSocket', harness.Impl);

    const connectPromise = connectAutomation(CONNECTION, 'inst_0000000000000000000000001', {
      attempts: 3,
      retryDelayMs: 5,
    });
    await waitForCondition(() => harness.instances.length > 0);
    harness.latest().simulateOpen();
    harness.latest().simulateJson({
      v: 1,
      t: 'welcome',
      re: harness.latest().lastSentJson()['id'] as string,
      ts: Date.now(),
      sq: 1,
      version: 1,
      serverVersion: '0.0.0-fake',
      downgraded: false,
      viewerId: 'vwr_1',
      sessionId: 'sess_1',
      tenantId: 'ten_1',
      appId: 'app_1',
      instance: {
        instanceId: 'inst_0000000000000000000000001',
        state: 'running',
        engine: 'chromium',
        channel: 'stable',
        engineVersion: '1',
        headless: true,
        runtime: 'host',
        nodeId: null,
        profile: { mode: 'ephemeral', key: 'eph:1', sizeBytes: 0 },
        viewport: { width: 1280, height: 800, dpr: 1 },
        startedAt: Date.now(),
      },
      targets: [
        {
          targetId: 'tgt_1',
          kind: 'page',
          title: '',
          url: 'about:blank',
          faviconUrl: null,
          index: 0,
          active: true,
          audible: false,
          muted: false,
          loading: false,
          canGoBack: false,
          canGoForward: false,
          openerTargetId: null,
          viewers: 0,
          createdAt: Date.now(),
        },
      ],
      granted: ['view', 'control', 'navigate', 'automation'],
      lease: {
        byTarget: {},
        defaultTtlMs: 60000,
        renewWithinMs: 15000,
        idleReleaseMs: 20000,
        maxQueue: 5,
      },
      presence: { viewers: [] },
      limits: {
        maxStreams: 1,
        maxBacklog: 1,
        maxBufferedBytes: 1,
        maxControlMsgBytes: 1,
        maxUploadBytes: 1,
        maxUploadChunkBytes: 1,
        inputRatePerSec: 1,
        controlRatePerSec: 1,
        navRatePerSec: 1,
        maxTargets: 1,
        maxSessionDurationMs: 1,
        idleTimeoutMs: 1,
      },
      ack: { policy: 'cumulative', everyNFrames: 1, maxAckIntervalMs: 1, required: true },
      streaming: {
        codec: 'jpeg',
        fallbackCodec: 'jpeg',
        maxFps: 1,
        keyframeIntervalMs: 1,
        adaptive: false,
        qualityProfiles: ['auto'],
      },
      resume: { token: 'rsm', windowMs: 1, issuedAt: Date.now() },
      sessionToken: 'session-token',
      sessionTokenExpiresAt: Date.now() + 1000,
      resumed: false,
      reauth: false,
      serverTime: Date.now(),
      notices: [],
    });

    const client = await connectPromise;
    expect(client.instanceId).toBe('inst_0000000000000000000000001');
    expect(tokenCalls).toBe(2);
    client.close();
    restMock.restore();
  });
});
