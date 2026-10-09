/**
 * The core-level (pre-wire) shapes `DownloadBridge` produces, mirroring
 * `../diagnostics/types.ts`'s own split: this package has no dependency on
 * `targetId`/`Envelope` framing (a `DownloadBridge` is already scoped to one
 * target by construction) and no dependency on hashing, staging directories,
 * signed URLs, or the `onDownload` hook, all of which belong to
 * `@browserglass/server` (`packages/server/src/downloads/download-store.ts`
 * and `session/managed-session.ts`'s `dispatchEffect`). This module is the
 * seam: everything above it is "what Chrome told us about one download",
 * everything below it is "what BrowserGlass does about that".
 */

/**
 * `Browser.downloadWillBegin`, relayed. `suggestedName` is the page's own
 * `download` attribute or `Content-Disposition` filename and is therefore
 * UNTRUSTED, exactly like `../diagnostics/types.ts`'s `ConsolePayload.text`:
 * it is never touched here and is never used as a filesystem path anywhere
 * in this package (see `DownloadBridge`'s module doc for where the actual
 * on-disk name comes from instead). `url` is likewise page-controlled.
 */
export interface DownloadStartedPayload {
  /** CDP's own `guid` for this download: opaque, server-minted by Chrome, safe to use as a map key or (see the server package) a path component. Never derived from anything the page supplied. */
  downloadId: string;
  suggestedName: string;
  url: string;
}

/** `Browser.downloadProgress` while `state === 'inProgress'`. */
export interface DownloadProgressPayload {
  downloadId: string;
  receivedBytes: number;
  /** `null` when Chrome does not know the final size (no `Content-Length`, a chunked response), matching `DownloadStarted.totalBytes`'s own wire doc. */
  totalBytes: number | null;
}

/**
 * `Browser.downloadProgress` at `state === 'completed'`.
 *
 * `path` is the ONE field in this whole module that is not safe to hand a
 * viewer: it is an absolute filesystem path on the machine running Chrome.
 * It exists here purely so the server package can open, hash, and re-home
 * the bytes before anything is sent back down the wire; core itself never
 * puts it on the wire, has no wire to put it on, and this type is not part
 * of `@browserglass/protocol`.
 */
export interface DownloadCompletedPayload {
  downloadId: string;
  suggestedName: string;
  path: string;
  sizeBytes: number;
}

/**
 * A download that will never reach {@link DownloadCompletedPayload}: Chrome
 * reported `state: 'canceled'`, or this collector gave up on it itself
 * (see `DownloadBridge.rebind`/`stop`'s doc for the two cases where a
 * download in flight is deliberately abandoned rather than left to hang
 * forever).
 */
export interface DownloadFailedPayload {
  downloadId: string;
  reason: string;
}

/** Where a `DownloadBridge` delivers everything it observes. One `DownloadBridge` per target, exactly like `../diagnostics/types.ts`'s `DiagnosticsSink`. */
export interface DownloadSink {
  onDownloadStarted(e: DownloadStartedPayload): void;
  onDownloadProgress(e: DownloadProgressPayload): void;
  onDownloadCompleted(e: DownloadCompletedPayload): void;
  onDownloadFailed(e: DownloadFailedPayload): void;
}
