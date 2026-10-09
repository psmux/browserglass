/**
 * `@browserglass/server`'s WebSocket transport: `completeHandshakeAndServe`
 * (the extension point `packages/server/src/index.ts`'s `handleUpgrade`
 * calls into once the pre-socket Origin and subprotocol checks pass),
 * credential resolution, and the `Connection` message loop.
 */

export * from './cdp-upgrade.js';
export * from './connection.js';
export * from './credentials.js';
export * from './origin-check.js';
export * from './peer-upgrade.js';
export * from './upgrade.js';
