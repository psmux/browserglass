import { Transport, type TransportHelloOptions } from '@browserglass/client';
import {
  type Envelope,
  FrameFlag,
  type InstanceId,
  decodeBinaryHeader,
} from '@browserglass/protocol';
/**
 * The structurally load-bearing protocol assertions, run against a real
 * gateway
 * (`@browserglass/server` plus real `@browserglass/store-sqlite`, real
 * `@browserglass/router`, and real `@browserglass/runtime-host` launching
 * real Chrome on this machine) rather than the fake-CDP harness
 * `@browserglass/server`'s own unit suite uses (this package is the one
 * that gives the router-integrated, real-Chrome path its own end to end
 * coverage).
 *
 * Uses `@browserglass/client`'s low level `Transport` class directly
 * (not the higher level `BrowserGlassClient`), since these assertions are
 * about exact wire behaviour: envelope ordering, `sidEpoch`/`gen`
 * bumps, and the raw binary frame header's flags.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { type RealGateway, startRealGateway } from './support/real-gateway.js';

const HELLO: TransportHelloOptions = {
  client: { name: 'conformance', version: '0.0.0', runtime: 'node' },
  capabilities: {
    codecs: ['jpeg'],
    binaryFrames: true,
    input: ['mouse', 'key', 'text', 'touch', 'scroll'],
  },
  viewport: { width: 1280, height: 720, dpr: 1, visible: true, fitMode: 'contain' },
};

let gateway: RealGateway;

beforeAll(async () => {
  gateway = await startRealGateway({ headless: 'new' });
}, 120_000);

afterAll(async () => {
  await gateway.close();
}, 60_000);

/** Instances acquired by the current test, released in `afterEach` so a real gateway's `maxConcurrentLaunches` never backs up across an already-finished test's still-live Chrome. */
const acquiredThisTest: InstanceId[] = [];

afterEach(async () => {
  for (const instanceId of acquiredThisTest.splice(0)) {
    await gateway.releaseInstance(instanceId);
  }
});

/**
 * Builds a real, connected `Transport` against `gateway`, plus a real
 * target to subscribe to. The target list comes from `welcome.targets`,
 * not `AcquireResult.targets`: the router places and launches Chrome but
 * never talks CDP itself (the router places, it does not stream), so `BrowserRouter.acquire()`'s own result always reports an
 * empty `targets` array; real target discovery only happens once a
 * viewer socket connects and `core.TargetRegistry` starts against the
 * live CDP endpoint.
 */
async function connectedTransport(
  caps?: readonly string[],
): Promise<{ transport: Transport; targetId: string }> {
  const result = await gateway.acquireInstance();
  acquiredThisTest.push(result.instanceId);
  const token = await gateway.mintToken(
    result.instanceId,
    caps ? { caps: caps as never } : undefined,
  );
  const transport = new Transport({
    url: gateway.wsUrl,
    token,
    autoReconnect: false,
    hello: HELLO,
    transport: { WebSocketImpl: WebSocket as never, allowInsecureTransport: true },
  });
  // This low level `Transport` class deliberately never acks a binary frame
  // on its own (only the higher level `BrowserGlassClient` does, after a
  // real decode); a caller using `Transport` directly is responsible for
  // acking. `Attachment`'s fan out gate (`packages/server/src/session/frame-pipeline.ts`,
  // `packages/core/src/stream/attachment.ts`) legitimately stops sending
  // new frames to an attachment once `maxBacklog` (3) frames are
  // outstanding unacked, exactly as it would for a real, slow client; every
  // one of this file's cases needs frames to keep flowing past that first
  // burst, so this helper acks every binary frame it receives, matching
  // what a real client does.
  transport.on('binary', (buf) => {
    const header = decodeBinaryHeader(buf);
    transport.send({
      v: 1,
      t: 'ack',
      ts: Date.now(),
      streamId: header.streamId,
      seq: header.seq,
    } as never);
  });
  const connected = new Promise<{ targets: readonly { targetId: string }[] }>((resolve) => {
    transport.once('connected', (info) => resolve(info.welcome));
  });
  await transport.connect();
  const welcome = await connected;
  const targetId = welcome.targets[0]?.targetId;
  if (!targetId) throw new Error('welcome reported no targets');
  return { transport, targetId };
}

/** Waits for the next binary frame and decodes its header. */
function nextFrame(transport: Transport): Promise<ReturnType<typeof decodeBinaryHeader>> {
  return new Promise((resolve) => {
    transport.once('binary', (buf) => resolve(decodeBinaryHeader(buf)));
  });
}

/** Waits for the next control message matching `predicate`. */
function nextMessageWhere(
  transport: Transport,
  predicate: (env: Envelope) => boolean,
  timeoutMs = 15_000,
): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error(`timed out waiting for a matching message after ${timeoutMs}ms`));
    }, timeoutMs);
    const unsub = transport.on('message', (env) => {
      if (predicate(env)) {
        clearTimeout(timer);
        unsub();
        resolve(env);
      }
    });
  });
}

describe('load-bearing conformance (against a real gateway and real Chrome)', () => {
  it('#18 the client ignores an unknown `t` without error: the socket stays open and later messages still arrive', async () => {
    const { transport, targetId } = await connectedTransport();
    try {
      // The server never emits an unrecognised `t` on its own; this proves
      // the CLIENT side of #18 by sending a bogus `t` back at the server
      // (which itself ignores unknown types per the same rule) and then
      // confirming the connection is still fully live for a real
      // subsequent exchange, rather than asserting on an internal client
      // code path directly.
      transport.send({ v: 1, t: 'totally.unknown.message.type', ts: Date.now() } as never);
      const subscribed = nextMessageWhere(transport, (e) => e['t'] === 'stream.subscribed');
      transport.send({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId } as never);
      const env = await subscribed;
      expect(env['t']).toBe('stream.subscribed');
    } finally {
      await transport.disconnect();
    }
  });

  it('#38 keyframe on subscribe: the very first frame on a fresh subscription carries the KEYFRAME flag', async () => {
    const { transport, targetId } = await connectedTransport();
    try {
      const framePromise = nextFrame(transport);
      transport.send({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId } as never);
      const header = await framePromise;
      expect(header.keyframe).toBe(true);
    } finally {
      await transport.disconnect();
    }
  });

  // Un-skipped: the original diagnosis ("the request is silently
  // swallowed somewhere in the forceFrame() chain") was traced to be wrong.
  // A from-scratch, fully-logged trace against real Chrome found
  // `forceFrame()`'s entire chain (`ManagedSession.requestKeyframe()` ->
  // `Session.streamHandleFor(targetId).forceFrame()` ->
  // `TargetActivationPolicy.current(targetId)?.forceFrame()` ->
  // `CdpScreencastSource.forceFrame()`'s `Page.captureScreenshot`) resolves
  // correctly and hands the forced frame to `ManagedSession.handleFrame()`
  // every time; the frame was then legitimately dropped by
  // `frameOutAttachments`'s own backpressure gate
  // (`packages/server/src/session/frame-pipeline.ts`, mirroring `core`'s
  // `fanOut`), since this test never sent an `ack` for the 3 frames a fresh
  // subscribe bursts out, and `Attachment.maxBacklog` (3) was reached before
  // any of them could drain. `connectedTransport()` above now acks every
  // binary frame it receives, matching what a real client
  // (`@browserglass/client`'s `BrowserGlassClient`) does automatically; this
  // case passes with that fix alone, no `core`/`server` production code
  // needed to change for it.
  it('#38 keyframe on keyframe.request: an explicit request produces a KEYFRAME flagged frame', async () => {
    const { transport, targetId } = await connectedTransport();
    try {
      const initialKeyframe = nextFrame(transport); // the initial subscribe keyframe
      const subscribedPromise = nextMessageWhere(transport, (e) => e['t'] === 'stream.subscribed');
      transport.send({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId } as never);
      await initialKeyframe;
      const subscribed = await subscribedPromise;
      const streamId = subscribed['streamId'] as number;

      const nextAfterRequest = nextFrame(transport);
      transport.send({ v: 1, t: 'keyframe.request', ts: Date.now(), streamId } as never);
      const header = await nextAfterRequest;
      expect(header.streamId).toBe(streamId);
      expect(header.keyframe).toBe(true);
    } finally {
      await transport.disconnect();
    }
  });

  // Un-skipped: this case's own real bug turned out to be separate from the
  // `keyframe.request` case above's (that one was never a production bug at
  // all, see its own comment). `stream.quality`'s wire doc
  // (`packages/protocol/src/wire/messages/streams.ts`'s `StreamQuality`)
  // documents it as "Answered with a re-emitted `stream.subscribed` carrying
  // a bumped `sidEpoch`", but `ManagedSession.setQuality()` never bumped
  // `sidEpoch`, never re-emitted `stream.subscribed`, never forced a
  // keyframe, and (this case's own `maxWidth`/`maxHeight`-only request)
  // returned immediately without doing anything at all whenever `quality`
  // was omitted. Replaced with `ManagedSession.reconfigureStream()`, which
  // implements the documented contract.
  it('#39 keyframe on sidEpoch change: stream.quality re-emits stream.subscribed with a bumped sidEpoch and the following frame is a keyframe', async () => {
    const { transport, targetId } = await connectedTransport();
    try {
      transport.send({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId } as never);
      const firstSubscribed = await nextMessageWhere(
        transport,
        (e) => e['t'] === 'stream.subscribed',
      );
      const streamId = firstSubscribed['streamId'] as number;
      const initialEpoch = firstSubscribed['sidEpoch'] as number;

      const reconfigured = nextMessageWhere(
        transport,
        (e) => e['t'] === 'stream.subscribed' && e['streamId'] === streamId,
      );
      const nextKeyframe = nextFrame(transport);
      transport.send({
        v: 1,
        t: 'stream.quality',
        ts: Date.now(),
        streamId,
        maxWidth: 640,
        maxHeight: 480,
      } as never);

      const resub = await reconfigured;
      expect(resub['sidEpoch']).toBeGreaterThan(initialEpoch);

      const header = await nextKeyframe;
      expect(header.streamId).toBe(streamId);
      expect(header.keyframe).toBe(true);
    } finally {
      await transport.disconnect();
    }
  });

  it('#41 input without a lease is dropped and answered with a non-fatal error: no close, the socket stays healthy', async () => {
    // This assertion changed shape deliberately, and the change is worth
    // recording rather than just editing over.
    //
    // The rule used to be that unleased input was dropped SILENTLY: no
    // error reply at all. That is what this test asserted. It was changed
    // in `packages/core`'s `buildInputDispatcher`, whose `onSignal` was
    // previously an empty function, so every dropped input produced no
    // reply, no log line, and nothing else. Its own comment records what
    // that cost: it hid three separate defects that stopped automation
    // input dead, because "my clicks do nothing" and "my clicks are being
    // refused for a specific, nameable reason" were indistinguishable from
    // the outside.
    //
    // What the server sends now is bounded and specific. It is coalesced
    // to one report per `(viewer, target, kind, code)` per
    // `INPUT_SIGNAL_COALESCE_MS` (5s, `managed-session.ts`), so a control
    // handoff turning a few hundred in-flight moves into `stale_lease`
    // drops still yields one message, and the code distinguishes "you hold
    // no lease" from "your lease id is outdated" so the client knows which
    // of the two to fix.
    //
    // Every SAFETY property this test existed to protect is asserted
    // below and still holds: the input is not dispatched, the error is not
    // fatal, the socket is not closed, and the connection is still fully
    // usable afterwards. Only the silence went away.
    const { transport, targetId } = await connectedTransport();
    try {
      const errors: Record<string, unknown>[] = [];
      const unsub = transport.on('message', (e) => {
        if (e['t'] === 'error') errors.push(e as Record<string, unknown>);
      });

      // Learn the target's REAL generation first, rather than hardcoding
      // one. This is not incidental setup, it is what makes the test test
      // what its name says.
      //
      // `InputDispatcher` checks the generation BEFORE the lease fence
      // (`packages/core/src/input/dispatcher.ts`), and a stale generation
      // on a `move` is dropped SILENTLY on purpose: moves arrive at cursor
      // rate, so erroring on each one during a generation bump would flood
      // a client with thousands of identical messages. A hardcoded `gen: 0`
      // therefore never reaches the lease check at all once the target has
      // per-target state, and this test would pass or fail depending on
      // whether something else had happened to create that state first.
      // It did exactly that: it passed while `getGeneration` was returning
      // its `?? 0` fallback for a target with no state, and started failing
      // the moment something created the state earlier.
      const probed = nextMessageWhere(transport, (e) => e['t'] === 'target.probed');
      transport.send({
        v: 1,
        t: 'target.probe',
        ts: Date.now(),
        targetId,
        x: 0,
        y: 0,
        fw: 1280,
        fh: 720,
        detail: 'hover',
      } as never);
      const gen = Number((await probed)['gen'] ?? 0);

      transport.send({
        v: 1,
        t: 'input.mouse',
        ts: Date.now(),
        targetId,
        kind: 'move',
        x: 10,
        y: 10,
        buttons: 0,
        modifiers: 0,
        fw: 1280,
        fh: 720,
        gen,
        leaseId: 'lse_notheldbyanyone00000000',
      } as never);

      // Prove the connection is still fully alive after the dropped
      // input: a real application `ping`/`pong` round trip.
      const pong = new Promise<void>((resolve) => transport.once('pong', () => resolve()));
      transport.send({ v: 1, t: 'ping', ts: Date.now(), cts: Date.now() } as never);
      await pong;

      // The `pong` above proves the socket survived, which is the
      // load-bearing half of this test: an unauthorised input must never
      // cost a viewer its connection.
      expect(transport.state).not.toBe('fatal');

      // Then WAIT for the error rather than assuming the pong ordered it.
      //
      // Asserting on `errors` straight after the pong is a race, and it is
      // one this test actually lost: it passed run in isolation and failed
      // in a full suite run with `expected [] to have a length of 1`. The
      // pong says the socket is alive, nothing more. The input signal
      // travels a different path (`core`'s `InputDispatcher` raises it
      // asynchronously, `ManagedSession.reportInputSignal` coalesces it,
      // and only then does it reach this socket), so on a loaded machine it
      // can easily land after a ping that was answered immediately. There
      // is no ordering guarantee between the two and there should not be
      // one.
      await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0), {
        timeout: 5000,
        interval: 50,
      });

      unsub();

      // Exactly one report for one offending message, naming the fault the
      // client can actually act on.
      expect(errors).toHaveLength(1);
      const err = errors[0] as Record<string, unknown>;
      expect(err['code']).toBe('bgls.error.control.not_held');
      expect(err['category']).toBe('control');
      expect(err['fatal']).toBe(false);
      // Not retryable: resending the same message unchanged fails the same
      // way. The client has to acquire a lease first.
      expect(err['retryable']).toBe(false);
      expect((err['context'] as Record<string, unknown>)['targetId']).toBe(targetId);
    } finally {
      await transport.disconnect();
    }
  });

  it('#59-64 goodbye precedes every writable 4xxx close: an invalid credential closes with error, then goodbye, then the socket', async () => {
    const messages: Envelope[] = [];
    const transport = new Transport({
      url: gateway.wsUrl,
      token: 'not.a.valid.jwt',
      autoReconnect: false,
      hello: HELLO,
      transport: { WebSocketImpl: WebSocket as never, allowInsecureTransport: true },
    });
    transport.on('message', (e) => messages.push(e));
    const fatal = new Promise<{ code: number }>((resolve) =>
      transport.once('fatal', (info) => resolve(info)),
    );

    await expect(transport.connect()).rejects.toBeDefined();
    const info = await fatal;

    expect(info.code).toBeGreaterThanOrEqual(4200);
    expect(info.code).toBeLessThan(4300);

    const errorIndex = messages.findIndex((m) => m['t'] === 'error');
    const goodbyeIndex = messages.findIndex((m) => m['t'] === 'goodbye');
    expect(errorIndex).toBeGreaterThanOrEqual(0);
    expect(goodbyeIndex).toBeGreaterThan(errorIndex);
    expect((messages[goodbyeIndex] as unknown as { code: number }).code).toBe(info.code);
  });
});
