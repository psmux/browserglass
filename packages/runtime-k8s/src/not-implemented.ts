/**
 * `NotImplementedError`: the error every stub method on `K8sRuntime`
 * throws. `runtime-k8s` is roadmap tier, interface only: specifying the
 * interface now proves it holds before a third implementation exists. See `@browserglass/runtime-docker`'s
 * own `not-implemented.ts` for the identical rationale; this package
 * carries its own copy rather than a shared dependency, consistent with
 * each stub runtime owning its error shape.
 */

/** The two docker-shaped codes a `NotImplementedError` may carry here too, kept spelled identically to `LaunchErrorCode` for a caller that switches on `.code` across runtimes. */
export type K8sErrorCode = 'E_DOCKER_UNAVAILABLE' | 'E_IMAGE_MISSING';

/** Thrown by every `K8sRuntime` method this stub does not implement. */
export class NotImplementedError extends Error {
  readonly code: K8sErrorCode;
  readonly method: string;

  constructor(method: string, code: K8sErrorCode = 'E_DOCKER_UNAVAILABLE') {
    super(
      `@browserglass/runtime-k8s.${method}() is not implemented yet; runtime-k8s is roadmap tier, interface only. See this package's README.md for the open design areas`,
    );
    this.name = 'NotImplementedError';
    this.code = code;
    this.method = method;
  }
}
