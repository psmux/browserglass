/**
 * `@browserglass/runtime-k8s`: Chrome on Kubernetes, one pod per browser.
 * Roadmap tier, interface only: `capabilities()` and `probe()` are real, everything else
 * throws `NotImplementedError`. Exists to prove the `BrowserRuntime`
 * interface holds for a third implementation before one is built. See
 * this package's `README.md` for the four open design areas.
 */

export { K8S_CAPABILITIES, buildK8sCapabilities } from './capabilities.js';
export { probeKubeApi, type KubeApiProbeResult } from './kube-api-probe.js';
export { NotImplementedError, type K8sErrorCode } from './not-implemented.js';
export { K8sRuntime } from './runtime.js';
