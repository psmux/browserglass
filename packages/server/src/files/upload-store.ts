/**
 * The staging area: where a caller's bytes land before Chrome is asked to
 * attach them.
 *
 * WHY THIS EXISTS AT ALL, WHICH IS THE INTERESTING PART OF FILE UPLOAD
 *
 * `DOM.setFileInputFiles` takes paths, and it opens them in the browser
 * process. The file therefore has to exist on the machine running Chrome,
 * which for a remote caller is not the machine holding the file. A Python
 * client on a laptop calling a gateway in a datacentre has bytes; the node
 * has a filesystem; nothing in CDP moves one to the other. That gap is why
 * upload is not a passthrough the way `navigate` is, and this module is
 * the thing that closes it: bytes arrive over HTTP or the socket, land in
 * a directory this process owns, and are named to Chrome by a path the
 * caller never sees and could not have chosen.
 *
 * LIFECYCLE
 *
 * `begin` -> `append`* -> `complete` -> (attached, possibly several times)
 * -> `discard`, or expiry. Every record carries an `expiresAt` and a
 * background sweep removes what is past it, so a caller that opens an
 * upload and vanishes costs one directory for at most one TTL rather than
 * forever.
 *
 * WHEN THE BYTES ARE ACTUALLY READ, WHICH DICTATES THE TTL
 *
 * Chrome does not read the file during `DOM.setFileInputFiles`. It builds
 * a `File` backed by the path and reads it lazily, when the page submits
 * the form, or calls `FileReader`, or streams it into a `fetch` body. On a
 * real checkout or signup form that can be minutes later, after the user (or the
 * agent) fills six more fields. So the staged file MUST outlive the
 * attach call. Deleting on attach, which is the obvious tidy thing to do,
 * produces an upload that reports success and then submits an empty or
 * failed file. That is why `retentionMs` is generous by default and why
 * `attach` extends the deadline rather than starting a countdown to
 * deletion.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not write to the `uploads` table in the store, even though that
 * table exists and is implemented (`@browserglass/protocol`'s `Upload` and
 * `store-sqlite`'s `createUpload`). A store row is a promise that the
 * bytes are findable later, and the bytes live on one node's local disk:
 * after a gateway restart the row would survive and the file would not,
 * which is a worse contract than having no row. Persisting uploads is a
 * real feature (it is what makes a staged file survive a restart, and what
 * a shared object store would back), and it is not this one.
 */

import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../config/logger.js';
import { containedPath, safeFileName } from './safe-name.js';

/** How much of one binary frame's payload the server asks a client to send per `UPLOAD_CHUNK`. 256 KiB is comfortably under the 1 MiB default `maxRequestBodyBytes` a REST chunk faces and small enough that a cancelled upload wastes little. */
export const DEFAULT_UPLOAD_CHUNK_BYTES = 256 * 1024;

/** How many unacked chunks a client may have in flight, reported in `upload.accepted`. */
export const DEFAULT_UPLOAD_MAX_IN_FLIGHT = 4;

/** The longest `uploadId` a caller may choose. Not a safety bound (the id never becomes a path component, see {@link UploadStore}) but a memory bound: the id is a map key held for the record's lifetime. */
export const MAX_UPLOAD_ID_CHARS = 128;

/** Why an {@link UploadStoreError} was raised. Each maps to one HTTP status at the REST edge and one wire error code on the socket. */
export type UploadStoreErrorCode =
  | 'E_UPLOAD_NOT_FOUND'
  | 'E_UPLOAD_ID_INVALID'
  | 'E_UPLOAD_DUPLICATE'
  | 'E_UPLOAD_TOO_LARGE'
  | 'E_UPLOAD_SIZE_MISMATCH'
  | 'E_UPLOAD_HASH_MISMATCH'
  | 'E_UPLOAD_NOT_READY'
  | 'E_UPLOAD_ALREADY_COMPLETE'
  | 'E_UPLOAD_LIMIT'
  | 'E_UPLOAD_GONE';

/** Everything this module refuses for a reason the caller can act on. Anything else (a full disk, a permissions problem) propagates as a plain error and becomes a 500. */
export class UploadStoreError extends Error {
  readonly code: UploadStoreErrorCode;
  constructor(code: UploadStoreErrorCode, message: string) {
    super(message);
    this.name = 'UploadStoreError';
    this.code = code;
  }
}

/** What a caller must supply to open an upload. */
export interface BeginUploadRequest {
  /** Caller-chosen correlation handle. Never a path component; see {@link UploadStore}. */
  readonly uploadId: string;
  /** The tenant this upload belongs to. Every later lookup is scoped to it, so one tenant can never resolve another's id. */
  readonly tenantId: string;
  /** The caller's filename. Sanitised before it touches disk; the sanitised form is returned. */
  readonly name: string;
  /** Declared size. Enforced: `append` refuses bytes past it and `complete` refuses a short upload. */
  readonly sizeBytes: number;
  readonly mime?: string;
  readonly instanceId?: string | null;
  readonly viewerId?: string | null;
}

/** What `begin` tells the caller, and what `upload.accepted` and `POST /v1/upload/init` are built from. */
export interface BeginUploadResult {
  readonly uploadId: string;
  /** The 16 raw bytes, hex, that name this upload inside an `UPLOAD_CHUNK` binary frame. */
  readonly binaryId: string;
  readonly chunkBytes: number;
  readonly maxInFlight: number;
  readonly expiresAt: number;
  /** The sanitised name, which may differ from the one sent. This is what the page's `File.name` will report. */
  readonly name: string;
}

/** A staged upload's public state. Deliberately carries no filesystem path: `UploadStore.pathFor` is the only way to obtain one and it is internal to this package. */
export interface UploadStatus {
  readonly uploadId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly mime: string;
  readonly declaredBytes: number;
  readonly receivedBytes: number;
  readonly status: 'staging' | 'ready';
  readonly sha256: string | null;
  readonly expiresAt: number;
  readonly instanceId: string | null;
}

interface StagedUpload {
  uploadId: string;
  binaryId: string;
  tenantId: string;
  instanceId: string | null;
  viewerId: string | null;
  name: string;
  mime: string;
  declaredBytes: number;
  receivedBytes: number;
  status: 'staging' | 'ready';
  dir: string;
  path: string;
  expiresAt: number;
  hash: ReturnType<typeof createHash> | null;
  sha256: string | null;
  handle: FileHandle | null;
  /** Serialises `append`/`complete` for one upload: two concurrent writes to the same handle would interleave at arbitrary offsets. */
  chain: Promise<void>;
}

/** Construction options. Every limit has a default so a caller that wants the feature does not have to configure it first. */
export interface UploadStoreOptions {
  /** The directory this store owns outright. Created if absent, emptied on `dispose()`. Nothing else may write here. */
  readonly root: string;
  readonly logger: Logger;
  /** Per-file ceiling. Defaults to `limits.uploadMaxBytes`'s own 100 MiB default. */
  readonly maxUploadBytes?: number;
  /** How long an INCOMPLETE upload may sit before it is swept. Short: an abandoned handshake is dead weight. */
  readonly stagingTtlMs?: number;
  /** How long a COMPLETED upload is kept. Long: Chrome reads the file lazily, see this module's doc. */
  readonly retentionMs?: number;
  /** Ceiling on simultaneously staged uploads across all tenants, so a swarm cannot open ten thousand of them. */
  readonly maxConcurrent?: number;
  /** Ceiling on total bytes held across all staged uploads, so a swarm cannot fill the disk with legal-sized files. */
  readonly maxTotalBytes?: number;
  /** How often the sweep runs. `0` disables the timer entirely, for tests that drive `sweep()` by hand. */
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
}

const DEFAULT_MAX_UPLOAD_BYTES = 104_857_600;
const DEFAULT_STAGING_TTL_MS = 5 * 60_000;
const DEFAULT_RETENTION_MS = 30 * 60_000;
const DEFAULT_MAX_CONCURRENT = 256;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

/** `uploadId` must be a plain token. Not for path safety (it never becomes one) but so it is loggable, comparable, and bounded. */
const UPLOAD_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The staging area for one gateway process.
 *
 * PATH SAFETY, THE WHOLE ARGUMENT IN ONE PLACE
 *
 * A staged file lives at `<root>/<binaryId>/<safeName>`. Three components,
 * and exactly one of them is influenced by the caller:
 *
 * - `<root>` is configuration. A caller cannot reach it.
 * - `<binaryId>` is 16 bytes from `crypto.randomBytes`, minted here. The
 *   caller-chosen `uploadId` is deliberately NOT used as the directory
 *   name even though it is unique and convenient, because that would make
 *   caller input a path component for no reason. It stays a map key.
 * - `<safeName>` is `safeFileName(req.name)`, and it is a path component
 *   because it has to be: Chrome reports `basename(path)` to the page as
 *   `File.name`, so a caller uploading `invoice-2024-03.pdf` must get that
 *   name on the form. See `safe-name.ts` for what that function removes
 *   and why, and for `containedPath`, the independent check that the
 *   composed path did not leave `<root>/<binaryId>` regardless.
 *
 * Symlinks are handled at the two moments they can actually be handled.
 * At create time the file is opened `wx` (`O_CREAT | O_EXCL`), which the
 * kernel refuses to satisfy if anything already exists at that path,
 * INCLUDING a symlink, and which cannot follow one. At attach time
 * `pathFor` does an `lstat` and requires a regular file, so a symlink
 * planted between completion and attachment (by something with write
 * access to the staging root, which is already a compromised host) does
 * not get handed to Chrome.
 *
 * UNC paths need no separate handling: `safeFileName` keeps only the last
 * component of the name it is given, so `\\\\attacker\\share\\payload`
 * reduces to `payload` before it is ever joined to anything.
 */
export interface UploadStore {
  begin(req: BeginUploadRequest): Promise<BeginUploadResult>;
  /** Appends `bytes` to a staging upload. Refuses once the declared size is reached. */
  append(uploadId: string, tenantId: string, bytes: Uint8Array): Promise<UploadStatus>;
  /** Closes the file and marks it ready. `expectedSha256`, when given, must match what was received. */
  complete(uploadId: string, tenantId: string, expectedSha256?: string): Promise<UploadStatus>;
  status(uploadId: string, tenantId: string): UploadStatus;
  /** Resolves a binary channel id (as sent in an `UPLOAD_CHUNK` frame) to the `uploadId` it belongs to, or `null`. */
  uploadIdForBinaryId(binaryId: string): string | null;
  /**
   * The absolute path of a completed upload, verified to still be a
   * regular file. The ONLY function in this build that produces a path for
   * `DOM.setFileInputFiles`, and it takes an id, never a path.
   */
  pathFor(uploadId: string, tenantId: string): Promise<string>;
  /** Pushes a completed upload's deadline out by the retention window. Called when it is attached to a page, because attaching is evidence it is about to be read. */
  touch(uploadId: string, tenantId: string): void;
  /** Removes an upload and its bytes. Idempotent: an unknown id is a no-op, not an error. */
  discard(uploadId: string, tenantId: string): Promise<void>;
  /** Removes everything past its deadline. Returns how many records went. */
  sweep(): Promise<number>;
  /** Stops the sweep timer, closes every open handle, and removes the staging root. */
  dispose(): Promise<void>;
}

/** Builds an {@link UploadStore} rooted at `opts.root`. */
export function createUploadStore(opts: UploadStoreOptions): UploadStore {
  const root = opts.root;
  const logger = opts.logger;
  const maxUploadBytes = opts.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  const stagingTtlMs = opts.stagingTtlMs ?? DEFAULT_STAGING_TTL_MS;
  const retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
  const maxConcurrent = opts.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());

  /** By `uploadId`. Not by `${tenantId}:${uploadId}`: the tenant is checked on every lookup instead, so a cross-tenant id guess is a not-found rather than a key that silently works. */
  const byUploadId = new Map<string, StagedUpload>();
  /** By `binaryId`, for the socket's `UPLOAD_CHUNK` frames, which carry 16 bytes and no tenant. */
  const byBinaryId = new Map<string, string>();
  /**
   * The staging budget, against `maxTotalBytes`.
   *
   * Counts DECLARED bytes, reserved the moment `begin` succeeds, not bytes
   * actually received. Counting what has arrived is the obvious reading of
   * "total staged bytes" and it is useless as a cap: a swarm opening two
   * hundred uploads that each declare 100 MB has received nothing at the
   * moment the budget is checked, so every one of them is admitted and the
   * disk fills anyway. Reserving at `begin` is what makes the ceiling
   * mean something. Every reclaim returns the same declared figure, so the
   * two sides cannot drift.
   */
  let budgetBytes = 0;
  let disposed = false;

  function record(uploadId: string, tenantId: string): StagedUpload {
    const rec = byUploadId.get(uploadId);
    // The tenant mismatch is reported as not-found, never as forbidden: a
    // distinguishable "wrong tenant" answer confirms that an id exists,
    // which is exactly the oracle an id-guessing caller wants.
    if (!rec || rec.tenantId !== tenantId) {
      throw new UploadStoreError('E_UPLOAD_NOT_FOUND', `no staged upload "${uploadId}"`);
    }
    return rec;
  }

  function toStatus(rec: StagedUpload): UploadStatus {
    return {
      uploadId: rec.uploadId,
      tenantId: rec.tenantId,
      name: rec.name,
      mime: rec.mime,
      declaredBytes: rec.declaredBytes,
      receivedBytes: rec.receivedBytes,
      status: rec.status,
      sha256: rec.sha256,
      expiresAt: rec.expiresAt,
      instanceId: rec.instanceId,
    };
  }

  /**
   * Removes one record's bytes and forgets it. `rm` is given Node's own
   * per-entry retry, which is the same answer `runtime-host`'s
   * `profile-fs.ts` `trash()` reaches for after its rename ladder: on
   * Windows a directory cannot be removed while any handle inside it is
   * open, and a handle can still be closing when this runs. Failure is
   * logged and swallowed: the record is gone from the map either way, and
   * a leftover directory is untidy rather than incorrect. The next
   * `dispose()` takes the whole root anyway.
   */
  async function reclaim(rec: StagedUpload): Promise<void> {
    if (!byUploadId.has(rec.uploadId)) return; // Already reclaimed; do not refund the budget twice.
    byUploadId.delete(rec.uploadId);
    byBinaryId.delete(rec.binaryId);
    budgetBytes -= rec.declaredBytes;
    if (budgetBytes < 0) budgetBytes = 0;
    if (rec.handle) {
      try {
        await rec.handle.close();
      } catch {
        // Already closed, or closing. Nothing useful to do.
      }
      rec.handle = null;
    }
    try {
      await rm(rec.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      logger.warn(
        {
          component: 'server',
          uploadId: rec.uploadId,
          error: err instanceof Error ? err.message : String(err),
        },
        'could not remove staged upload directory',
      );
    }
  }

  async function begin(req: BeginUploadRequest): Promise<BeginUploadResult> {
    if (disposed) throw new UploadStoreError('E_UPLOAD_GONE', 'this gateway is shutting down');
    if (!UPLOAD_ID_RE.test(req.uploadId)) {
      throw new UploadStoreError(
        'E_UPLOAD_ID_INVALID',
        `uploadId must be 1 to ${MAX_UPLOAD_ID_CHARS} characters of [A-Za-z0-9._:-]`,
      );
    }
    if (byUploadId.has(req.uploadId)) {
      throw new UploadStoreError('E_UPLOAD_DUPLICATE', `upload "${req.uploadId}" is already open`);
    }
    if (!Number.isInteger(req.sizeBytes) || req.sizeBytes < 0) {
      throw new UploadStoreError('E_UPLOAD_TOO_LARGE', 'sizeBytes must be a non-negative integer');
    }
    if (req.sizeBytes > maxUploadBytes) {
      throw new UploadStoreError(
        'E_UPLOAD_TOO_LARGE',
        `declared size ${req.sizeBytes} exceeds the ${maxUploadBytes} byte per-file limit`,
      );
    }
    if (byUploadId.size >= maxConcurrent) {
      throw new UploadStoreError(
        'E_UPLOAD_LIMIT',
        `this gateway already holds ${byUploadId.size} staged uploads, the configured maximum`,
      );
    }
    if (budgetBytes + req.sizeBytes > maxTotalBytes) {
      throw new UploadStoreError(
        'E_UPLOAD_LIMIT',
        `reserving ${req.sizeBytes} more bytes would exceed the ${maxTotalBytes} byte staging budget (${budgetBytes} already reserved)`,
      );
    }

    const binaryId = randomBytes(16).toString('hex');
    const name = safeFileName(req.name);
    const dir = join(root, binaryId);
    // `containedPath` runs against the per-upload directory, not the root:
    // the tighter the parent, the less an escape could reach even in
    // principle.
    const path = containedPath(dir, name);

    await mkdir(root, { recursive: true });
    // Non-recursive and therefore failing on EEXIST, deliberately. 16
    // random bytes will not collide, so an existing directory here means
    // something this store did not create is sitting in its root, and
    // writing into it would be the wrong response.
    await mkdir(dir);
    // 'wx' is O_CREAT | O_EXCL: refuses to open anything that already
    // exists, and by POSIX rule cannot follow a symlink at the final
    // component. See this interface's doc for the second half of the
    // symlink argument, at attach time.
    const handle = await open(path, 'wx');

    const rec: StagedUpload = {
      uploadId: req.uploadId,
      binaryId,
      tenantId: req.tenantId,
      instanceId: req.instanceId ?? null,
      viewerId: req.viewerId ?? null,
      name,
      mime: req.mime ?? 'application/octet-stream',
      declaredBytes: req.sizeBytes,
      receivedBytes: 0,
      status: 'staging',
      dir,
      path,
      expiresAt: now() + stagingTtlMs,
      hash: createHash('sha256'),
      sha256: null,
      handle,
      chain: Promise.resolve(),
    };
    byUploadId.set(rec.uploadId, rec);
    byBinaryId.set(binaryId, rec.uploadId);
    budgetBytes += rec.declaredBytes;
    return {
      uploadId: rec.uploadId,
      binaryId,
      chunkBytes: DEFAULT_UPLOAD_CHUNK_BYTES,
      maxInFlight: DEFAULT_UPLOAD_MAX_IN_FLIGHT,
      expiresAt: rec.expiresAt,
      name,
    };
  }

  /** Runs `fn` after whatever is already queued for `rec`, so writes to one handle never interleave. */
  function serialise<T>(rec: StagedUpload, fn: () => Promise<T>): Promise<T> {
    const result = rec.chain.then(fn);
    // The chain itself must not reject, or every later call on this upload
    // inherits the rejection. The caller still sees the real error through
    // `result`.
    rec.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function append(
    uploadId: string,
    tenantId: string,
    bytes: Uint8Array,
  ): Promise<UploadStatus> {
    const rec = record(uploadId, tenantId);
    if (rec.status !== 'staging' || rec.handle === null) {
      throw new UploadStoreError(
        'E_UPLOAD_ALREADY_COMPLETE',
        `upload "${uploadId}" is already complete`,
      );
    }
    return serialise(rec, async () => {
      const handle = rec.handle;
      if (handle === null) {
        throw new UploadStoreError(
          'E_UPLOAD_ALREADY_COMPLETE',
          `upload "${uploadId}" is already complete`,
        );
      }
      if (rec.receivedBytes + bytes.byteLength > rec.declaredBytes) {
        throw new UploadStoreError(
          'E_UPLOAD_TOO_LARGE',
          `upload "${uploadId}" declared ${rec.declaredBytes} bytes and would reach ${rec.receivedBytes + bytes.byteLength}`,
        );
      }
      await handle.write(bytes);
      rec.hash?.update(bytes);
      rec.receivedBytes += bytes.byteLength;
      // Each chunk that arrives is evidence the caller is still there, so
      // an upload in progress does not expire underneath a slow but
      // healthy transfer.
      rec.expiresAt = now() + stagingTtlMs;
      return toStatus(rec);
    });
  }

  async function complete(
    uploadId: string,
    tenantId: string,
    expectedSha256?: string,
  ): Promise<UploadStatus> {
    const rec = record(uploadId, tenantId);
    if (rec.status === 'ready') return toStatus(rec);
    return serialise(rec, async () => {
      if (rec.status === 'ready') return toStatus(rec);
      if (rec.receivedBytes !== rec.declaredBytes) {
        throw new UploadStoreError(
          'E_UPLOAD_SIZE_MISMATCH',
          `upload "${uploadId}" declared ${rec.declaredBytes} bytes but received ${rec.receivedBytes}`,
        );
      }
      const digest = rec.hash?.digest('hex') ?? null;
      rec.hash = null;
      if (expectedSha256 !== undefined && digest !== expectedSha256.toLowerCase()) {
        // The bytes on disk are not what the caller meant to send, so they
        // are removed rather than left staged: keeping them would let a
        // caller retry the attach step and get the corrupt file anyway.
        await reclaim(rec);
        throw new UploadStoreError(
          'E_UPLOAD_HASH_MISMATCH',
          `upload "${uploadId}" hashed to ${digest}, not the declared ${expectedSha256}`,
        );
      }
      rec.sha256 = digest;
      if (rec.handle) {
        // `sync()` before `close()`: Chrome opens this path from another
        // process, and on a crash between completion and attachment a
        // buffered tail would be silently missing rather than reported.
        try {
          await rec.handle.sync();
        } catch {
          // Not every filesystem supports fsync on every handle; the close
          // below still flushes through the OS page cache, which is what
          // another process reads.
        }
        await rec.handle.close();
        rec.handle = null;
      }
      rec.status = 'ready';
      rec.expiresAt = now() + retentionMs;
      return toStatus(rec);
    });
  }

  async function pathFor(uploadId: string, tenantId: string): Promise<string> {
    const rec = record(uploadId, tenantId);
    if (rec.status !== 'ready') {
      throw new UploadStoreError(
        'E_UPLOAD_NOT_READY',
        `upload "${uploadId}" has ${rec.receivedBytes} of ${rec.declaredBytes} bytes and has not been completed`,
      );
    }
    // `lstat`, not `stat`: `stat` follows a symlink and would report the
    // TARGET as a regular file, which is precisely the case being ruled
    // out. See this store's interface doc for why both halves of the
    // symlink argument are needed.
    const st = await lstat(rec.path);
    if (!st.isFile()) {
      await reclaim(rec);
      throw new UploadStoreError(
        'E_UPLOAD_GONE',
        `staged upload "${uploadId}" is no longer a regular file`,
      );
    }
    return rec.path;
  }

  async function sweep(): Promise<number> {
    const cutoff = now();
    const expired = [...byUploadId.values()].filter((r) => r.expiresAt <= cutoff);
    for (const rec of expired) await reclaim(rec);
    if (expired.length > 0) {
      logger.debug({ component: 'server', count: expired.length }, 'swept expired staged uploads');
    }
    return expired.length;
  }

  const timer =
    sweepIntervalMs > 0
      ? setInterval(() => {
          void sweep().catch((err: unknown) => {
            logger.warn(
              { component: 'server', error: err instanceof Error ? err.message : String(err) },
              'upload sweep failed',
            );
          });
        }, sweepIntervalMs)
      : null;
  timer?.unref?.();

  return {
    begin,
    append,
    complete,
    pathFor,
    sweep,

    status(uploadId, tenantId) {
      return toStatus(record(uploadId, tenantId));
    },

    uploadIdForBinaryId(binaryId) {
      return byBinaryId.get(binaryId) ?? null;
    },

    touch(uploadId, tenantId) {
      const rec = record(uploadId, tenantId);
      if (rec.status === 'ready') rec.expiresAt = now() + retentionMs;
    },

    async discard(uploadId, tenantId) {
      const rec = byUploadId.get(uploadId);
      if (!rec || rec.tenantId !== tenantId) return;
      await reclaim(rec);
    },

    async dispose() {
      disposed = true;
      if (timer) clearInterval(timer);
      for (const rec of [...byUploadId.values()]) await reclaim(rec);
      try {
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (err) {
        logger.warn(
          { component: 'server', error: err instanceof Error ? err.message : String(err) },
          'could not remove upload staging root',
        );
      }
    },
  };
}
