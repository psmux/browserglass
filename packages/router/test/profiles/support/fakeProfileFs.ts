/**
 * An in-memory, instrumented `ProfileFs` for `ProfileService` tests. Every
 * method call is recorded in `calls`, so a test can assert a code path
 * touched zero files (the `renew` stale-fence protocol's step 4
 * requirement) by snapshotting `calls.length` before and after.
 */

import { basename, join } from 'node:path';
import type {
  CowKind,
  ProbeResult,
  ProfileFs,
  SweeperConfig,
  TrashKind,
} from '@browserglass/protocol';

/** This fake's fixed root, matching `capabilities()`'s own `root` below. */
const FAKE_ROOT = '/fake-root';

/** One recorded `ProfileFs` method invocation. */
export interface FakeFsCall {
  method: keyof ProfileFs;
  args: readonly unknown[];
  at: number;
}

export interface FakeProfileFs extends ProfileFs {
  /** Every call made so far, in order. */
  readonly calls: FakeFsCall[];
  /** Directories "on disk", path -> fence (or `null` meaning no `.bgls-fence` file). */
  readonly fences: Map<string, number | null>;
  /** Paths that exist as live directories. */
  readonly dirs: Set<string>;
  /** Paths currently in `trash/`, mapped to their `TrashKind`. */
  readonly trashed: Map<string, TrashKind>;
  /** Forces the next `probe()` call to fail once. */
  failNextProbe(): void;
  /** Forces the next `clearSingleton()` call to report a live foreign pid once. */
  refuseNextClearSingleton(pid: number): void;
  /** Number of calls recorded so far, for before/after "touched nothing" assertions. */
  callCount(): number;
}

/** Creates a fresh `FakeProfileFs`. `now` defaults to `Date.now` but a test may pass a controllable clock function. */
export function createFakeProfileFs(now: () => number = () => Date.now()): FakeProfileFs {
  const calls: FakeFsCall[] = [];
  const fences = new Map<string, number | null>();
  const dirs = new Set<string>();
  const trashed = new Map<string, TrashKind>();
  let failProbeOnce = false;
  let refuseSingletonPid: number | null = null;

  function record(method: keyof ProfileFs, args: readonly unknown[]): void {
    calls.push({ method, args, at: now() });
  }

  const fs: FakeProfileFs = {
    calls,
    fences,
    dirs,
    trashed,

    capabilities(): Promise<{ cow: CowKind; fsType: string; root: string }> {
      record('capabilities', []);
      return Promise.resolve({ cow: 'none', fsType: 'fake', root: FAKE_ROOT });
    },

    materialise(req): Promise<{
      path: string;
      materialisation: 'empty' | 'template-clone' | 'restore' | 'import' | 'slow-copy';
      materialiseMs: number;
      sizeBytes: number;
    }> {
      record('materialise', [req]);
      // Deterministic from (tenantId, profileId) alone, matching the real
      // `ProfileFs`'s contract: `materialise()` has no destination
      // parameter, so its returned path must be a pure function of the
      // profile identity, joined (via `node:path`'s `join`, exactly like
      // `ProfileService.createProfileRow` and the real `runtime-host`
      // `ProfileFs` both do) against this fake's own root (`FAKE_ROOT`,
      // see `capabilities()` below). Real `materialise()` always returns
      // an absolute path.
      const path = join(FAKE_ROOT, `tenants/${req.tenantId}/profiles/${req.profileId}/udd`);
      dirs.add(path);
      fences.set(path, null);
      const materialisation =
        req.from.kind === 'empty'
          ? 'empty'
          : req.from.kind === 'template'
            ? 'template-clone'
            : req.from.kind === 'restore'
              ? 'restore'
              : 'import';
      return Promise.resolve({ path, materialisation, materialiseMs: 1, sizeBytes: 0 });
    },

    /**
     * Refuses a path this fake never materialised, with the same ENOENT
     * the real one throws.
     *
     * This used to succeed unconditionally, and that is the single reason
     * a defect that broke the FIRST acquire of EVERY persistent key
     * shipped with 259 passing tests in this package. The real
     * `writeFence` opens `<path>/.bgls-fence` with `writeFileSync`, so a
     * directory that was never created throws; this fake wrote into a Map
     * that did not care whether anything had ever been materialised, so
     * `acquirePersistent` could skip materialisation entirely and still
     * pass every test here.
     *
     * A fake is allowed to be simpler than the thing it stands in for. It
     * is not allowed to be more PERMISSIVE on the one axis the code under
     * test is deciding, and materialise-then-fence is exactly that axis.
     */
    writeFence(path: string, fence: number): Promise<void> {
      record('writeFence', [path, fence]);
      if (!dirs.has(path)) {
        const err = new Error(
          `ENOENT: no such file or directory, open '${join(path, '.bgls-fence')}'`,
        ) as Error & { code: string };
        err.code = 'ENOENT';
        return Promise.reject(err);
      }
      fences.set(path, fence);
      return Promise.resolve();
    },

    readFence(path: string): Promise<number | null> {
      record('readFence', [path]);
      return Promise.resolve(fences.has(path) ? (fences.get(path) ?? null) : null);
    },

    probe(path: string): Promise<ProbeResult> {
      record('probe', [path]);
      if (failProbeOnce) {
        failProbeOnce = false;
        return Promise.resolve({
          ok: false,
          checks: [{ name: 'sqlite_quick_check', ok: false, detail: 'forced failure' }],
          durationMs: 1,
        });
      }
      return Promise.resolve({
        ok: true,
        checks: [{ name: 'sqlite_quick_check', ok: true, detail: null }],
        durationMs: 1,
      });
    },

    clearSingleton(path: string): Promise<{ cleared: string[]; refusedLivePid: number | null }> {
      record('clearSingleton', [path]);
      if (refuseSingletonPid !== null) {
        const pid = refuseSingletonPid;
        refuseSingletonPid = null;
        return Promise.resolve({ cleared: [], refusedLivePid: pid });
      }
      return Promise.resolve({ cleared: ['SingletonLock'], refusedLivePid: null });
    },

    measure(path: string): Promise<{ sizeBytes: number; fileCount: number }> {
      record('measure', [path]);
      return Promise.resolve({ sizeBytes: 0, fileCount: 0 });
    },

    trash(path: string, kind: TrashKind): Promise<string> {
      record('trash', [path, kind]);
      dirs.delete(path);
      const trashPath = join(FAKE_ROOT, 'trash', `${basename(path)}.${now()}.${kind}`);
      trashed.set(trashPath, kind);
      return Promise.resolve(trashPath);
    },

    sweep(opts: SweeperConfig): Promise<{ unlinked: number; bytes: number }> {
      record('sweep', [opts]);
      const unlinked = trashed.size;
      trashed.clear();
      return Promise.resolve({ unlinked, bytes: 0 });
    },

    reconcile(): Promise<{ orphanDirs: string[]; missingDirs: string[] }> {
      record('reconcile', []);
      return Promise.resolve({ orphanDirs: [], missingDirs: [] });
    },

    failNextProbe(): void {
      failProbeOnce = true;
    },
    refuseNextClearSingleton(pid: number): void {
      refuseSingletonPid = pid;
    },
    callCount(): number {
      return calls.length;
    },
  };

  return fs;
}
