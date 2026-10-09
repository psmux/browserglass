import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_MCP_TOOLS,
  callAutomationTool,
  createMcpStateForTest,
} from '../../src/mcp/server.js';
import type { AutomationMcpServerOptions } from '../../src/mcp/server.js';
import { type FakeGatewayHarness, createFakeGatewayHarness } from '../fake-gateway.js';
import { completeSwarmMemberHandshake, connectFakeClient, tick } from '../helpers.js';

/** Parses the `--- bgls ---` fenced JSON trailer, same helper as `swarm-tools.test.ts`. */
function trailerOf(text: string): Record<string, unknown> {
  const marker = '--- bgls ---';
  const idx = text.indexOf(marker);
  expect(idx).toBeGreaterThan(-1);
  const fenced = text.slice(idx + marker.length);
  const jsonStart = fenced.indexOf('```json');
  const jsonEnd = fenced.lastIndexOf('```');
  return JSON.parse(fenced.slice(jsonStart + '```json'.length, jsonEnd).trim()) as Record<
    string,
    unknown
  >;
}

/**
 * `bg_swarm_open`'s `subject` argument, end to end through the real tool
 * dispatch rather than through `BrowserSwarm` directly.
 *
 * What matters at this seam is that the value an agent types reaches the
 * server's own `acquire` function, per member slot. An MCP server whose
 * `acquire` ignores `ctx.subject` accepts the argument and does nothing
 * with it, which is the one way this plumbing can quietly under deliver,
 * so the fixture below records exactly what `acquire` was handed.
 */
describe('bg_swarm_open ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function recordingSwarmAcquire(harness: FakeGatewayHarness) {
    const calls: Array<{ index: number; subject: string | undefined }> = [];
    let socketOrder = 0;
    return {
      calls,
      acquire: async (
        index: number,
        ctx: { subject: string | undefined; stickyWithinMs: number | undefined },
      ) => {
        calls.push({ index, subject: ctx.subject });
        const order = socketOrder++;
        return {
          instanceId: `inst_swarm_${order}`,
          wsUrl: 'wss://gateway.test/browserglass/socket',
          token: `tkn.swarm.${order}`,
        };
      },
      transport: { WebSocketImpl: harness.Impl },
    };
  }

  async function setupState(harness: FakeGatewayHarness) {
    const { client: boundClient } = await connectFakeClient();
    const fixture = recordingSwarmAcquire(harness);
    const options: AutomationMcpServerOptions = {
      client: boundClient,
      swarm: { acquire: fixture.acquire, transport: fixture.transport },
    };
    return { state: createMcpStateForTest(options), boundClient, fixture };
  }

  it('declares subject and stickyWithinMs on bg_swarm_open so an agent can discover them from tools/list', () => {
    const tool = AUTOMATION_MCP_TOOLS.find((t) => t.name === 'bg_swarm_open');
    const properties =
      (tool?.inputSchema as { properties?: Record<string, { description?: string }> }).properties ??
      {};
    expect(Object.keys(properties)).toContain('subject');
    expect(Object.keys(properties)).toContain('stickyWithinMs');
    expect(properties['subject']?.description ?? '').toMatch(/reattach/i);
  });

  it("passes one slot subject per member into the server's own acquire, and reports the ownership in the result", async () => {
    const harness = createFakeGatewayHarness();
    const { state, boundClient, fixture } = await setupState(harness);

    const openPromise = callAutomationTool(state, 'bg_swarm_open', {
      size: 3,
      subject: 'agent-alpha',
    });
    await tick();
    for (let i = 0; i < 3; i++) completeSwarmMemberHandshake(harness, i);
    const result = await openPromise;

    expect(result.isError).toBeFalsy();
    expect(fixture.calls.map((c) => c.subject)).toEqual([
      'agent-alpha#0',
      'agent-alpha#1',
      'agent-alpha#2',
    ]);

    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['subject']).toBe('agent-alpha');
    expect((trailer['members'] as Array<{ subject: string }>).map((m) => m.subject)).toEqual([
      'agent-alpha#0',
      'agent-alpha#1',
      'agent-alpha#2',
    ]);
    // The prose half of the result says which behaviour the agent got.
    // An agent that meant to reattach and instead launched three fresh
    // browsers cannot tell from the instance ids alone.
    expect(result.content[0]?.text ?? '').toContain('owned by "agent-alpha"');

    await callAutomationTool(state, 'bg_swarm_close', { swarmId: trailer['swarmId'] as string });
    boundClient.close();
  });

  it('without subject, acquire is called anonymously and the result says the browsers are owned by no one', async () => {
    const harness = createFakeGatewayHarness();
    const { state, boundClient, fixture } = await setupState(harness);

    const openPromise = callAutomationTool(state, 'bg_swarm_open', { size: 2 });
    await tick();
    for (let i = 0; i < 2; i++) completeSwarmMemberHandshake(harness, i);
    const result = await openPromise;

    expect(fixture.calls.map((c) => c.subject)).toEqual([undefined, undefined]);
    expect(trailerOf(result.content[0]?.text ?? '')['subject']).toBeNull();
    expect(result.content[0]?.text ?? '').toContain('owned by no one');

    await callAutomationTool(state, 'bg_swarm_close', {
      swarmId: trailerOf(result.content[0]?.text ?? '')['swarmId'] as string,
    });
    boundClient.close();
  });

  it("bg_swarm_grow inherits the swarm's subject, so growing a set does not silently start launching unowned browsers", async () => {
    const harness = createFakeGatewayHarness();
    const { state, boundClient, fixture } = await setupState(harness);

    const openPromise = callAutomationTool(state, 'bg_swarm_open', {
      size: 2,
      subject: 'agent-alpha',
    });
    await tick();
    for (let i = 0; i < 2; i++) completeSwarmMemberHandshake(harness, i);
    const swarmId = trailerOf((await openPromise).content[0]?.text ?? '')['swarmId'] as string;

    const growPromise = callAutomationTool(state, 'bg_swarm_grow', { swarmId, n: 1 });
    await tick();
    completeSwarmMemberHandshake(harness, 2);
    const grown = await growPromise;

    expect(grown.isError).toBeFalsy();
    expect(fixture.calls.map((c) => c.subject)).toEqual([
      'agent-alpha#0',
      'agent-alpha#1',
      'agent-alpha#2',
    ]);
    expect(
      (trailerOf(grown.content[0]?.text ?? '')['added'] as Array<{ subject: string }>)[0]?.subject,
    ).toBe('agent-alpha#2');

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
    boundClient.close();
  });

  it('rejects an empty subject rather than opening a swarm nobody can address again', async () => {
    const harness = createFakeGatewayHarness();
    const { state, boundClient, fixture } = await setupState(harness);

    const result = await callAutomationTool(state, 'bg_swarm_open', { size: 1, subject: '' });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toMatch(/non-empty string/);
    // Rejected before any browser was asked for, not after.
    expect(fixture.calls).toHaveLength(0);
    expect(harness.instances).toHaveLength(0);

    boundClient.close();
  });
});
