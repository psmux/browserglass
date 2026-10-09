# @browserglass/runtime-docker

Chrome inside a container, on the same machine as the node. This package is
a stub for now: `capabilities()`
and `probe()` are real, `launch`, `attach`, `terminate`, `stats`, and `list`
throw `NotImplementedError` (or, for `launch`/`attach`, a `LaunchError` coded
`E_DOCKER_UNAVAILABLE`), with every method's real signature preserved so a
caller integrates against the real contract now.

## What is real today

* `capabilities()` reports what a full implementation would: container per
  browser resource limits (`cpus`/`memoryMb`/`shmMb`/`pidsLimit` all
  enforceable), `xvfb-headful` as the default headless mode, download and
  upload file bridges, and the architecture dependent channel list (no
  `chrome` on `arm64`, bundled Chromium instead).
* `probe()` issues a real `GET /version` against the Docker (or Podman,
  API compatible) daemon socket: the Unix socket on Linux and macOS, the
  named pipe on Windows, or a `tcp://` address when `DOCKER_HOST` names
  one. It returns `status: 'unavailable'` cleanly, never throws, when the
  daemon is absent, unreachable, or slow to answer.

## Decisions the eventual real implementation must stay consistent with

These are settled design commitments, not open questions. `runtime-k8s`, which shares the same container image and
container agent, inherits every one of them too.

1. **One container per browser instance**, created at `launch()` and
   removed at `terminate()`. Explicitly rejected: one long lived container
   hosting several browsers behind fixed port mapping. That shape has fixed
   slot exhaustion, shared resource limits across browsers sharing one
   container, and full-container blast radius on compromise.
2. **CDP is never reachable over a published host port.** Docker's port
   publishing DNATs past the host firewall's `INPUT` chain, and CDP is
   unauthenticated full browser control. Reached instead over a Unix
   domain socket bind-mounted into the container (Linux/macOS default), or
   a per-node loopback proxy container on a private bridge network (the
   Windows/macOS Docker Desktop fallback, where a Unix socket bind mount
   across the Desktop VM boundary is unreliable). `CdpEndpoint` has a
   `unix://` URL form for this.
3. **The image is `ghcr.io/browserglass/chrome:<chromeMajor>-<imageRev>`**,
   immutable tags, Debian bookworm slim (not Alpine, Chrome is glibc
   linked), `dumb-init` as PID 1, a non-root `bgls` user, and a small
   container agent that launches Chrome, applies init scripts inside the
   container, and proxies CDP.
4. **Never bind mount a directory this runtime did not create itself**, and
   never mount the Docker socket into a browser container (a container with
   the Docker socket is root on the host).
5. **`--rm` is deliberately not used**; the runtime removes containers
   explicitly after `docker inspect`, which is how an OOM kill (`137` with
   the OOM flag) is told apart from a crash or a clean shutdown.

## Not built yet

Everything else: the container agent, the volume/mount table, the hardening flag set, the
reconciliation-by-label janitor, and the terminate ladder. `launch()` and
`attach()` throw `LaunchError` coded `E_DOCKER_UNAVAILABLE`; `terminate()`,
`stats()`, and `list()` throw `NotImplementedError` (same code). `E_IMAGE_MISSING`
is reserved on the same `NotImplementedError`/`LaunchErrorCode` type for
the eventual "image not pulled" case, not thrown by this stub.
