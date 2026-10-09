/**
 * Startup reattach, all ten steps, every one idempotent (the node can crash mid reconciliation and
 * must be able to re-run it from scratch). `survivesNodeRestart: true`
 * exists because of this algorithm.
 */

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getBootId } from './boot-id.js';
import { probeCdpIdentity } from './identity-probe.js';
import {
  chromeProcsForDataDirAsync,
  classifyChromeProcess,
  filterForDataDir,
  listAllChromeFamilyProcessesAsync,
  pidAlive,
} from './process-table.js';
import { killProcessTree } from './spawn.js';
import { type StateFileEntry, StateFileStore, loadStateFile } from './state-file.js';

/** Step 6's router round trip: what should happen to a browser this node still holds a live, matching entry for. */
export type ReconcileDecision = 'adopt' | 'terminate' | 'unknown';

/** Dependencies {@link reconcileOnStartup} needs. */
export interface ReconcileDeps {
  stateDir: string;
  nodeId: string;
  /** Every directory this node knows might hold a profile, for step 9's orphan scan. Optional: omitted in a build with no profile root configured yet. */
  profileDirsToScan?: readonly string[];
  fetchImpl?: typeof fetch;
  /**
   * Step 6: asks the router whether an adoption candidate is still
   * current. Defaults to always `'adopt'`, correct for the embedded,
   * single-node build, where the in-process router (`LocalNode`) has no separate process to have forgotten anything
   * across; a networked deployment supplies a real round trip here.
   */
  askRouter?: (entry: StateFileEntry) => Promise<ReconcileDecision>;
  perRequestTimeoutMs?: number;
}

/** One state file entry's outcome. */
export interface ReconcileEntryOutcome {
  instanceId: string;
  outcome:
    | 'adopted'
    | 'terminated-router-said-so'
    | 'terminated-unknown-to-router'
    | 'cleanup-hung-killed'
    | 'cleanup-already-dead';
}

/** What one call to {@link reconcileOnStartup} did, matching the single `node.reconciled` report step 10 emits. */
export interface ReconcileReport {
  adoptedCount: number;
  terminatedCount: number;
  orphansReaped: number;
  orphansRefused: number;
  durationMs: number;
  entries: ReconcileEntryOutcome[];
}

async function checkCdpLiveness(
  cdpUrl: string,
  browserGuid: string,
  fetchImpl: typeof fetch | undefined,
  perRequestTimeoutMs: number,
): Promise<boolean> {
  try {
    await probeCdpIdentity({
      cdpUrl,
      mode: 'adopt',
      expectBrowserGuid: browserGuid,
      overallTimeoutMs: perRequestTimeoutMs,
      perRequestTimeoutMs,
      ...(fetchImpl !== undefined ? { fetchImpl } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

async function commandLineHasDataDir(profilePath: string, pid: number): Promise<boolean> {
  const found = await chromeProcsForDataDirAsync(profilePath);
  return found.some((p) => p.pid === pid);
}

/**
 * Runs the full ten-step startup reattach algorithm and returns the opened
 * (and, if needed, already rewritten) {@link StateFileStore} alongside the
 * report. Safe to call once at process startup; every step tolerates a
 * prior partial run.
 */
export async function reconcileOnStartup(
  deps: ReconcileDeps,
): Promise<{ store: StateFileStore; report: ReconcileReport }> {
  const start = performance.now();
  const askRouter = deps.askRouter ?? (async () => 'adopt' as const);
  const perRequestTimeoutMs = deps.perRequestTimeoutMs ?? 2000;

  // Step 1: read the state file, before StateFileStore.open() (below)
  // stamps this process's own current boot id onto it as the new writer.
  // The RAW on-disk writerBootId, read here, is what step 2 needs to
  // compare; reading it only after `open()` would always see a match,
  // since `open()`'s whole job is to make this process the current
  // writer. `StateFileStore.open` still quarantines a corrupt file and
  // falls back to an empty list.
  const path = join(deps.stateDir, 'runtime-host.json');
  const rawLoad = loadStateFile(path, deps.nodeId);
  const rawWriterBootId = rawLoad.status === 'ok' ? rawLoad.contents.writerBootId : null;

  const { store, loadStatus } = StateFileStore.open(deps.stateDir, deps.nodeId);
  const entries = loadStatus === 'ok' ? [...store.list()] : [];

  // Step 2: compare writerBootId to the current boot id. A mismatch means
  // discard everything unconditionally: pids are reused across a reboot.
  const currentBootId = getBootId();
  const bootMismatch = rawWriterBootId !== null && rawWriterBootId !== currentBootId;
  const candidateEntries = bootMismatch ? [] : entries;

  // Step 3 (writerPid vs current pid) is informational only; it does not
  // change behaviour here, so it is not separately branched.

  const outcomes: ReconcileEntryOutcome[] = [];
  const adopted: StateFileEntry[] = [];

  for (const entry of candidateEntries) {
    // Step 4: three widening liveness checks, stop at first failure.
    const pidExists = pidAlive(entry.pid);
    const cmdlineMatches = pidExists && (await commandLineHasDataDir(entry.profilePath, entry.pid));
    const cdpAnswers =
      cmdlineMatches &&
      (await checkCdpLiveness(
        entry.cdpUrl,
        entry.browserGuid,
        deps.fetchImpl,
        perRequestTimeoutMs,
      ));

    if (pidExists && cmdlineMatches && cdpAnswers) {
      // Step 5 pass, step 6: ask the router.
      const decision = await askRouter(entry);
      if (decision === 'adopt') {
        adopted.push(entry);
        outcomes.push({ instanceId: entry.instanceId, outcome: 'adopted' });
      } else {
        await killProcessTree(entry.pid, 'SIGTERM');
        outcomes.push({
          instanceId: entry.instanceId,
          outcome:
            decision === 'terminate' ? 'terminated-router-said-so' : 'terminated-unknown-to-router',
        });
      }
      continue;
    }

    // Step 7: cleanup candidate. `pidExists && cmdlineMatches && !cdpAnswers`
    // is the hung-Chrome case (kill it); anything else is already dead.
    if (pidExists && cmdlineMatches) {
      await killProcessTree(entry.pid, 'SIGTERM');
      outcomes.push({ instanceId: entry.instanceId, outcome: 'cleanup-hung-killed' });
    } else {
      outcomes.push({ instanceId: entry.instanceId, outcome: 'cleanup-already-dead' });
    }
  }

  // Step 8: rewrite the state file with the adopted entries only.
  if (bootMismatch || outcomes.length > 0) {
    store.replaceAll(adopted);
  }

  // Step 9: the orphan scan, across every profile directory the caller
  // knows about. Only directories with no adopted entry are scanned, so a
  // browser this pass just adopted is never re-flagged as an orphan of
  // itself.
  let orphansReaped = 0;
  let orphansRefused = 0;
  const adoptedProfilePaths = new Set(adopted.map((e) => e.profilePath));
  // ONE scan for every profile directory, not one scan per directory.
  // This loop used to call `chromeProcsForDataDir(dir)` per entry, and
  // each of those spawned its own PowerShell and stopped the event loop
  // for the length of it. On a checkout carrying 54 profile directories
  // that was 54 child processes and, measured, over a minute of blocked
  // startup, with any single one of them exceeding its timeout being
  // enough to abort the gateway's boot outright. The process table does
  // not change per directory, so it is read once and asked 54 questions.
  const dirsToScan = (deps.profileDirsToScan ?? []).filter(
    (dir) => !adoptedProfilePaths.has(dir) && existsSync(dir),
  );
  const tableSnapshot =
    dirsToScan.length > 0 ? await listAllChromeFamilyProcessesAsync({ maxAgeMs: 0 }) : [];
  for (const dir of dirsToScan) {
    const procs = filterForDataDir(tableSnapshot, dir);
    for (const proc of procs) {
      const classification = classifyChromeProcess(proc, { currentlyLaunchingPids: new Set() });
      if (classification === 'foreign') {
        orphansRefused += 1;
        continue;
      }
      if (classification === 'orphan') {
        await killProcessTree(proc.pid, 'SIGTERM');
        orphansReaped += 1;
      }
    }
  }

  const report: ReconcileReport = {
    adoptedCount: outcomes.filter((o) => o.outcome === 'adopted').length,
    terminatedCount: outcomes.filter((o) => o.outcome.startsWith('terminated')).length,
    orphansReaped,
    orphansRefused,
    durationMs: performance.now() - start,
    entries: outcomes,
  };

  return { store, report };
}

/**
 * Lists every directory under `profileRoot` that a Chrome could have been
 * launched against, for {@link ReconcileDeps.profileDirsToScan}.
 *
 * Returns `tenants/<t>/profiles/<p>/udd`, NOT `tenants/<t>/profiles/<p>`.
 * That trailing `udd` segment is the whole point. `ProfileFs.materialise`
 * returns `join(destDir, 'udd')` as `MaterialisedProfile.path`
 * (`profile-fs.ts`, which fixed exactly this off-by-one-level
 * mistake for Chrome's own `--user-data-dir`), so every real Chrome carries
 * `--user-data-dir=<...>/profiles/<p>/udd`. This function was left pointing
 * at the profile's parent directory, and `containsDataDirArg`
 * (`process-table.ts`) compares the two paths for exact equality, so the
 * startup orphan scan compared `.../profiles/<p>` against
 * `.../profiles/<p>/udd`, never matched, and reaped nothing. It was
 * verified against a real stranded Chrome: hard killing the demo server
 * left a browser whose parent was dead (so it classified as a reapable
 * orphan, not a foreign one) and a server restart walked straight past it.
 *
 * The profile directory itself is returned as well. Nothing writes that
 * layout today, but a Chrome launched before that fix landed would carry it,
 * and a scan that is cheap and wrong in one direction only should err
 * toward looking in both places.
 */
export function listAllProfileDirs(profileRoot: string): string[] {
  const tenantsDir = join(profileRoot, 'tenants');
  if (!existsSync(tenantsDir)) return [];
  const dirs: string[] = [];
  for (const tenantId of readdirSync(tenantsDir)) {
    const profilesDir = join(tenantsDir, tenantId, 'profiles');
    if (!existsSync(profilesDir)) continue;
    for (const profileId of readdirSync(profilesDir)) {
      const profileDir = join(profilesDir, profileId);
      dirs.push(join(profileDir, 'udd'));
      dirs.push(profileDir);
    }
  }
  return dirs;
}

// ── bounded garbage reaper (accumulated `tenants/<t>/profiles/<p>` litter) ──

/** One `tenants/<t>/profiles/<p>` directory {@link reapAbandonedProfileDirs} found, before any age or liveness check has run against it. */
interface ProfileDirCandidate {
  readonly tenantId: string;
  readonly profileId: string;
  /** `tenants/<t>/profiles/<p>`, the directory this sweep may remove whole. */
  readonly dir: string;
  /** `tenants/<t>/profiles/<p>/udd`, the exact path a live Chrome's `--user-data-dir` would name (see {@link listAllProfileDirs}'s own comment on why the trailing segment matters). */
  readonly uddDir: string;
}

/** Every `tenants/<t>/profiles/<p>` directory under `profileRoot`, structured rather than flattened the way {@link listAllProfileDirs} is, since this sweep needs the tenant and profile id back out separately for its ownership check and its log lines. */
function listProfileDirCandidates(profileRoot: string): ProfileDirCandidate[] {
  const tenantsDir = join(profileRoot, 'tenants');
  if (!existsSync(tenantsDir)) return [];
  const out: ProfileDirCandidate[] = [];
  for (const tenantId of readdirSync(tenantsDir)) {
    const profilesDir = join(tenantsDir, tenantId, 'profiles');
    if (!existsSync(profilesDir)) continue;
    for (const profileId of readdirSync(profilesDir)) {
      const dir = join(profilesDir, profileId);
      out.push({ tenantId, profileId, dir, uddDir: join(dir, 'udd') });
    }
  }
  return out;
}

/** Dependencies {@link reapAbandonedProfileDirs} needs. */
export interface ReapAbandonedProfileDirsDeps {
  readonly profileRoot: string;
  /**
   * Every `profileId` this sweep must never touch: the store has a
   * `Profile` row for it and that row is NOT in `'deleting'`/`'deleted'`
   * state. This package has no `Store` handle (the router decides, the
   * runtime does), so the caller computes this set once per sweep,
   * the same split `ProfileService.reconcileMissingDirs`'s own doc comment
   * already calls for: a filesystem-only view
   * cannot tell an orphan from a profile mid materialise, only the
   * DB-holding side can.
   *
   * Every directory whose id is ABSENT from this set is a candidate for
   * one of two reasons, and this function does not need to tell them
   * apart because both mean the same thing on disk: either no row ever
   * existed for it (a stray directory), or the store's own row already
   * says the bytes should be gone (`applyReleaseAction` ran, set the
   * profile to `'deleting'`, and the directory was never actually
   * reclaimed: the historical defect `packages/router/src/profiles/adapter.ts`'s
   * `applyReleaseAction` comment describes, where a missing `tenantId`
   * left 51 of 54 real profile directories full rather than emptied).
   */
  readonly protectedProfileIds: ReadonlySet<string>;
  /**
   * A directory younger than this is never a candidate, whatever
   * `protectedProfileIds` says. Default 15 minutes, matching
   * `DEFAULT_PROFILE_SERVICE_CONFIG.trashRetentionMsByKind.ephemeral`
   * (`../router`'s own floor for how long a released profile's bytes are
   * kept before anything unlinks them): a fresh acquire creates its row
   * before `ProfileFs.materialise()` ever renames a directory into place
   * (`ProfileService.acquireFresh`/`acquirePersistent`, both call
   * `createProfileRow` first), so an unprotected directory younger than
   * this age gate is never a real race with an in-flight launch, only a
   * belt-and-braces margin against clock skew and a slow caller-side
   * store read.
   */
  readonly minAgeMs?: number;
  /**
   * The most directories one call removes. Bounds a single sweep tick to
   * a fixed amount of `rmSync` work, the same reasoning
   * `PROFILE_SWEEP_MAX_PASSES`/`sweeperBatchLimit` apply to the trash
   * sweep (`packages/server/src/lifecycle/wiring.ts`'s
   * `runProfileMaintenance`): a large backlog is worked off over several
   * ticks rather than blocking one of them for its whole length. Default
   * 50.
   */
  readonly maxRemovals?: number;
}

/** One directory this sweep declined to remove, and why. */
export interface ReapedDirRefusal {
  readonly tenantId: string;
  readonly profileId: string;
  readonly dir: string;
  readonly pid: number;
}

/** One directory this sweep tried to remove and could not. */
export interface ReapedDirFailure {
  readonly tenantId: string;
  readonly profileId: string;
  readonly dir: string;
  readonly error: string;
}

/** What one call to {@link reapAbandonedProfileDirs} did. */
export interface ReapAbandonedProfileDirsReport {
  /** Every `tenants/<t>/profiles/<p>` directory this sweep found, before any filter. */
  readonly scanned: number;
  /** How many of those passed the ownership and age filters and were considered for removal. */
  readonly candidates: number;
  /** Directories actually unlinked this pass, oldest evidence first. */
  readonly removed: readonly {
    readonly tenantId: string;
    readonly profileId: string;
    readonly dir: string;
  }[];
  /**
   * Candidates a live Chrome still holds, per an exact `--user-data-dir`
   * match against ONE process table snapshot (never removed, whatever
   * `protectedProfileIds` says the store believes; see this function's own
   * comment on why the snapshot is taken once for every candidate rather
   * than once per directory).
   */
  readonly refusedLive: readonly ReapedDirRefusal[];
  /** Candidates skipped only for being younger than `minAgeMs`; not otherwise evaluated. */
  readonly skippedTooRecent: number;
  /** Candidates this sweep tried to remove and could not (a locked file, a permissions error); the directory is left intact. */
  readonly failed: readonly ReapedDirFailure[];
  readonly durationMs: number;
}

/**
 * The bounded reaper for the garbage that accumulates once
 * `applyReleaseAction` has run: profile directories no live row protects
 * any more, per {@link ReapAbandonedProfileDirsDeps.protectedProfileIds}.
 *
 * Two safety properties, both non negotiable, both mirroring
 * `ProfileFs.trash()`'s own established contract (`profile-fs.ts`) rather
 * than inventing a second standard for the same class of danger:
 *
 * 1. NEVER removes a directory a live Chrome still holds. Checked with
 *    `chromeProcsForDataDirAsync`'s exact `--user-data-dir` match (never
 *    the sync variant on this path, and never one scan per directory: this
 *    function takes exactly one `listAllChromeFamilyProcessesAsync`
 *    snapshot for however many candidates survive the ownership and age
 *    filters, then asks `filterForDataDir` that one snapshot once per
 *    directory, the same pattern {@link reconcileOnStartup}'s step 9 uses
 *    and for the same measured reason: one WMI query, not N of them).
 * 2. NEVER removes anything outside `profileRoot`. Every path this
 *    function touches is built from `join(profileRoot, 'tenants', ...)`
 *    against directory names `readdirSync` itself returned; nothing here
 *    accepts a caller-supplied path.
 *
 * Deliberately does not attempt `ProfileFs.trash()`'s rename-into-`trash/`
 * ladder: that ladder exists so an operator can recover a directory
 * destroyed by MISTAKE within its retention window, and every candidate
 * this function ever sees has already failed that safety net once, since
 * `protectedProfileIds` only excludes it after the disk side of a normal
 * release should already have run. A second rename-then-wait step here
 * would only delay reclaiming bytes a store row already disowns. `rmSync`
 * is given the same generous Windows retry budget `ProfileFs.trash()`'s
 * own in place delete fallback uses, for the same measured reason (a
 * loaded Windows machine can hold Chrome's own file handles open for over
 * half a second after the process itself has exited).
 */
export async function reapAbandonedProfileDirs(
  deps: ReapAbandonedProfileDirsDeps,
): Promise<ReapAbandonedProfileDirsReport> {
  const start = performance.now();
  const minAgeMs = deps.minAgeMs ?? 15 * 60_000;
  const maxRemovals = deps.maxRemovals ?? 50;
  const now = Date.now();

  const all = listProfileDirCandidates(deps.profileRoot);
  let skippedTooRecent = 0;
  const candidates: ProfileDirCandidate[] = [];
  for (const entry of all) {
    if (deps.protectedProfileIds.has(entry.profileId)) continue;
    let mtimeMs: number;
    try {
      mtimeMs = statSync(entry.dir).mtimeMs;
    } catch {
      continue; // vanished between the listing and here; nothing left to reap
    }
    // Clamped to 0: on Windows a directory's mtime, sampled by statSync,
    // can land microseconds after the `now` sampled just above (different
    // clock sources, different rounding), so `now - mtimeMs` can go
    // slightly negative for a directory created this instant. Without the
    // clamp that negative "age" trips `< minAgeMs` even when `minAgeMs`
    // is 0, which this suite (and any caller) uses to mean "no age gate".
    const ageMs = Math.max(0, now - mtimeMs);
    if (ageMs < minAgeMs) {
      skippedTooRecent += 1;
      continue;
    }
    candidates.push(entry);
  }

  const removed: { tenantId: string; profileId: string; dir: string }[] = [];
  const refusedLive: ReapedDirRefusal[] = [];
  const failed: ReapedDirFailure[] = [];

  // ONE snapshot for every candidate. See this function's own comment.
  const snapshot =
    candidates.length > 0 ? await listAllChromeFamilyProcessesAsync({ maxAgeMs: 0 }) : [];

  for (const entry of candidates) {
    if (removed.length >= maxRemovals) break;
    const owners = filterForDataDir(snapshot, entry.uddDir);
    const owner = owners[0];
    if (owner !== undefined) {
      refusedLive.push({
        tenantId: entry.tenantId,
        profileId: entry.profileId,
        dir: entry.dir,
        pid: owner.pid,
      });
      continue;
    }
    try {
      // Budget matches `ProfileFs.trash()`'s own in place delete fallback
      // (`profile-fs.ts`): `maxRetries: 20, retryDelay: 200`, about 4
      // seconds, for the same Windows handle-lag reason documented there.
      rmSync(entry.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
      removed.push({ tenantId: entry.tenantId, profileId: entry.profileId, dir: entry.dir });
    } catch (err) {
      failed.push({
        tenantId: entry.tenantId,
        profileId: entry.profileId,
        dir: entry.dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    scanned: all.length,
    candidates: candidates.length,
    removed,
    refusedLive,
    skippedTooRecent,
    failed,
    durationMs: performance.now() - start,
  };
}
