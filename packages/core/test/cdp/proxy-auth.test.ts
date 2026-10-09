/**
 * `ProxyAuthHandler` behaviour, plus the `CdpBridge.armProxyAuth`/
 * `disarmProxyAuth`/`hasPlainFetchInterception` composition `./bridge.ts`'s
 * `send()` performs so a `RequestGate` and a `ProxyAuthHandler` never
 * silently disable each other on one session (`../../src/cdp/proxy-auth.ts`'s
 * module doc, "The central design problem").
 *
 * The tests that matter most here are not the happy path either, same as
 * `request-gate.test.ts`'s own framing:
 *  * coexistence, both directions (a plain `Fetch.enable` before proxy auth
 *    arms, and after), because a silent clobber in either direction is
 *    exactly the bug this design exists to prevent; and
 *  * re-arming after a rebind, because a proxy auth handler that misses a
 *    renderer swap, a re-attach, or a transport reconnect looks like an
 *    intermittent proxy outage with nothing anywhere to explain it; and
 *  * credentials never reaching anywhere but the one legitimate CDP call.
 */

import { describe, expect, it } from 'vitest';
import { type ProxyAuthCredentials, ProxyAuthHandler } from '../../src/cdp/proxy-auth.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { connectFakeBridge } from './test-helpers.js';

const CREDS: ProxyAuthCredentials = { username: 'proxy-user', password: 'hunter2-super-secret' };

/** Attaches `targetId` on `bridge`'s world and returns the live `CdpSessionId` the fake responder minted for it. */
async function attachSession(
  bridge: Awaited<ReturnType<typeof connectFakeBridge>>['bridge'],
  world: Awaited<ReturnType<typeof connectFakeBridge>>['world'],
  targetId: string,
): Promise<CdpSessionId> {
  world.targetInfos.push({
    targetId,
    type: 'page',
    title: '',
    url: 'https://example.com',
    attached: false,
  });
  const handle = await bridge.sessionFor(targetId);
  return handle.id;
}

describe('ProxyAuthHandler: arming', () => {
  it('arms Fetch with a Request-stage catchall and handleAuthRequests: true', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });

    expect(handler.isArmed).toBe(false);
    await handler.start();
    expect(handler.isArmed).toBe(true);

    const enable = socket.lastSent('Fetch.enable');
    expect(enable?.params).toEqual({
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: true,
    });
  });

  it('start() is idempotent and does not re-arm a second time on the same session', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });

    await handler.start();
    await handler.start();
    expect(socket.allSent('Fetch.enable')).toHaveLength(1);
  });

  it('stop() disarms and stop() is idempotent', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    await handler.stop();
    expect(handler.isArmed).toBe(false);
    expect(socket.lastSent('Fetch.disable')).toBeDefined();

    await handler.stop();
    expect(socket.allSent('Fetch.disable')).toHaveLength(1);
  });
});

describe('ProxyAuthHandler: auth challenges', () => {
  it('answers a Proxy source challenge with ProvideCredentials, carrying the configured username and password', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    socket.emitEvent(
      'Fetch.authRequired',
      {
        requestId: 'auth-1',
        authChallenge: { source: 'Proxy', origin: 'http://proxy.example:8080' },
      },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();

    const cont = socket.lastSent('Fetch.continueWithAuth');
    expect(cont?.params).toEqual({
      requestId: 'auth-1',
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username: CREDS.username,
        password: CREDS.password,
      },
    });
  });

  it('answers a non Proxy (Server) source challenge with Default, never handing that site the proxy credentials', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'auth-2', authChallenge: { source: 'Server', origin: 'https://site.example' } },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();

    const cont = socket.lastSent('Fetch.continueWithAuth');
    expect(cont?.params).toEqual({
      requestId: 'auth-2',
      authChallengeResponse: { response: 'Default' },
    });
    expect(JSON.stringify(cont?.params)).not.toContain(CREDS.password);
  });

  it('continues a non-auth Request-stage pause unconditionally when no RequestGate is present, so ordinary traffic does not stall behind a domain nobody else is answering', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    socket.emitEvent(
      'Fetch.requestPaused',
      {
        requestId: 'req-1',
        resourceType: 'Document',
        request: { url: 'https://example.com/', method: 'GET', headers: {} },
      },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();

    const cont = socket.lastSent('Fetch.continueRequest');
    expect(cont?.params).toEqual({ requestId: 'req-1' });
  });

  it('leaves a Response-stage pause untouched instead of deciding on it, since it only ever asks for the Request stage', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    socket.emitEvent('Fetch.requestPaused', { requestId: 'req-2', responseStatusCode: 200 }, sid);
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.lastSent('Fetch.continueRequest')?.params).toEqual({ requestId: 'req-2' });
  });
});

describe('ProxyAuthHandler: re-arming on a fresh session', () => {
  it('rebind() re-arms on the new session and stale events on the old session id are ignored', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid1 = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid1, credentials: CREDS });
    await handler.start();

    // A cross origin navigation: Chrome tears down the old renderer's
    // session and mints a fresh one for the SAME target (`Target.attachToTarget`
    // again, matching `registry.test.ts`'s own cross origin navigation
    // fixture), the exact seam `../../src/cdp/target-registry.ts`'s
    // `installProxyAuth` drives this class's `rebind()` from.
    world.targetInfos.push({
      targetId: 'T1-again',
      type: 'page',
      title: '',
      url: 'https://b.example',
      attached: false,
    });
    const handle2 = await bridge.sessionFor('T1-again');
    const sid2 = handle2.id;

    await handler.rebind(sid2);
    expect(handler.isArmed).toBe(true);
    expect(socket.allSent('Fetch.enable')).toHaveLength(2);

    // A stale authRequired on the OLD session must not be answered by this
    // handler any more (it may already belong to a different, unrelated
    // consumer by the time it arrives).
    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'stale', authChallenge: { source: 'Proxy' } },
      sid1,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.allSent('Fetch.continueWithAuth')).toHaveLength(0);

    // The new session's own challenge IS answered.
    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'fresh', authChallenge: { source: 'Proxy' } },
      sid2,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.allSent('Fetch.continueWithAuth')).toHaveLength(1);
  });
});

describe('ProxyAuthHandler + RequestGate coexistence (via CdpBridge Fetch composition)', () => {
  it("RequestGate active FIRST: arming proxy auth afterwards keeps the catchall patterns AND turns handleAuthRequests on, instead of the arm silently dropping RequestGate's own interception", async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');

    // Simulate RequestGate.start(): a plain Fetch.enable, unaware proxy
    // auth exists, exactly the payload request-gate.test.ts pins.
    await bridge.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sid,
    );
    expect(bridge.hasPlainFetchInterception(sid)).toBe(true);

    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    const enable = socket.lastSent('Fetch.enable');
    expect(enable?.params).toEqual({
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: true,
    });

    // With RequestGate present, this handler's own requestPaused listener
    // must defer rather than race the gate's own verdict.
    socket.emitEvent(
      'Fetch.requestPaused',
      {
        requestId: 'req-1',
        resourceType: 'Document',
        request: { url: 'https://example.com/', method: 'GET', headers: {} },
      },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.allSent('Fetch.continueRequest')).toHaveLength(0);
  });

  it('proxy auth armed FIRST: a plain Fetch.enable sent afterwards (simulating RequestGate.start()) still composes handleAuthRequests: true, instead of silently turning auth off', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');

    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();
    expect(socket.lastSent('Fetch.enable')?.params).toMatchObject({ handleAuthRequests: true });

    // RequestGate.start()'s own call, sent with no knowledge of proxy auth.
    await bridge.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sid,
    );

    const enable = socket.lastSent('Fetch.enable');
    expect(enable?.params).toEqual({
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: true,
    });
    expect(bridge.hasPlainFetchInterception(sid)).toBe(true);

    // The proxy auth challenge is still answered after the plain re-enable.
    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'auth-1', authChallenge: { source: 'Proxy' } },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.lastSent('Fetch.continueWithAuth')?.params).toMatchObject({
      requestId: 'auth-1',
    });
  });

  it('RequestGate.stop() (a plain Fetch.disable) while proxy auth is still armed falls back to the plain config with auth off, instead of disabling Fetch out from under the still-armed handler', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');

    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();
    await bridge.send(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sid,
    );

    // RequestGate.stop()'s own call.
    await bridge.send('Fetch.disable', undefined, sid);

    expect(bridge.hasPlainFetchInterception(sid)).toBe(false);
    expect(handler.isArmed).toBe(true);
    // Fetch was never actually disabled: the last thing sent is an
    // ENABLE (auth-only shape), not a disable.
    expect(socket.sent[socket.sent.length - 1]?.method).toBe('Fetch.enable');
    expect(socket.sent[socket.sent.length - 1]?.params).toEqual({
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: true,
    });

    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'auth-2', authChallenge: { source: 'Proxy' } },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(socket.lastSent('Fetch.continueWithAuth')?.params).toMatchObject({
      requestId: 'auth-2',
    });
  });

  it('disarming proxy auth when no plain caller is active sends a real Fetch.disable', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    await handler.stop();

    expect(socket.lastSent('Fetch.disable')).toBeDefined();
    expect(bridge.hasPlainFetchInterception(sid)).toBe(false);
  });
});

describe('ProxyAuthHandler: credentials never leak', () => {
  it('a rejected Fetch.continueWithAuth reports an error to onError whose own serialisation never contains the password', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const errors: unknown[] = [];
    const handler = new ProxyAuthHandler({
      bridge,
      sessionId: sid,
      credentials: CREDS,
      onError: (err) => errors.push(err),
    });
    await handler.start();

    socket.autoRespond = (msg, sock) => {
      if (msg.method === 'Fetch.continueWithAuth') {
        sock.emitError(msg.id, { code: -32000, message: 'Session with given id not found' });
        return;
      }
      sock.emitResult(msg.id, {});
    };

    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'auth-fail', authChallenge: { source: 'Proxy' } },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    const serialised = JSON.stringify(errors[0], Object.getOwnPropertyNames(errors[0] as object));
    expect(serialised).not.toContain(CREDS.password);
    expect(serialised).not.toContain(CREDS.username);
    expect((errors[0] as Error).message).not.toContain(CREDS.password);
  });

  it('the only wire message anywhere containing the password is the single Fetch.continueWithAuth call answering a Proxy challenge', async () => {
    const { bridge, world, socket } = await connectFakeBridge();
    const sid = await attachSession(bridge, world, 'T1');
    const handler = new ProxyAuthHandler({ bridge, sessionId: sid, credentials: CREDS });
    await handler.start();

    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'auth-3', authChallenge: { source: 'Proxy' } },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();
    // A non-auth request and a non-proxy challenge on the same session,
    // exercising every OTHER outbound call this handler makes.
    socket.emitEvent(
      'Fetch.requestPaused',
      {
        requestId: 'req-3',
        resourceType: 'Document',
        request: { url: 'https://example.com/', method: 'GET', headers: {} },
      },
      sid,
    );
    socket.emitEvent(
      'Fetch.authRequired',
      { requestId: 'auth-4', authChallenge: { source: 'Server' } },
      sid,
    );
    await Promise.resolve();
    await Promise.resolve();

    const carryingPassword = socket.sent.filter((m) => JSON.stringify(m).includes(CREDS.password));
    expect(carryingPassword).toHaveLength(1);
    expect(carryingPassword[0]?.method).toBe('Fetch.continueWithAuth');
    expect(carryingPassword[0]?.params).toMatchObject({ requestId: 'auth-3' });

    // And bridge-level stats, which every diagnostics/monitoring consumer
    // in this build reads, never carry it either (`CdpBridgeStats` has no
    // field that could: see `./bridge.ts`'s `stats()`).
    expect(JSON.stringify(bridge.stats())).not.toContain(CREDS.password);
  });
});
