/**
 * `DockerRuntime`: `@browserglass/runtime-docker`'s `BrowserRuntime`
 * implementation. A stub for now:
 * `capabilities()` and `probe()` are real; `launch`, `attach`, `terminate`,
 * `stats`, and `list` throw {@link NotImplementedError} carrying the right
 * error code, with every method's real signature preserved so a caller
 * integrates against the real contract now. `dispose()` is a real no-op:
 * a stub holds no runtime-wide resources to release.
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
import { DOCKER_CAPABILITIES } from './capabilities.js';
import { probeDockerDaemon } from './daemon-probe.js';
import { NotImplementedError } from './not-implemented.js';

function wallNow(): number {
  return Date.now();
}

/** `@browserglass/runtime-docker`'s `BrowserRuntime`. See this file's top comment for the stub's exact scope. */
export class DockerRuntime implements BrowserRuntime {
  readonly kind = 'docker' as const;

  capabilities(): RuntimeCapabilities {
    return DOCKER_CAPABILITIES;
  }

  async probe(): Promise<RuntimeProbe> {
    const checkedAt = wallNow();
    const result = await probeDockerDaemon();
    if (!result.reachable) {
      return {
        ok: false,
        status: 'unavailable',
        detail: `docker daemon not reachable at ${result.target.kind === 'socket' ? result.target.path : `${result.target.host}:${result.target.port}`}: ${result.detail}`,
        engine: null,
        remediation:
          'start the Docker (or Podman) daemon, or set DOCKER_HOST to a reachable socket/pipe/TCP address',
        checkedAt,
      };
    }
    return {
      ok: true,
      status: 'ready',
      detail: `docker daemon reachable, version ${result.version?.Version ?? 'unknown'}`,
      engine: { name: 'docker', version: result.version?.Version ?? 'unknown', path: null },
      remediation: null,
      checkedAt,
    };
  }

  // Every stub method below is declared `async` deliberately, not just
  // typed to return a `Promise`: an `async` function wraps a synchronous
  // `throw` into a rejected promise, so `runtime.launch(req)` never throws
  // into the caller's own call stack, only ever rejects, matching every
  // other (non-stub) `BrowserRuntime` implementation's calling convention.

  async launch(req: LaunchRequest): Promise<LaunchedBrowser> {
    throw new LaunchError({
      code: 'E_DOCKER_UNAVAILABLE',
      phase: 'preflight',
      message: 'runtime-docker.launch() is not implemented yet; this package is a stub',
      remediation: 'use the host or remote runtime until the docker runtime is implemented',
      retryable: false,
      context: { instanceId: req.instanceId },
    });
  }

  async attach(req: AttachRequest): Promise<LaunchedBrowser> {
    throw new LaunchError({
      code: 'E_DOCKER_UNAVAILABLE',
      phase: 'preflight',
      message: 'runtime-docker.attach() is not implemented yet; this package is a stub',
      remediation: 'use the host or remote runtime until the docker runtime is implemented',
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
    // A stub holds no runtime-wide resources (no supervisors, no sockets,
    // no watched containers), so there is nothing to release. Real,
    // successful, and idempotent, per the interface's own contract.
  }
}
