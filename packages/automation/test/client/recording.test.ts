import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/**
 * `AutomationClient.startRecording()`/`.stopRecording()`/`.listRecordings()`
 * against the scripted fake gateway.
 *
 * The harness's own default granted set (`capture`, `probe`, ... but not
 * `download`) is exactly the case worth proving first: every `recording.*`
 * call needs BOTH `capture` AND `download` together
 * (`@browserglass/protocol`'s `wire/messages/recording.ts` module doc), so
 * a token carrying only `capture` (the harness default) is still refused,
 * and that refusal names `download` specifically, per this file's own
 * "double gate" test below.
 */
const GRANTED_WITH_DOWNLOAD = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'automation',
  'download',
];
const GRANTED_WITHOUT_CAPTURE = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'probe',
  'automation',
  'download',
];

async function grantedClient(granted: string[] = GRANTED_WITH_DOWNLOAD) {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness));
  await tick();
  const gateway = startScriptedGateway(harness, { granted: granted as Capability[] });
  const client = await connectPromise;
  return { client, gateway, harness };
}

describe('AutomationClient recording', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('startRecording() refuses locally on the missing download capability, without a round trip', async () => {
    const { client, gateway } = await connectFakeClient();

    await expect(client.startRecording()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'download' },
    });
    expect(gateway.recordingStartCalls).toHaveLength(0);

    client.close();
  });

  it('startRecording() names capture first when both capabilities are missing', async () => {
    const { client, gateway } = await grantedClient(GRANTED_WITHOUT_CAPTURE);

    await expect(client.startRecording()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'capture' },
    });
    expect(gateway.recordingStartCalls).toHaveLength(0);

    client.close();
  });

  it('stopRecording() and listRecordings() refuse locally on the same double gate', async () => {
    const { client, gateway } = await connectFakeClient();

    await expect(client.stopRecording('rec_1')).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'download' },
    });
    await expect(client.listRecordings()).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { required: 'download' },
    });
    expect(gateway.recordingStopCalls).toHaveLength(0);
    expect(gateway.recordingListCalls).toHaveLength(0);

    client.close();
  });

  it('startRecording() sends recording.start with targetId/mode and returns the handle', async () => {
    const { client, gateway } = await grantedClient();

    const startPromise = client.startRecording({ mode: 'thumbnail' });
    await tick();
    const handle = await startPromise;

    expect(handle.recordingId).toBe('rec_1');
    expect(handle.targetId).toBe(client.targetId);
    expect(handle.mode).toBe('thumbnail');
    expect(typeof handle.startedAtMs).toBe('number');
    expect(gateway.recordingStartCalls.at(-1)).toMatchObject({
      t: 'recording.start',
      targetId: client.targetId,
      mode: 'thumbnail',
    });

    client.close();
  });

  it('startRecording() defaults mode to live when omitted', async () => {
    const { client, gateway } = await grantedClient();

    const startPromise = client.startRecording();
    await tick();
    const handle = await startPromise;

    expect(handle.mode).toBe('live');
    expect(gateway.recordingStartCalls.at(-1)?.['mode']).toBeUndefined();

    client.close();
  });

  it('stopRecording() sends recording.stop with recordingId and returns the summary', async () => {
    const { client, gateway } = await grantedClient();

    const stopPromise = client.stopRecording('rec_42');
    await tick();
    const result = await stopPromise;

    expect(result.recordingId).toBe('rec_42');
    expect(result.framesWritten).toBe(3);
    expect(result.failed).toBe(false);
    expect(gateway.recordingStopCalls.at(-1)).toMatchObject({
      t: 'recording.stop',
      recordingId: 'rec_42',
    });

    client.close();
  });

  it('stopRecording() reports failed:true without throwing, for a recording that degraded to a no-op', async () => {
    const { client, gateway } = await grantedClient();
    gateway.recordingStopResponder = (msg) => ({
      t: 'recording.stopped',
      recordingId: msg['recordingId'],
      targetId: 'tgt_0000000000000000000000001',
      startedAtMs: Date.now() - 1000,
      stoppedAtMs: Date.now(),
      framesWritten: 1,
      failed: true,
    });

    const stopPromise = client.stopRecording('rec_degraded');
    await tick();
    const result = await stopPromise;

    expect(result.failed).toBe(true);
    expect(result.framesWritten).toBe(1);

    client.close();
  });

  it('listRecordings() sends recording.list and returns the recordings array', async () => {
    const { client, gateway } = await grantedClient();
    gateway.recordingListResponder = () => ({
      t: 'recording.listed',
      recordings: [
        {
          recordingId: 'rec_a',
          targetId: 'tgt_a',
          mode: 'live',
          startedAtMs: 1000,
          stoppedAtMs: 2000,
          framesWritten: 5,
          failed: false,
        },
      ],
    });

    const listPromise = client.listRecordings();
    await tick();
    const recordings = await listPromise;

    expect(recordings).toHaveLength(1);
    expect(recordings[0]).toMatchObject({ recordingId: 'rec_a', targetId: 'tgt_a' });
    expect(gateway.recordingListCalls).toHaveLength(1);

    client.close();
  });

  it('listRecordings() forwards an optional targetId filter', async () => {
    const { client, gateway } = await grantedClient();

    const listPromise = client.listRecordings({ targetId: 'tgt_other' });
    await tick();
    await listPromise;

    expect(gateway.recordingListCalls.at(-1)).toMatchObject({ targetId: 'tgt_other' });

    client.close();
  });

  it('maps bgls.error.target.recording_unavailable to POLICY_DENIED', async () => {
    const { client, gateway } = await grantedClient();
    gateway.recordingStartResponder = () => ({
      t: 'error',
      code: 'bgls.error.target.recording_unavailable',
      category: 'target',
      message: 'This gateway has no recordings directory configured.',
      fatal: false,
      retryable: false,
    });

    // Settled BEFORE ticking, never `await expect(p).rejects` after it: the
    // reply lands inside `tick()`, so a handler attached afterwards means
    // the rejection is briefly unhandled (`./response-body.test.ts`'s own
    // note on the same trap).
    const settled = client.startRecording().then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({
      code: 'POLICY_DENIED',
      message: expect.stringContaining('recordings directory'),
    });

    client.close();
  });

  it('maps bgls.error.target.recording_not_found to NOT_FOUND', async () => {
    const { client, gateway } = await grantedClient();
    gateway.recordingStopResponder = () => ({
      t: 'error',
      code: 'bgls.error.target.recording_not_found',
      category: 'target',
      message: 'no recording rec_missing on this session',
      fatal: false,
      retryable: false,
    });

    const settled = client.stopRecording('rec_missing').then(
      () => null,
      (e: unknown) => e,
    );
    await tick();
    expect(await settled).toMatchObject({ code: 'NOT_FOUND' });

    client.close();
  });
});
