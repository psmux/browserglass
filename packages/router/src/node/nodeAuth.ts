/**
 * The shared secret trust boundary `WebSocketNodeTransport` uses to
 * authenticate one peer link: two gateways talking to each other is a
 * trust boundary.
 *
 * `packages/server/src/auth` (`jwtAuthResolver`, `AppSigningKey`) was the
 * first thing looked at for this, since it is the codebase's own answer to
 * "authenticate a caller". It does not fit here: `@browserglass/router`
 * must depend only on `@browserglass/protocol` (`BrowserRouter.ts`'s own
 * top comment, enforced by `scripts/check-deps.mjs`'s layer gate), so this
 * package cannot import `server`'s auth machinery even if its JWT model
 * were otherwise a good match for a node to node link rather than a human
 * or app credential. The honest answer for this specific boundary is an
 * operator supplied shared
 * secret: every gateway process in a deployment is configured with the
 * identical value, out of band (an env var, a secrets manager entry;
 * wiring that delivery is a deployment concern, not this module's).
 *
 * WHAT THIS PROTECTS: a network party that does not know `sharedSecret`
 * cannot construct a `hello` frame this module, or a correctly implemented
 * peer, would accept, so an arbitrary client that merely knows a gateway's
 * WebSocket address cannot impersonate a second router node and issue
 * `NodeActionRequest`s (navigate, screenshot, click, type, the scoped CDP
 * passthrough) against instances that node owns. The MAC is over a
 * timestamp, not a static bearer value, so a captured `hello` frame is
 * only replayable within `skewMs` of when it was minted, not forever.
 *
 * WHAT THIS DOES NOT PROTECT:
 * - Confidentiality. Every frame after the hello, including a
 *   `NodeActionRequest`'s params (typed text, a CDP passthrough's raw
 *   params, a screenshot's bytes), still travels in clear text unless the
 *   deployment terminates TLS on the socket itself (a `wss://` endpoint
 *   URL, or a `NodeSocketFactory` that wraps one). This module has no
 *   opinion about transport security and cannot add it.
 * - Peer identity. Every node in a deployment shares the one secret, so
 *   any node that has it is fully trusted to dispatch to any other; there
 *   is no per node credential, only "knows the secret or does not". This
 *   mirrors the flat trust `LocalNodeTransport`'s single node registry
 *   already assumes for a node reaching itself, just widened to a
 *   cluster.
 * - Rotation without downtime. Unlike `server/src/auth`'s `AppSigningKey`
 *   table (many keys, one or more active, rotated in place), this is
 *   exactly one accepted value. Changing it on some nodes and not others
 *   locks those nodes out of each other rather than rotating gracefully;
 *   a real rotation needs a coordinated restart of every node in the
 *   deployment at once.
 * - Exact single use replay protection. `skewMs` trades a real
 *   challenge/response round trip (which this minimal protocol does not
 *   have, since there is no peer side listener built in this repository
 *   to challenge against, see `WebSocketNodeTransport.ts`'s own top
 *   comment) for tolerance of ordinary clock drift between two processes.
 *   A party able to capture a hello and replay it inside the skew window,
 *   before the legitimate connection completes, is not defended against
 *   by this module alone.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NodeId } from '@browserglass/protocol';

/** Default tolerance between a hello's own `ts` and the verifier's clock, 30 seconds either direction. */
export const DEFAULT_HELLO_SKEW_MS = 30_000;

/**
 * The authentication frame sent once per connection, immediately after the
 * socket opens and before any request frame. `mac` is
 * `HMAC-SHA256(sharedSecret, "<nodeId>:<ts>")`, hex encoded: the secret
 * itself never travels on the wire, even under TLS, as defence in depth
 * against a logged or mis-routed frame.
 */
export interface NodeAuthHello {
  t: 'hello';
  nodeId: NodeId;
  ts: number;
  mac: string;
}

function computeMac(secret: string, nodeId: NodeId, ts: number): string {
  return createHmac('sha256', secret).update(`${nodeId}:${ts}`).digest('hex');
}

/** Builds a fresh, correctly signed hello frame asserting `nodeId`, timestamped `now`. */
export function signHello(secret: string, nodeId: NodeId, now: number): NodeAuthHello {
  return { t: 'hello', nodeId, ts: now, mac: computeMac(secret, nodeId, now) };
}

/**
 * Verifies a received hello frame against `secret`: the MAC must match
 * exactly, compared in constant time via `timingSafeEqual` so a party
 * probing this endpoint cannot learn the secret one byte at a time from
 * response timing, and `ts` must fall within `skewMs` of `now`.
 *
 * Written for a peer side listener to call; this package itself builds no
 * such listener (see `WebSocketNodeTransport.ts`'s own top comment: that
 * class is the DIAL half only), so this function still has no caller
 * inside this package's own runtime path, only its test suite. The
 * listener that does call it lives one layer up, in
 * `@browserglass/server`'s `ws/peer-upgrade.ts`, which depends on this
 * package the ordinary way (not the reverse: `@browserglass/router` still
 * imports only `@browserglass/protocol`). Exported for exactly
 * that: the wire contract `signHello` produces has one real, symmetric,
 * testable counterpart, rather than being documented prose a caller in a
 * higher layer has to reconstruct from scratch.
 */
export function verifyHello(
  hello: NodeAuthHello,
  secret: string,
  now: number,
  skewMs = DEFAULT_HELLO_SKEW_MS,
): boolean {
  if (Math.abs(now - hello.ts) > skewMs) return false;
  const expected = computeMac(secret, hello.nodeId, hello.ts);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(hello.mac, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
