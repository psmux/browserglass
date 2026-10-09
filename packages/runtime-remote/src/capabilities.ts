/**
 * `REMOTE_CAPABILITIES`: `runtime-remote` did not
 * launch the process, so it cannot fix anything at launch time (channel,
 * headless mode, args, proxy, extensions, resource limits, profile), cannot
 * supervise an unseen process (`stats()` reports only what CDP itself
 * gives), and cannot terminate cleanly beyond `Browser.close`.
 */

import type { RuntimeCapabilities } from '@browserglass/protocol';

/** The one, fixed capability set every `runtime-remote` endpoint reports. */
export const REMOTE_CAPABILITIES: RuntimeCapabilities = Object.freeze({
  kind: 'remote',
  channels: Object.freeze([]),
  headlessModes: Object.freeze([]),
  resourceLimits: Object.freeze({ cpus: false, memoryMb: false, shmMb: false, pidsLimit: false }),
  extensions: Object.freeze({ unpacked: false, crx: false, withHeadlessNew: false }),
  proxyPerInstance: false,
  proxyAuthPerInstance: true,
  timezonePerInstance: true,
  localePerInstance: true,
  fileBridge: Object.freeze({ download: true, upload: false }),
  survivesNodeRestart: true,
  supportsAttach: true,
  gracefulTerminate: false,
  maxConcurrentBrowsers: 1,
  maxLaunchTimeoutMs: 30000,
  notes: Object.freeze(['spec fields fixed at launch are ignored; see instance.incidents']),
}) as RuntimeCapabilities;
