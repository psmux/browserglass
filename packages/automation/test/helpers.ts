import { vi } from 'vitest';
import { AutomationClient, BrowserSwarm } from '../src/index.js';
import type { AutomationClientOptions, BrowserSwarmOptions } from '../src/index.js';
import {
  type FakeGatewayHarness,
  ScriptedGateway,
  createFakeGatewayHarness,
  fixtureWelcome,
  startScriptedGateway,
} from './fake-gateway.js';

/** Advances the fake clock (and drains any timers and microtasks it triggers). Requires `vi.useFakeTimers()` already active. */
export async function tick(ms = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** A minimal, complete `AutomationClientOptions` fixture wired to `harness`'s fake socket. */
export function fixtureOptions(
  harness: FakeGatewayHarness,
  overrides: Partial<AutomationClientOptions> = {},
): AutomationClientOptions {
  return {
    endpoint: 'wss://gateway.test/browserglass/socket',
    token: 'tkn.header.payload.signature',
    transport: { WebSocketImpl: harness.Impl },
    ...overrides,
  };
}

/**
 * Connects an `AutomationClient` against a fresh `ScriptedGateway`, driving
 * the handshake and starting the auto-responder. Requires `vi.useFakeTimers()`
 * already active in the calling test.
 */
export async function connectFakeClient(overrides: Partial<AutomationClientOptions> = {}) {
  const harness = createFakeGatewayHarness();
  const connectPromise = AutomationClient.connect(fixtureOptions(harness, overrides));
  await tick();
  const gateway = startScriptedGateway(harness);
  const client = await connectPromise;
  return { client, gateway, harness };
}

/** A minimal, complete `BrowserSwarmOptions` fixture: `acquire()` mints a distinct fake `instanceId`/token per index, wired to `harness`'s fake socket implementation so every member's `AutomationClient.connect()` lands on its own `FakeGatewaySocket`. */
export function fixtureSwarmOptions(
  harness: FakeGatewayHarness,
  overrides: Partial<BrowserSwarmOptions> = {},
): BrowserSwarmOptions {
  return {
    size: 3,
    transport: { WebSocketImpl: harness.Impl },
    acquire: async (index: number) => ({
      instanceId: `inst_swarm_${index}`,
      wsUrl: 'wss://gateway.test/browserglass/socket',
      token: `tkn.swarm.${index}`,
    }),
    ...overrides,
  };
}

/**
 * Drives one member's handshake to completion: the socket at
 * `harness.instances[index]`, stamped with the matching `inst_swarm_<index>`
 * instance id `AutomationClient.connect()` validates against what
 * `fixtureSwarmOptions()`'s `acquire()` returned for that same index, and
 * a distinct `targetId` so cross-member assertions (no target leaking
 * between members) have something to check. Shared by `openFakeSwarm()`
 * and by any test driving `grow()`'s own follow-up handshake.
 */
export function completeSwarmMemberHandshake(
  harness: FakeGatewayHarness,
  index: number,
  welcomeOverride: Parameters<typeof fixtureWelcome>[1] = {},
): ScriptedGateway {
  const ws = harness.instances[index];
  if (!ws)
    throw new Error(
      `completeSwarmMemberHandshake(): expected a socket for member ${index}, only ${harness.instances.length} were created`,
    );
  ws.simulateOpen();
  const defaults = fixtureWelcome(ws);
  ws.simulateJson(
    fixtureWelcome(ws, {
      instance: { ...defaults.instance, instanceId: `inst_swarm_${index}` },
      targets: defaults.targets.map((t) => ({ ...t, targetId: `${t.targetId}_${index}` })),
      ...welcomeOverride,
    }),
  );
  const gateway = new ScriptedGateway(harness, ws);
  gateway.start();
  return gateway;
}

/**
 * Opens a `BrowserSwarm` against fresh `ScriptedGateway`s, one per member,
 * driving every handshake to completion. Requires `vi.useFakeTimers()`
 * already active.
 *
 * Members are assumed to open their sockets in index order (0..size-1):
 * `BrowserSwarm.open()` acquires and connects every member concurrently
 * with no artificial delay anywhere in this fixture's own `acquire()`, so
 * the N `FakeGatewaySocket`s land in `harness.instances` in the same
 * order `openOneMember()` called them.
 */
export async function openFakeSwarm(
  overrides: Partial<BrowserSwarmOptions> = {},
  welcomeOverrides: Record<number, Parameters<typeof fixtureWelcome>[1]> = {},
) {
  const harness = createFakeGatewayHarness();
  const opts = fixtureSwarmOptions(harness, overrides);
  const openPromise = BrowserSwarm.open(opts);
  await tick();

  const gateways: ScriptedGateway[] = [];
  for (let i = 0; i < opts.size; i++) {
    gateways.push(completeSwarmMemberHandshake(harness, i, welcomeOverrides[i]));
  }

  const swarm = await openPromise;
  return { swarm, harness, gateways };
}
