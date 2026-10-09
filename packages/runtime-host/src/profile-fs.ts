/**
 * The `ProfileFs` implementation: the on-disk layout, copy on write, the
 * sweeper, and the corruption probe. This is the only
 * module in this build permitted to touch a profile directory's bytes;
 * `@browserglass/router`'s `ProfileService` holds one of these by
 * injection and decides what should happen. The router decides, the
 * runtime does.
 */

import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type {
  CowKind,
  Materialisation,
  ProbeResult,
  ProfileFs,
  SweeperConfig,
  TrashKind,
} from '@browserglass/protocol';
import { MAX_INLINE_COPY_BYTES, WINDOWS_MAX_PROFILE_ROOT_CHARS } from './config.js';
import { probeProfileCorruption } from './corruption-probe.js';
import { probeCowCapability } from './cow-probe.js';
import {
  SINGLETON_LOCK_FILES,
  chromeProcsForDataDirAsync,
  pidAlive,
  readSingletonLockPid,
} from './process-table.js';
import { healProfile } from './profile-heal.js';

/** Thrown by `materialise()` when a non copy-on-write clone would exceed `maxInlineCopyBytes` and the caller did not opt into a slow copy. */
export class CopyTooSlowError extends Error {
  readonly code = 'E_COPY_TOO_SLOW';
  readonly estimatedMs: number;
  constructor(sizeBytes: number, estimatedMs: number) {
    super(
      `template is ${sizeBytes} bytes with no copy-on-write support; estimated ${estimatedMs}ms, above maxInlineCopyBytes without allowSlowCopy`,
    );
    this.name = 'CopyTooSlowError';
    this.estimatedMs = estimatedMs;
  }
}

/**
 * Thrown by `trash()` when neither the rename nor the in place recursive
 * delete could reclaim a profile directory. Carries the path, the intended
 * trash destination and the underlying filesystem error so the caller can
 * log something an operator can act on, rather than the bare "EPERM" that
 * a swallowed rejection used to produce (see `trash()`'s own comment on
 * why this must never be silent).
 */
export class ProfileTrashFailedError extends Error {
  readonly code = 'E_PROFILE_TRASH_FAILED';
  readonly path: string;
  readonly dest: string;
  readonly attempts: number;
  constructor(path: string, dest: string, attempts: number, cause: unknown) {
    super(
      `could not reclaim profile directory ${JSON.stringify(path)} after ${attempts} rename attempts and an in place delete: ${String((cause as { message?: string })?.message ?? cause)}`,
    );
    this.name = 'ProfileTrashFailedError';
    this.path = path;
    this.dest = dest;
    this.attempts = attempts;
    this.cause = cause;
  }
}

/**
 * Thrown by `trash()` when a live Chrome browser-main process still owns
 * the data directory it was asked to reclaim. Deliberately distinct from
 * {@link ProfileTrashFailedError}: this one means "do not retry, and above
 * all do not delete", because deleting a profile directory out from under a
 * running Chrome corrupts its LevelDB stores and loses the user's session.
 * The caller's terminate ladder failed to actually kill the browser, and
 * that, not the filesystem, is what needs attention.
 */
export class ProfileStillLiveError extends Error {
  readonly code = 'E_PROFILE_STILL_LIVE';
  readonly path: string;
  readonly pid: number;
  constructor(path: string, pid: number) {
    super(
      `refusing to reclaim profile directory ${JSON.stringify(path)}: Chrome pid ${pid} still holds it`,
    );
    this.name = 'ProfileStillLiveError';
    this.path = path;
    this.pid = pid;
  }
}

/**
 * `trash()`'s rename retry schedule, in milliseconds between attempts.
 *
 * On Windows a directory cannot be renamed while any process holds an open
 * handle to a file inside it, and Chrome's renderer, GPU and network
 * service children keep their handles under `--user-data-dir` open for a
 * short window AFTER the browser-main process has already exited. The
 * terminate ladder (`terminate.ts`) polls only the browser-main pid, so
 * `release()` can reach this rename while a child is still on its way out,
 * and the single unretried `renameSync` this function used to perform lost
 * that race with a bare `EPERM`. Measured directly on Windows 11 with real
 * Chrome: the losing rename fails within a millisecond, and a retry wins
 * once the last child handle closes, which is normally well under a
 * second. POSIX never hits this at all (an unlinked but open file is
 * fine), which is why a Linux CI run would never have caught it.
 *
 * The schedule totals about 3.6 seconds across 8 attempts, deliberately
 * front loaded so the overwhelmingly common case (the second attempt wins)
 * costs 25 ms rather than a fixed sleep.
 */
const TRASH_RENAME_RETRY_DELAYS_MS: readonly number[] = [25, 50, 100, 200, 400, 800, 1000, 1000];

/** Errno codes that mean "something still holds this path", the only ones {@link TRASH_RENAME_RETRY_DELAYS_MS} is worth spending on. Anything else (a bad path, a cross device move, a permissions misconfiguration) will not improve by waiting. */
const TRASH_RETRYABLE_CODES: ReadonlySet<string> = new Set([
  'EPERM',
  'EACCES',
  'EBUSY',
  'ENOTEMPTY',
]);

/**
 * The trash kinds `trash()` may reclaim with an in place recursive delete
 * once the rename ladder is exhausted.
 *
 * Deliberately not all four. For `'ephemeral'` and `'deleted'` the caller
 * has already decided the bytes are to go, and their retention windows (15
 * minutes and 7 days) are a safety net rather than a promise, so removing
 * them a few days early is a smaller harm than a directory that never goes
 * away. `'quarantine'` and `'migration'` are the opposite: a quarantined
 * profile is kept for 30 days precisely so a human can look at what
 * corrupted it, and a migration directory is one half of a move still in
 * flight. Destroying either to tidy up a failed rename would delete the
 * very thing the retention exists to preserve, so those throw instead and
 * leave the directory for a later sweep.
 */
const TRASH_KINDS_SAFE_TO_DELETE_IN_PLACE: ReadonlySet<TrashKind> = new Set<TrashKind>([
  'ephemeral',
  'deleted',
]);

/** Thrown when a profile root's path would exceed Windows' practical `MAX_PATH` budget once Chrome's own deep paths are appended. */
export class ProfileRootTooLongError extends Error {
  readonly code = 'E_PROFILE_ROOT_TOO_LONG';
  constructor(path: string) {
    super(
      `profile root ${JSON.stringify(path)} is ${path.length} characters, above the ${WINDOWS_MAX_PROFILE_ROOT_CHARS} character Windows limit`,
    );
    this.name = 'ProfileRootTooLongError';
  }
}

interface RootMarker {
  schema: 'bgls.profile-root/1';
  cow: CowKind;
  fsType: string;
  probedAt: number;
}

/** `.bgls-size.json`'s schema. */
interface SizeMarker {
  schema: 'bgls.profile-size/1';
  sizeBytes: number;
  fileCount: number;
  measuredAt: number;
}

function tenantsDir(root: string): string {
  return join(root, 'tenants');
}

function profileDir(root: string, tenantId: string, profileId: string): string {
  return join(tenantsDir(root), tenantId, 'profiles', profileId);
}

function tenantTrashDir(root: string, tenantId: string): string {
  return join(tenantsDir(root), tenantId, 'trash');
}

function tmpOpDir(root: string, opId: string): string {
  return join(root, 'tmp', opId);
}

function errnoCodeOf(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === 'string' ? code : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Removes the profile directory a trashed user data directory lived in,
 * once that directory is empty.
 *
 * `materialise()` returns `tenants/<t>/profiles/<p>/udd` as the profile's
 * path (see its own comment), so every caller of
 * `trash()`, without exception, hands us the `udd` CHILD rather than the
 * `prf_...` directory itself. Renaming that child into `trash/` therefore
 * reclaimed the bytes but always left `tenants/<t>/profiles/<p>/` behind as
 * an empty shell that nothing else in this build ever removes: the
 * sweeper only walks `trash/`, and `reconcile()` only walks `tmp/`. Fifty
 * released instances on one developer machine meant fifty empty profile
 * directories, which is exactly what "the profile directory is not
 * destroyed" looked like from the outside even on the releases where the
 * rename itself had succeeded.
 *
 * Deliberately narrow, because this deletes a directory the caller did not
 * name: it fires only when the parent sits directly under a `profiles`
 * directory (so this really is `tenants/<t>/profiles/<p>`, not some other
 * caller's tree) and only when that parent is genuinely empty, so a future
 * sibling of `udd` (a snapshot staging directory, say) is never destroyed
 * as a side effect. Failure is ignored: an empty directory left behind is
 * untidy, never incorrect, and must not turn a successful reclaim into a
 * failed one.
 */
function removeEmptyProfileDir(trashedPath: string): void {
  try {
    const parent = dirname(trashedPath);
    if (basename(dirname(parent)) !== 'profiles') return;
    if (readdirSync(parent).length > 0) return;
    rmdirSync(parent);
  } catch {
    // Best effort. See this function's own doc comment.
  }
}

/** Recursively copies `src` into `dst`, preferring a reflink/clonefile per file when `cow !== 'none'`, falling back to a byte copy otherwise. */
function copyTree(src: string, dst: string, cow: CowKind): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const from = join(src, entry.name);
    const to = join(dst, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to, cow);
    } else if (entry.isSymbolicLink()) {
      // Chrome profiles do not rely on symlinks in practice; skip rather
      // than risk copying a link target outside the profile tree.
    } else {
      if (cow !== 'none') {
        try {
          copyFileSync(from, to, constants.COPYFILE_FICLONE_FORCE);
          continue;
        } catch {
          // Fall through to a plain copy for this one file.
        }
      }
      copyFileSync(from, to);
    }
  }
}

function treeSize(dir: string): { sizeBytes: number; fileCount: number } {
  let sizeBytes = 0;
  let fileCount = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        try {
          sizeBytes += statSync(full).size;
        } catch {
          // Vanished between readdir and stat; not counted.
        }
      }
    }
  }
  return { sizeBytes, fileCount };
}

/** Options {@link createProfileFs} needs beyond `ProfileFs`'s own per-call arguments. */
export interface ProfileFsOptions {
  root: string;
}

/**
 * Builds the `ProfileFs` implementation rooted at `opts.root`. Every method
 * operates only under `opts.root`; nothing outside `tenants/<tenantId>/`
 * is reachable from a profile key, and the caller-supplied `key` never
 * appears as a path component, only the DB-generated `profileId` does.
 */
export function createProfileFs(opts: ProfileFsOptions): ProfileFs {
  const root = opts.root;
  const rootMarkerPath = join(root, '.bgls-root.json');

  function ensureRootLayout(): void {
    mkdirSync(tenantsDir(root), { recursive: true });
    mkdirSync(join(root, 'tmp'), { recursive: true });
  }

  function loadOrProbeCapabilities(): RootMarker {
    if (existsSync(rootMarkerPath)) {
      try {
        const parsed = JSON.parse(readFileSync(rootMarkerPath, 'utf8')) as RootMarker;
        if (parsed.schema === 'bgls.profile-root/1' && typeof parsed.cow === 'string')
          return parsed;
      } catch {
        // Corrupt marker; re-probe below.
      }
    }
    ensureRootLayout();
    const cow = probeCowCapability(root);
    const marker: RootMarker = {
      schema: 'bgls.profile-root/1',
      cow,
      fsType: process.platform,
      probedAt: Date.now(),
    };
    writeFileSync(rootMarkerPath, JSON.stringify(marker, null, 2));
    return marker;
  }

  return {
    async capabilities() {
      const marker = loadOrProbeCapabilities();
      return { cow: marker.cow, fsType: marker.fsType, root };
    },

    async materialise(req) {
      ensureRootLayout();
      const marker = loadOrProbeCapabilities();
      const destDir = profileDir(root, req.tenantId, req.profileId);
      if (destDir.length > WINDOWS_MAX_PROFILE_ROOT_CHARS && process.platform === 'win32') {
        throw new ProfileRootTooLongError(destDir);
      }

      const opDir = tmpOpDir(root, req.opId);
      const stagingUdd = join(opDir, 'udd');
      mkdirSync(opDir, { recursive: true });

      const start = performance.now();
      let materialisation: Materialisation;

      if (req.from.kind === 'empty') {
        mkdirSync(stagingUdd, { recursive: true });
        materialisation = 'empty';
      } else if (req.from.kind === 'template') {
        const templateSize = existsSync(req.from.templateDir)
          ? treeSize(req.from.templateDir).sizeBytes
          : 0;
        if (marker.cow === 'none' && templateSize > MAX_INLINE_COPY_BYTES && !req.allowSlowCopy) {
          rmSync(opDir, { recursive: true, force: true });
          // Recursive copy of a large template with no COW support is slow
          // enough (measured at 6 to 90+ seconds depending on
          // platform and AV interference) that the acquire path refuses by
          // default rather than stalling silently.
          const estimatedMs = Math.round((templateSize / (30 * 1024 * 1024)) * 1000); // ~30 MB/s conservative recursive-copy estimate.
          throw new CopyTooSlowError(templateSize, estimatedMs);
        }
        copyTree(req.from.templateDir, stagingUdd, marker.cow);
        materialisation = 'template-clone';
      } else {
        // 'restore' (from a snapshot bundle) and 'import' (from an
        // external bundle) are not implemented yet: bundle import/export
        // is its own substantial format. Fail loudly rather than silently
        // producing an empty profile under a "restored" label.
        rmSync(opDir, { recursive: true, force: true });
        throw new Error(`ProfileFs.materialise: '${req.from.kind}' is not implemented yet`);
      }

      // The rename target's parent (tenants/<t>/profiles/) must exist,
      // but the destination leaf itself must not: rename() creates that,
      // and assembly must stay entirely outside the destination until
      // this one atomic move lands it.
      mkdirSync(join(tenantsDir(root), req.tenantId, 'profiles'), { recursive: true });
      renameSync(opDir, destDir);
      // `renameSync(opDir, destDir)` moved the whole `tmp/<opId>/` (which
      // contains `udd/`) directly to `destDir`, so `destDir/udd` now holds
      // the materialised profile. This keeps assembly entirely outside
      // the destination until one atomic rename lands it.

      const materialiseMs = performance.now() - start;
      const uddDir = join(destDir, 'udd');
      const { sizeBytes } = treeSize(destDir);
      // `destDir` is the profile's own directory; `renameSync` above moved
      // the whole staged `tmp/<opId>/` (which contains `udd/`) directly to
      // `destDir`, so the materialised profile itself lives one level
      // deeper, at `destDir/udd`. Returning `destDir` here (rather than
      // `destDir/udd`) pointed every caller (the fence write, and
      // eventually Chrome's own `--user-data-dir`) at the profile's parent
      // directory instead of its real contents.
      return { path: uddDir, materialisation, materialiseMs, sizeBytes };
    },

    async writeFence(path, fence) {
      const fencePath = join(path, '.bgls-fence');
      const content = `${fence}\n`;
      // O_TRUNC (the default 'w' flag) plus an explicit fsync via the
      // synchronous write, then a read-back to confirm the bytes actually
      // landed before the caller launches Chrome against this fence.
      writeFileSync(fencePath, content, { flag: 'w' });
      const readBack = readFileSync(fencePath, 'utf8');
      if (readBack.trim() !== String(fence)) {
        throw new Error(
          `writeFence read-back mismatch for ${fencePath}: wrote ${fence}, read ${JSON.stringify(readBack)}`,
        );
      }
    },

    async readFence(path) {
      const fencePath = join(path, '.bgls-fence');
      if (!existsSync(fencePath)) return null;
      const raw = readFileSync(fencePath, 'utf8').trim();
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    },

    async probe(path): Promise<ProbeResult> {
      return probeProfileCorruption(path);
    },

    /**
     * Clears one profile's claim so another process may open it.
     *
     * WHAT CHANGED ON WINDOWS, AND WHY IT IS NOT A NO-OP ANY MORE. The
     * earlier observation stands: Windows Chrome claims a profile with a named
     * mutex and a message window, leaves no `SingletonLock`,
     * `SingletonSocket` or `SingletonCookie` behind, and so there is
     * genuinely nothing to unlink there. The old implementation drew the
     * conclusion that there was therefore nothing to DO, returned
     * `{ cleared: [], refusedLivePid: null }`, and that was the bug: the
     * lock files are not the only thing a killed Chrome leaves in a
     * profile, they are only the part that happens to be POSIX specific.
     *
     * The part that is not POSIX specific is `Default/Preferences` saying
     * `exit_type: "Crashed"`. On Windows this runtime's terminate ladder
     * ALWAYS produces that, because `'graceful'` collapses to
     * `taskkill /T /F` there (`terminate.ts`, no softer signal exists for
     * a GUI process tree). Under an ephemeral profile it never mattered,
     * since the directory is trashed before anything reads it again. This
     * method's one live caller is `ProfileService`'s lease STEAL path, and
     * a steal is by definition a profile that is about to be handed to
     * somebody else and opened again.
     *
     * So on both platforms this now runs the same repair the launch path
     * runs (`profile-heal.ts`), which unlinks the lock files where they
     * exist and rewrites the crash marker where it does. `cleared` reports
     * both kinds: absolute paths for files removed, bare names like
     * `'exit_type'` for a preference repaired, which keeps one contract
     * ("what did you fix") rather than two.
     *
     * `refusedLivePid` still comes first and still wins. On POSIX it can
     * be answered from `SingletonLock` alone, without a process scan,
     * which is cheaper and is kept for that reason; the process table scan
     * inside `healProfile` is what answers it on Windows.
     */
    async clearSingleton(path) {
      if (process.platform !== 'win32') {
        const lockPid = readSingletonLockPid(path);
        if (lockPid !== null && pidAlive(lockPid)) {
          return { cleared: [], refusedLivePid: lockPid };
        }
      }
      const healed = await healProfile(path);
      if (healed.inUse) return { cleared: [], refusedLivePid: healed.heldByPid };
      // Absolute paths for the lock files, matching what this method
      // returned before, and bare repair names for everything else.
      const lockNames = new Set<string>(SINGLETON_LOCK_FILES);
      return {
        cleared: healed.fixed.map((name) => (lockNames.has(name) ? join(path, name) : name)),
        refusedLivePid: null,
      };
    },

    async measure(path) {
      const result = treeSize(path);
      const marker: SizeMarker = {
        schema: 'bgls.profile-size/1',
        sizeBytes: result.sizeBytes,
        fileCount: result.fileCount,
        measuredAt: Date.now(),
      };
      try {
        writeFileSync(join(path, '.bgls-size.json'), JSON.stringify(marker, null, 2));
      } catch {
        // Best effort cache write; the measurement itself is still valid.
      }
      return result;
    },

    /**
     * Moves a profile directory out of the live tree and into
     * `trash/<id>.<ts>.<kind>`, then removes the now empty
     * `tenants/<t>/profiles/<p>` shell it lived in.
     *
     * Three behaviours here exist because of measured failures, not
     * theory, and each is load bearing:
     *
     * 1. A path that is already gone is a success, not an error.
     *    `BrowserRouter.release()` step 6 calls `applyReleaseAction`
     *    (which trashes as `'deleted'`) and then step 7 calls
     *    `releaseLeaseQuietly` (which, for an ephemeral profile, trashes
     *    the same path again as `'ephemeral'`). Before this, the second
     *    call threw `ENOENT` from `renameSync`, which aborted
     *    `ProfileService.release()` BEFORE its step 6 store write, so
     *    `store.releaseProfileLease` never ran and the lease row kept
     *    `released_at = NULL` forever. Verified directly against the demo
     *    database: `prf_01M0X7DM0WJTDHN3KD346EBZRM` reached state
     *    `deleting` at 19:47:43.226Z with its lease row still unreleased,
     *    while two older releases (from before `instances.profile_id` was
     *    populated, so step 6 was skipped and only one trash ever ran)
     *    both have a proper `released_at`. Idempotence is the correct
     *    contract for a reclaim operation anyway.
     *
     * 2. The rename is retried on a lock-class errno rather than
     *    attempted once. See {@link TRASH_RENAME_RETRY_DELAYS_MS} for the
     *    Windows handle race this loses otherwise.
     *
     * 3. When the retries are exhausted the directory is deleted in
     *    place instead, but ONLY for a kind listed in
     *    {@link TRASH_KINDS_SAFE_TO_DELETE_IN_PLACE}, and ONLY after
     *    confirming no live Chrome still owns it. A recursive delete
     *    under a running browser corrupts its LevelDB stores; a live
     *    owner means the caller's terminate ladder failed, which is a
     *    different bug and must be reported as one
     *    ({@link ProfileStillLiveError}) rather than papered over.
     *
     * Guarantee on return: the bytes are reclaimed, either moved to
     * `trash/` (the normal path, and the only one that leaves them
     * recoverable for the sweeper's retention window) or unlinked in
     * place. In the second case the returned path names where they would
     * have gone and does not exist, since nothing is left to name.
     *
     * Guarantee on throw: nothing was deleted and nothing was partially
     * deleted. The directory is intact where it was, and the error names
     * it, the destination, the number of attempts spent, and the
     * underlying errno, so the caller's log line is enough to act on. A
     * directory left behind and reported is an acceptable end state; one
     * left behind in silence is what this whole function exists to stop.
     */
    async trash(path, kind: TrashKind) {
      const segments = path.split(sep);
      const tenantsIdx = segments.indexOf('tenants');
      const tenantId = tenantsIdx !== -1 ? segments[tenantsIdx + 1] : 'unknown-tenant';
      const trashRoot = tenantId ? tenantTrashDir(root, tenantId) : join(root, 'trash');
      const id = basename(path);
      const dest = join(trashRoot, `${id}.${Date.now()}.${kind}`);

      // Behaviour 1. Checked before `mkdirSync(trashRoot)` so a repeat
      // call on an already reclaimed profile does not recreate a trash
      // root that the sweeper has since emptied and removed.
      if (!existsSync(path)) {
        removeEmptyProfileDir(path);
        return dest;
      }

      mkdirSync(trashRoot, { recursive: true });

      // Behaviour 2.
      let attempts = 0;
      let lastError: unknown = null;
      for (let i = 0; i <= TRASH_RENAME_RETRY_DELAYS_MS.length; i += 1) {
        attempts += 1;
        try {
          renameSync(path, dest);
          removeEmptyProfileDir(path);
          return dest;
        } catch (err) {
          lastError = err;
          const code = errnoCodeOf(err);
          if (code === 'ENOENT') {
            // Something else reclaimed it between the `existsSync` above
            // and this attempt. Same outcome as behaviour 1.
            removeEmptyProfileDir(path);
            return dest;
          }
          if (code === null || !TRASH_RETRYABLE_CODES.has(code)) break;
          const delay = TRASH_RENAME_RETRY_DELAYS_MS[i];
          if (delay === undefined) break;
          await sleep(delay);
        }
      }

      // Behaviour 3. `chromeProcsForDataDirAsync` is a process table
      // scan (a WMI query on Windows), which is why it runs only here,
      // on the path that is about to do something irreversible, and
      // never on the successful rename that handles every ordinary
      // release. This comment used to estimate that scan at ~200 ms; a
      // real measurement on a machine running 410 processes put it at
      // ~1.45 seconds, which is precisely why the whole call graph
      // moved off the synchronous variant.
      if (!TRASH_KINDS_SAFE_TO_DELETE_IN_PLACE.has(kind)) {
        throw new ProfileTrashFailedError(path, dest, attempts, lastError);
      }

      const owners = await chromeProcsForDataDirAsync(path, { maxAgeMs: 0 });
      const owner = owners[0];
      if (owner !== undefined) throw new ProfileStillLiveError(path, owner.pid);

      try {
        // `maxRetries`/`retryDelay` are Node's own per entry retry for
        // exactly this class of Windows error, so a file whose handle
        // closes mid walk does not fail the whole delete.
        //
        // The budget is deliberately at least as large as
        // `TRASH_RENAME_RETRY_DELAYS_MS` totals (about 3.6 seconds),
        // because of WHEN this code runs. It is only reached after the
        // rename ladder above has already failed every one of its eight
        // attempts, which is to say only on a machine that has just
        // demonstrated it is slow to release handles. Giving the fallback
        // a seventh of the budget of the thing it is falling back from
        // had it backwards, and it showed: under a full-suite run with
        // other Chrome tests in flight, `chrome-shutdown.e2e.test.ts`
        // failed with `EBUSY ... unlink '...\udd\Default\Account Web
        // Data'` and a `stop()` report of `deadlineExceeded: true`, while
        // passing three times out of three in isolation. Chrome's own
        // handles on Windows can outlive its process exit by longer than
        // half a second when the machine is loaded.
        rmSync(path, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
      } catch (err) {
        throw new ProfileTrashFailedError(path, dest, attempts, err ?? lastError);
      }
      removeEmptyProfileDir(path);
      return dest;
    },

    async sweep(cfg: SweeperConfig) {
      let unlinked = 0;
      let bytes = 0;
      const tenants = existsSync(tenantsDir(root)) ? readdirSync(tenantsDir(root)) : [];
      outer: for (const tenantId of tenants) {
        const trashRoot = tenantTrashDir(root, tenantId);
        if (!existsSync(trashRoot)) continue;
        for (const entry of readdirSync(trashRoot)) {
          if (unlinked >= cfg.batchLimit) break outer;
          const match = /\.(\d+)\.([a-z]+)$/.exec(entry);
          if (!match) continue;
          const trashedAt = Number(match[1]);
          const kind = match[2] as TrashKind;
          const retentionMs = cfg.trashRetentionMsByKind[kind];
          if (retentionMs === undefined) continue;
          if (Date.now() - trashedAt < retentionMs) continue;
          const full = join(trashRoot, entry);
          const size = existsSync(full) ? treeSize(full).sizeBytes : 0;
          rmSync(full, { recursive: true, force: true });
          unlinked += 1;
          bytes += size;
        }
      }
      return { unlinked, bytes };
    },

    async reconcile() {
      // Scoped to what a filesystem-only view can honestly determine: a
      // `tmp/<opId>` staging directory left behind by an interrupted
      // `materialise()` (crashed before the final rename) is always an
      // orphan, since `tmp/` is exclusively this module's scratch space.
      // Comparing `tenants/*/profiles/*` against the DB's own row set
      // (which is what would normally populate `missingDirs`, "a row with
      // no directory") needs data only the router's `ProfileService`
      // holds; `ProfileFs.reconcile()` has no DB handle, per this
      // package's architecture ("the router decides, the runtime does").
      // `missingDirs` is therefore always empty from this implementation;
      // the router's own reconciliation pass is expected to compute it by
      // combining its row set with a directory listing.
      const orphanDirs: string[] = [];
      const tmpRoot = join(root, 'tmp');
      if (existsSync(tmpRoot)) {
        for (const entry of readdirSync(tmpRoot)) {
          orphanDirs.push(join(tmpRoot, entry));
        }
      }
      return { orphanDirs, missingDirs: [] };
    },
  };
}
