/**
 * `printToPdf`: one-shot `Page.printToPDF`, this package's PDF capture
 * primitive. Lives in its own `pdf/` directory rather than folding into
 * `../stream/` or `../pagemap/`, for two different reasons against two
 * different neighbours:
 *
 *  * NOT `../stream/`: everything under `stream/` implements
 *    `FrameSource`, a continuous, cadence-driven abstraction (a poll
 *    interval, a quality ladder, a "healthy" flag, frames arriving on
 *    their own schedule and fed to an `Attachment`). A PDF render is the
 *    opposite shape: one request, one CDP round trip, one reply, done.
 *    `managed-session.ts`'s own `capture()` (screenshot) already makes
 *    this same distinction in practice: `Page.captureScreenshot` gets a
 *    `ScreenshotPollSource` under `stream/` for the FRAME-SOURCE case, but
 *    a direct, undecorated `bridge.send()` call for the one-shot case,
 *    which is exactly the shape this module gives PDF.
 *  * NOT `../pagemap/`: `pagemap/` is also a one-shot, whole-page capture
 *    that can produce a large payload, the closest sibling this package
 *    has, but it captures STRUCTURE (a DOM tree, an accessibility merge,
 *    text blocks) built from several CDP domains fanned out and joined by
 *    a multi-phase orchestrator (`pagemap/capture.ts`'s own module doc).
 *    This module captures one opaque BINARY document from one CDP command.
 *    Folding a single `bridge.send()` call into a directory whose module
 *    doc is a multi-phase pipeline specification would misrepresent what
 *    this is.
 *
 * ── Why base64 in, base64 out, not `transferMode: 'ReturnAsStream'` ──────
 *
 * `Page.printToPDF` supports two transfer modes: `'ReturnAsBase64'`
 * (default), which answers the command itself with the whole PDF as a
 * base64 string, and `'ReturnAsStream'`, which answers with a stream
 * handle a caller then drains through repeated `IO.read` calls. This
 * module always uses the base64 form, for the same reason
 * `../stream/screenshot-poll-source.ts` and `managed-session.ts`'s
 * `capture()` both take `Page.captureScreenshot`'s base64 reply rather
 * than reaching for a streamed alternative: the caller two layers up
 * (`ManagedSession.pdf()`) needs the WHOLE byte count before it can decide
 * whether the result is small enough to inline on the control channel or
 * has to be written to disk and served as a signed download URL, so the
 * bytes are going to be fully buffered in memory either way. An `IO.read`
 * loop would only move that buffering into this module while adding a
 * second CDP domain and a multi-call state machine for no caller that
 * benefits from it.
 *
 * ── Why no session domain-enable here ─────────────────────────────────
 *
 * `Page.printToPDF`, like `Page.captureScreenshot`, answers without a
 * prior `Page.enable` on the session: confirmed by `capture()`'s own
 * precedent (`managed-session.ts`), which sends `Page.captureScreenshot`
 * with no enable step and has done so since that method was written. This
 * module follows the identical shape, one direct `bridge.send()` call, no
 * bracketing.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId } from '../cdp/types.js';
import {
  DEFAULT_PDF_PAPER_FORMAT,
  MAX_PDF_SCALE,
  MIN_PDF_SCALE,
  PDF_PAPER_FORMATS,
  PrintToPdfOptionsError,
} from './types.js';
import type { PrintToPdfOptions, PrintToPdfResult } from './types.js';

/** Resolves `format`/`widthInches`/`heightInches` into one `{width, height}` pair, inches, or throws {@link PrintToPdfOptionsError} for a shape that cannot resolve to exactly one. */
function resolvePaperSize(opts: PrintToPdfOptions): {
  readonly width: number;
  readonly height: number;
} {
  const hasWidth = opts.widthInches !== undefined;
  const hasHeight = opts.heightInches !== undefined;
  if (opts.format !== undefined && (hasWidth || hasHeight)) {
    throw new PrintToPdfOptionsError(
      'format is mutually exclusive with widthInches/heightInches; give one or the other, not both.',
    );
  }
  if (hasWidth !== hasHeight) {
    throw new PrintToPdfOptionsError('widthInches and heightInches must be given together.');
  }
  if (hasWidth && hasHeight) {
    const width = opts.widthInches as number;
    const height = opts.heightInches as number;
    if (!(width > 0) || !(height > 0)) {
      throw new PrintToPdfOptionsError(
        `widthInches and heightInches must both be positive; got ${width} x ${height}.`,
      );
    }
    return { width, height };
  }
  return PDF_PAPER_FORMATS[opts.format ?? DEFAULT_PDF_PAPER_FORMAT];
}

/**
 * Sends `Page.printToPDF` on `sessionId` and returns the encoded document.
 * Validates `opts` before sending anything (see {@link PrintToPdfOptionsError}
 * on each check above); a CDP-level failure (timeout, detached session,
 * Chrome refusing the render) propagates as whatever `bridge.send()`
 * itself throws (a `CdpError`, `../cdp/errors.ts`), unwrapped, matching
 * `capture()`'s own precedent of not re-wrapping CDP failures.
 */
export async function printToPdf(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  opts: PrintToPdfOptions = {},
): Promise<PrintToPdfResult> {
  if (opts.scale !== undefined && (opts.scale < MIN_PDF_SCALE || opts.scale > MAX_PDF_SCALE)) {
    throw new PrintToPdfOptionsError(
      `scale must be between ${MIN_PDF_SCALE} and ${MAX_PDF_SCALE}, got ${opts.scale}.`,
    );
  }
  const { width, height } = resolvePaperSize(opts);
  const displayHeaderFooter =
    opts.headerTemplate !== undefined || opts.footerTemplate !== undefined;

  const params: Record<string, unknown> = {
    paperWidth: width,
    paperHeight: height,
    transferMode: 'ReturnAsBase64',
    ...(opts.landscape !== undefined ? { landscape: opts.landscape } : {}),
    ...(opts.printBackground !== undefined ? { printBackground: opts.printBackground } : {}),
    ...(opts.scale !== undefined ? { scale: opts.scale } : {}),
    ...(opts.marginTopInches !== undefined ? { marginTop: opts.marginTopInches } : {}),
    ...(opts.marginBottomInches !== undefined ? { marginBottom: opts.marginBottomInches } : {}),
    ...(opts.marginLeftInches !== undefined ? { marginLeft: opts.marginLeftInches } : {}),
    ...(opts.marginRightInches !== undefined ? { marginRight: opts.marginRightInches } : {}),
    ...(opts.pageRanges !== undefined ? { pageRanges: opts.pageRanges } : {}),
    ...(displayHeaderFooter ? { displayHeaderFooter: true } : {}),
    ...(opts.headerTemplate !== undefined ? { headerTemplate: opts.headerTemplate } : {}),
    ...(opts.footerTemplate !== undefined ? { footerTemplate: opts.footerTemplate } : {}),
  };

  const result = (await bridge.send('Page.printToPDF', params, sessionId)) as { data: string };
  return { data: result.data };
}
