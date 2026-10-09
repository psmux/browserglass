/**
 * The copy-on-write capability probe. Creates a 1 MB file in `tmp/` and attempts the clone; never
 * trusts the filesystem type string alone (btrfs with `nodatacow` fails
 * `FICLONE` at runtime even though the fstype string says btrfs). Cached
 * in `.bgls-root.json` by the caller ({@link probeCowCapability} itself is
 * pure and does not read or write that file).
 *
 * Implemented via Node's own `fs.copyFile`/`copyFileSync` with
 * `COPYFILE_FICLONE_FORCE`, which fails loudly when the platform cannot
 * make the copy copy-on-write, rather than `COPYFILE_FICLONE` (no
 * `_FORCE`), which silently falls back to a full copy and so cannot be
 * used to detect the capability at all. This reaches Linux reflink
 * (`FICLONE`) and macOS `clonefile` without a native addon. Windows ReFS
 * block cloning (`FSCTL_DUPLICATE_EXTENTS_TO_FILE`) has no Node binding
 * and is not implemented yet (the common case, an NTFS `C:` volume, has no
 * block cloning either way); a Windows host always reports `'none'` for
 * now and uses the recursive-copy path.
 */

import { constants, copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CowKind } from '@browserglass/protocol';

const PROBE_FILE_SIZE_BYTES = 1024 * 1024;

/** Attempts a real clone of a 1 MB file inside `root/tmp/`, cleaning up after itself either way. */
export function probeCowCapability(root: string): CowKind {
  if (process.platform === 'win32') {
    // No Node binding for FSCTL_DUPLICATE_EXTENTS_TO_FILE (ReFS block
    // cloning); NTFS, this machine's actual filesystem, has no block
    // cloning at all. Report honestly rather than guessing.
    return 'none';
  }

  const tmpDir = join(root, 'tmp', `.cow-probe-${process.pid}-${Date.now()}`);
  const src = join(tmpDir, 'src.bin');
  const dst = join(tmpDir, 'dst.bin');
  try {
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(src, Buffer.alloc(PROBE_FILE_SIZE_BYTES, 1));
    copyFileSync(src, dst, constants.COPYFILE_FICLONE_FORCE);
    return process.platform === 'darwin' ? 'clonefile' : 'reflink';
  } catch {
    return 'none';
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** The filesystem type string, best effort, for `.bgls-root.json`'s record only; never trusted for the capability decision itself (see this file's header). */
export function detectFsTypeLabel(): string {
  return process.platform;
}
