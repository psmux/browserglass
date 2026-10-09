import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { StateFileStore, loadStateFile, writeStateFileAtomic } from '../src/state-file.js';

let dirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-runtime-host-state-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

const SAMPLE_ENTRY = {
  instanceId: 'inst_01',
  pid: 4242,
  pgid: 4242,
  containerId: null,
  startedAt: Date.now(),
  cdpUrl: 'http://127.0.0.1:9222',
  browserGuid: 'guid-a',
  profilePath: 'C:\\profiles\\p1',
  profileFence: 1,
  engineVersion: 'Chrome/151.0.0.0',
  channel: 'chrome',
  headless: 'new' as const,
  displayName: null,
  downloadDir: null,
  labels: {},
};

describe('loadStateFile', () => {
  it('treats a missing file as an empty list', () => {
    const dir = freshDir();
    const { contents, status } = loadStateFile(join(dir, 'runtime-host.json'), 'nod_1');
    expect(status).toBe('missing');
    expect(contents.browsers).toEqual([]);
  });

  it('reports corrupt for unparseable JSON and falls back to an empty list', () => {
    const dir = freshDir();
    const path = join(dir, 'runtime-host.json');
    writeFileSync(path, '{ not json');
    const { contents, status } = loadStateFile(path, 'nod_1');
    expect(status).toBe('corrupt');
    expect(contents.browsers).toEqual([]);
  });
});

describe('writeStateFileAtomic', () => {
  it('writes temp-then-rename: no partial file is ever left at the final path, and the write round-trips', () => {
    const dir = freshDir();
    const path = join(dir, 'runtime-host.json');
    writeStateFileAtomic(path, {
      version: 1,
      nodeId: 'nod_1',
      runtimeKind: 'host',
      writerPid: process.pid,
      writerBootId: 'boot-a',
      updatedAt: Date.now(),
      browsers: [SAMPLE_ENTRY],
    });
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const roundTripped = JSON.parse(readFileSync(path, 'utf8'));
    expect(roundTripped.browsers).toHaveLength(1);
    expect(roundTripped.browsers[0].instanceId).toBe('inst_01');
  });
});

describe('StateFileStore', () => {
  it('add() persists immediately, so a fresh open sees it without any explicit flush', () => {
    const dir = freshDir();
    const { store } = StateFileStore.open(dir, 'nod_1');
    store.add(SAMPLE_ENTRY);

    const { store: reopened, loadStatus } = StateFileStore.open(dir, 'nod_1');
    expect(loadStatus).toBe('ok');
    expect(reopened.list()).toHaveLength(1);
    expect(reopened.list()[0]?.instanceId).toBe('inst_01');
  });

  it('remove() persists immediately and is a no-op for an unknown instanceId', () => {
    const dir = freshDir();
    const { store } = StateFileStore.open(dir, 'nod_1');
    store.add(SAMPLE_ENTRY);
    store.remove('does-not-exist');
    expect(store.list()).toHaveLength(1);
    store.remove('inst_01');
    expect(store.list()).toHaveLength(0);

    const { store: reopened } = StateFileStore.open(dir, 'nod_1');
    expect(reopened.list()).toHaveLength(0);
  });

  it('add() replaces an existing entry with the same instanceId rather than duplicating it', () => {
    const dir = freshDir();
    const { store } = StateFileStore.open(dir, 'nod_1');
    store.add(SAMPLE_ENTRY);
    store.add({ ...SAMPLE_ENTRY, pid: 9999 });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.pid).toBe(9999);
  });

  it('records the current writerBootId and writerPid on open', () => {
    const dir = freshDir();
    const { store } = StateFileStore.open(dir, 'nod_1');
    expect(store.writerPid).toBe(process.pid);
    expect(store.writerBootId.length).toBeGreaterThan(0);
  });
});
