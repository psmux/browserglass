/**
 * `/v1/upload/*`: staging a caller's file bytes on the machine that runs
 * Chrome, so `POST /v1/instances/:instanceId/targets/:targetId/files`
 * (`routes/targets.ts`'s `setTargetFiles`) can attach them.
 *
 * These five routes were registered as blind 501 stubs before this. The
 * wire message types for the same handshake (`upload.begin`,
 * `upload.accepted`, `upload.complete`, `upload.done`) and the `uploads`
 * store table both already existed and were both inert; the handshake
 * below is the same one, over HTTP, because a Python or curl caller has no
 * `bgls.v1` socket and REST is the on-ramp that actually matters for one.
 *
 * WHY FOUR CALLS AND NOT ONE MULTIPART POST
 *
 * A single `multipart/form-data` POST would be fewer round trips and is
 * what most people reach for. It is rejected here for three reasons.
 * First, `dispatchRest`'s body reader buffers the WHOLE body into memory
 * and caps it at `limits.maxRequestBodyBytes` (1 MiB by default), so a
 * multi-megabyte file would need that ceiling raised for every route on the
 * gateway, not just this one. Second, multipart parsing is a dependency
 * and a parser-differential surface for a payload that is one file with no
 * fields. Third, and decisively, an init/chunk/complete handshake is the
 * shape that already works for a caller who has to resume: the same
 * `uploadId` accepts more bytes after a dropped connection, where a failed
 * multipart POST can only be retried whole.
 *
 * A caller who does not want to chunk simply sends the entire file as one
 * `PUT`, which is what a 60 KB PDF does.
 */

import type { IncomingMessage } from 'node:http';
import type { UploadStore } from '../../files/upload-store.js';
import { UploadStoreError } from '../../files/upload-store.js';
import { RestError, writeJson } from '../errors.js';
import type { RestContext, RestHandler } from '../types.js';

/** 503, matching `routes/targets.ts`'s `requireDriver`/`requireCdp`: a real dependency this gateway has not wired, not a blind 501. */
function requireUploads(ctx: RestContext): UploadStore {
  if (ctx.uploads === undefined) {
    throw new RestError(
      503,
      'E_UPLOADS_UNAVAILABLE',
      'This gateway has no upload staging area wired (RestContext.uploads is unset). The routes exist and are capability-gated; they need an UploadStore plugged in at the composition root.',
    );
  }
  return ctx.uploads;
}

/** The HTTP status each {@link UploadStoreError} deserves. Kept as data next to the routes that raise them so a new store error code cannot silently become a 500. */
const UPLOAD_ERROR_STATUS: Readonly<Record<string, number>> = Object.freeze({
  E_UPLOAD_NOT_FOUND: 404,
  E_UPLOAD_ID_INVALID: 400,
  E_UPLOAD_DUPLICATE: 409,
  E_UPLOAD_TOO_LARGE: 413,
  E_UPLOAD_SIZE_MISMATCH: 400,
  E_UPLOAD_HASH_MISMATCH: 400,
  E_UPLOAD_NOT_READY: 409,
  E_UPLOAD_ALREADY_COMPLETE: 409,
  E_UPLOAD_LIMIT: 429,
  E_UPLOAD_GONE: 410,
});

/** Rethrows an {@link UploadStoreError} as the `RestError` its code maps to, and anything else unchanged (a real bug still becomes a logged 500). */
export function mapUploadError(err: unknown): never {
  if (err instanceof UploadStoreError) {
    const status = UPLOAD_ERROR_STATUS[err.code] ?? 500;
    throw new RestError(status, err.code, err.message, { retryable: status === 429 });
  }
  throw err;
}

function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new RestError(400, 'E_MISSING_PARAM', `${name} is required.`);
  return value;
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RestError(400, 'E_BAD_JSON', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/**
 * Reads a raw binary request body, capped at `max`.
 *
 * `dispatchRest`'s own `readBody` is not reusable here: it decodes UTF-8
 * and parses JSON, which mangles binary, and it has already run by the
 * time a handler is called. It skips bodies for `GET`/`DELETE`/`HEAD`
 * only, so for the chunk route it would have consumed the stream first,
 * which is why that route is a `PUT` reading `rctx.req` directly and why
 * `router.ts` must not add `PUT` to its own body reader's skip list
 * without revisiting this.
 */
async function readRawBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > max) {
      throw new RestError(413, 'E_UPLOAD_TOO_LARGE', `Chunk exceeds the ${max} byte upload limit.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/**
 * `POST /v1/upload/init`, capability `upload`. Body:
 * `{uploadId?, name, sizeBytes, mime?, instanceId?}`.
 *
 * `uploadId` is optional here and required on the socket, because a REST
 * caller has no session to make its own ids unique within and a generated
 * one saves it the trouble. When supplied it is validated as a token, not
 * as a path: it never becomes one. See `files/upload-store.ts`.
 */
export const initUpload: RestHandler = async (ctx, rctx) => {
  const uploads = requireUploads(ctx);
  const body = asRecord(rctx.body);
  const name = body['name'];
  if (typeof name !== 'string' || name.length === 0) {
    throw new RestError(400, 'E_MISSING_PARAM', 'name is required.');
  }
  const sizeBytes = body['sizeBytes'];
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0) {
    throw new RestError(
      400,
      'E_MISSING_PARAM',
      'sizeBytes is required and must be a non-negative integer.',
    );
  }
  const uploadId =
    typeof body['uploadId'] === 'string' && body['uploadId'].length > 0
      ? (body['uploadId'] as string)
      : `up_${rctx.requestId.slice(4)}`;
  const mime = typeof body['mime'] === 'string' ? (body['mime'] as string) : undefined;
  const instanceId = typeof body['instanceId'] === 'string' ? (body['instanceId'] as string) : null;

  try {
    const result = await uploads.begin({
      uploadId,
      tenantId: rctx.principal.tenantId,
      name,
      sizeBytes,
      instanceId,
      viewerId: rctx.principal.sub,
      ...(mime !== undefined ? { mime } : {}),
    });
    writeJson(
      rctx.res,
      rctx.requestId,
      {
        uploadId: result.uploadId,
        name: result.name,
        chunkBytes: result.chunkBytes,
        maxInFlight: result.maxInFlight,
        expiresAt: result.expiresAt,
      },
      201,
    );
  } catch (err) {
    mapUploadError(err);
  }
};

/**
 * `PUT /v1/upload/:uploadId`, capability `upload`. Body: raw bytes,
 * appended at the current offset.
 *
 * Append-at-current-offset rather than an explicit `Content-Range`: the
 * store serialises writes per upload and reports `receivedBytes` in every
 * reply, so a caller resuming after a drop reads the offset from
 * `GET /v1/upload/:uploadId` and continues from there. Accepting a
 * caller-declared offset would mean supporting sparse writes and holes,
 * for a transfer that is sequential in every real client.
 */
export const putUploadChunk: RestHandler = async (ctx, rctx) => {
  const uploads = requireUploads(ctx);
  const uploadId = requireParam(rctx.params, 'uploadId');
  const bytes = await readRawBody(rctx.req, ctx.config.limits.uploadMaxBytes);
  try {
    const status = await uploads.append(uploadId, rctx.principal.tenantId, bytes);
    writeJson(rctx.res, rctx.requestId, {
      uploadId: status.uploadId,
      receivedBytes: status.receivedBytes,
      declaredBytes: status.declaredBytes,
      status: status.status,
    });
  } catch (err) {
    mapUploadError(err);
  }
};

/** `GET /v1/upload/:uploadId`, capability `upload`. The resume point and the completion state. */
export const getUpload: RestHandler = async (ctx, rctx) => {
  const uploads = requireUploads(ctx);
  const uploadId = requireParam(rctx.params, 'uploadId');
  try {
    writeJson(rctx.res, rctx.requestId, uploads.status(uploadId, rctx.principal.tenantId));
  } catch (err) {
    mapUploadError(err);
  }
};

/**
 * `POST /v1/upload/:uploadId/complete`, capability `upload`. Body:
 * `{sha256?}`.
 *
 * The digest is computed server side on every upload regardless, and is
 * returned here. Supplying one makes it a check rather than a report: a
 * mismatch discards the staged bytes instead of leaving a corrupt file
 * attachable.
 */
export const completeUpload: RestHandler = async (ctx, rctx) => {
  const uploads = requireUploads(ctx);
  const uploadId = requireParam(rctx.params, 'uploadId');
  const body = rctx.body === undefined ? {} : asRecord(rctx.body);
  const sha256 = typeof body['sha256'] === 'string' ? (body['sha256'] as string) : undefined;
  try {
    const status = await uploads.complete(uploadId, rctx.principal.tenantId, sha256);
    writeJson(rctx.res, rctx.requestId, {
      uploadId: status.uploadId,
      name: status.name,
      sizeBytes: status.receivedBytes,
      sha256: status.sha256,
      status: status.status,
      expiresAt: status.expiresAt,
    });
  } catch (err) {
    mapUploadError(err);
  }
};

/**
 * `DELETE /v1/upload/:uploadId`, capability `upload`. Discards the staged
 * bytes.
 *
 * Idempotent, and answers the same for an id this tenant never had. A
 * distinguishable 404 would confirm which ids exist, which is the oracle
 * an id-guessing caller wants; and "the bytes are not there" is true
 * either way, which is what the caller asked for.
 *
 * `200 {deleted: true}` rather than `204 No Content`, matching
 * `routes/instances.ts`'s and `routes/targets.ts`'s own deletes: every
 * route in this package answers with a JSON envelope, and the adapter that
 * serves this surface as a web `Response`
 * (`rest/fetch-bridge.ts`'s `fetchResponseFromNode`) cannot build a 204
 * from a captured body at all, since the `Response` constructor forbids a
 * body on a 204. Being the one route with a different shape would buy
 * nothing and break the Next.js/Hono adapters.
 *
 * Callers should call this once the page has actually consumed the file,
 * but nothing depends on their doing so: the store's retention window
 * reclaims anything they forget. See `files/upload-store.ts` on why the
 * window has to outlive the attach call by a long way.
 */
export const deleteUpload: RestHandler = async (ctx, rctx) => {
  const uploads = requireUploads(ctx);
  const uploadId = requireParam(rctx.params, 'uploadId');
  await uploads.discard(uploadId, rctx.principal.tenantId);
  writeJson(rctx.res, rctx.requestId, { uploadId, deleted: true });
};
