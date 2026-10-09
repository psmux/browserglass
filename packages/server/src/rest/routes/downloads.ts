/**
 * `GET /v1/downloads/:token`: the fetch side of `download.ready.url`.
 *
 * Deliberately `public: true` in `rest/router.ts` (no `Principal`, no
 * capability check): `@browserglass/protocol`'s own wire doc for
 * `DownloadReady.url` promises "a normal browser download", which means a
 * plain `<a href>` or `window.location` navigation the client hands
 * straight to the OS, carrying no `Authorization` header at all. The token
 * itself is the authorization (`download-store.ts`'s module doc spells out
 * why an unguessable, single-use, short-lived bearer token stands in for a
 * cryptographically signed one here); this route's whole job is to look it
 * up, stream the bytes exactly once, and clean up either way.
 */

import { createReadStream } from 'node:fs';
import type { DownloadStore } from '../../downloads/download-store.js';
import { RestError } from '../errors.js';
import type { RestContext, RestHandler } from '../types.js';

/** 503, matching `routes/uploads.ts`'s `requireUploads` pattern exactly: a real dependency this build has not wired, not a blind 404. */
function requireDownloads(ctx: RestContext): DownloadStore {
  if (ctx.downloads === undefined) {
    throw new RestError(
      503,
      'E_DOWNLOADS_UNAVAILABLE',
      'This gateway has no download store wired (RestContext.downloads is unset). The route exists and is public; it needs a DownloadStore plugged in at the composition root.',
    );
  }
  return ctx.downloads;
}

/** RFC 5987 `filename*` encoding for `Content-Disposition`, so a `safeFileName`d name outside ASCII (accented letters, CJK, an emoji a page's `download` attribute supplied) still displays correctly rather than being mangled or dropped. The plain `filename=` parameter alongside it is a pure-ASCII fallback for a client that does not understand `filename*` at all. */
function contentDisposition(safeName: string): string {
  const asciiFallback = safeName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
  const encoded = encodeURIComponent(safeName);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

export const fetchDownload: RestHandler = async (ctx, rctx) => {
  const token = rctx.params['token'];
  if (token === undefined) throw new RestError(400, 'E_MISSING_PARAM', 'token is required.');
  const store = requireDownloads(ctx);

  const taken = store.takeToken(token);
  if (!taken) {
    // The one honest answer either way, per `download-store.ts`'s
    // `takeToken` doc: a caller cannot tell "never existed" from "already
    // used" from "expired" without that distinction itself becoming a
    // usable oracle for guessing at other tokens.
    throw new RestError(
      404,
      'bgls.error.download.expired',
      'This download URL is invalid, expired, or has already been used.',
    );
  }

  rctx.res.writeHead(200, {
    'Content-Type': taken.mime,
    'Content-Length': String(taken.sizeBytes),
    'Content-Disposition': contentDisposition(taken.safeName),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });

  await new Promise<void>((resolveStream) => {
    const stream = createReadStream(taken.path);
    stream.on('error', (err) => {
      ctx.logger.error(
        { component: 'server', requestId: rctx.requestId, error: err.message },
        'failed to stream a completed download',
      );
      if (!rctx.res.headersSent) {
        rctx.res.writeHead(500);
      }
      rctx.res.end();
      resolveStream();
    });
    rctx.res.on('close', () => resolveStream());
    stream.pipe(rctx.res);
  });

  // Streamed exactly once, successfully or not: the file's only purpose
  // was to answer this one signed URL (see `download-store.ts`'s module
  // doc), and `takeToken` already made a second fetch of the same token
  // impossible regardless of whether this cleanup runs.
  await store.discard(taken.downloadId);
};
