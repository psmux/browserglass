/**
 * `K8S_CAPABILITIES`: what a real k8s runtime would report:
 * `survivesNodeRestart: true`, `supportsAttach: true`, resource limits
 * true, and `fileBridge` `{download:false, upload:false}` pending the PVC
 * design. Pod per browser, same image and container agent as
 * `runtime-docker`, so most of the shape mirrors `DOCKER_CAPABILITIES`.
 */

import * as process from 'node:process';
import type { RuntimeCapabilities } from '@browserglass/protocol';

function channelsForArch(arch: string): RuntimeCapabilities['channels'] {
  return arch === 'arm64'
    ? Object.freeze(['chromium', 'bundled'])
    : Object.freeze(['chrome', 'chromium', 'bundled']);
}

/** Builds the capability set a real k8s runtime would report, mirroring `runtime-docker`'s `buildDockerCapabilities` for the fields the two share (same image, same container agent). */
export function buildK8sCapabilities(arch: string = process.arch): RuntimeCapabilities {
  return Object.freeze({
    kind: 'k8s',
    channels: channelsForArch(arch),
    headlessModes: Object.freeze(['new', 'xvfb-headful']),
    // A Pod's container resource requests/limits map the same way docker's do.
    resourceLimits: Object.freeze({ cpus: true, memoryMb: true, shmMb: true, pidsLimit: true }),
    extensions: Object.freeze({ unpacked: true, crx: true, withHeadlessNew: false }),
    proxyPerInstance: true,
    proxyAuthPerInstance: true,
    timezonePerInstance: true,
    localePerInstance: true,
    // Pending the PersistentVolumeClaim
    // design (this README's open design area 2), no file bridge is
    // promised yet, unlike the docker runtime's bind mounts.
    fileBridge: Object.freeze({ download: false, upload: false }),
    survivesNodeRestart: true,
    supportsAttach: true,
    gracefulTerminate: true,
    // Scheduling is a k8s Deployment/warm-pool question, not a hard slot
    // count on one node; a generous, clearly-a-placeholder default.
    maxConcurrentBrowsers: 256,
    // Cold pod start is 2 to 15s (scheduling plus image pull plus
    // container start), well above docker's single-container
    // cold start; the ceiling reflects that.
    maxLaunchTimeoutMs: 90000,
    notes: Object.freeze([
      'runtime-k8s is roadmap tier, interface only, for now: capabilities() and probe() are real, launch/attach/terminate/stats/list throw NotImplementedError',
      'pod per browser, same container image and agent as runtime-docker, an owner reference to a BrowserInstance custom resource',
      'CDP reachability across the pod network, PersistentVolumeClaim profile mutual exclusion, router-vs-scheduler placement, and cold-start warm pools are all open design areas; see README.md',
    ]),
  }) as RuntimeCapabilities;
}

/** `K8S_CAPABILITIES` for the architecture this process is running on. Prefer {@link buildK8sCapabilities} when the target architecture is not the current process's own. */
export const K8S_CAPABILITIES: RuntimeCapabilities = buildK8sCapabilities();
