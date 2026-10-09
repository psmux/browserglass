import type { ControlState } from '@browserglass/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserGlassClient } from '../../src/client/BrowserGlassClient.js';
import type { FakeWebSocketHarness } from '../transport/fake-websocket.js';
import { connectClientToLive, fixtureClientOptions, fixtureWelcome, nextSq } from './helpers.js';

/**
 * `client.yieldControl()`, the browser side of `control.yield`.
 *
 * The point of this suite is the DECISIONS, not the plumbing. Sending a
 * message is one line and would not be worth a test; what is worth a test
 * is that the two refusals the server can answer with are decided here
 * instead, that the local decision only fires on knowledge rather than on
 * absence of knowledge, and that the message is sent even when this client
 * believes there is nothing to ask.
 */

const TARGET = 'tgt_00000000000000000000000001';

function controlState(
  ws: ReturnType<FakeWebSocketHarness['latest']>,
  overrides: Partial<ControlState['leases'][number]> = {},
): ControlState {
  return {
    v: 1,
    t: 'control.state',
    ts: Date.now(),
    sq: nextSq(ws),
    leases: [
      {
        targetId: TARGET,
        holderViewerId: null,
        holderLabel: null,
        grantedAt: null,
        expiresAt: null,
        mode: 'shared',
        holders: [],
        holderCount: 0,
        queue: [],
        queueLength: 0,
        queuePosition: null,
        ...overrides,
      },
    ],
  } as unknown as ControlState;
}

function holder(viewerId: string) {
  return { viewerId, label: viewerId, grantedAt: 0, expiresAt: 0, connected: true };
}

function rosterEntry(viewerId: string, kind: 'human' | 'agent' | 'service') {
  return {
    viewerId,
    label: viewerId,
    kind,
    colour: '#64b5f6',
    controlling: [TARGET],
    watching: [],
    idle: false,
    joinedAt: 0,
  };
}

describe('BrowserGlassClient.yieldControl()', () => {
  let client: BrowserGlassClient;
  let harness: FakeWebSocketHarness;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    client?.destroy();
    vi.useRealTimers();
  });

  async function connect(granted: string[] = ['view', 'control']) {
    const fixture = fixtureClientOptions();
    harness = fixture.harness;
    client = new BrowserGlassClient(fixture.options);
    const connectPromise = client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const ws = harness.latest();
    ws.simulateOpen();
    const hello = ws.lastSentJson();
    ws.simulateJson(fixtureWelcome({ granted: granted as never }, hello.id as string));
    await connectPromise;
    return ws;
  }

  function sentYields(ws: ReturnType<FakeWebSocketHarness['latest']>) {
    return ws.sentJsonMessages().filter((m) => m.t === 'control.yield');
  }

  describe('the refusals, decided here rather than by a round trip', () => {
    it("refuses without the 'control' capability, and sends nothing", async () => {
      const ws = await connect(['view']);
      await expect(client.yieldControl(TARGET)).rejects.toThrow(/control.+capability/i);
      expect(sentYields(ws)).toHaveLength(0);
    });

    /**
     * `automation` is exactly what makes a viewer `kind: 'agent'` server
     * side, so this check and the server's `not_human` cannot disagree.
     */
    it('refuses a token carrying automation, which is what makes a viewer an agent', async () => {
      const ws = await connect(['view', 'control', 'automation']);
      await expect(client.yieldControl(TARGET)).rejects.toThrow(/only be sent by a human/i);
      expect(sentYields(ws)).toHaveLength(0);
    });

    it('refuses on a target it KNOWS is exclusive, and says what to use instead', async () => {
      const ws = await connect();
      ws.simulateJson(controlState(ws, { mode: 'exclusive' }));
      await vi.advanceTimersByTimeAsync(0);
      await expect(client.yieldControl(TARGET)).rejects.toThrow(/exclusive/i);
      await expect(client.yieldControl(TARGET)).rejects.toThrow(/requestControl/);
      expect(sentYields(ws)).toHaveLength(0);
    });

    /**
     * The asymmetry that matters. A mode this client has not been told
     * about is not a mode it may refuse on: refusing on an unknown would
     * make the button fail at random during the window between connecting
     * and the first `control.state`.
     */
    it('does NOT refuse a target whose mode it has not been told, and sends', async () => {
      const ws = await connect();
      await expect(client.yieldControl(TARGET)).resolves.toBeDefined();
      expect(sentYields(ws)).toHaveLength(1);
    });
  });

  describe('what it puts on the wire', () => {
    it('sends control.yield naming the target, with the reason when given', async () => {
      const ws = await connect();
      await client.yieldControl(TARGET, 'a person taking over');
      const [msg] = sentYields(ws);
      expect(msg?.targetId).toBe(TARGET);
      expect(msg?.reason).toBe('a person taking over');
    });

    it('omits reason entirely rather than sending an empty one', async () => {
      const ws = await connect();
      await client.yieldControl(TARGET);
      expect(sentYields(ws)[0]).not.toHaveProperty('reason');
    });
  });

  describe('agentsAsked, which is this client’s own count and says so', () => {
    it('counts the agent holders it can see, from holders joined to the roster', async () => {
      const ws = await connect();
      ws.simulateJson(
        controlState(ws, { holders: [holder('bot'), holder('alice')], holderCount: 2 }),
      );
      ws.simulateJson({
        v: 1,
        t: 'presence.state',
        ts: Date.now(),
        sq: nextSq(ws),
        viewers: [rosterEntry('bot', 'agent'), rosterEntry('alice', 'human')],
      });
      await vi.advanceTimersByTimeAsync(0);

      const result = await client.yieldControl(TARGET);
      expect(result).toEqual({ agentsAsked: 1, unknownHolders: 0 });
    });

    /**
     * A holder the roster does not describe is reported separately and is
     * never counted as a person. The roster lags a fresh grant by one
     * broadcast, and the synthetic viewer the REST control path borrows a
     * lease under never appears in it at all, so folding those into
     * "no agents" would let this method report an empty room over a
     * REST-driven tab.
     */
    it('reports an unclassifiable holder as unknown, not as a person', async () => {
      const ws = await connect();
      ws.simulateJson(controlState(ws, { holders: [holder('ghost')], holderCount: 1 }));
      await vi.advanceTimersByTimeAsync(0);

      const result = await client.yieldControl(TARGET);
      expect(result).toEqual({ agentsAsked: 0, unknownHolders: 1 });
    });

    /**
     * The safety property. Suppressing the message on a local count of zero
     * would mean a grant this client has not been told about yet silently
     * swallows a person's takeover. A redundant yield costs one frame.
     */
    it('sends even when it believes no agent is driving', async () => {
      const ws = await connect();
      ws.simulateJson(controlState(ws, { holders: [], holderCount: 0 }));
      await vi.advanceTimersByTimeAsync(0);

      const result = await client.yieldControl(TARGET);
      expect(result.agentsAsked).toBe(0);
      expect(sentYields(ws)).toHaveLength(1);
    });
  });
});
