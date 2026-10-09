import { Transport, type TransportHelloOptions } from '@browserglass/client';
import { type Envelope, type InstanceId, decodeBinaryHeader } from '@browserglass/protocol';
/**
 * Regression coverage for reply correlation: every
 * direct, single-recipient reply `packages/server/src/ws/connection.ts`
 * sends in answer to a client message carrying `id` must echo that `id`
 * as `re` (`packages/protocol/src/wire/envelope.ts`).
 * `@browserglass/client`'s `BrowserGlassClient.request()` (and
 * `@browserglass/automation`'s `AutomationCore.request()`, which mirrors it
 * over the same `Transport`) correlate a reply to its request by
 * `m.re === id`; before the fix, no direct reply ever set `re`, so
 * every one of those calls hung until its own request timeout against a
 * real gateway (this package's own `test/e2e/support/real-gateway.ts`).
 *
 * Uses `@browserglass/client`'s low level `Transport` for the first two
 * cases (raw wire visibility onto `re`, and precise, interleaved control
 * over which `id` is sent when) and the higher level `BrowserGlassClient`
 * for the third, since that is the exact class the bug report names.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
 * A real, connected `Transport` against `gateway`, plus a real target to
 * address. `instanceId` is optional so a caller can connect a second
 * viewer to the SAME instance (two connections, one target, for the
 * control-queue case below) instead of always acquiring a fresh Chrome.
 */
async function connectedTransport(
  instanceId?: InstanceId,
): Promise<{ transport: Transport; targetId: string; instanceId: InstanceId }> {
  let iid = instanceId;
  if (!iid) {
    const result = await gateway.acquireInstance();
    acquiredThisTest.push(result.instanceId);
    iid = result.instanceId;
  }
  const token = await gateway.mintToken(iid);
  const transport = new Transport({
    url: gateway.wsUrl,
    token,
    autoReconnect: false,
    hello: HELLO,
    transport: { WebSocketImpl: WebSocket as never, allowInsecureTransport: true },
  });
  // See `load-bearing.test.ts`'s own `connectedTransport` doc: acks every
  // binary frame, matching what a real client does, so the fan-out
  // backpressure gate never stalls this test.
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
  if (!targetId) throw new Error('no targets reported after connect');
  return { transport, targetId, instanceId: iid };
}

/** Resolves with the first message on `transport` whose `re` equals `id`. Rejects on timeout, exactly what a hung, un-correlated reply looked like before this fix. */
function awaitReplyOn(transport: Transport, id: string, timeoutMs = 10_000): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      off();
      reject(new Error(`no reply carrying re="${id}" arrived within ${timeoutMs}ms`));
    }, timeoutMs);
    const off = transport.on('message', (m) => {
      if (m.re !== id) return;
      clearTimeout(timer);
      off();
      resolve(m);
    });
  });
}

describe('reply correlation: `re` echoes the originating request `id` ', () => {
  it('interleaved target.list, target.capture, and two target.probe requests each get a reply carrying their own id as re, regardless of arrival order', async () => {
    const { transport, targetId } = await connectedTransport();

    const idList = `req_list_${Math.random().toString(36).slice(2)}`;
    const idCapture = `req_capture_${Math.random().toString(36).slice(2)}`;
    const idProbeA = `req_probeA_${Math.random().toString(36).slice(2)}`;
    const idProbeB = `req_probeB_${Math.random().toString(36).slice(2)}`;

    // Every promise's listener is registered before any request is sent,
    // and every request is sent before any reply is awaited: nothing
    // here depends on send order matching arrival order.
    const listPromise = awaitReplyOn(transport, idList);
    const capturePromise = awaitReplyOn(transport, idCapture);
    const probeAPromise = awaitReplyOn(transport, idProbeA);
    const probeBPromise = awaitReplyOn(transport, idProbeB);

    transport.send({ v: 1, t: 'target.list', id: idList, ts: Date.now() } as never);
    transport.send({
      v: 1,
      t: 'target.capture',
      id: idCapture,
      ts: Date.now(),
      targetId,
      format: 'jpeg',
    } as never);
    transport.send({
      v: 1,
      t: 'target.probe',
      id: idProbeA,
      ts: Date.now(),
      targetId,
      x: 1,
      y: 1,
      fw: 100,
      fh: 100,
    } as never);
    transport.send({
      v: 1,
      t: 'target.probe',
      id: idProbeB,
      ts: Date.now(),
      targetId,
      x: 2,
      y: 2,
      fw: 100,
      fh: 100,
    } as never);

    const [listReply, captureReply, probeAReply, probeBReply] = await Promise.all([
      listPromise,
      capturePromise,
      probeAPromise,
      probeBPromise,
    ]);

    expect(listReply.t).toBe('target.listed');
    expect(listReply.re).toBe(idList);
    expect(captureReply.t).toBe('target.captured');
    expect(captureReply.re).toBe(idCapture);
    expect(probeAReply.t).toBe('target.probed');
    expect(probeAReply.re).toBe(idProbeA);
    expect(probeBReply.t).toBe('target.probed');
    expect(probeBReply.re).toBe(idProbeB);

    // Four distinct requests produced four distinct `re` values: none of
    // the four was accidentally paired with another's reply.
    expect(new Set([listReply.re, captureReply.re, probeAReply.re, probeBReply.re]).size).toBe(4);

    transport.destroy();
  }, 30_000);

  it('BrowserGlassClient.capture() and .probe() resolve rather than hang when issued concurrently (the exact regression this file guards)', async () => {
    const result = await gateway.acquireInstance();
    acquiredThisTest.push(result.instanceId);
    const client = await gateway.makeClient(result.instanceId);
    await client.connect();
    const targetId = client.targets[0]?.targetId;
    if (!targetId) throw new Error('client reported no targets after connect');

    // Before the fix, every one of these three `request()` calls hung
    // until `requestTimeoutMs` (15s default) because no reply ever
    // carried a matching `re`; issuing them concurrently also proves the
    // fix does not depend on requests being answered strictly in order.
    const [capture, probeA, probeB] = await Promise.all([
      client.capture(targetId),
      client.probe(targetId, 1, 1),
      client.probe(targetId, 2, 2),
    ]);

    expect(capture.targetId).toBe(targetId);
    expect(capture.blob.size).toBeGreaterThan(0);
    expect(probeA.targetId).toBe(targetId);
    expect(probeB.targetId).toBe(targetId);

    client.destroy();
  }, 30_000);

  it('a control.request that gets queued receives its eventual, unprompted control.granted carrying the SAME re as the original request id', async () => {
    const { transport: t1, targetId, instanceId } = await connectedTransport();
    const { transport: t2 } = await connectedTransport(instanceId);

    const id1 = `req_ctrl1_${Math.random().toString(36).slice(2)}`;
    const granted1Promise = awaitReplyOn(t1, id1);
    t1.send({
      v: 1,
      t: 'control.request',
      id: id1,
      ts: Date.now(),
      targetId,
      queue: true,
    } as never);
    const granted1 = await granted1Promise;
    expect(granted1.t).toBe('control.granted');
    expect(granted1.re).toBe(id1);

    // t2 requests control on the same, already-held target: it is
    // queued, not granted. Interleaved with an unrelated target.list on
    // the same connection, sent before either reply is awaited, so this
    // also exercises correlation under interleaving on t2's own socket.
    const id2 = `req_ctrl2_${Math.random().toString(36).slice(2)}`;
    const idListT2 = `req_list2_${Math.random().toString(36).slice(2)}`;
    const queued2Promise = awaitReplyOn(t2, id2);
    const list2Promise = awaitReplyOn(t2, idListT2);
    t2.send({
      v: 1,
      t: 'control.request',
      id: id2,
      ts: Date.now(),
      targetId,
      queue: true,
    } as never);
    t2.send({ v: 1, t: 'target.list', id: idListT2, ts: Date.now() } as never);
    const [queued2, list2] = await Promise.all([queued2Promise, list2Promise]);
    expect(queued2.t).toBe('control.queued');
    expect(queued2.re).toBe(id2);
    expect(list2.t).toBe('target.listed');
    expect(list2.re).toBe(idListT2);

    // t1 releases; the queue advances and t2 is granted asynchronously,
    // with no new request or `id` from t2. This grant must still echo
    // id2, the ORIGINAL request's id from moments ago, which is exactly
    // what `ControlLeaseEngine`'s `QueueEntry.requestId` (threaded
    // through `grantFromQueueEntry`) exists to make possible; without it
    // `AutomationClient.acquireControl()`'s own two-stage wait
    // (`m.re === id && m.t === 'control.granted'` after a `control.queued`)
    // would hang exactly like every other case this file describes.
    const granted2Promise = new Promise<Envelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error('t2 never received an unprompted control.granted after t1 released'));
      }, 10_000);
      const off = t2.on('message', (m) => {
        if (m.t !== 'control.granted') return;
        clearTimeout(timer);
        off();
        resolve(m);
      });
    });
    t1.send({
      v: 1,
      t: 'control.release',
      ts: Date.now(),
      targetId,
      leaseId: (granted1 as unknown as { leaseId: string }).leaseId,
    } as never);
    const granted2 = await granted2Promise;
    expect(granted2.re).toBe(id2);

    t1.destroy();
    t2.destroy();
  }, 30_000);
});
