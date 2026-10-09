/**
 * `@browserglass/protocol`'s wire layer: ids, the JSON envelope and the
 * full `bgls.v1` message catalogue, the 20-byte binary frame codec, close
 * codes, errors, capabilities, auth types, version negotiation, and
 * default limits. Zero runtime dependencies; this ships inside the
 * browser bundle.
 */
export * from './ids.js';
export * from './envelope.js';
export * from './binary.js';
export * from './close-codes.js';
export * from './errors.js';
export * from './capabilities.js';
export * from './auth.js';
export * from './version.js';
export * from './limits.js';
export * from './messages/index.js';
