/**
 * The full `bgls.v1` message catalogue, including a few message types that
 * are typed but not wired up yet. `error` itself lives in `../errors.js`, alongside
 * the `ErrorCategory` and registry it shares a namespace with.
 */
export * from './session.js';
export * from './targets.js';
export * from './streams.js';
export * from './input.js';
export * from './control.js';
export * from './navigation.js';
export * from './clipboard.js';
export * from './files.js';
export * from './dialogs.js';
export * from './instance.js';
export * from './presence.js';
export * from './diagnostics.js';
export * from './capture.js';
export * from './probe.js';
export * from './evaluate.js';
export * from './interception.js';
export * from './response-body.js';
export * from './a11y.js';
export * from './pagemap.js';
export * from './pdf.js';
export * from './recording.js';
