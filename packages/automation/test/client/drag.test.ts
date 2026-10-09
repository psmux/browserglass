import type { Capability } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutomationClient } from '../../src/index.js';
import { createFakeGatewayHarness, startScriptedGateway } from '../fake-gateway.js';
import { connectFakeClient, fixtureOptions, tick } from '../helpers.js';

/**
 * mouseDown / mouseUp / moveTo({ buttons }) / drag(), against the scripted
 * fake gateway. What matters on the wire: the press and release carry the
 * held lease, the moves between them report the held button, and nothing
 * is sent without a lease.
 */

function mouseMessages(gateway: { ws: { sentJsonMessages(): Array<Record<string, unknown>> } }) {
  return gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.mouse');
}

async function settle<T>(p: Promise<T>): Promise<T> {
  for (let i = 0; i < 20; i++) await tick(20);
  return p;
}

describe('AutomationClient drag input', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('mouseDown, moveTo and mouseUp each refuse with LEASE_NOT_HELD and send nothing without a lease', async () => {
    const { client, gateway } = await connectFakeClient();
    await expect(client.mouseDown(1, 1)).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });
    await expect(client.mouseUp(1, 1)).rejects.toMatchObject({ code: 'LEASE_NOT_HELD' });
    await expect(client.moveTo(1, 1, { buttons: 1 })).rejects.toMatchObject({
      code: 'LEASE_NOT_HELD',
    });
    await expect(client.drag({ x: 0, y: 0 }, { x: 5, y: 5 })).rejects.toMatchObject({
      code: 'LEASE_NOT_HELD',
    });
    expect(mouseMessages(gateway)).toHaveLength(0);
    client.close();
  });

  it('sends a held press, a move carrying buttons, and a release, all under the lease', async () => {
    const { client, gateway } = await connectFakeClient();
    const leaseP = client.acquireControl();
    await tick();
    const lease = await leaseP;

    await settle(client.mouseDown(10, 20, { button: 'left' }));
    await settle(client.moveTo(30, 40, { buttons: 1 }));
    await settle(client.mouseUp(30, 40));

    const sent = mouseMessages(gateway);
    expect(sent.map((m) => m['kind'])).toEqual(['down', 'move', 'up']);
    expect(sent[0]).toMatchObject({
      x: 10,
      y: 20,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      leaseId: lease.leaseId,
    });
    expect(sent[1]).toMatchObject({ x: 30, y: 40, buttons: 1, leaseId: lease.leaseId });
    expect(sent[2]).toMatchObject({ x: 30, y: 40, button: 'left', buttons: 0 });
    expect(sent[2]?.['clickCount']).toBeUndefined();
    client.close();
  });

  it('moveTo() without options still reports buttons: 0, as before', async () => {
    const { client, gateway } = await connectFakeClient();
    const leaseP = client.acquireControl();
    await tick();
    await leaseP;
    await settle(client.moveTo(5, 6));
    expect(mouseMessages(gateway)[0]).toMatchObject({ kind: 'move', buttons: 0, button: 'none' });
    client.close();
  });

  it('drag() between two points interpolates moves with the button held', async () => {
    const { client, gateway } = await connectFakeClient();
    const leaseP = client.acquireControl();
    await tick();
    const lease = await leaseP;

    const result = await settle(
      client.drag({ x: 100, y: 100 }, { x: 200, y: 300 }, { steps: 4, delayMs: 5 }),
    );
    expect(result).toEqual({ from: { x: 100, y: 100 }, to: { x: 200, y: 300 }, steps: 4 });

    const sent = mouseMessages(gateway);
    expect(sent.map((m) => m['kind'])).toEqual([
      'move',
      'down',
      'move',
      'move',
      'move',
      'move',
      'up',
    ]);
    expect(sent[0]).toMatchObject({ x: 100, y: 100, buttons: 0 });
    expect(sent[1]).toMatchObject({ x: 100, y: 100, button: 'left', buttons: 1 });
    const moves = sent.slice(2, 6).map((m) => [m['x'], m['y'], m['buttons']]);
    expect(moves).toEqual([
      [125, 150, 1],
      [150, 200, 1],
      [175, 250, 1],
      [200, 300, 1],
    ]);
    expect(sent[6]).toMatchObject({ x: 200, y: 300, buttons: 0 });
    for (const m of sent) expect(m['leaseId']).toBe(lease.leaseId);
    client.close();
  });

  it('drag() resolves selector ends to the centre of their first match', async () => {
    const harness = createFakeGatewayHarness();
    const connectPromise = AutomationClient.connect(fixtureOptions(harness));
    await tick();
    const gateway = startScriptedGateway(harness, {
      granted: [
        'view',
        'control',
        'navigate',
        'tabs.manage',
        'capture',
        'probe',
        'automation',
        'evaluate',
      ] as Capability[],
    });
    const client = await connectPromise;
    gateway.evaluateResponder = (msg) => {
      const isTarget = JSON.stringify(msg).includes('#drop');
      const center = isTarget ? { x: 400, y: 50 } : { x: 20, y: 50 };
      return {
        t: 'page.evaluated',
        ok: true,
        resultType: 'value',
        value: {
          matches: [
            {
              index: 0,
              ref: null,
              tagName: 'div',
              type: null,
              id: null,
              name: null,
              role: null,
              rect: { x: center.x - 5, y: center.y - 5, w: 10, h: 10 },
              center,
              attached: true,
              visible: true,
              enabled: true,
              disabledReason: null,
              editable: false,
              stable: null,
              hitTestOk: null,
              occludedBy: null,
              hitReason: null,
              inViewport: true,
              opacity: 1,
              pointerEvents: 'auto',
              text: null,
              value: null,
              checked: null,
              readValue: null,
              describe: 'div',
            },
          ],
          total: 1,
          truncated: false,
          engine: 'css',
          segments: 1,
          scopeMissing: false,
          selectorError: null,
          url: 'https://example.test/',
          title: 't',
          viewport: { w: 1280, h: 800, scrollX: 0, scrollY: 0 },
        },
        sizeBytes: 10,
      };
    };
    const leaseP = client.acquireControl();
    await tick();
    await leaseP;

    const result = await settle(client.drag('#card', '#drop', { steps: 2, delayMs: 0 }));
    expect(result.from).toEqual({ x: 20, y: 50 });
    expect(result.to).toEqual({ x: 400, y: 50 });
    const sent = mouseMessages(gateway);
    expect(sent.at(1)).toMatchObject({ kind: 'down', x: 20, y: 50 });
    expect(sent.at(-1)).toMatchObject({ kind: 'up', x: 400, y: 50 });
    client.close();
  });
});
