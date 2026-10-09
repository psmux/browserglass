/**
 * The server side half of the download feature: what happens to a
 * completed file `@browserglass/core`'s `DownloadBridge` reports before
 * anything reaches a viewer.
 *
 * THE THREAT, STATED THE SAME WAY `files/safe-name.ts` STATES IT FOR UPLOAD
 *
 * A download feature ends with this process handing a viewer a URL that,
 * when fetched, streams bytes off this node's disk. If a caller (or a
 * hostile page) can influence WHICH bytes that URL reaches, the feature is
 * an arbitrary-file-read primitive with a browser shaped delivery
 * mechanism. Two things close that off, the same "primary defence plus
 * belt and braces" shape `safe-name.ts` uses for the upload direction:
 *
 * 1. THE PRIMARY DEFENCE: `DownloadBridge` arms `Page.setDownloadBehavior`
 *    with `behavior: 'allowAndName'`, so Chrome itself renames every
 *    completed download to its own opaque `guid` inside the ONE directory
 *    ({@link DownloadStoreOptions.root}) this store owns. The page's
 *    `suggestedFilename` never becomes a path component anywhere, not even
 *    transiently; `finalize()` below only ever reads
 *    `<root>/<downloadId>`, an id this process never derived from
 *    anything the page supplied.
 * 2. BELT AND BRACES: `finalize()` recomputes that expected path itself
 *    with `containedPath` (the same independent check `upload-store.ts`
 *    runs) rather than trusting the path `DownloadBridge` reports, and
 *    `lstat`s the result to refuse anything that is not a plain regular
 *    file, the same symlink defence `upload-store.ts`'s `pathFor` runs at
 *    attach time.
 *
 * WHAT A VIEWER ACTUALLY GETS
 *
 * `download.ready.url` (`@browserglass/protocol`'s wire doc) promises "a
 * signed, short-lived, single-use HTTP URL for a normal browser download".
 * This store's `issueUrl` mints an unguessable, server tracked, random
 * bearer token rather than a cryptographically signed one (there is no
 * existing signed-URL infrastructure in this codebase to reuse: `auth/jwt.ts`
 * signs `bgls.v1` session tokens, a different trust boundary with its own
 * `typ`/audience checks, and bolting a one-shot resource capability onto
 * it would be a second, unrelated use of session signing keys for no
 * safety benefit this design does not already get from unguessability plus
 * server side single-use tracking). The effective properties the wire doc
 * actually cares about, short lived, single use, unforgeable by guessing,
 * are all still true: 32 random bytes is not brute-forceable inside
 * `urlTtlMs`, and {@link DownloadStore.takeToken} removes the mapping
 * atomically, so a second fetch of the same URL 404s even mid-stream.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Logger } from '../config/logger.js';
import { containedPath } from '../files/safe-name.js';

/** `downloadId` here is always a CDP `guid`, never caller input, but it still becomes a path component (`<root>/<downloadId>`), so it is validated the same conservative way `upload-store.ts`'s `UPLOAD_ID_RE` validates a caller supplied `uploadId`: reaching a non-match means `DownloadBridge` or Chrome itself handed this store something it should not have, which is a bug report, not a user error. */
const DOWNLOAD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Byte length of the random bearer token {@link DownloadStore.issueUrl} mints, before hex encoding. 32 bytes (256 bits) is comfortably beyond brute force within any realistic `urlTtlMs`. */
const TOKEN_BYTES = 32;

const DEFAULT_MAX_BYTES = 524_288_000; // matches `limits.downloadMaxBytes`'s own default, config/resolve.ts
const DEFAULT_URL_TTL_MS = 60_000;
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;

export type DownloadStoreErrorCode =
  | 'E_DOWNLOAD_ID_INVALID'
  | 'E_DOWNLOAD_TOO_LARGE'
  | 'E_DOWNLOAD_NOT_FOUND'
  | 'E_DOWNLOAD_GONE';

/** Everything this module refuses for a reason a caller (here, always `ManagedSession` itself) can act on. */
export class DownloadStoreError extends Error {
  readonly code: DownloadStoreErrorCode;
  constructor(code: DownloadStoreErrorCode, message: string) {
    super(message);
    this.name = 'DownloadStoreError';
    this.code = code;
  }
}

export interface DownloadStoreOptions {
  /** The directory this store owns outright, and the same value `Session.startDownloadCapture` must be given as `downloadPath`. Created on demand by whichever mechanism creates upload's own root; unlike `UploadStore` this store never creates it itself, since `DownloadBridge`/Chrome is the one thing that writes into it. */
  readonly root: string;
  readonly logger: Logger;
  /** Per file ceiling. Defaults to `limits.downloadMaxBytes`'s own 500 MiB default. */
  readonly maxBytes?: number;
  /** How long an issued URL stays fetchable. Defaults to 60s. Referenced by name in `@browserglass/protocol`'s `bgls.error.download.expired` doc as `limits.downloadUrlTtlMs`. */
  readonly urlTtlMs?: number;
  /**
   * `ResolvedConfig.publicUrl`. Only its origin is used, the same way
   * `lifecycle/wiring.ts`'s `wsUrlFor` uses it for the socket URL. When
   * set, issued URLs are absolute (`<origin><basePath>/v1/downloads/<token>`);
   * when `null`, they are root relative (`<basePath>/v1/downloads/<token>`),
   * which is a complete path from the host root and resolves correctly
   * against any URL on the gateway's own origin.
   */
  readonly publicUrl?: string | null;
  /**
   * `ResolvedConfig.basePath` (default `/browserglass`), the prefix every
   * REST route is mounted under, `GET /v1/downloads/:token` included.
   * Without it an issued URL pointed at the host root, where nothing
   * answers. `'/'` or omitted means no prefix.
   */
  readonly basePath?: string;
  readonly sweepIntervalMs?: number;
  readonly now?: () => number;
}

interface IssuedToken {
  readonly downloadId: string;
  readonly path: string;
  readonly safeName: string;
  readonly mime: string;
  readonly sizeBytes: number;
  readonly expiresAt: number;
}

/** What `finalize()` hands back: the file's real, independently measured size and its SHA-256, the two fields `DownloadEvent`/`download.ready` both require. */
export interface FinalizedDownload {
  readonly sizeBytes: number;
  readonly sha256: string;
}

/**
 * What a resolved (and consumed) token hands the REST route to actually
 * stream. `downloadId` is included so the route can call {@link DownloadStore.discard}
 * once it is done streaming (successfully or not): `takeToken` already
 * removed the URL from the token map (that is what "single use" means),
 * but the FILE on disk survives that call on purpose, since the route
 * still needs to read it. Without a second, explicit cleanup step the
 * bytes would become an orphan `sweep()` can never find again, because
 * sweeping walks the token map and this token is no longer in it.
 */
export interface TakenDownloadToken {
  readonly downloadId: string;
  readonly path: string;
  readonly safeName: string;
  readonly mime: string;
  readonly sizeBytes: number;
}

export interface DownloadStore {
  readonly root: string;
  /**
   * Hashes and independently re-verifies the location of a completed
   * download. `suggestedName` is used only for size/shape validation
   * elsewhere (this method never touches the filesystem with it); see the
   * module doc for why it never becomes a path component.
   *
   * Throws `E_DOWNLOAD_TOO_LARGE` (file removed) when the real on-disk size
   * exceeds `maxBytes`. A caller (`ManagedSession`) that catches this is
   * expected to emit `download.failed` rather than `download.ready`.
   */
  finalize(downloadId: string, path: string): Promise<FinalizedDownload>;
  /** Mints a single use, short lived bearer token for an already-finalized download. `safeName` should already be `safeFileName`d by the caller (`files/safe-name.ts`); this method does not sanitise it again. */
  issueUrl(
    downloadId: string,
    safeName: string,
    mime: string,
    sizeBytes: number,
  ): { readonly token: string; readonly url: string; readonly expiresAt: number };
  /** Atomically resolves and invalidates `token`. `null` for an unknown, expired, or already-consumed token; the caller (the REST route) is expected to answer `bgls.error.download.expired` either way, since a caller cannot distinguish "never existed" from "already used" without that being itself a usable oracle. */
  takeToken(token: string): TakenDownloadToken | null;
  /** Removes a download's bytes outright without ever issuing a URL for it: the `onDownload` veto path, and the `E_DOWNLOAD_TOO_LARGE` path internally. Idempotent. */
  discard(downloadId: string): Promise<void>;
  /** Removes every token past its deadline. Returns how many were swept. The underlying FILE for an unclaimed download is removed here too: a `download.ready` nobody ever fetched must not hold disk forever. */
  sweep(): Promise<number>;
  dispose(): Promise<void>;
}

/**
 * Everything before `/v1/downloads/<token>` in an issued URL: the public
 * origin when one is configured, then the base path. Exported for tests.
 */
export function downloadUrlPrefix(publicUrl: string | null, basePath: string | undefined): string {
  const path = basePath === undefined || basePath === '/' ? '' : basePath.replace(/\/+$/, '');
  if (publicUrl === null || publicUrl === '') return path;
  let origin: string;
  try {
    origin = new URL(publicUrl).origin;
  } catch {
    origin = publicUrl.replace(/\/+$/, '');
  }
  return `${origin}${path}`;
}

export function createDownloadStore(opts: DownloadStoreOptions): DownloadStore {
  const root = opts.root;
  const logger = opts.logger;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const urlTtlMs = opts.urlTtlMs ?? DEFAULT_URL_TTL_MS;
  const publicUrl = opts.publicUrl ?? null;
  const urlPrefix = downloadUrlPrefix(publicUrl, opts.basePath);
  const sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());

  const byToken = new Map<string, IssuedToken>();

  /** The one and only place a `downloadId` becomes a filesystem path, mirroring `upload-store.ts`'s own single composition point. */
  function pathForDownload(downloadId: string): string {
    if (!DOWNLOAD_ID_RE.test(downloadId)) {
      throw new DownloadStoreError(
        'E_DOWNLOAD_ID_INVALID',
        `"${downloadId}" is not a valid download id`,
      );
    }
    return containedPath(root, downloadId);
  }

  async function removeFile(path: string): Promise<void> {
    try {
      await rm(path, { force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      logger.warn(
        { component: 'server', path, error: err instanceof Error ? err.message : String(err) },
        'could not remove staged download file',
      );
    }
  }

  async function finalize(downloadId: string, path: string): Promise<FinalizedDownload> {
    const expected = pathForDownload(downloadId);
    // Belt and braces: `DownloadBridge` reports `path` itself (either
    // CDP's own `filePath` or its own `<downloadPath>/<guid>` fallback,
    // see that class's doc), but this store never trusts it blindly. Any
    // mismatch means something upstream is not doing what this module's
    // security argument assumes, so it is treated the same way
    // `safe-name.ts`'s `PathEscapeError` is: a bug report, not a
    // recoverable caller error.
    if (resolve(path) !== expected) {
      throw new Error(
        `DownloadStore.finalize: reported path ${JSON.stringify(path)} does not match the expected ${JSON.stringify(expected)} for download ${JSON.stringify(downloadId)}. Refusing to hash or serve it.`,
      );
    }
    // `lstat`, not `stat`: refuses a symlink planted at this path between
    // Chrome finishing the write and this call running, the same defence
    // `upload-store.ts`'s `pathFor` applies at attach time.
    const lst = await lstat(expected);
    if (!lst.isFile()) {
      await removeFile(expected);
      throw new DownloadStoreError(
        'E_DOWNLOAD_GONE',
        `download "${downloadId}" is not a regular file`,
      );
    }
    const st = await stat(expected);
    if (st.size > maxBytes) {
      await removeFile(expected);
      throw new DownloadStoreError(
        'E_DOWNLOAD_TOO_LARGE',
        `download "${downloadId}" is ${st.size} bytes, exceeding the ${maxBytes} byte limit`,
      );
    }
    const sha256 = await new Promise<string>((resolvePromise, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(expected);
      stream.on('data', (chunk: string | Buffer) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', () => resolvePromise(hash.digest('hex')));
    });
    return { sizeBytes: st.size, sha256 };
  }

  function issueUrl(downloadId: string, safeName: string, mime: string, sizeBytes: number) {
    const path = pathForDownload(downloadId);
    const token = randomBytes(TOKEN_BYTES).toString('hex');
    const expiresAt = now() + urlTtlMs;
    byToken.set(token, { downloadId, path, safeName, mime, sizeBytes, expiresAt });
    return { token, url: `${urlPrefix}/v1/downloads/${token}`, expiresAt };
  }

  function takeToken(token: string): TakenDownloadToken | null {
    const entry = byToken.get(token);
    if (!entry) return null;
    // Consumed unconditionally on the way out, single use REGARDLESS of
    // whether it turns out to already be expired: an expired token must
    // not remain a live oracle for "does this token exist" one request
    // longer than an unexpired one would.
    byToken.delete(token);
    if (entry.expiresAt <= now()) return null;
    return {
      downloadId: entry.downloadId,
      path: entry.path,
      safeName: entry.safeName,
      mime: entry.mime,
      sizeBytes: entry.sizeBytes,
    };
  }

  async function discard(downloadId: string): Promise<void> {
    let path: string;
    try {
      path = pathForDownload(downloadId);
    } catch {
      return;
    }
    for (const [token, entry] of [...byToken]) {
      if (entry.downloadId === downloadId) byToken.delete(token);
    }
    await removeFile(path);
  }

  async function sweep(): Promise<number> {
    const cutoff = now();
    const expired = [...byToken.entries()].filter(([, e]) => e.expiresAt <= cutoff);
    for (const [token, entry] of expired) {
      byToken.delete(token);
      await removeFile(entry.path);
    }
    if (expired.length > 0) {
      logger.debug({ component: 'server', count: expired.length }, 'swept expired download tokens');
    }
    return expired.length;
  }

  const timer =
    sweepIntervalMs > 0
      ? setInterval(() => {
          void sweep().catch((err: unknown) => {
            logger.warn(
              { component: 'server', error: err instanceof Error ? err.message : String(err) },
              'download sweep failed',
            );
          });
        }, sweepIntervalMs)
      : null;
  timer?.unref?.();

  return {
    root,
    finalize,
    issueUrl,
    takeToken,
    discard,
    sweep,
    async dispose() {
      if (timer) clearInterval(timer);
      byToken.clear();
    },
  };
}
