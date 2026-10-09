import type { Welcome } from '@browserglass/protocol';
import { type FakeGatewayHarness, ScriptedGateway, fixtureWelcome } from './fake-gateway.js';

/** Polls `check()` with real timers until it returns `true`, or throws after `timeoutMs`. Used instead of `vi.advanceTimersByTimeAsync` because these tests run against real `global.fetch`/`WebSocket` stubs rather than `vi.useFakeTimers()`. */
export async function waitForCondition(
  check: () => boolean,
  timeoutMs = 3000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline)
      throw new Error('waitForCondition(): timed out waiting for the condition to become true');
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Completes the handshake for `harness.instances[index]` specifically (rather than `harness.latest()`), for tests driving several concurrently opened sockets, e.g. `swarm run`'s members. */
export function completeHandshakeAt(
  harness: FakeGatewayHarness,
  index: number,
  welcomeOverrides: Partial<Welcome> = {},
): ScriptedGateway {
  const ws = harness.instances[index];
  if (!ws)
    throw new Error(
      `completeHandshakeAt(): expected a socket at index ${index}, only ${harness.instances.length} exist`,
    );
  ws.simulateOpen();
  ws.simulateJson(fixtureWelcome(ws, welcomeOverrides));
  const gateway = new ScriptedGateway(harness, ws);
  gateway.start();
  return gateway;
}
