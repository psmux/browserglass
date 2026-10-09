import type { Envelope } from '../envelope.js';

/**
 * C to S: begin a file upload. The actual bytes travel over the binary
 * channel as `UPLOAD_CHUNK` (`msgType 0x03`, see `../binary.ts`), because a
 * 200MB base64 string in a JSON message would be 267MB of text.
 *
 * `uploadId` is the caller's own correlation handle and is the ONLY name a
 * caller ever gets for a staged file. It is never a filesystem path and is
 * never turned into one: the gateway keys its staging registry by this id
 * and derives the on-disk location itself from a root it owns
 * (`@browserglass/server`'s `src/files/upload-store.ts`). See
 * {@link UploadDone.path} for why no absolute path is disclosed either.
 */
export interface UploadBegin extends Envelope {
  t: 'upload.begin';
  /** Client generated, unique per session. */
  uploadId: string;
  targetId: string;
  name: string;
  sizeBytes: number;
  mime: string;
  lastModified?: number;
  /**
   * What the bytes are for. `'input'` is the one this build wires: the
   * caller intends to attach the finished file to an `<input type="file">`
   * with a later `files.set`. `'filechooser'` (answering an intercepted
   * native chooser through `filechooser.answer`), `'drop'` and `'profile'`
   * remain typed only.
   */
  purpose: 'input' | 'filechooser' | 'drop' | 'profile';
  /** Required when `purpose === 'filechooser'`. */
  chooserId?: string;
}

/** S to C: acknowledges `upload.begin` and dictates chunking parameters. */
export interface UploadAccepted extends Envelope {
  t: 'upload.accepted';
  uploadId: string;
  /** Server-dictated chunk size. */
  chunkBytes: number;
  /** Unacked chunks the client may have in flight. */
  maxInFlight: number;
  /**
   * The 16 raw bytes, as 32 lowercase hex characters, that identify this
   * upload inside an `UPLOAD_CHUNK` binary frame (`../binary.ts`'s
   * `encodeUploadChunkPayload`).
   *
   * The binary channel spends a fixed 16 bytes on the id, so it cannot
   * carry `uploadId` itself, which is a caller-chosen string of arbitrary
   * length. Rather than constrain callers to UUIDs (the conformance
   * vectors already carry a non-UUID `uploadId`, and a client picking its
   * own correlation ids is the more useful contract), the server mints the
   * binary key and hands it back here. A client that cannot use the binary
   * channel ignores this field and uses the REST upload routes instead.
   */
  binaryId?: string;
  /** When the staged bytes are discarded if the upload is never completed or attached, Unix ms. */
  expiresAt?: number;
}

/** S to C: periodic progress while chunks arrive. */
export interface UploadProgress extends Envelope {
  t: 'upload.progress';
  uploadId: string;
  receivedBytes: number;
}

/** C to S: all chunks sent; asks the server to finalise. */
export interface UploadComplete extends Envelope {
  t: 'upload.complete';
  uploadId: string;
  sha256?: string;
}

/**
 * C to S: abandon an upload and discard whatever bytes arrived.
 *
 * Idempotent and never answered with an error for an unknown id: a client
 * cancelling something the server already swept, or already discarded
 * because the socket dropped, has got the outcome it asked for. The server
 * also cancels a connection's own incomplete uploads when that connection
 * closes, so this exists for the deliberate case (the agent changed its
 * mind) rather than for cleanup, which is not left to the client.
 */
export interface UploadCancel extends Envelope {
  t: 'upload.cancel';
  uploadId: string;
}

/**
 * S to C: the upload is finalised and ready to attach.
 *
 * `path` is deliberately NOT an absolute filesystem path, despite its
 * name. It carries an opaque `bgls-upload://<uploadId>/<name>` reference,
 * where `<name>` is the sanitised basename the page's `File.name` will
 * report. Three reasons, in order of weight:
 *
 * 1. No API in this protocol accepts a filesystem path from a caller.
 *    `files.set` takes `uploadIds` only. Returning a real path would
 *    advertise a shape the server refuses to consume, and the first thing
 *    a caller does with a returned path is try to send it back.
 * 2. The staging root is an implementation detail of whichever node
 *    happens to run the browser. Disclosing it tells a tenant of a shared
 *    gateway where on the host its neighbours' bytes land, which is free
 *    reconnaissance for no gain.
 * 3. The name is the part callers actually want: it is what the page sees
 *    as the uploaded filename, and it may differ from the `name` sent in
 *    `upload.begin` if that name had to be sanitised.
 */
export interface UploadDone extends Envelope {
  t: 'upload.done';
  uploadId: string;
  path: string;
  sizeBytes: number;
  /** Lowercase hex SHA-256 of the received bytes, always computed server side. */
  sha256?: string;
}

/**
 * C to S: attach already-completed uploads to an `<input type="file">`,
 * the wire form of Playwright's `set_input_files`.
 *
 * Only `uploadIds` name the files: there is no field here, and there is
 * deliberately none anywhere in this protocol, by which a caller can name
 * a path on the machine running the browser. The server resolves each id
 * through its own staging registry (scoped to this session's tenant) into
 * a path it built itself, which is the whole reason attaching is a
 * two-step "stage, then attach" rather than a passthrough.
 *
 * `selector` is a CSS selector resolved with `DOM.querySelector` against
 * the target's main document. It is not a script and is never evaluated:
 * this path never touches the `Runtime` domain.
 */
export interface FilesSet extends Envelope {
  t: 'files.set';
  targetId: string;
  selector: string;
  uploadIds: string[];
}

/** S to C: the reply to {@link FilesSet}, naming what was actually attached. */
export interface FilesSetResult extends Envelope {
  t: 'files.set.result';
  targetId: string;
  selector: string;
  /** The sanitised basenames now attached, in the order the page will see them. */
  files: string[];
}

/** S to C: the remote page opened a native file chooser. */
export interface FileChooserOpened extends Envelope {
  t: 'filechooser.opened';
  chooserId: string;
  targetId: string;
  multiple: boolean;
  accept: string[];
  /** UNTRUSTED page text; see `packages/server/src/wire/sanitize.ts`. */
  elementDescription: string;
}

/** C to S: answers an open file chooser with completed upload ids, or cancels it. */
export interface FileChooserAnswer extends Envelope {
  t: 'filechooser.answer';
  chooserId: string;
  uploadIds: string[];
  cancel?: boolean;
}

/** S to C: the remote browser started a download. */
export interface DownloadStarted extends Envelope {
  t: 'download.started';
  downloadId: string;
  targetId: string;
  suggestedName: string;
  mime: string;
  totalBytes: number | null;
  url: string;
}

/** S to C: periodic download progress. */
export interface DownloadProgress extends Envelope {
  t: 'download.progress';
  downloadId: string;
  receivedBytes: number;
  totalBytes: number | null;
}

/**
 * S to C: the download finished. Downloads never stream through the
 * socket; this carries a signed, short-lived, single-use HTTP URL for a
 * normal browser download.
 */
export interface DownloadReady extends Envelope {
  t: 'download.ready';
  downloadId: string;
  sizeBytes: number;
  sha256: string;
  url: string;
  expiresAt: number;
}

/** S to C: the download failed. */
export interface DownloadFailed extends Envelope {
  t: 'download.failed';
  downloadId: string;
  reason: string;
}
