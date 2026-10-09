/**
 * `probeKubeApi`: a real, cheap reachability check for the Kubernetes API
 * server. No `@kubernetes/client-node` or other runtime dependency is
 * added (the same reasoning as `@browserglass/runtime-docker`'s daemon
 * probe).
 *
 * Scope, deliberately narrow: this only ever probes the in-cluster API
 * server, using the service account credentials Kubernetes injects into
 * every pod (`KUBERNETES_SERVICE_HOST`/`_PORT` env vars, the token and CA
 * cert files under `/var/run/secrets/kubernetes.io/serviceaccount/`). It
 * does not parse an out-of-cluster `kubeconfig` (`~/.kube/config` or
 * `$KUBECONFIG`): that needs a real YAML parser (a new dependency) and
 * multi-context/auth-plugin resolution logic disproportionate to a stub
 * package whose entire point is proving the `BrowserRuntime` interface
 * holds, not standing up a working cluster client. Out-of-cluster,
 * `probe()` reports `status: 'unavailable'` with a clear, honest detail
 * rather than a fragile best-effort guess. See this package's README.md.
 */

import * as fs from 'node:fs';
import * as https from 'node:https';
import * as process from 'node:process';

const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** What one `probeKubeApi` call found. */
export interface KubeApiProbeResult {
  reachable: boolean;
  /** `false` when this process is not running inside a Kubernetes pod at all (no in-cluster env vars). */
  inCluster: boolean;
  detail: string;
  /** Parsed from the API server's `/version` response, when reachable. */
  version: { gitVersion?: string; platform?: string } | null;
}

function inClusterTarget(
  env: Record<string, string | undefined>,
): { host: string; port: number } | null {
  const host = env['KUBERNETES_SERVICE_HOST'];
  const port = env['KUBERNETES_SERVICE_PORT'];
  if (!host || !port) {
    return null;
  }
  const parsedPort = Number.parseInt(port, 10);
  return Number.isNaN(parsedPort) ? null : { host, port: parsedPort };
}

function requestVersion(
  host: string,
  port: number,
  ca: string,
  token: string,
  timeoutMs: number,
): Promise<KubeApiProbeResult> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        host,
        port,
        path: '/version',
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        ca,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: string[] = [];
        res.on('data', (chunk) => chunks.push(String(chunk)));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            resolve({
              reachable: false,
              inCluster: true,
              detail: `kube API answered HTTP ${res.statusCode}`,
              version: null,
            });
            return;
          }
          try {
            const parsed = JSON.parse(chunks.join('')) as KubeApiProbeResult['version'];
            resolve({ reachable: true, inCluster: true, detail: 'ok', version: parsed });
          } catch {
            resolve({
              reachable: false,
              inCluster: true,
              detail: 'kube API answered with an unparseable body',
              version: null,
            });
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({
        reachable: false,
        inCluster: true,
        detail: `no response within ${timeoutMs}ms`,
        version: null,
      });
    });
    req.on('error', (err) => {
      resolve({ reachable: false, inCluster: true, detail: err.message, version: null });
    });
    req.end();
  });
}

/**
 * Probes the in-cluster Kubernetes API server's `/version` endpoint using
 * the pod's own service account credentials. Never throws. When this
 * process is not running inside a cluster at all (the common case for a
 * developer machine or this build's CI), resolves with `inCluster: false`
 * and `reachable: false` rather than attempting a fragile out-of-cluster
 * `kubeconfig` guess.
 */
export async function probeKubeApi(timeoutMs = 2000): Promise<KubeApiProbeResult> {
  const target = inClusterTarget(process.env);
  if (!target) {
    return {
      reachable: false,
      inCluster: false,
      detail:
        'not running inside a Kubernetes pod (no KUBERNETES_SERVICE_HOST/PORT); out-of-cluster kubeconfig probing is not implemented in this stub',
      version: null,
    };
  }
  const tokenPath = `${SERVICE_ACCOUNT_DIR}/token`;
  const caPath = `${SERVICE_ACCOUNT_DIR}/ca.crt`;
  if (!fs.existsSync(tokenPath) || !fs.existsSync(caPath)) {
    return {
      reachable: false,
      inCluster: true,
      detail: `in-cluster env vars set but ${SERVICE_ACCOUNT_DIR} is missing the expected token/ca.crt files`,
      version: null,
    };
  }
  try {
    const token = fs.readFileSync(tokenPath, 'utf8').trim();
    const ca = fs.readFileSync(caPath, 'utf8');
    return await requestVersion(target.host, target.port, ca, token, timeoutMs);
  } catch (err) {
    return {
      reachable: false,
      inCluster: true,
      detail: err instanceof Error ? err.message : String(err),
      version: null,
    };
  }
}
