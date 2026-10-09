import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getBootId } from '../src/boot-id.js';
import {
  listAllProfileDirs,
  reapAbandonedProfileDirs,
  reconcileOnStartup,
} from '../src/reconcile.js';
import type { StateFileContents } from '../src/state-file.js';

let dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-reconcile-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const SAMPLE_ENTRY = {
  instanceId: 'inst_dead',
  pid: 2_100_000_000, // guaranteed not to exist
  pgid: 2_100_000_000,
  containerId: null,
  startedAt: Date.now(),
  cdpUrl: 'http://127.0.0.1:9',
  browserGuid: 'guid-does-not-matter',
  profilePath: 'C:\\does-not-exist',
  profileFence: 1,
  engineVersion: 'Chrome/151.0.0.0',
  channel: 'chrome',
  headless: 'new' as const,
  displayName: null,
  downloadDir: null,
  labels: {},
};

describe('reconcileOnStartup', () => {
  it('treats a missing state file as an empty list and produces a zeroed report', async () => {
    const stateDir = freshDir();
    const { report } = await reconcileOnStartup({ stateDir, nodeId: 'nod_1' });
    expect(report.adoptedCount).toBe(0);
    expect(report.terminatedCount).toBe(0);
    expect(report.entries).toEqual([]);
  });

  it('classifies a dead pid as a cleanup candidate rather than an adoption candidate', async () => {
    const stateDir = freshDir();
    const contents: StateFileContents = {
      version: 1,
      nodeId: 'nod_1',
      runtimeKind: 'host',
      writerPid: 1,
      writerBootId: getBootId(),
      updatedAt: Date.now(),
      browsers: [SAMPLE_ENTRY],
    };
    writeFileSync(join(stateDir, 'runtime-host.json'), JSON.stringify(contents));

    const { report, store } = await reconcileOnStartup({ stateDir, nodeId: 'nod_1' });
    expect(report.entries).toEqual([{ instanceId: 'inst_dead', outcome: 'cleanup-already-dead' }]);
    expect(report.adoptedCount).toBe(0);
    expect(store.list()).toHaveLength(0);
  });

  it('a writerBootId mismatch discards every entry unconditionally, without even checking liveness', async () => {
    const stateDir = freshDir();
    const contents: StateFileContents = {
      version: 1,
      nodeId: 'nod_1',
      runtimeKind: 'host',
      writerPid: 1,
      writerBootId: 'a-completely-different-boot-id-than-this-machine-has-right-now',
      updatedAt: Date.now(),
      browsers: [SAMPLE_ENTRY],
    };
    writeFileSync(join(stateDir, 'runtime-host.json'), JSON.stringify(contents));

    const { report, store } = await reconcileOnStartup({ stateDir, nodeId: 'nod_1' });
    expect(report.entries).toEqual([]);
    expect(store.list()).toHaveLength(0);
  });

  it('quarantines an unparseable state file and proceeds with an empty list', async () => {
    const stateDir = freshDir();
    writeFileSync(join(stateDir, 'runtime-host.json'), '{ this is not valid json');
    const { report } = await reconcileOnStartup({ stateDir, nodeId: 'nod_1' });
    expect(report.entries).toEqual([]);
  });
});

/**
 * `listAllProfileDirs` feeds `ReconcileDeps.profileDirsToScan`, which is the
 * only input to the startup orphan scan. Getting the path level wrong there
 * does not fail loudly, it just makes the scan silently match nothing, so
 * this is worth pinning down explicitly.
 */
describe('listAllProfileDirs', () => {
  it("returns each profile's `udd` directory, the path Chrome is actually launched against", () => {
    const root = freshDir();
    const profileDir = join(root, 'tenants', 'ten_a', 'profiles', 'prf_1');
    mkdirSync(join(profileDir, 'udd'), { recursive: true });

    const found = listAllProfileDirs(root);

    // The load-bearing one. `ProfileFs.materialise` returns
    // `join(destDir, 'udd')` as `MaterialisedProfile.path`, so
    // every real Chrome carries `--user-data-dir=<...>/prf_1/udd`, and
    // `containsDataDirArg` compares paths for exact equality. Returning
    // only the parent made the scan compare `.../prf_1` against
    // `.../prf_1/udd` and reap nothing, ever.
    expect(found).toContain(join(profileDir, 'udd'));
    // The older parent-directory layout is still scanned, cheaply, so a browser
    // launched by an older build is not stranded forever.
    expect(found).toContain(profileDir);
  });

  it('returns nothing when the profile root has no tenants directory yet', () => {
    expect(listAllProfileDirs(freshDir())).toEqual([]);
  });
});

/**
 * `reapAbandonedProfileDirs`, the bounded garbage reaper for
 * `tenants/<t>/profiles/<p>` directories a store row no longer protects.
 * Every test here uses `minAgeMs: 0` unless it is specifically pinning the
 * age gate, since `mkdtempSync`/`mkdirSync` stamp a directory's mtime at
 * "now" and this suite has no reason to wait real minutes for it to age.
 */
describe('reapAbandonedProfileDirs', () => {
  function makeProfileDir(root: string, tenantId: string, profileId: string): string {
    const dir = join(root, 'tenants', tenantId, 'profiles', profileId);
    mkdirSync(join(dir, 'udd'), { recursive: true });
    writeFileSync(join(dir, 'udd', 'marker.txt'), 'placeholder profile bytes');
    return dir;
  }

  it('removes a directory whose profileId is absent from protectedProfileIds', async () => {
    const root = freshDir();
    const dir = makeProfileDir(root, 'ten_a', 'prf_orphan');

    const report = await reapAbandonedProfileDirs({
      profileRoot: root,
      protectedProfileIds: new Set(),
      minAgeMs: 0,
    });

    expect(report.scanned).toBe(1);
    expect(report.candidates).toBe(1);
    expect(report.removed).toEqual([{ tenantId: 'ten_a', profileId: 'prf_orphan', dir }]);
    expect(report.refusedLive).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(existsSync(dir)).toBe(false);
  });

  it('never removes a directory whose profileId is protected, however old it is', async () => {
    const root = freshDir();
    const dir = makeProfileDir(root, 'ten_a', 'prf_live');

    const report = await reapAbandonedProfileDirs({
      profileRoot: root,
      protectedProfileIds: new Set(['prf_live']),
      minAgeMs: 0,
    });

    expect(report.scanned).toBe(1);
    expect(report.candidates).toBe(0);
    expect(report.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('skips an unprotected directory younger than minAgeMs, so a launch mid materialise is never a candidate', async () => {
    const root = freshDir();
    const dir = makeProfileDir(root, 'ten_a', 'prf_fresh');

    const report = await reapAbandonedProfileDirs({
      profileRoot: root,
      protectedProfileIds: new Set(),
      minAgeMs: 10 * 60_000, // 10 minutes; the directory was just created
    });

    expect(report.candidates).toBe(0);
    expect(report.skippedTooRecent).toBe(1);
    expect(report.removed).toEqual([]);
    expect(existsSync(dir)).toBe(true);
  });

  it('caps removals at maxRemovals, leaving the rest for the next tick', async () => {
    const root = freshDir();
    makeProfileDir(root, 'ten_a', 'prf_1');
    makeProfileDir(root, 'ten_a', 'prf_2');
    makeProfileDir(root, 'ten_a', 'prf_3');

    const report = await reapAbandonedProfileDirs({
      profileRoot: root,
      protectedProfileIds: new Set(),
      minAgeMs: 0,
      maxRemovals: 1,
    });

    expect(report.candidates).toBe(3);
    expect(report.removed).toHaveLength(1);
  });

  it('reports zero scanned and does nothing on a profile root with no tenants directory yet', async () => {
    const report = await reapAbandonedProfileDirs({
      profileRoot: freshDir(),
      protectedProfileIds: new Set(),
    });
    expect(report.scanned).toBe(0);
    expect(report.candidates).toBe(0);
    expect(report.removed).toEqual([]);
  });
});
