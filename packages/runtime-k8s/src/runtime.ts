/**
 * `K8sRuntime`: `@browserglass/runtime-k8s`'s `BrowserRuntime`
 * implementation. Roadmap tier, interface only: `capabilities()` and
 * `probe()` are real; `launch`, `attach`, `terminate`, `stats`, and `list`
 * throw {@link NotImplementedError}, with every method's real signature
 * preserved, so the interface is proven to hold before a third
 * implementation exists.
 */

import type {
  AttachRequest,
  BrowserRuntime,
  LaunchRequest,
  LaunchedBrowser,
  RuntimeCapabilities,
  RuntimeInventoryEntry,
  RuntimeProbe,
  RuntimeStats,
  TerminateMode,
  TerminateResult,
} from '@browserglass/protocol';
import { LaunchError } from '@browserglass/protocol';
import { K8S_CAPABILITIES } from './capabilities.js';
import { probeKubeApi } from './kube-api-probe.js';
import { NotImplementedError } from './not-implemented.js';

function wallNow(): number {
  return Date.now();
}

/** `@browserglass/runtime-k8s`'s `BrowserRuntime`. See this file's top comment for the stub's exact scope. */
export class K8sRuntime implements BrowserRuntime {
  readonly kind = 'k8s' as const;

  capabilities(): RuntimeCapabilities {
    return K8S_CAPABILITIES;
  }

  async probe(): Promise<RuntimeProbe> {
    const checkedAt = wallNow();
    const result = await probeKubeApi();
    if (!result.reachable) {
      return {
        ok: false,
        status: 'unavailable',
        detail: result.detail,
        engine: null,
        remediation: result.inCluster
          ? 'confirm the pod service account can reach the Kubernetes API server (RBAC, network policy)'
          : 'runtime-k8s only probes the in-cluster API server; run this node inside a Kubernetes pod, or see README.md for the out-of-cluster limitation',
        checkedAt,
      };
    }
    return {
      ok: true,
      status: 'ready',
      detail: `kube API reachable, version ${result.version?.gitVersion ?? 'unknown'}`,
      engine: { name: 'kubernetes', version: result.version?.gitVersion ?? 'unknown', path: null },
      remediation: null,
      checkedAt,
    };
  }

  // Every stub method below is declared `async` deliberately: an `async`
  // function wraps a synchronous `throw` into a rejected promise, so
  // `runtime.launch(req)` never throws into the caller's own call stack,
  // only ever rejects, matching every other `BrowserRuntime`
  // implementation's calling convention.

  async launch(req: LaunchRequest): Promise<LaunchedBrowser> {
    throw new LaunchError({
      code: 'E_DOCKER_UNAVAILABLE',
      phase: 'preflight',
      message:
        'runtime-k8s.launch() is not implemented yet; runtime-k8s is roadmap tier, interface only',
      remediation:
        'see this package README.md for the open design areas a real implementation must resolve first',
      retryable: false,
      context: { instanceId: req.instanceId },
    });
  }

  async attach(req: AttachRequest): Promise<LaunchedBrowser> {
    throw new LaunchError({
      code: 'E_DOCKER_UNAVAILABLE',
      phase: 'preflight',
      message:
        'runtime-k8s.attach() is not implemented yet; runtime-k8s is roadmap tier, interface only',
      remediation:
        'see this package README.md for the open design areas a real implementation must resolve first',
      retryable: false,
      context: { instanceId: req.instanceId },
    });
  }

  async stats(_handle: LaunchedBrowser): Promise<RuntimeStats> {
    throw new NotImplementedError('stats');
  }

  async terminate(_handle: LaunchedBrowser, _mode: TerminateMode): Promise<TerminateResult> {
    throw new NotImplementedError('terminate');
  }

  async list(): Promise<readonly RuntimeInventoryEntry[]> {
    throw new NotImplementedError('list');
  }

  async dispose(): Promise<void> {
    // A stub holds no runtime-wide resources, nothing to release.
  }
}
