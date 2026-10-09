/**
 * The durable state file, `<stateDir>/runtime-host.json`. Written temp-then-fsync-
 * then-rename on every browser add or remove, never on a timer: a browser
 * that exists and is not in the file is exactly what reconciliation
 * cannot fix.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import type { HeadlessMode } from '@browserglass/protocol';
import { getBootId } from './boot-id.js';

/** One browser entry in the durable state file. */
export interface StateFileEntry {
  instanceId: string;
  /** The resolved, long-lived browser-main process pid (never the transient `spawnPid`, see `spawn.ts`). */
  pid: number;
  pgid: number;
  containerId: string | null;
  startedAt: number;
  cdpUrl: string;
  browserGuid: string;
  profilePath: string;
  profileFence: number;
  engineVersion: string;
  channel: string;
  headless: HeadlessMode;
  displayName: string | null;
  downloadDir: string | null;
  labels: Readonly<Record<string, string>>;
}

/** The whole state file's shape. */
export interface StateFileContents {
  version: 1;
  nodeId: string;
  runtimeKind: 'host';
  writerPid: number;
  writerBootId: string;
  updatedAt: number;
  browsers: StateFileEntry[];
}

function emptyContents(nodeId: string): StateFileContents {
  return {
    version: 1,
    nodeId,
    runtimeKind: 'host',
    writerPid: process.pid,
    writerBootId: getBootId(),
    updatedAt: Date.now(),
    browsers: [],
  };
}

/** Result of {@link loadStateFile}: the contents plus whether the file was missing, corrupt, or a clean read. */
export interface LoadedStateFile {
  contents: StateFileContents;
  status: 'missing' | 'corrupt' | 'ok';
}

/**
 * Reads the state file. A missing file is treated as an empty list (the
 * normal first-boot case). A file that fails to parse is logged by the
 * caller at `warn` via the returned `'corrupt'` status; this function
 * itself only reads, it does not move the corrupt file aside (that is
 * {@link quarantineCorruptStateFile}'s job, called explicitly by the
 * reconciliation flow so the decision to touch disk stays visible at the
 * call site).
 */
export function loadStateFile(path: string, nodeId: string): LoadedStateFile {
  if (!existsSync(path)) {
    return { contents: emptyContents(nodeId), status: 'missing' };
  }
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as StateFileContents;
    if (parsed.version !== 1 || !Array.isArray(parsed.browsers)) {
      return { contents: emptyContents(nodeId), status: 'corrupt' };
    }
    return { contents: parsed, status: 'ok' };
  } catch {
    return { contents: emptyContents(nodeId), status: 'corrupt' };
  }
}

/** Moves an unparseable state file aside as `runtime-host.json.corrupt.<ts>` (startup reconciliation step 1). */
export function quarantineCorruptStateFile(path: string): void {
  if (!existsSync(path)) return;
  renameSync(path, `${path}.corrupt.${Date.now()}`);
}

/**
 * Writes `contents` to `path` with the required discipline: build in
 * memory, write to `<path>.tmp` in the same directory, `fsync` the file
 * descriptor, then `rename` over the real file (atomic on every target
 * filesystem, and same-directory keeps it on the same filesystem so the
 * rename cannot silently become a copy).
 */
export function writeStateFileAtomic(path: string, contents: StateFileContents): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  const json = JSON.stringify(contents, null, 2);
  const fd = openSync(tmpPath, 'w');
  try {
    writeSync(fd, json, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, path);
}

/**
 * In-process owner of one node's state file: holds the current contents,
 * and persists on every {@link StateFileStore.add}/{@link StateFileStore.remove}
 * call, never on a timer.
 */
export class StateFileStore {
  readonly path: string;
  private contents: StateFileContents;

  private constructor(path: string, contents: StateFileContents) {
    this.path = path;
    this.contents = contents;
  }

  /** Loads (or initialises) the store for `stateDir`. `stateDir` gets `runtime-host.json` joined onto it. */
  static open(
    stateDir: string,
    nodeId: string,
  ): { store: StateFileStore; loadStatus: LoadedStateFile['status'] } {
    const path = join(stateDir, 'runtime-host.json');
    const loaded = loadStateFile(path, nodeId);
    if (loaded.status === 'corrupt') quarantineCorruptStateFile(path);
    // Opening always stamps this process's own pid/bootId as the writer,
    // since from this point on this process is the one keeping the file
    // current; the entries themselves (and their own recorded fence, guid,
    // etc.) are what reconciliation actually reasons about.
    const contents: StateFileContents = {
      ...loaded.contents,
      nodeId,
      writerPid: process.pid,
      writerBootId: getBootId(),
    };
    const store = new StateFileStore(path, contents);
    return { store, loadStatus: loaded.status };
  }

  /** The entries as of the last read or write; callers must not mutate this array in place. */
  list(): readonly StateFileEntry[] {
    return this.contents.browsers;
  }

  get writerBootId(): string {
    return this.contents.writerBootId;
  }

  get writerPid(): number {
    return this.contents.writerPid;
  }

  /** Adds or replaces (by `instanceId`) one entry, then persists immediately. */
  add(entry: StateFileEntry): void {
    const others = this.contents.browsers.filter((b) => b.instanceId !== entry.instanceId);
    this.contents = { ...this.contents, browsers: [...others, entry], updatedAt: Date.now() };
    this.persist();
  }

  /** Removes one entry by `instanceId`, then persists immediately. No-op if absent. */
  remove(instanceId: string): void {
    const next = this.contents.browsers.filter((b) => b.instanceId !== instanceId);
    if (next.length === this.contents.browsers.length) return;
    this.contents = { ...this.contents, browsers: next, updatedAt: Date.now() };
    this.persist();
  }

  /** Replaces the whole entry list at once (used by reconciliation step 8, "rewrite with the adopted entries only"), then persists immediately. */
  replaceAll(entries: readonly StateFileEntry[]): void {
    this.contents = { ...this.contents, browsers: [...entries], updatedAt: Date.now() };
    this.persist();
  }

  private persist(): void {
    writeStateFileAtomic(this.path, this.contents);
  }
}
