/**
 * `@browserglass/client`'s transport layer: the eight-state connection
 * machine, reconnection with backoff and resume, `sq` gap detection, the
 * 4200 ticket-consumed exception, and the application keepalive. Zero
 * Node builtins, zero runtime dependencies beyond `@browserglass/protocol`.
 *
 * This module owns the socket and the wire protocol only. Stream/target/
 * control message routing, canvas rendering, and input capture are built
 * on top of {@link Transport} by later tasks (`packages/client/src/render`,
 * `packages/client/src/input`, and `packages/client/src/client`).
 */
export * from './emitter.js';
export * from './keepalive.js';
export * from './reconnect.js';
export * from './resume.js';
export * from './state-machine.js';
export * from './transport.js';
export * from './types.js';
