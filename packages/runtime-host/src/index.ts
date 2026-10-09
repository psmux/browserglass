/**
 * `@browserglass/runtime-host`: real Chrome on the host OS. Binary
 * discovery, flag composition, detached spawn with process-group kill,
 * `DevToolsActivePort` plus GUID identity confirmation, `BrowserSupervisor`,
 * the durable instance registry, startup reattach and reconciliation,
 * orphan and `SingletonLock` handling, the terminate ladder, and the
 * `ProfileFs` filesystem implementation.
 */

export { HostRuntime, createHostRuntime } from './runtime.js';
export type { HostRuntimeConfig } from './config.js';
export {
  DEFAULT_SUPERVISOR_CONFIG,
  DEFAULT_SWEEPER_CONFIG,
  DEFAULT_TRASH_RETENTION_MS_BY_KIND,
  MAX_INLINE_COPY_BYTES,
  CORRUPTION_PROBE_BUDGET_MS,
  WINDOWS_MAX_PROFILE_ROOT_CHARS,
  defaultProfileRoot,
  defaultStateDir,
  resolveAllowNoSandbox,
} from './config.js';

export { resolveChromeBinary, BinaryNotFoundError } from './binary-discovery.js';
export type { ResolvedBinary } from './binary-discovery.js';

export { buildLaunchArgs, BACKGROUNDING_FLAGS } from './flags.js';
export type { BuildLaunchArgsOptions, BuiltLaunchArgs, DeniedArg } from './flags.js';

export {
  isStealthLevelEnabled,
  resolveStealthProfile,
  resolveRequiredStealthProfile,
  validateStealthProfiles,
} from './stealth.js';

export { BASIC_STEALTH_PROFILE } from './stealth-profiles/basic.js';
export { MEASURED_STEALTH_PROFILE } from './stealth-profiles/measured.js';

export { runStealthSelfTest } from './stealth-self-test.js';
export type { RunStealthSelfTestOptions, StealthSelfTestReport } from './stealth-self-test.js';

export { spawnDetachedChrome, resolveBrowserPid, killProcessTree } from './spawn.js';
export type { SpawnDetachedOptions, SpawnedChrome } from './spawn.js';

export {
  discoverCdpEndpoint,
  unlinkStaleDevToolsActivePort,
  waitForDevToolsActivePort,
} from './cdp-endpoint.js';
export type { DevToolsActivePortContents } from './cdp-endpoint.js';

export { healProfile } from './profile-heal.js';
export type { HealOptions, HealResult } from './profile-heal.js';

export { probeCdpIdentity, CdpProbeTimeoutError } from './identity-probe.js';
export type {
  ProbeCdpIdentityMode,
  ProbeCdpIdentityOptions,
  CdpIdentity,
} from './identity-probe.js';

export {
  candidateLocalBrowserProfiles,
  probeLocalBrowserCandidate,
  discoverLocalBrowser,
  LocalBrowserPermissionBlockedError,
  LocalBrowserNotFoundError,
} from './local-browser-discovery.js';
export type {
  LocalBrowserProfileEntry,
  LocalBrowserCandidateStatus,
  LocalBrowserCandidateResult,
  CandidateProfileDirsOptions,
  ProbeLocalBrowserCandidateOptions,
  DiscoverLocalBrowserOptions,
  LocalBrowserDiscoveryResult,
} from './local-browser-discovery.js';

export {
  chromeProcsForDataDir,
  chromeProcsForDataDirAsync,
  classifyChromeProcess,
  filterForDataDir,
  invalidateProcessTableSnapshot,
  lastProcessTableScanError,
  listAllChromeFamilyProcesses,
  listAllChromeFamilyProcessesAsync,
  pidAlive,
  PROCESS_TABLE_SNAPSHOT_TTL_MS,
  readSingletonLockPid,
  SINGLETON_LOCK_FILES,
} from './process-table.js';
export type { ChromeProcessInfo, ProcessClassification } from './process-table.js';

export {
  StateFileStore,
  loadStateFile,
  writeStateFileAtomic,
  quarantineCorruptStateFile,
} from './state-file.js';
export type { StateFileContents, StateFileEntry, LoadedStateFile } from './state-file.js';

export { BrowserSupervisor, StderrRingBuffer } from './supervisor.js';
export type { BrowserSupervisorOptions } from './supervisor.js';

export { reconcileOnStartup, listAllProfileDirs, reapAbandonedProfileDirs } from './reconcile.js';
export type {
  ReconcileDeps,
  ReconcileDecision,
  ReconcileEntryOutcome,
  ReconcileReport,
  ReapAbandonedProfileDirsDeps,
  ReapAbandonedProfileDirsReport,
  ReapedDirRefusal,
  ReapedDirFailure,
} from './reconcile.js';

export { terminateBrowser, PROFILE_CLEAR_BUDGET_MS } from './terminate.js';
export type { TerminateOptions } from './terminate.js';

export {
  createProfileFs,
  CopyTooSlowError,
  ProfileRootTooLongError,
  ProfileStillLiveError,
  ProfileTrashFailedError,
} from './profile-fs.js';
export type { ProfileFsOptions } from './profile-fs.js';

export { probeCowCapability } from './cow-probe.js';
export { probeProfileCorruption } from './corruption-probe.js';

export { getBootId } from './boot-id.js';

export { sendBrowserClose } from './cdp-close.js';

/** Package identity constant, kept for anything that still probes for it. */
export const PACKAGE_NAME = '@browserglass/runtime-host';
