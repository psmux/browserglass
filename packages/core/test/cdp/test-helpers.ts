/** Shared setup helpers for the CDP layer test suite. */

import { newId } from '@browserglass/protocol';
import type { InstanceId } from '@browserglass/protocol';
import { CdpBridgeImpl, type CdpBridgeOptions } from '../../src/cdp/bridge.js';
import type { ProxyAuthCredentials } from '../../src/cdp/proxy-auth.js';
import { type StealthProfileHooks, TargetRegistryImpl } from '../../src/cdp/target-registry.js';
import type { BrowserVersion } from '../../src/cdp/types.js';
import {
  FakeCdpWebSocket,
  type FakeCdpWorld,
  installDefaultResponder,
} from './fake-cdp-endpoint.js';

/** A connected {@link CdpBridgeImpl} whose `wsFactory` hands out a fresh {@link FakeCdpWebSocket} per call, for reconnect tests that need to drive more than one socket over the bridge's lifetime. */
export interface ReconnectableFakeBridge {
  bridge: CdpBridgeImpl;
  /** Every socket the bridge's `wsFactory` has produced so far, in order: `sockets[0]` is the initial connection, `sockets[1]`, `sockets[2]`, ... are reconnect attempts. Grows as the bridge redials, so re-read its `.length` after driving a reconnect rather than destructuring it once up front. */
  sockets: FakeCdpWebSocket[];
  world: FakeCdpWorld;
  version: BrowserVersion;
  instanceId: InstanceId;
}

/**
 * Like {@link connectFakeBridge}, but backed by a socket factory that hands
 * out a fresh {@link FakeCdpWebSocket} on every `wsFactory()` call instead of
 * reusing one fixed socket, so a test can drive `CdpBridgeImpl`'s
 * unexpected-close reconnect loop (`../../src/cdp/reconnect.ts`) through
 * more than one dial. Only `sockets[0]` gets
 * {@link installDefaultResponder} wired automatically, matching
 * `connectFakeBridge`'s own initial handshake; a test scripts every socket
 * after that by hand (`installDefaultResponder(sockets[1])` for a
 * succeeding reconnect attempt, `sockets[1].failToOpen()` for a failing
 * one). `reconnectOptions` is threaded straight to
 * `CdpBridgeOptions.reconnect`, so a test can shrink the backoff/dial
 * timeout down from production's 1s/2s/4s and 8s defaults.
 */
export async function connectFakeBridgeReconnectable(
  reconnectOptions?: CdpBridgeOptions['reconnect'],
): Promise<ReconnectableFakeBridge> {
  const instanceId = newId('inst');
  const sockets: FakeCdpWebSocket[] = [];
  const wsFactory = (): FakeCdpWebSocket => {
    const socket = new FakeCdpWebSocket();
    sockets.push(socket);
    return socket;
  };
  const bridge = new CdpBridgeImpl(instanceId, { wsFactory, reconnect: reconnectOptions });

  const connectPromise = bridge.connect({ url: 'ws://fake/devtools/browser/fake' });
  const initialSocket = sockets[0] as FakeCdpWebSocket;
  const world = installDefaultResponder(initialSocket);
  initialSocket.open();
  const version = await connectPromise;

  return { bridge, sockets, world, version, instanceId };
}

/** A connected {@link CdpBridgeImpl} plus its driving {@link FakeCdpWebSocket} and {@link FakeCdpWorld}. */
export interface ConnectedFakeBridge {
  bridge: CdpBridgeImpl;
  socket: FakeCdpWebSocket;
  world: FakeCdpWorld;
  version: BrowserVersion;
  instanceId: InstanceId;
}

/**
 * Constructs a {@link CdpBridgeImpl} against a fresh {@link FakeCdpWebSocket}
 * with the default responder installed, opens the socket, and awaits
 * `connect()`. The returned `socket` is still the exact instance driving the
 * bridge, so a test can override `socket.autoRespond` afterward to script
 * specific behaviour. `bridgeOptions`, when given, is threaded straight
 * through to `CdpBridgeImpl`'s own second constructor argument (its
 * `wsFactory` is always overridden to return the fake socket regardless of
 * what `bridgeOptions.wsFactory` says); the intended use is a test wanting
 * to shrink `reconnect.backoffMs`/`reconnect.dialTimeoutMs`, or hand in a
 * `CrashBudget` with `maxAttempts: 0` so an unexpected close finalizes
 * without ever attempting a reconnect, matching this suite's pre-reconnect
 * "a dead socket is just dead" tests (`test/session/create-target-relaunch.test.ts`).
 */
export async function connectFakeBridge(
  bridgeOptions?: CdpBridgeOptions,
): Promise<ConnectedFakeBridge> {
  const instanceId = newId('inst');
  const socket = new FakeCdpWebSocket();
  const world = installDefaultResponder(socket);
  const bridge = new CdpBridgeImpl(instanceId, { ...bridgeOptions, wsFactory: () => socket });

  const connectPromise = bridge.connect({ url: 'ws://fake/devtools/browser/fake' });
  socket.open();
  const version = await connectPromise;

  return { bridge, socket, world, version, instanceId };
}

/** A started {@link TargetRegistryImpl} on top of a {@link connectFakeBridge} bridge. */
export interface StartedFakeRegistry extends ConnectedFakeBridge {
  registry: TargetRegistryImpl;
}

/**
 * Builds a connected fake bridge and a {@link TargetRegistryImpl} on top of
 * it, then runs `start()` (discovery setup plus the initial `resync()`).
 * `world.targetInfos` may be populated before calling this, so the initial
 * resync already has targets to discover. `initScripts`, when given, is
 * threaded straight through to `TargetRegistryImpl`'s own third
 * constructor argument, for tests exercising `installInitScripts`/
 * `removeInitScripts`. `stealth`, when given, is threaded through to the
 * fourth constructor argument, for tests exercising the `StealthProfile`
 * injection slot (`StealthProfileHooks.initScripts` ordering,
 * `onTargetAttached`). `proxyAuthCredentials`, when given, is threaded
 * through to the fifth constructor argument, for tests exercising
 * `installProxyAuth` (`../../src/cdp/proxy-auth.ts`'s `ProxyAuthHandler`
 * injection slot). `bridgeOptions`, when given, is threaded straight
 * through to {@link connectFakeBridge}.
 */
export async function startFakeRegistry(
  initScripts?: readonly { name: string; source: string }[],
  stealth?: StealthProfileHooks | null,
  bridgeOptions?: CdpBridgeOptions,
  proxyAuthCredentials?: ProxyAuthCredentials | null,
): Promise<StartedFakeRegistry> {
  const connected = await connectFakeBridge(bridgeOptions);
  const registry = new TargetRegistryImpl(
    connected.instanceId,
    connected.bridge,
    initScripts,
    stealth,
    proxyAuthCredentials,
  );
  await registry.start();
  return { ...connected, registry };
}
