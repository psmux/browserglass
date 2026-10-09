/**
 * Completes the `bgls.v1` WebSocket handshake and starts the message loop.
 * `packages/server/src/index.ts`'s `handleUpgrade` closure already performs the two pre-socket checks (`Origin`, the
 * `bgls.v1` subprotocol offer) before calling into this module; everything
 * from here on always completes the WS handshake: a bad token completes
 * the handshake then closes with a 42xx code, it does not fail the HTTP
 * upgrade.
 *
 * Uses the `ws` package's `WebSocketServer` in `noServer` mode for the
 * actual RFC 6455 framing (masking, fragmentation, ping/pong, close
 * frames): hand-rolling that protocol correctly is a large surface with a
 * well-tested library already in this workspace's dependency tree, and
 * getting it wrong silently corrupts frames under fragmentation, which a
 * simple happy-path test would never catch.
 */

import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { Connection, type ConnectionDeps } from './connection.js';
import { extractPreUpgradeCarriers } from './credentials.js';

/**
 * One process-wide `noServer` `WebSocketServer`; it never listens on a port
 * itself, `handleUpgrade` is called manually per accepted connection.
 * `handleProtocols` always echoes exactly `bgls.v1`: the caller has already verified it was
 * offered before this module is ever invoked, and this build speaks no
 * other subprotocol.
 */
const wss = new WebSocketServer({ noServer: true, handleProtocols: () => 'bgls.v1' });

/**
 * Completes the handshake (the caller has already verified `bgls.v1` is
 * among `offeredSubprotocols`) and constructs a {@link Connection}. Never
 * writes anything itself before this point; the caller owns every
 * pre-socket response.
 */
export function completeHandshakeAndServe(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  offeredSubprotocols: readonly string[],
  deps: ConnectionDeps,
): void {
  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  const remoteAddress = req.socket.remoteAddress;
  const userAgent =
    typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
  const preCarriers = extractPreUpgradeCarriers(req, offeredSubprotocols);

  wss.handleUpgrade(req, socket, head, (ws) => {
    new Connection(ws, deps, { origin, remoteAddress, userAgent, preCarriers });
  });
}
