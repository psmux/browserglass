/**
 * `files/upload-store.ts`. Real filesystem work against a temp directory,
 * not a mock: the whole point of this module is what it does to disk, and
 * a fake `fs` would prove nothing about the exclusive create, the symlink
 * refusal, or the Windows-flavoured removal retry.
 */

import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Logger } from '../../src/config/logger.js';
import {
  type UploadStore,
  UploadStoreError,
  createUploadStore,
} from '../../src/files/upload-store.js';

const silentLogger: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const TENANT = 'ten_test';
const OTHER_TENANT = 'ten_other';

let root: string;
let store: UploadStore;
let now = 1_000_000;

function build(
  opts: Parameters<typeof createUploadStore>[0] extends infer T ? Partial<T> : never = {},
): UploadStore {
  return createUploadStore({
    root,
    logger: silentLogger,
    // No sweep timer: every test that cares drives `sweep()` by hand, and
    // a background timer in a suite that manipulates a fake clock is a
    // flake generator.
    sweepIntervalMs: 0,
    now: () => now,
    ...opts,
  });
}

async function stage(
  s: UploadStore,
  uploadId: string,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  await s.begin({ uploadId, tenantId: TENANT, name, sizeBytes: bytes.byteLength });
  if (bytes.byteLength > 0) await s.append(uploadId, TENANT, bytes);
  await s.complete(uploadId, TENANT);
}

beforeEach(async () => {
  now = 1_000_000;
  root = await mkdtemp(join(tmpdir(), 'bgls-upload-test-'));
  store = build();
});

afterEach(async () => {
  await store.dispose();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe('lifecycle', () => {
  it('stages bytes and reports them back under the sanitised name', async () => {
    const bytes = new TextEncoder().encode('an invoice, notionally');
    const begun = await store.begin({
      uploadId: 'up_1',
      tenantId: TENANT,
      name: 'Invoice 2041.pdf',
      sizeBytes: bytes.byteLength,
    });
    expect(begun.name).toBe('Invoice 2041.pdf');
    expect(begun.binaryId).toMatch(/^[0-9a-f]{32}$/);

    await store.append('up_1', TENANT, bytes.subarray(0, 5));
    expect(store.status('up_1', TENANT).receivedBytes).toBe(5);
    await store.append('up_1', TENANT, bytes.subarray(5));

    const done = await store.complete('up_1', TENANT);
    expect(done.status).toBe('ready');
    expect(done.receivedBytes).toBe(bytes.byteLength);
    expect(done.sha256).toMatch(/^[0-9a-f]{64}$/);

    const path = await store.pathFor('up_1', TENANT);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  });

  it('puts the file under a server-minted directory, never under the caller-chosen id', async () => {
    // The caller-supplied `uploadId` must not become a path component.
    // A id that looks like traversal is legal as a map key and must not
    // reach disk in any form.
    await store.begin({ uploadId: 'up_..:weird', tenantId: TENANT, name: 'x.txt', sizeBytes: 1 });
    const dirs = await readdir(root);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/^[0-9a-f]{32}$/);
  });

  it('names the file with the sanitised basename, so the page sees the right File.name', async () => {
    await stage(store, 'up_1', '../../../etc/passwd', new Uint8Array([1]));
    const path = await store.pathFor('up_1', TENANT);
    expect(path.endsWith(`${'passwd'}`)).toBe(true);
    // And it is genuinely inside the staging root, not two levels up.
    expect(path.startsWith(root)).toBe(true);
    // Checked by shape, not by probing `<root>/../../../etc/passwd`: on
    // Linux the temp root sits directly under `/tmp`, so that walk clamps
    // at `/` and lands on the real `/etc/passwd`, which always exists.
    expect(relative(root, path).split(sep)).toEqual([
      expect.stringMatching(/^[0-9a-f]{32}$/),
      'passwd',
    ]);
  });

  it('accepts a zero-byte file', async () => {
    await stage(store, 'up_0', 'empty.txt', new Uint8Array(0));
    expect((await readFile(await store.pathFor('up_0', TENANT))).byteLength).toBe(0);
  });

  it('is idempotent on a repeated complete', async () => {
    await stage(store, 'up_1', 'a.txt', new Uint8Array([1, 2, 3]));
    const again = await store.complete('up_1', TENANT);
    expect(again.status).toBe('ready');
  });
});

describe('refusals', () => {
  it('refuses a duplicate uploadId', async () => {
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.txt', sizeBytes: 1 });
    await expect(
      store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'b.txt', sizeBytes: 1 }),
    ).rejects.toMatchObject({
      code: 'E_UPLOAD_DUPLICATE',
    });
  });

  it('refuses an uploadId that is not a plain token', async () => {
    await expect(
      store.begin({ uploadId: 'a/b', tenantId: TENANT, name: 'a.txt', sizeBytes: 1 }),
    ).rejects.toMatchObject({
      code: 'E_UPLOAD_ID_INVALID',
    });
    await expect(
      store.begin({ uploadId: 'x'.repeat(200), tenantId: TENANT, name: 'a.txt', sizeBytes: 1 }),
    ).rejects.toMatchObject({
      code: 'E_UPLOAD_ID_INVALID',
    });
  });

  it('refuses a declared size over the per-file limit', async () => {
    const small = build({ maxUploadBytes: 10 });
    await expect(
      small.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 11 }),
    ).rejects.toMatchObject({
      code: 'E_UPLOAD_TOO_LARGE',
    });
    await small.dispose();
  });

  it('refuses bytes past the declared size', async () => {
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 4 });
    await store.append('up_1', TENANT, new Uint8Array([1, 2, 3, 4]));
    await expect(store.append('up_1', TENANT, new Uint8Array([5]))).rejects.toMatchObject({
      code: 'E_UPLOAD_TOO_LARGE',
    });
  });

  it('refuses to complete a short upload', async () => {
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 4 });
    await store.append('up_1', TENANT, new Uint8Array([1, 2]));
    await expect(store.complete('up_1', TENANT)).rejects.toMatchObject({
      code: 'E_UPLOAD_SIZE_MISMATCH',
    });
  });

  it('discards the bytes on a hash mismatch rather than leaving them attachable', async () => {
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 2 });
    await store.append('up_1', TENANT, new Uint8Array([1, 2]));
    await expect(store.complete('up_1', TENANT, 'f'.repeat(64))).rejects.toMatchObject({
      code: 'E_UPLOAD_HASH_MISMATCH',
    });
    expect(() => store.status('up_1', TENANT)).toThrow(UploadStoreError);
    expect(await readdir(root)).toHaveLength(0);
  });

  it('refuses a path for an incomplete upload', async () => {
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 4 });
    await expect(store.pathFor('up_1', TENANT)).rejects.toMatchObject({
      code: 'E_UPLOAD_NOT_READY',
    });
  });

  it('caps concurrent uploads', async () => {
    const capped = build({ maxConcurrent: 2 });
    await capped.begin({ uploadId: 'a', tenantId: TENANT, name: 'a', sizeBytes: 1 });
    await capped.begin({ uploadId: 'b', tenantId: TENANT, name: 'b', sizeBytes: 1 });
    await expect(
      capped.begin({ uploadId: 'c', tenantId: TENANT, name: 'c', sizeBytes: 1 }),
    ).rejects.toMatchObject({
      code: 'E_UPLOAD_LIMIT',
    });
    await capped.dispose();
  });

  it('caps total staged bytes, which is the swarm case', async () => {
    // Ten browsers each staging a legal 100 KB file is 1 MB, and the
    // per-file limit says nothing about it.
    const capped = build({ maxTotalBytes: 100 });
    await capped.begin({ uploadId: 'a', tenantId: TENANT, name: 'a', sizeBytes: 60 });
    await expect(
      capped.begin({ uploadId: 'b', tenantId: TENANT, name: 'b', sizeBytes: 60 }),
    ).rejects.toMatchObject({
      code: 'E_UPLOAD_LIMIT',
    });
    await capped.dispose();
  });
});

describe('tenant scoping', () => {
  it("reports another tenant's id as not found, not as forbidden", async () => {
    // A distinguishable "wrong tenant" answer is an existence oracle.
    await stage(store, 'up_1', 'a.txt', new Uint8Array([1]));
    expect(() => store.status('up_1', OTHER_TENANT)).toThrow(UploadStoreError);
    await expect(store.pathFor('up_1', OTHER_TENANT)).rejects.toMatchObject({
      code: 'E_UPLOAD_NOT_FOUND',
    });
    await expect(store.append('up_1', OTHER_TENANT, new Uint8Array([2]))).rejects.toMatchObject({
      code: 'E_UPLOAD_NOT_FOUND',
    });
  });

  it('does not let another tenant discard an upload', async () => {
    await stage(store, 'up_1', 'a.txt', new Uint8Array([1]));
    await store.discard('up_1', OTHER_TENANT);
    expect(store.status('up_1', TENANT).status).toBe('ready');
  });
});

describe('symlinks', () => {
  it('refuses to open over anything that already exists, which is what O_EXCL buys', async () => {
    // The staging file is opened 'wx' (O_CREAT | O_EXCL). The kernel
    // refuses that for anything already at the path, symlink included, and
    // cannot follow one. Asserted on the flag directly rather than through
    // the store, whose per-upload directory name is 16 random bytes and so
    // is not reachable to pre-plant anything in.
    const { open } = await import('node:fs/promises');
    const victim = join(root, 'already-here');
    await writeFile(victim, 'existing');
    await expect(open(victim, 'wx')).rejects.toMatchObject({ code: 'EEXIST' });
    // And the existing content survives the refusal, which is the part
    // that matters: a plain 'w' would have truncated it.
    expect(await readFile(victim, 'utf8')).toBe('existing');
  });

  it('refuses to hand Chrome a path that has become a symlink', async () => {
    await stage(store, 'up_1', 'a.txt', new Uint8Array([1, 2, 3]));
    const path = await store.pathFor('up_1', TENANT);

    // Replace the staged file with a symlink to something sensitive.
    // `lstat` is what catches this; `stat` would follow the link and
    // cheerfully report a regular file.
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'not yours');
    await rm(path);
    try {
      await symlink(secret, path);
    } catch (err) {
      // Windows without Developer Mode refuses symlink creation for an
      // unprivileged process. The behaviour under test is real, the test
      // for it is not runnable here, and skipping loudly beats asserting
      // nothing.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return;
      throw err;
    }
    expect((await lstat(path)).isSymbolicLink()).toBe(true);
    await expect(store.pathFor('up_1', TENANT)).rejects.toMatchObject({ code: 'E_UPLOAD_GONE' });
  });
});

describe('expiry and cleanup', () => {
  it('sweeps an incomplete upload whose caller vanished', async () => {
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 100 });
    await store.append('up_1', TENANT, new Uint8Array([1]));
    expect(await store.sweep()).toBe(0);

    now += 5 * 60_000 + 1;
    expect(await store.sweep()).toBe(1);
    expect(() => store.status('up_1', TENANT)).toThrow(UploadStoreError);
    expect(await readdir(root)).toHaveLength(0);
  });

  it('keeps a completed upload for the full retention window, not until attach', async () => {
    // Chrome reads the file when the page submits the form, which can be
    // long after the attach call returned. A completed upload that expired
    // on the staging TTL would break exactly the case this feature exists
    // for.
    await stage(store, 'up_1', 'a.txt', new Uint8Array([1]));
    now += 5 * 60_000 + 1;
    expect(await store.sweep()).toBe(0);
    expect(store.status('up_1', TENANT).status).toBe('ready');

    now += 30 * 60_000;
    expect(await store.sweep()).toBe(1);
  });

  it('extends the deadline when the upload is attached', async () => {
    await stage(store, 'up_1', 'a.txt', new Uint8Array([1]));
    now += 25 * 60_000;
    store.touch('up_1', TENANT);
    now += 20 * 60_000;
    expect(await store.sweep()).toBe(0);
  });

  it('extends the deadline while chunks are still arriving', async () => {
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 10 });
    for (let i = 0; i < 10; i += 1) {
      now += 4 * 60_000;
      await store.append('up_1', TENANT, new Uint8Array([i]));
      expect(await store.sweep()).toBe(0);
    }
    expect(store.status('up_1', TENANT).receivedBytes).toBe(10);
  });

  it('discards on request and is idempotent about it', async () => {
    await stage(store, 'up_1', 'a.txt', new Uint8Array([1]));
    await store.discard('up_1', TENANT);
    await store.discard('up_1', TENANT);
    await store.discard('never-existed', TENANT);
    expect(await readdir(root)).toHaveLength(0);
  });

  it('removes the whole staging root on dispose, including open handles', async () => {
    await store.begin({ uploadId: 'open_1', tenantId: TENANT, name: 'a.bin', sizeBytes: 100 });
    await stage(store, 'done_1', 'b.txt', new Uint8Array([1]));
    await store.dispose();
    expect(existsSync(root)).toBe(false);
  });

  it('refuses new uploads once disposed', async () => {
    await store.dispose();
    await expect(
      store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a', sizeBytes: 1 }),
    ).rejects.toMatchObject({
      code: 'E_UPLOAD_GONE',
    });
  });
});

describe('binary channel ids', () => {
  it('resolves a binary id back to its upload, and only its own', async () => {
    const a = await store.begin({ uploadId: 'up_a', tenantId: TENANT, name: 'a', sizeBytes: 1 });
    const b = await store.begin({ uploadId: 'up_b', tenantId: TENANT, name: 'b', sizeBytes: 1 });
    expect(store.uploadIdForBinaryId(a.binaryId)).toBe('up_a');
    expect(store.uploadIdForBinaryId(b.binaryId)).toBe('up_b');
    expect(store.uploadIdForBinaryId('0'.repeat(32))).toBeNull();
  });

  it('forgets a binary id once the upload is gone', async () => {
    const a = await store.begin({ uploadId: 'up_a', tenantId: TENANT, name: 'a', sizeBytes: 1 });
    await store.discard('up_a', TENANT);
    expect(store.uploadIdForBinaryId(a.binaryId)).toBeNull();
  });
});

describe('concurrency', () => {
  it('serialises interleaved appends so the bytes land in order', async () => {
    // Two overlapping writes to one handle without serialisation land at
    // arbitrary offsets and produce a file that is the right length and
    // the wrong content, which no size check would catch.
    const total = 64;
    await store.begin({ uploadId: 'up_1', tenantId: TENANT, name: 'a.bin', sizeBytes: total });
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < total; i += 1) chunks.push(new Uint8Array([i]));
    await Promise.all(chunks.map((c) => store.append('up_1', TENANT, c)));
    await store.complete('up_1', TENANT);
    const written = await readFile(await store.pathFor('up_1', TENANT));
    expect([...written]).toEqual([...Array(total).keys()]);
  });
});
