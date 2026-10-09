/**
 * `DOCKER_CAPABILITIES`: what a real docker runtime would report, given
 * its design (one container per browser, per container resource limits).
 * Real even though `launch`/`attach`/etc. are stubs: `capabilities()` is
 * what the router's placement scoring reads, and a spec asking for
 * something this runtime cannot do is meant to be a placement failure
 * caught before `launch()` is ever called, not a launch failure.
 */

import * as process from 'node:process';
import type { RuntimeCapabilities } from '@browserglass/protocol';

/**
 * On `arch: 'arm64'`, no official Chrome build exists, so the docker
 * image ships bundled Chromium instead and `channels` omits `'chrome'`
 */
function channelsForArch(arch: string): RuntimeCapabilities['channels'] {
  return arch === 'arm64'
    ? Object.freeze(['chromium', 'bundled'])
    : Object.freeze(['chrome', 'chromium', 'bundled']);
}

/**
 * Builds the capability set a real docker runtime would report for the
 * current architecture. A function, not a frozen constant, because
 * `channels` is architecture dependent and `capabilities()` is documented to be "read once at node
 * registration, re-read after a config reload".
 */
export function buildDockerCapabilities(arch: string = process.arch): RuntimeCapabilities {
  return Object.freeze({
    kind: 'docker',
    channels: channelsForArch(arch),
    // xvfb-headful is the docker runtime's default (always has Xvfb in the
    // image); 'off' is never advertised, container runs have no console
    // session for a headful browser without a virtual display.
    headlessModes: Object.freeze(['new', 'xvfb-headful']),
    // Container per browser: exact per-container --cpus /
    // --memory / --pids-limit mapping, all true.
    resourceLimits: Object.freeze({ cpus: true, memoryMb: true, shmMb: true, pidsLimit: true }),
    // headless 'new' plus extensions is a known bad combination
    // in Chrome; unpacked and crx both load fine
    // otherwise, since the image controls its own extension directory.
    extensions: Object.freeze({ unpacked: true, crx: true, withHeadlessNew: false }),
    proxyPerInstance: true,
    proxyAuthPerInstance: true,
    timezonePerInstance: true,
    localePerInstance: true,
    // Downloads and uploads are both bind-mounted per instance.
    fileBridge: Object.freeze({ download: true, upload: true }),
    survivesNodeRestart: true,
    supportsAttach: true,
    gracefulTerminate: true,
    // A scheduling question, not a hard slot count; a
    // generous, clearly-a-placeholder default for this stub.
    maxConcurrentBrowsers: 64,
    // Cold container start (300 to 900ms) plus Chrome's own (400 to
    // 1200ms); a comfortable ceiling above the sum.
    maxLaunchTimeoutMs: 60000,
    notes: Object.freeze([
      'runtime-docker is a stub for now: capabilities() and probe() are real, launch/attach/terminate/stats/list throw NotImplementedError',
      'one container per browser instance, created at launch and removed at terminate',
      'CDP is never reachable over a published host port; unix socket (or a per-node loopback proxy on Docker Desktop)',
    ]),
  }) as RuntimeCapabilities;
}

/** `DOCKER_CAPABILITIES` for the architecture this process is running on. Prefer {@link buildDockerCapabilities} when the target architecture is not the current process's own. */
export const DOCKER_CAPABILITIES: RuntimeCapabilities = buildDockerCapabilities();
