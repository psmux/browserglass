/**
 * `ProfileFs`, the filesystem side of profile storage. `ProfileService`
 * (router side) has no filesystem interface of its own; without this one
 * `router` would do file IO directly and break the layer gate. Implemented
 * by `runtime-host`; `router`'s profile service holds one by injection so
 * `runtime-docker` can implement it later.
 */

/** The copy-on-write technique a profile root filesystem supports, probed once and cached in `.bgls-root.json`. */
export type CowKind = 'reflink' | 'clonefile' | 'refs' | 'none';

/** How a `materialise()` call produced its directory. */
export type Materialisation = 'empty' | 'template-clone' | 'restore' | 'import' | 'slow-copy';

/** The result of `ProfileFs.probe()`, the 400 ms corruption check run before trusting a profile directory. */
export interface ProbeResult {
  ok: boolean;
  /** Names of the checks run, in order, for example `sqlite_quick_check`, `lock_files`, `fence_present`. */
  checks: readonly { name: string; ok: boolean; detail: string | null }[];
  durationMs: number;
}

/** The retention bucket a trashed profile directory falls into, each with its own retention window. */
export type TrashKind = 'ephemeral' | 'deleted' | 'quarantine' | 'migration';

/** Sweeper configuration, per trash kind rather than one flat constant. */
export interface SweeperConfig {
  trashRetentionMsByKind: Readonly<Record<TrashKind, number>>;
  /** Upper bound on directories inspected in one sweep pass. */
  batchLimit: number;
}

/**
 * The filesystem side of the profile lifecycle: materialising a directory,
 * fencing writes to it, probing it for corruption, and reclaiming it. The
 * router decides what should happen to a profile; this interface is the
 * only thing that touches its bytes.
 */
export interface ProfileFs {
  capabilities(): Promise<{ cow: CowKind; fsType: string; root: string }>;

  materialise(req: {
    profileId: string;
    tenantId: string;
    opId: string;
    from:
      | { kind: 'empty' }
      | { kind: 'template'; templateDir: string }
      | { kind: 'restore'; snapshotUri: string }
      | { kind: 'import'; bundleUri: string };
    allowSlowCopy: boolean;
  }): Promise<{
    path: string;
    materialisation: Materialisation;
    materialiseMs: number;
    sizeBytes: number;
  }>;

  writeFence(path: string, fence: number): Promise<void>;
  readFence(path: string): Promise<number | null>;

  /** The 400 ms corruption probe. */
  probe(path: string): Promise<ProbeResult>;

  clearSingleton(path: string): Promise<{ cleared: string[]; refusedLivePid: number | null }>;

  measure(path: string): Promise<{ sizeBytes: number; fileCount: number }>;

  /**
   * Renames into `trash/<id>.<ts>.<kind>`, returns the new path.
   *
   * Two contract points an implementation must honour, both learned from
   * a real leak rather than assumed:
   *
   * Idempotent. A `path` that no longer exists is a success, never an
   * error. `BrowserRouter.release()` reclaims the same directory twice by
   * design (step 6's release action, then step 7's lease release), and an
   * implementation that threw `ENOENT` on the second call aborted the
   * lease release before its store write.
   *
   * `path` is `tenants/<t>/profiles/<p>/udd`, the user data directory,
   * not the profile directory that contains it. An implementation must
   * also remove that now empty parent, since nothing else in the system
   * ever will: `sweep()` walks only `trash/` and `reconcile()` only
   * `tmp/`.
   */
  trash(path: string, kind: TrashKind): Promise<string>;

  sweep(opts: SweeperConfig): Promise<{ unlinked: number; bytes: number }>;

  reconcile(): Promise<{ orphanDirs: string[]; missingDirs: string[] }>;
}
