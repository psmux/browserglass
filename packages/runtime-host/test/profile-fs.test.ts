import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_TRASH_RETENTION_MS_BY_KIND } from '../src/config.js';
import { ProfileTrashFailedError, createProfileFs } from '../src/profile-fs.js';

let root: string | null = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function freshRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'bgls-profile-fs-'));
  return root;
}

describe('ProfileFs.capabilities', () => {
  it('probes once and caches the result in .bgls-root.json', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const first = await fs.capabilities();
    expect(first.root).toBe(r);
    expect(existsSync(join(r, '.bgls-root.json'))).toBe(true);
    const second = await fs.capabilities();
    expect(second).toEqual(first);
  });
});

describe('ProfileFs.materialise, from empty', () => {
  it('assembles in tmp/<opId>/ and renames into place, never assembling directly in the destination', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const result = await fs.materialise({
      profileId: 'prf_1',
      tenantId: 'ten_1',
      opId: 'op_1',
      from: { kind: 'empty' },
      allowSlowCopy: false,
    });
    expect(result.materialisation).toBe('empty');
    // `materialise()` returns the materialised profile's own directory
    // directly (`destDir/udd`), not its parent.
    expect(existsSync(result.path)).toBe(true);
    expect(existsSync(join(r, 'tmp', 'op_1'))).toBe(false);
    expect(result.path).toBe(join(r, 'tenants', 'ten_1', 'profiles', 'prf_1', 'udd'));
  });
});

describe('ProfileFs.materialise, from a template with copy-on-write or recursive copy', () => {
  it('clones a small template directory into a fresh profile', async () => {
    const r = freshRoot();
    const templateDir = join(r, 'template-udd');
    mkdirSync(join(templateDir, 'Default'), { recursive: true });
    writeFileSync(join(templateDir, 'Default', 'Preferences'), '{"seeded":true}');

    const fs = createProfileFs({ root: r });
    const result = await fs.materialise({
      profileId: 'prf_2',
      tenantId: 'ten_1',
      opId: 'op_2',
      from: { kind: 'template', templateDir },
      allowSlowCopy: true,
    });
    expect(result.materialisation).toBe('template-clone');
    // `result.path` is already the `udd` directory itself.
    const copiedFile = join(result.path, 'Default', 'Preferences');
    expect(existsSync(copiedFile)).toBe(true);
  });
});

describe('ProfileFs.writeFence / readFence', () => {
  it('writes with a read-back confirmation, and readFence returns the same value', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_3');
    mkdirSync(profileDir, { recursive: true });

    await fs.writeFence(profileDir, 7);
    const fence = await fs.readFence(profileDir);
    expect(fence).toBe(7);
  });

  it('readFence returns null when the fence file is absent (treated as fence 0 by the caller)', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_4');
    mkdirSync(profileDir, { recursive: true });
    const fence = await fs.readFence(profileDir);
    expect(fence).toBeNull();
  });

  it('overwrites (O_TRUNC) rather than appends on a second write', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_5');
    mkdirSync(profileDir, { recursive: true });
    await fs.writeFence(profileDir, 1);
    await fs.writeFence(profileDir, 42);
    const fence = await fs.readFence(profileDir);
    expect(fence).toBe(42);
  });
});

describe('ProfileFs.clearSingleton, no live process', () => {
  it('reports nothing cleared and no refusal on a directory with no chrome process attached', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_6');
    mkdirSync(profileDir, { recursive: true });
    const result = await fs.clearSingleton(profileDir);
    expect(result.refusedLivePid).toBeNull();
  });
});

describe('ProfileFs.measure', () => {
  it('sums file sizes and counts recursively, and writes .bgls-size.json', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_7');
    mkdirSync(join(profileDir, 'udd', 'Default'), { recursive: true });
    writeFileSync(join(profileDir, 'udd', 'Default', 'a.bin'), Buffer.alloc(1000));
    writeFileSync(join(profileDir, 'udd', 'Default', 'b.bin'), Buffer.alloc(2000));

    const result = await fs.measure(profileDir);
    expect(result.sizeBytes).toBe(3000);
    expect(result.fileCount).toBe(2);
    expect(existsSync(join(profileDir, '.bgls-size.json'))).toBe(true);
  });
});

describe('ProfileFs.trash', () => {
  it('renames into tenants/<t>/trash/<id>.<ts>.<kind>, returning the new path', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_8');
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, 'marker.txt'), 'x');

    const trashedPath = await fs.trash(profileDir, 'deleted');
    expect(existsSync(profileDir)).toBe(false);
    expect(existsSync(trashedPath)).toBe(true);
    expect(trashedPath).toContain(join('tenants', 'ten_1', 'trash'));
    expect(trashedPath).toMatch(/prf_8\.\d+\.deleted$/);
  });

  it('removes the now empty profile directory when it is handed the udd child, which is what every real caller passes', async () => {
    // `materialise()` returns `tenants/<t>/profiles/<p>/udd`, so every
    // `ProfileService` call site hands `trash()` the child rather than the
    // profile directory. Moving only the child used to leave the `prf_...`
    // directory behind as an empty shell that nothing ever removed, which
    // is what "the profile directory is not destroyed" actually looked
    // like on disk: 50 empty directories accumulated on one machine.
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_8');
    const udd = join(profileDir, 'udd');
    mkdirSync(udd, { recursive: true });
    writeFileSync(join(udd, 'marker.txt'), 'x');

    const trashedPath = await fs.trash(udd, 'ephemeral');

    expect(existsSync(trashedPath)).toBe(true);
    expect(existsSync(udd)).toBe(false);
    expect(existsSync(profileDir)).toBe(false);
    expect(readdirSync(join(r, 'tenants', 'ten_1', 'profiles'))).toEqual([]);
  });

  it('leaves the profile directory alone when it still holds something other than the trashed child', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const profileDir = join(r, 'tenants', 'ten_1', 'profiles', 'prf_9');
    const udd = join(profileDir, 'udd');
    mkdirSync(udd, { recursive: true });
    writeFileSync(join(profileDir, 'sibling.txt'), 'not mine to delete');

    await fs.trash(udd, 'ephemeral');

    expect(existsSync(udd)).toBe(false);
    expect(existsSync(join(profileDir, 'sibling.txt'))).toBe(true);
  });

  it('is idempotent: trashing an already reclaimed path resolves instead of throwing ENOENT', async () => {
    // `BrowserRouter.release()` reclaims the same directory twice by
    // design: step 6's `applyReleaseAction` trashes it as 'deleted', then
    // step 7's `releaseLeaseQuietly` trashes it again as 'ephemeral'. The
    // second call used to throw ENOENT out of `ProfileService.release()`
    // BEFORE its store write, so `store.releaseProfileLease` never ran and
    // the lease row stayed marked held forever.
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const udd = join(r, 'tenants', 'ten_1', 'profiles', 'prf_10', 'udd');
    mkdirSync(udd, { recursive: true });
    writeFileSync(join(udd, 'marker.txt'), 'x');

    await fs.trash(udd, 'deleted');
    await expect(fs.trash(udd, 'ephemeral')).resolves.toMatch(/prf_10|udd/);

    // The second call must not have resurrected a trash root or left any
    // other debris behind.
    expect(readdirSync(join(r, 'tenants', 'ten_1', 'trash'))).toHaveLength(1);
  });

  // Windows only, because this failure mode does not exist elsewhere: on
  // POSIX an unlinked but open file is fine and the rename always wins,
  // which is precisely why a Linux CI run never caught this. An open file
  // handle inside the directory is the same thing that blocks the rename
  // when Chrome's renderer, GPU and network service children have not yet
  // released their handles under `--user-data-dir`, which they do
  // asynchronously AFTER the browser-main process has already exited.
  const winOnly = process.platform === 'win32' ? it : it.skip;

  winOnly(
    'retries a rename that a still open handle blocks, and wins once the handle closes',
    async () => {
      const r = freshRoot();
      const fs = createProfileFs({ root: r });
      const udd = join(r, 'tenants', 'ten_1', 'profiles', 'prf_11', 'udd');
      mkdirSync(udd, { recursive: true });
      const held = join(udd, 'History');
      writeFileSync(held, 'x');
      const fd = openSync(held, 'r+');

      // A single unretried renameSync (what this used to do) fails here.
      expect(() => renameSync(udd, join(r, 'proof-a-bare-rename-fails'))).toThrow(/EPERM/);

      const closeAt = setTimeout(() => closeSync(fd), 150);
      try {
        const trashedPath = await fs.trash(udd, 'ephemeral');
        expect(existsSync(trashedPath)).toBe(true);
        expect(existsSync(udd)).toBe(false);
      } finally {
        clearTimeout(closeAt);
      }
    },
  );

  winOnly(
    'falls back to an in place delete for an ephemeral profile when the rename ladder is exhausted',
    async () => {
      const r = freshRoot();
      const fs = createProfileFs({ root: r });
      const udd = join(r, 'tenants', 'ten_1', 'profiles', 'prf_12', 'udd');
      mkdirSync(udd, { recursive: true });
      const held = join(udd, 'History');
      writeFileSync(held, 'seven bytes');
      const fd = openSync(held, 'r+');

      try {
        // The handle is never released, so no rename attempt can ever
        // win. The bytes still have to go: a leftover directory nobody
        // sweeps is the defect being fixed.
        await fs.trash(udd, 'ephemeral');
        expect(existsSync(udd)).toBe(false);
        expect(existsSync(join(r, 'tenants', 'ten_1', 'profiles', 'prf_12'))).toBe(false);
        // Reclaimed in place, so nothing reached the trash root.
        expect(readdirSync(join(r, 'tenants', 'ten_1', 'trash'))).toEqual([]);
      } finally {
        closeSync(fd);
      }
    },
    30_000,
  );

  winOnly(
    'refuses to delete a quarantined profile in place, throwing ProfileTrashFailedError with the directory intact',
    async () => {
      // A quarantined profile is kept for 30 days precisely so a human can
      // see what corrupted it. Tidying up a failed rename by destroying it
      // would delete the thing the retention exists to preserve.
      const r = freshRoot();
      const fs = createProfileFs({ root: r });
      const udd = join(r, 'tenants', 'ten_1', 'profiles', 'prf_13', 'udd');
      mkdirSync(udd, { recursive: true });
      const held = join(udd, 'History');
      writeFileSync(held, 'the evidence');
      const fd = openSync(held, 'r+');

      try {
        await expect(fs.trash(udd, 'quarantine')).rejects.toBeInstanceOf(ProfileTrashFailedError);
        expect(existsSync(held)).toBe(true);
      } finally {
        closeSync(fd);
      }
    },
    30_000,
  );
});

describe('ProfileFs.sweep', () => {
  it('unlinks trash entries older than their kind’s retention window and reports bytes freed', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const trashDir = join(r, 'tenants', 'ten_1', 'trash');
    mkdirSync(trashDir, { recursive: true });

    // An old ephemeral entry (retention 900_000ms): should be unlinked.
    const oldTs = Date.now() - DEFAULT_TRASH_RETENTION_MS_BY_KIND.ephemeral - 60_000;
    const oldEntry = join(trashDir, `prf_old.${oldTs}.ephemeral`);
    mkdirSync(oldEntry, { recursive: true });
    writeFileSync(join(oldEntry, 'data.bin'), Buffer.alloc(500));

    // A fresh quarantine entry: must survive (30-day retention).
    const freshEntry = join(trashDir, `prf_fresh.${Date.now()}.quarantine`);
    mkdirSync(freshEntry, { recursive: true });

    const result = await fs.sweep({
      trashRetentionMsByKind: DEFAULT_TRASH_RETENTION_MS_BY_KIND,
      batchLimit: 64,
    });
    expect(result.unlinked).toBe(1);
    expect(result.bytes).toBe(500);
    expect(existsSync(oldEntry)).toBe(false);
    expect(existsSync(freshEntry)).toBe(true);
  });

  it('respects batchLimit as a per-pass cap', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    const trashDir = join(r, 'tenants', 'ten_1', 'trash');
    mkdirSync(trashDir, { recursive: true });
    const oldTs = Date.now() - DEFAULT_TRASH_RETENTION_MS_BY_KIND.ephemeral - 60_000;
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(trashDir, `prf_${i}.${oldTs}.ephemeral`), { recursive: true });
    }
    const result = await fs.sweep({
      trashRetentionMsByKind: DEFAULT_TRASH_RETENTION_MS_BY_KIND,
      batchLimit: 2,
    });
    expect(result.unlinked).toBe(2);
    expect(readdirSync(trashDir)).toHaveLength(3);
  });
});

describe('ProfileFs.reconcile', () => {
  it('reports a leftover tmp/<opId> staging directory as an orphan', async () => {
    const r = freshRoot();
    const fs = createProfileFs({ root: r });
    await fs.capabilities(); // ensures tmp/ exists
    mkdirSync(join(r, 'tmp', 'abandoned-op'), { recursive: true });
    const result = await fs.reconcile();
    expect(result.orphanDirs.some((d) => d.endsWith('abandoned-op'))).toBe(true);
  });
});
