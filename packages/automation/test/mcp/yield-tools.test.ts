import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_MCP_TOOLS,
  callAutomationTool,
  createMcpStateForTest,
} from '../../src/mcp/server.js';
import type { AutomationMcpServerOptions } from '../../src/mcp/server.js';
import {
  type FakeGatewayHarness,
  type ScriptedGateway,
  createFakeGatewayHarness,
} from '../fake-gateway.js';
import {
  completeSwarmMemberHandshake,
  connectFakeClient,
  fixtureSwarmOptions,
  tick,
} from '../helpers.js';

/** Parses the `--- bgls ---` fenced JSON trailer, same as `server.test.ts`'s own helper. */
function trailerOf(text: string): Record<string, unknown> {
  const marker = '--- bgls ---';
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const fenced = text.slice(idx + marker.length);
  const jsonStart = fenced.indexOf('```json');
  const jsonEnd = fenced.lastIndexOf('```');
  const json = fenced.slice(jsonStart + '```json'.length, jsonEnd).trim();
  return JSON.parse(json) as Record<string, unknown>;
}

/**
 * The stand-down as seen through MCP.
 *
 * An agent driving through these tools never sees an
 * `onControlYield()` callback, because MCP has no callbacks: it sees tool
 * results and nothing else. So a yield that exists only as a client-side
 * event is a yield the most likely user of this package cannot
 * observe at all, and every case here is about the same thing, whether the
 * takeover reaches the one channel an MCP client actually reads.
 */
describe('the stand-down through the MCP tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function setupHolding() {
    const { client, gateway } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    await client.inspectAt(0, 0);
    const acquiring = callAutomationTool(state, 'bg_control', { action: 'acquire' });
    await tick();
    await acquiring;
    return { client, gateway, state };
  }

  it('bg_control declares the yield actions in its own schema, so an agent can discover them from tools/list alone', () => {
    const tool = AUTOMATION_MCP_TOOLS.find((t) => t.name === 'bg_control');
    const action = (tool?.inputSchema as { properties?: Record<string, { enum?: unknown[] }> })
      .properties?.['action'];
    expect(action?.enum).toEqual(['acquire', 'release', 'status', 'yield', 'yield_status']);
  });

  it('bg_click after a takeover fails with a hint that says a PERSON has it and to stop, not to retry', async () => {
    const { client, gateway, state } = await setupHolding();
    gateway.sendPreemptRequest(client.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });

    const result = await callAutomationTool(state, 'bg_click', { x: 10, y: 10 });
    expect(result.isError).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['code']).toBe('LEASE_REVOKED');
    expect(String(trailer['hint'])).toContain('A person');
    expect(String(trailer['hint'])).toContain('Alice');
    expect(String(trailer['hint'])).toContain('Do NOT retry');
    expect(trailer['details']).toMatchObject({ yielded: true, human: true });

    client.close();
  });

  it('distinguishes a rival agent from a person in the hint, which is the whole reason the reason field exists', async () => {
    const { client, gateway, state } = await setupHolding();
    gateway.sendPresence([{ viewerId: 'vwr_agent_2', label: 'crawler-7', kind: 'agent' }]);
    gateway.sendPreemptRequest(client.targetId, {
      byLabel: 'crawler-7',
      graceMs: 2000,
      deadlineInMs: 2000,
      reason: 'priority',
      byViewerId: 'vwr_agent_2',
    });

    const trailer = trailerOf(
      (await callAutomationTool(state, 'bg_click', { x: 10, y: 10 })).content[0]?.text ?? '',
    );
    expect(String(trailer['hint'])).not.toContain('A person');
    expect(String(trailer['hint'])).toContain('yield_status');
    expect(trailer['details']).toMatchObject({ yielded: true, human: false });

    client.close();
  });

  it('bg_status says so in the plain-text summary, not only in the JSON trailer', async () => {
    const { client, gateway, state } = await setupHolding();
    gateway.sendPreemptRequest(client.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });

    const result = await callAutomationTool(state, 'bg_status', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('A person (Alice) has taken this browser over');
    expect(trailerOf(text)['controlYield']).toMatchObject({
      humanTookOver: true,
      byLabel: 'Alice',
      phase: 'requested',
    });

    client.close();
  });

  it("bg_control 'yield_status' reports nothing taken, then who took it and when control may be requested again", async () => {
    const { client, gateway, state } = await setupHolding();

    const before = await callAutomationTool(state, 'bg_control', { action: 'yield_status' });
    expect(trailerOf(before.content[0]?.text ?? '')['yielded']).toBe(false);

    gateway.sendPreemptRequest(client.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });
    gateway.sendPreempted(client.targetId, {
      byLabel: 'Alice',
      released: true,
      requeueAfterMs: 30000,
    });

    const after = await callAutomationTool(state, 'bg_control', { action: 'yield_status' });
    const trailer = trailerOf(after.content[0]?.text ?? '');
    expect(trailer['yielded']).toBe(true);
    expect(trailer['controlYield']).toMatchObject({ humanTookOver: true, phase: 'taken' });
    expect(
      (trailer['controlYield'] as { resumeNotBefore: number }).resumeNotBefore,
    ).toBeGreaterThan(Date.now());

    client.close();
  });

  it("bg_control 'yield' stands down on demand and refuses input afterwards", async () => {
    const { client, gateway, state } = await setupHolding();

    const result = await callAutomationTool(state, 'bg_control', {
      action: 'yield',
      reason: 'handing back to the operator',
    });
    expect(result.isError).toBeFalsy();
    expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'control.release')).toBe(true);

    const clicked = await callAutomationTool(state, 'bg_click', { x: 1, y: 1 });
    expect(clicked.isError).toBe(true);
    expect(trailerOf(clicked.content[0]?.text ?? '')['code']).toBe('LEASE_REVOKED');

    client.close();
  });

  it("bg_control 'acquire' inside the backoff window explains itself rather than reporting a bare policy denial", async () => {
    const { client, gateway, state } = await setupHolding();
    gateway.sendPreemptRequest(client.targetId, {
      byLabel: 'Alice',
      graceMs: 2000,
      deadlineInMs: 2000,
    });
    gateway.sendPreempted(client.targetId, {
      byLabel: 'Alice',
      released: true,
      requeueAfterMs: 30000,
    });

    const result = await callAutomationTool(state, 'bg_control', { action: 'acquire', waitMs: 0 });
    expect(result.isError).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['code']).toBe('POLICY_DENIED');
    expect(trailer['details']).toMatchObject({ yielded: true, human: true, byLabel: 'Alice' });

    client.close();
  });

  describe('through a swarm', () => {
    async function setupSwarm(size: number): Promise<{
      state: ReturnType<typeof createMcpStateForTest>;
      swarmId: string;
      gateways: ScriptedGateway[];
      harness: FakeGatewayHarness;
      boundClient: Awaited<ReturnType<typeof connectFakeClient>>['client'];
    }> {
      const { client: boundClient } = await connectFakeClient();
      const swarmHarness = createFakeGatewayHarness();
      const swarmOpts = fixtureSwarmOptions(swarmHarness);
      const options: AutomationMcpServerOptions = {
        client: boundClient,
        swarm: {
          acquire: swarmOpts.acquire,
          ...(swarmOpts.transport !== undefined ? { transport: swarmOpts.transport } : {}),
        },
      };
      const state = createMcpStateForTest(options);
      const openPromise = callAutomationTool(state, 'bg_swarm_open', { size });
      await tick();
      const gateways = Array.from({ length: size }, (_unused, i) =>
        completeSwarmMemberHandshake(swarmHarness, i),
      );
      const swarmId = trailerOf((await openPromise).content[0]?.text ?? '')['swarmId'] as string;
      return { state, swarmId, gateways, harness: swarmHarness, boundClient };
    }

    it('bg_swarm_list marks exactly the taken-over member, so an agent knows which of its browsers to leave alone', async () => {
      const { state, swarmId, gateways, boundClient } = await setupSwarm(3);

      gateways[1]!.sendPreemptRequest('tgt_0000000000000000000000001_1', {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      const result = await callAutomationTool(state, 'bg_swarm_list', { swarmId });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('1 member(s) have been taken over');
      const members = trailerOf(text)['members'] as Array<Record<string, unknown>>;
      expect(members[0]?.['yielded']).toBeUndefined();
      expect(members[1]).toMatchObject({
        index: 1,
        yielded: true,
        humanTookOver: true,
        yieldedTo: 'Alice',
      });
      expect(members[2]?.['yielded']).toBeUndefined();

      await callAutomationTool(state, 'bg_swarm_close', { swarmId });
      boundClient.close();
    });

    it('bg_swarm_run reports the taken member as failed and the others as fine, in one call', async () => {
      const { state, swarmId, gateways, boundClient } = await setupSwarm(3);

      gateways[1]!.sendPreemptRequest('tgt_0000000000000000000000001_1', {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      const runPromise = callAutomationTool(state, 'bg_swarm_run', { swarmId, action: 'status' });
      await tick();
      const trailer = trailerOf((await runPromise).content[0]?.text ?? '');
      // `status` needs no lease, so all three succeed: the point here is
      // that the yield on one member did not break the fan-out itself.
      const results = trailer['results'] as Array<Record<string, unknown>>;
      expect(results.map((r) => r['ok'])).toEqual([true, true, true]);

      // navigate DOES need a lease, and this is where the taken member
      // parts company with its siblings without taking them down with it.
      const navPromise = callAutomationTool(state, 'bg_swarm_run', {
        swarmId,
        action: 'navigate',
        url: 'https://example.test/next',
      });
      await tick();
      const navResults = trailerOf((await navPromise).content[0]?.text ?? '')['results'] as Array<
        Record<string, unknown>
      >;
      expect(navResults.map((r) => r['ok'])).toEqual([true, false, true]);
      expect(navResults[1]?.['code']).toBe('POLICY_DENIED');

      await callAutomationTool(state, 'bg_swarm_close', { swarmId });
      boundClient.close();
    });
  });
});
