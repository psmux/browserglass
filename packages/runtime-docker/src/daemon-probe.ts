/**
 * `probeDockerDaemon`: a real, cheap liveness check for the Docker (or
 * Podman, API compatible) daemon socket. No `dockerode` or other runtime
 * dependency is added, to keep the install small: this issues one plain `GET /version` against the daemon's
 * own Unix socket (or named pipe on Windows, or TCP when `DOCKER_HOST`
 * names one), which is the entire Docker Engine API surface this probe
 * needs.
 */

import * as http from 'node:http';
import * as process from 'node:process';

/** Where the Docker daemon socket is reached, resolved from `DOCKER_HOST` or the per-platform default. */
export type DockerSocketTarget =
  | { kind: 'socket'; path: string }
  | { kind: 'tcp'; host: string; port: number };

/** Resolves the daemon socket target: `DOCKER_HOST` first (`unix://`, `npipe://`, or `tcp://`), then the per-platform default. */
export function resolveDockerSocketTarget(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
): DockerSocketTarget {
  const dockerHost = env['DOCKER_HOST'];
  if (dockerHost) {
    if (dockerHost.startsWith('unix://')) {
      return { kind: 'socket', path: dockerHost.slice('unix://'.length) };
    }
    if (dockerHost.startsWith('npipe://')) {
      // npipe:////./pipe/docker_engine -> \\.\pipe\docker_engine
      const rest = dockerHost.slice('npipe://'.length).replace(/\//g, '\\');
      return { kind: 'socket', path: rest.startsWith('\\') ? rest : `\\${rest}` };
    }
    if (dockerHost.startsWith('tcp://')) {
      const rest = dockerHost.slice('tcp://'.length);
      const [host, portStr] = rest.split(':');
      return {
        kind: 'tcp',
        host: host || '127.0.0.1',
        port: portStr ? Number.parseInt(portStr, 10) : 2375,
      };
    }
  }
  return platform === 'win32'
    ? { kind: 'socket', path: '\\\\.\\pipe\\docker_engine' }
    : { kind: 'socket', path: '/var/run/docker.sock' };
}

/** What one `probeDockerDaemon` call found. */
export interface DockerDaemonProbeResult {
  reachable: boolean;
  target: DockerSocketTarget;
  /** Parsed from the daemon's `/version` response, when reachable. */
  version: { Version?: string; ApiVersion?: string; Os?: string; Arch?: string } | null;
  /** A short, human-readable reason, populated when `reachable` is `false`. */
  detail: string;
}

function requestVersion(
  target: DockerSocketTarget,
  timeoutMs: number,
): Promise<DockerDaemonProbeResult> {
  return new Promise((resolve) => {
    const options: http.RequestOptions =
      target.kind === 'socket'
        ? { socketPath: target.path, path: '/version', method: 'GET', timeout: timeoutMs }
        : {
            host: target.host,
            port: target.port,
            path: '/version',
            method: 'GET',
            timeout: timeoutMs,
          };

    const req = http.request(options, (res) => {
      const chunks: string[] = [];
      res.on('data', (chunk) => chunks.push(String(chunk)));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({
            reachable: false,
            target,
            version: null,
            detail: `daemon answered HTTP ${res.statusCode}`,
          });
          return;
        }
        try {
          const parsed = JSON.parse(chunks.join('')) as DockerDaemonProbeResult['version'];
          resolve({ reachable: true, target, version: parsed, detail: 'ok' });
        } catch {
          resolve({
            reachable: false,
            target,
            version: null,
            detail: 'daemon answered with an unparseable body',
          });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({
        reachable: false,
        target,
        version: null,
        detail: `no response within ${timeoutMs}ms`,
      });
    });
    req.on('error', (err) => {
      resolve({ reachable: false, target, version: null, detail: err.message });
    });
    req.end();
  });
}

/**
 * Probes the Docker daemon's `/version` endpoint over its Unix socket
 * (Linux/macOS), named pipe (Windows), or TCP address (when `DOCKER_HOST`
 * names one). Never throws: an absent, unreachable, or timed-out daemon
 * resolves with `reachable: false` and a `detail` string, so `probe()`
 * can report `status: 'unavailable'` cleanly.
 */
export async function probeDockerDaemon(timeoutMs = 2000): Promise<DockerDaemonProbeResult> {
  const target = resolveDockerSocketTarget();
  try {
    return await requestVersion(target, timeoutMs);
  } catch (err) {
    return {
      reachable: false,
      target,
      version: null,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
