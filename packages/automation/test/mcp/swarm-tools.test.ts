import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callAutomationTool,
  createAutomationMcpServer,
  createMcpStateForTest,
} from '../../src/mcp/server.js';
import type { AutomationMcpServerOptions } from '../../src/mcp/server.js';
import { type FakeGatewayHarness, createFakeGatewayHarness } from '../fake-gateway.js';
import type { ScriptedGateway } from '../fake-gateway.js';
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
 * Builds an `McpServerState` whose bound client and whose swarm-opening
 * function point at two independent fake gateways: a swarm member must
 * never be reachable through the bound client's own harness, and vice
 * versa, so keeping them on separate harnesses is what makes cross
 * contamination a thing a test here could actually catch.
 */
async function setupStateWithSwarmCapability() {
  const { client: boundClient } = await connectFakeClient();
  const swarmHarness = createFakeGatewayHarness();
  const swarmOpts = fixtureSwarmOptions(swarmHarness);
  const options: AutomationMcpServerOptions = {
    client: boundClient,
    swarm: { acquire: swarmOpts.acquire, transport: swarmOpts.transport },
  };
  const state = createMcpStateForTest(options);
  return { state, boundClient, swarmHarness, options };
}

/** Opens a swarm through the real `bg_swarm_open` tool (not `BrowserSwarm.open()` directly), driving each member's handshake to completion. Returns the swarmId the tool minted. */
async function openSwarmViaTool(
  state: ReturnType<typeof createMcpStateForTest>,
  swarmHarness: FakeGatewayHarness,
  size: number,
  args: Record<string, unknown> = {},
): Promise<{ swarmId: string; gateways: ScriptedGateway[] }> {
  const openPromise = callAutomationTool(state, 'bg_swarm_open', { size, ...args });
  await tick();
  const gateways = Array.from({ length: size }, (_unused, i) =>
    completeSwarmMemberHandshake(swarmHarness, i),
  );
  const result = await openPromise;
  expect(result.isError).toBeFalsy();
  const swarmId = trailerOf(result.content[0]?.text ?? '')['swarmId'] as string;
  return { swarmId, gateways };
}

/**
 * Delays only the FIRST message this one gateway's socket sends by `ms`
 * (every later send goes through immediately, same as any other member):
 * used to prove `bg_swarm_run` fans out concurrently. An undelayed member
 * finishing its whole action while a delayed one has not even had its
 * first request answered is not possible from a serial (`for...of` with
 * `await`) implementation, which would block on the delayed member before
 * even starting the others.
 */
function delayGateway(gateway: ScriptedGateway, ms: number): void {
  const scriptedSend = gateway.ws.send.bind(gateway.ws);
  let delayedOnce = false;
  gateway.ws.send = (data) => {
    if (delayedOnce) {
      scriptedSend(data);
      return;
    }
    delayedOnce = true;
    const timer = setTimeout(() => scriptedSend(data), ms);
    (timer as unknown as { unref?: () => void }).unref?.();
  };
}

describe('the swarm MCP tools', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('bg_swarm_open reports NOT_IMPLEMENTED, naming what is missing, when this server was not configured with a way to open browsers', async () => {
    const { client } = await connectFakeClient();
    const state = createMcpStateForTest({ client });
    const result = await callAutomationTool(state, 'bg_swarm_open', { size: 2 });
    expect(result.isError).toBe(true);
    const trailer = trailerOf(result.content[0]?.text ?? '');
    expect(trailer['code']).toBe('NOT_IMPLEMENTED');
    expect(trailer['hint']).toContain('swarm.acquire');
    client.close();
  });

  it('bg_swarm_open opens size members concurrently and bg_swarm_list reports the swarm and its members', async () => {
    const { state, swarmHarness } = await setupStateWithSwarmCapability();
    const { swarmId } = await openSwarmViaTool(state, swarmHarness, 3);

    const listAll = await callAutomationTool(state, 'bg_swarm_list', {});
    // `subject: null` rather than an absent key: a swarm with no owner is
    // a fact worth stating in the listing, so an agent reading it can tell
    // "these browsers are nobody's and vanish on close" apart from an
    // older server that did not report ownership at all.
    expect(trailerOf(listAll.content[0]?.text ?? '')['swarms']).toEqual([
      { swarmId, size: 3, subject: null },
    ]);

    const listOne = await callAutomationTool(state, 'bg_swarm_list', { swarmId });
    const members = trailerOf(listOne.content[0]?.text ?? '')['members'] as Array<{
      index: number;
    }>;
    expect(members.map((m) => m.index)).toEqual([0, 1, 2]);

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
  });

  it('a single-target tool routed with swarmId/member acts on that swarm member, not the bound client', async () => {
    const { state, boundClient, swarmHarness } = await setupStateWithSwarmCapability();
    const { swarmId } = await openSwarmViaTool(state, swarmHarness, 2);

    const memberStatus = await callAutomationTool(state, 'bg_status', { swarmId, member: 1 });
    expect(memberStatus.isError).toBeFalsy();
    const memberTrailer = trailerOf(memberStatus.content[0]?.text ?? '');
    expect((memberTrailer['status'] as { targetId: string }).targetId).toBe(
      'tgt_0000000000000000000000001_1',
    );

    const boundStatus = await callAutomationTool(state, 'bg_status', {});
    const boundTrailer = trailerOf(boundStatus.content[0]?.text ?? '');
    expect((boundTrailer['status'] as { targetId: string }).targetId).toBe(boundClient.targetId);
    expect((boundTrailer['status'] as { targetId: string }).targetId).not.toBe(
      (memberTrailer['status'] as { targetId: string }).targetId,
    );

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
  });

  it('bg_status with an unknown member on a real swarmId reports NOT_FOUND rather than falling back to the bound client', async () => {
    const { state, swarmHarness } = await setupStateWithSwarmCapability();
    const { swarmId } = await openSwarmViaTool(state, swarmHarness, 1);

    const result = await callAutomationTool(state, 'bg_status', { swarmId, member: 5 });
    expect(result.isError).toBe(true);
    expect(trailerOf(result.content[0]?.text ?? '')['code']).toBe('NOT_FOUND');

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
  });

  it('bg_swarm_grow appends members without disturbing the existing ones; bg_swarm_shrink removes and closes the newest', async () => {
    const { state, swarmHarness } = await setupStateWithSwarmCapability();
    const { swarmId } = await openSwarmViaTool(state, swarmHarness, 2);

    const growPromise = callAutomationTool(state, 'bg_swarm_grow', { swarmId, n: 1 });
    await tick();
    completeSwarmMemberHandshake(swarmHarness, 2);
    const growResult = await growPromise;
    expect(growResult.isError).toBeFalsy();
    const added = trailerOf(growResult.content[0]?.text ?? '')['added'] as Array<{ index: number }>;
    expect(added.map((m) => m.index)).toEqual([2]);

    const shrinkResult = await callAutomationTool(state, 'bg_swarm_shrink', { swarmId, n: 1 });
    expect(shrinkResult.isError).toBeFalsy();
    expect(trailerOf(shrinkResult.content[0]?.text ?? '')['remaining']).toBe(2);

    const listOne = await callAutomationTool(state, 'bg_swarm_list', { swarmId });
    const members = trailerOf(listOne.content[0]?.text ?? '')['members'] as Array<{
      index: number;
    }>;
    expect(members.map((m) => m.index)).toEqual([0, 1]);

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
  });

  it('bg_swarm_shrink reports INVALID_ARGUMENT rather than clamping when n exceeds the swarm size', async () => {
    const { state, swarmHarness } = await setupStateWithSwarmCapability();
    const { swarmId } = await openSwarmViaTool(state, swarmHarness, 1);

    const result = await callAutomationTool(state, 'bg_swarm_shrink', { swarmId, n: 5 });
    expect(result.isError).toBe(true);
    expect(trailerOf(result.content[0]?.text ?? '')['code']).toBe('INVALID_ARGUMENT');

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
  });

  it('bg_swarm_close actually closes every member socket and forgets the swarm', async () => {
    const { state, swarmHarness } = await setupStateWithSwarmCapability();
    const { swarmId } = await openSwarmViaTool(state, swarmHarness, 2);
    expect(swarmHarness.instances.every((ws) => ws.readyState === 1)).toBe(true);

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });

    expect(swarmHarness.instances.every((ws) => ws.readyState === 3)).toBe(true);
    const listAll = await callAutomationTool(state, 'bg_swarm_list', {});
    expect(trailerOf(listAll.content[0]?.text ?? '')['swarms']).toEqual([]);
  });

  it('bg_swarm_run runs the action on every member concurrently: an undelayed member finishes while a delayed one has not even been replied to', async () => {
    const { state, swarmHarness } = await setupStateWithSwarmCapability();
    const { swarmId, gateways } = await openSwarmViaTool(state, swarmHarness, 3);

    // Member 0's gateway never replies within this test's own window. A
    // serial implementation (a for...of loop awaiting each member in turn)
    // would block on member 0 first and never even send members 1/2's
    // requests; a concurrent one (Promise.allSettled over all three) sends
    // every member's request up front, so 1 and 2 finish regardless.
    delayGateway(gateways[0]!, 5000);

    // Connecting already sent this gateway a 'hello' (and the transport's
    // own keepalive 'ping'); what matters is that nothing NEW goes out
    // while the first send sits in the delayed timer.
    const before = gateways[0]!.ws.sentJsonMessages().length;
    const runPromise = callAutomationTool(state, 'bg_swarm_run', {
      swarmId,
      action: 'navigate',
      url: 'https://example.test/fanout',
    });
    await tick(0);

    expect(gateways[1]!.ws.sentJsonMessages().some((m) => m['t'] === 'nav.goto')).toBe(true);
    expect(gateways[2]!.ws.sentJsonMessages().some((m) => m['t'] === 'nav.goto')).toBe(true);
    // Member 0's control.request is still sitting in the delayed timer:
    // proof members 1 and 2 did not wait on it.
    expect(gateways[0]!.ws.sentJsonMessages().length).toBe(before);

    await tick(5000);
    const result = await runPromise;
    expect(result.isError).toBeFalsy();
    const trailer = trailerOf(result.content[0]?.text ?? '');
    const results = trailer['results'] as Array<{ index: number; ok: boolean }>;
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.ok)).toBe(true);

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
  });

  it('bg_swarm_run reports a failing member without failing the whole call or stopping its siblings', async () => {
    const { state, swarmHarness } = await setupStateWithSwarmCapability();

    const openPromise = callAutomationTool(state, 'bg_swarm_open', { size: 3 });
    await tick();
    completeSwarmMemberHandshake(swarmHarness, 0);
    // Member 1 has no 'control' capability: its acquireControl() call
    // inside runOneSwarmAction() throws POLICY_DENIED locally, before any
    // wire traffic, without touching members 0 or 2.
    completeSwarmMemberHandshake(swarmHarness, 1, { granted: ['view', 'automation'] });
    completeSwarmMemberHandshake(swarmHarness, 2);
    const openResult = await openPromise;
    const swarmId = trailerOf(openResult.content[0]?.text ?? '')['swarmId'] as string;

    const runResult = await callAutomationTool(state, 'bg_swarm_run', {
      swarmId,
      action: 'navigate',
      url: 'https://example.test/partial',
    });
    expect(runResult.isError).toBeFalsy();
    const trailer = trailerOf(runResult.content[0]?.text ?? '');
    const results = trailer['results'] as Array<{ index: number; ok: boolean; code?: string }>;
    expect(results.find((r) => r.index === 0)).toMatchObject({ ok: true });
    expect(results.find((r) => r.index === 1)).toMatchObject({ ok: false, code: 'POLICY_DENIED' });
    expect(results.find((r) => r.index === 2)).toMatchObject({ ok: true });

    await callAutomationTool(state, 'bg_swarm_close', { swarmId });
  });

  it('bg_swarm_run with an unknown swarmId reports NOT_FOUND rather than throwing', async () => {
    const { state } = await setupStateWithSwarmCapability();
    const result = await callAutomationTool(state, 'bg_swarm_run', {
      swarmId: 'swarm_does_not_exist',
      action: 'status',
    });
    expect(result.isError).toBe(true);
    expect(trailerOf(result.content[0]?.text ?? '')['code']).toBe('NOT_FOUND');
  });

  it('createAutomationMcpServer() closes every outstanding swarm when its own connection ends, end to end through a real MCP client', async () => {
    const { client: boundClient } = await connectFakeClient();
    const swarmHarness = createFakeGatewayHarness();
    const swarmOpts = fixtureSwarmOptions(swarmHarness);
    const server = createAutomationMcpServer({
      client: boundClient,
      swarm: { acquire: swarmOpts.acquire, transport: swarmOpts.transport },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), mcpClient.connect(clientTransport)]);

    const openPromise = mcpClient.callTool({ name: 'bg_swarm_open', arguments: { size: 2 } });
    await tick();
    completeSwarmMemberHandshake(swarmHarness, 0);
    completeSwarmMemberHandshake(swarmHarness, 1);
    const openResult = await openPromise;
    expect(openResult.isError).toBeFalsy();
    expect(swarmHarness.instances[0]?.readyState).toBe(1);
    expect(swarmHarness.instances[1]?.readyState).toBe(1);

    // No bg_swarm_close call: the agent forgot, which is the whole point
    // of this test. Ending the MCP connection is what has to clean up.
    await mcpClient.close();
    await tick();

    expect(swarmHarness.instances[0]?.readyState).toBe(3);
    expect(swarmHarness.instances[1]?.readyState).toBe(3);

    boundClient.close();
  });
});
