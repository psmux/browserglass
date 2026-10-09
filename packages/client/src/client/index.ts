/**
 * `@browserglass/client`'s client-assembly layer: `BrowserGlassClient`
 * itself, `BrowserGlassError`, `StreamHandle`, and every client-owned type
 * it exposes. Built on top of `../transport`, `../render`, and
 * `../input`; those three modules are used here as they are.
 */
export { BrowserGlassClient } from './BrowserGlassClient.js';
export { BrowserGlassError, type BrowserGlassErrorInit } from './errors.js';
export { StreamHandleImpl, type StreamHost } from './StreamHandleImpl.js';
export { HoverWatcher, type ProbeFn } from './watchHover.js';
export * from './types.js';
