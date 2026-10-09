/**
 * `@browserglass/runtime-docker`: Chrome in a container, one container per
 * browser. A stub for now: `capabilities()` and `probe()` are real, everything else
 * throws `NotImplementedError`. See this package's `README.md` for the
 * docker decisions the eventual real implementation, and `runtime-k8s`
 * (which reuses the same container image and agent), must stay consistent
 * with.
 */

export { DOCKER_CAPABILITIES, buildDockerCapabilities } from './capabilities.js';
export {
  probeDockerDaemon,
  resolveDockerSocketTarget,
  type DockerDaemonProbeResult,
  type DockerSocketTarget,
} from './daemon-probe.js';
export { NotImplementedError, type DockerErrorCode } from './not-implemented.js';
export { DockerRuntime } from './runtime.js';
