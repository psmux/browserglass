/**
 * `NotImplementedError`: the error every stub method on `DockerRuntime`
 * throws.
 * Not `LaunchError` for every method: `LaunchError`'s `LaunchErrorCode` and
 * `LaunchPhase` shape is specific to `launch()`/`attach()`, which this
 * package's `runtime.ts` does use it for; `terminate()`, `stats()`,
 * `list()`, and `dispose()` have no equivalent typed error in
 * `@browserglass/protocol`, so this package carries a small one of its own,
 * preserving the same `E_DOCKER_UNAVAILABLE`/`E_IMAGE_MISSING` codes so a
 * caller can integrate against the real contract before a real
 * implementation exists.
 */

/** The two docker-specific codes a `NotImplementedError` carries, matching `LaunchErrorCode`'s spelling exactly. */
export type DockerErrorCode = 'E_DOCKER_UNAVAILABLE' | 'E_IMAGE_MISSING';

/** Thrown by every `DockerRuntime` method this stub does not implement. */
export class NotImplementedError extends Error {
  readonly code: DockerErrorCode;
  readonly method: string;

  constructor(method: string, code: DockerErrorCode = 'E_DOCKER_UNAVAILABLE') {
    super(
      `@browserglass/runtime-docker.${method}() is not implemented yet; this package is a stub that ships a real capabilities() and probe() only`,
    );
    this.name = 'NotImplementedError';
    this.code = code;
    this.method = method;
  }
}
