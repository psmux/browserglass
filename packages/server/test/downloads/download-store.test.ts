/**
 * `DownloadStore`: hashing, containment, and single use signed URLs for a
 * completed download. See `src/downloads/download-store.ts`'s module doc
 * for the full design; this suite exercises exactly the guarantees that
 * doc claims.
 */

import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DownloadStore,
  DownloadStoreError,
  createDownloadStore,
} from '../../src/downloads/download-store.js';

const noopLogger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} } as never;

let root: string;
let store: DownloadStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'bgls-download-store-'));
  store = createDownloadStore({ root, logger: noopLogger, sweepIntervalMs: 0 });
});

afterEach(async () => {
  await store.dispose();
  await rm(root, { recursive: true, force: true });
});

async function stage(downloadId: string, bytes: Uint8Array): Promise<string> {
  const path = join(root, downloadId);
  await writeFile(path, bytes);
  return path;
}

describe('DownloadStore.finalize', () => {
  it('hashes the real bytes and returns the real on-disk size', async () => {
    const bytes = new TextEncoder().encode('hello download');
    const path = await stage('g1', bytes);
    const result = await store.finalize('g1', path);
    expect(result.sizeBytes).toBe(bytes.byteLength);
    // sha256("hello download")
    expect(result.sha256).toBe(
      'f13fd89cc6417f1028614173a449ca08607af977ad51d788e8749198273fa7c1'.slice(0, 64),
    );
  });

  it('refuses a reported path that does not match <root>/<downloadId>, and never hashes it', async () => {
    const outside = join(tmpdir(), 'not-the-download-root.bin');
    await writeFile(outside, 'evil');
    await expect(store.finalize('g1', outside)).rejects.toThrow(/does not match the expected/);
  });

  it('rejects an invalid download id before ever touching the filesystem', async () => {
    await expect(store.finalize('../escape', join(root, '../escape'))).rejects.toThrow(
      DownloadStoreError,
    );
  });

  it('refuses a symlink planted at the expected path (belt and braces)', async () => {
    const real = join(root, '..', 'planted-secret.bin');
    await writeFile(real, 'secret');
    const linkPath = join(root, 'g1');
    await symlink(real, linkPath);
    await expect(store.finalize('g1', linkPath)).rejects.toThrow(DownloadStoreError);
    await rm(real, { force: true });
  });

  it('E_DOWNLOAD_TOO_LARGE when the real size exceeds maxBytes, and removes the file', async () => {
    const small = createDownloadStore({
      root,
      logger: noopLogger,
      sweepIntervalMs: 0,
      maxBytes: 4,
    });
    const path = await stage('g2', new TextEncoder().encode('way too big'));
    await expect(small.finalize('g2', path)).rejects.toMatchObject({
      code: 'E_DOWNLOAD_TOO_LARGE',
    });
    await expect(readFile(path)).rejects.toThrow();
    await small.dispose();
  });
});

describe('DownloadStore.issueUrl / takeToken: single use', () => {
  it('mints a fetchable, root-relative URL when publicUrl is unset', async () => {
    const path = await stage('g1', new TextEncoder().encode('x'));
    await store.finalize('g1', path);
    const issued = store.issueUrl('g1', 'report.pdf', 'application/pdf', 1);
    expect(issued.url).toBe(`/v1/downloads/${issued.token}`);
  });

  it('mints an absolute URL under publicUrl when configured', async () => {
    const s = createDownloadStore({
      root,
      logger: noopLogger,
      sweepIntervalMs: 0,
      publicUrl: 'https://gw.example',
    });
    const issued = s.issueUrl('g1', 'report.pdf', 'application/pdf', 1);
    expect(issued.url).toBe(`https://gw.example/v1/downloads/${issued.token}`);
    await s.dispose();
  });

  it('takeToken resolves once, then 404s (returns null) on a second call for the same token', async () => {
    const path = await stage('g1', new TextEncoder().encode('bytes'));
    await store.finalize('g1', path);
    const issued = store.issueUrl('g1', 'report.pdf', 'application/pdf', 5);
    const first = store.takeToken(issued.token);
    expect(first).toEqual({
      downloadId: 'g1',
      path,
      safeName: 'report.pdf',
      mime: 'application/pdf',
      sizeBytes: 5,
    });
    expect(store.takeToken(issued.token)).toBeNull();
  });

  it('an unknown token resolves to null, indistinguishable from an already-used one', () => {
    expect(store.takeToken('never-issued')).toBeNull();
  });

  it('an expired token resolves to null even on its first ever fetch', async () => {
    let now = 1_000_000;
    const s = createDownloadStore({
      root,
      logger: noopLogger,
      sweepIntervalMs: 0,
      urlTtlMs: 10,
      now: () => now,
    });
    const issued = s.issueUrl('g1', 'x.bin', 'application/octet-stream', 1);
    now += 11;
    expect(s.takeToken(issued.token)).toBeNull();
    await s.dispose();
  });
});

describe('DownloadStore.discard', () => {
  it('removes the file and invalidates every token minted for that downloadId', async () => {
    const path = await stage('g1', new TextEncoder().encode('bytes'));
    await store.finalize('g1', path);
    const issued = store.issueUrl('g1', 'x.bin', 'application/octet-stream', 5);
    await store.discard('g1');
    expect(store.takeToken(issued.token)).toBeNull();
    await expect(readFile(path)).rejects.toThrow();
  });

  it('is idempotent: discarding an unknown or already-discarded id never throws', async () => {
    await expect(store.discard('never-existed')).resolves.toBeUndefined();
    await expect(store.discard('never-existed')).resolves.toBeUndefined();
  });
});

describe('DownloadStore.sweep', () => {
  it('removes tokens (and their files) past expiresAt, leaves live ones alone', async () => {
    let now = 0;
    const s = createDownloadStore({
      root,
      logger: noopLogger,
      sweepIntervalMs: 0,
      urlTtlMs: 100,
      now: () => now,
    });
    const pathA = await stage('a', new TextEncoder().encode('a'));
    const pathB = await stage('b', new TextEncoder().encode('b'));
    const a = s.issueUrl('a', 'a.bin', 'application/octet-stream', 1);
    now = 50;
    const b = s.issueUrl('b', 'b.bin', 'application/octet-stream', 1);
    now = 120; // a (issued at 0, ttl 100, expiresAt 100) is expired; b (issued at 50, ttl 100, expiresAt 150) is not yet
    const swept = await s.sweep();
    expect(swept).toBe(1);
    await expect(readFile(pathA)).rejects.toThrow();
    await expect(readFile(pathB)).resolves.toBeDefined();
    expect(s.takeToken(a.token)).toBeNull();
    expect(s.takeToken(b.token)).not.toBeNull();
    await s.dispose();
  });
});
