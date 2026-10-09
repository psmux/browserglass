/**
 * `@browserglass/runtime-remote`: attach to an operator-configured CDP
 * endpoint. No spawn, no supervision, no profile locks, no orphan scan.
 */

export { REMOTE_CAPABILITIES } from './capabilities.js';
export { RemoteRuntime } from './runtime.js';
export { REMOTE_ENDPOINT_LABEL, type RemoteRuntimeOptions } from './types.js';
export type { SpecIgnoredIncident } from './spec-apply.js';
export {
  probeCdpIdentity,
  CdpProbeTimeoutError,
  type ProbeCdpIdentityMode,
  type ProbeCdpIdentityOptions,
  type CdpIdentity,
} from './cdp-identity.js';
export {
  RemoteCdpClient,
  RemoteCdpError,
  type CdpVersionInfo,
  type CdpTargetInfo,
  type RemoteCdpClientOptions,
} from './cdp-client.js';
export { deriveHttpOrigin, UnsupportedEndpointTransportError } from './endpoint-url.js';
