import type { Envelope } from '../envelope.js';

/**
 * `page.pdf.get` / `page.pdf.got`: renders one target as a PDF through
 * CDP's `Page.printToPDF` (`@browserglass/core`'s `pdf/print-to-pdf.ts`).
 *
 * ── Gated on `capture`, not a new capability ─────────────────────────────
 *
 * A PDF is a render of the page the caller can already SEE, the identical
 * authority `target.capture` (`./capture.ts`) already grants for a
 * screenshot: neither reads anything a screenshot could not already show
 * (no cookies, no storage, no script), and neither runs page script (this
 * is a CDP domain call, like `Page.captureScreenshot`, never
 * `Runtime.evaluate`). It is measured against `capture`, deliberately not
 * against `evaluate`: `evaluate`'s whole argument (`./evaluate.ts`,
 * `../capabilities.ts`'s own `Capability` doc) is that running script
 * reads cookies, storage, and tokens a rendered VIEW of the page does not
 * expose, and a PDF stays on the view side of that line exactly where a
 * screenshot does. Reusing `capture` also means `page.pdf.get` shares
 * `target.capture`'s own rate bucket (`captureRate`) rather than
 * getting a fresh limit to reason about independently: both are one CDP
 * round trip against the same renderer, and a caller already budgeted for
 * screenshot traffic should not need a second, separate ceiling for the
 * same class of request.
 *
 * ── Naming: `page.pdf.get`/`.got`, not `target.pdf`/`target.pdfed` ───────
 *
 * `target.capture` gets a `target.*` name because it is a verb Chrome's
 * own vocabulary already supplies a past tense for ("captured"). "Pdf" is
 * a noun, not a verb, so this pair follows `./a11y.ts`'s
 * `page.a11y.get`/`.got` and `./pagemap.ts`'s `page.map.get`/`.got`
 * instead: a noun that needs an explicit `.get`/`.got` suffix rather than
 * a verb that conjugates into one.
 *
 * ── Size is the actual design problem, and there is no `delivery` field ──
 *
 * `target.capture` lets a caller ask for `delivery: 'auto'|'inline'|'url'`
 * up front, because a screenshot's rough size is knowable before the
 * capture even runs (bounded by `maxDimension` and the codec), so "small,
 * ask inline" versus "large, ask for a URL" is a choice a caller can
 * usefully make in advance. A PDF has no equivalent up-front signal:
 * `Page.printToPDF` reports neither a page count nor a byte estimate
 * before it finishes composing the whole document, and a caller's own
 * paper-size/margin/scale choices interact with the PAGE'S content in ways
 * this door has no way to predict. So this pair carries no `delivery`
 * field at all: the server renders the PDF, measures what it actually
 * produced, and reports whichever delivery that size earned, honestly,
 * as data on the reply rather than as a request the caller had to guess
 * right.
 *
 * ── The two delivery shapes {@link PagePdfGot} can take ──────────────────
 *
 * Below {@link MAX_INLINE_PDF_BYTES}: `data` is set, base64, no
 * `downloadId`/`url`. At or above it: `data` is absent and `downloadId` +
 * `url` + `expiresAt` + `sha256` are set instead, the identical shape
 * `download.ready` (`./files.ts`) already uses for a real browser
 * download, reusing the same signed, short-lived, single-use URL
 * mechanism (`@browserglass/server`'s `DownloadStore`) rather than
 * inventing a second one for a PDF that happens to originate from this
 * process instead of from the page. This split is not optional: any
 * real page longer than a couple of screens produces a PDF well past
 * `MAX_INLINE_PDF_BYTES` (a single embedded font alone can be tens of
 * kilobytes), so the download path is not a rare fallback here the way
 * `target.captured.downloadId` is for a screenshot; it is the common
 * case, and is fully implemented rather than left as a documented gap.
 * When the gateway has no download store configured at all, or the
 * finished file exceeds the store's own size ceiling, generation is
 * refused outright as `bgls.error.capture.too_large` rather than the
 * reply silently omitting both `data` and `downloadId`: a caller must
 * never have to infer failure from an empty-looking success.
 */

/**
 * A named paper size, `@browserglass/core`'s own `PdfPaperFormat`
 * restated on the wire. Kept as a plain string union here (not imported
 * from core) for the same "no runtime dependency" reason every other
 * wire message in this package is: `@browserglass/protocol` ships inside
 * the browser bundle and has zero runtime dependencies (see
 * `../index.ts`'s module doc).
 */
export type PdfPaperFormat =
  | 'Letter'
  | 'Legal'
  | 'Tabloid'
  | 'Ledger'
  | 'A0'
  | 'A1'
  | 'A2'
  | 'A3'
  | 'A4'
  | 'A5'
  | 'A6';

/**
 * The largest `page.pdf.got` may deliver inline as base64 `data`, in raw
 * (pre-base64) bytes. 32768: identical to `./limits.ts`'s own
 * `maxInlineCaptureBytes`, `target.capture`'s inline ceiling, and for the
 * same reason: base64 inflates by 4/3, so 32768 raw bytes is roughly
 * 43.7 KiB of encoded text, comfortably inside the `maxControlMsgBytes`
 * (65536) headroom the control channel budgets for one JSON message,
 * envelope framing included. There is no reason for a PDF's inline
 * ceiling to differ from a screenshot's: both are base64 payloads riding
 * the identical control channel under the identical message-size
 * contract.
 */
export const MAX_INLINE_PDF_BYTES = 32768;

/**
 * C to S: renders `targetId` as a PDF via `Page.printToPDF`. Requires
 * `capture`; see this module's doc for the full scoping argument.
 */
export interface PagePdfGet extends Envelope {
  t: 'page.pdf.get';
  targetId: string;
  /** A named paper size. Mutually exclusive with `widthInches`/`heightInches`; giving both is `bgls.error.protocol.bad_envelope`. Default `'Letter'` when none of the three is given. */
  format?: PdfPaperFormat;
  /** Explicit paper width, inches. Must be given together with `heightInches`. */
  widthInches?: number;
  /** Explicit paper height, inches. Must be given together with `widthInches`. */
  heightInches?: number;
  /** Default false (portrait). */
  landscape?: boolean;
  /** Whether CSS backgrounds print. Default false, matching Chrome's own print dialog (unlike a screenshot, which always includes them: a PDF is understood to be print-bound, where ink cost is a real default-off reason). */
  printBackground?: boolean;
  /** 0.1 to 2. Default 1. */
  scale?: number;
  marginTopInches?: number;
  marginBottomInches?: number;
  marginLeftInches?: number;
  marginRightInches?: number;
  /** CDP's own page-range syntax, e.g. `'1-5, 8, 11-13'`. Default every page. */
  pageRanges?: string;
  /** HTML for the page header. Setting either this or `footerTemplate` turns header/footer display on; the other side, left unset, still gets Chrome's own default template rather than a blank one. */
  headerTemplate?: string;
  footerTemplate?: string;
}

/**
 * S to C, addressed to the requesting viewer only, never broadcast, for
 * the same reason `page.evaluated` and `page.a11y.got` are: a PDF is page
 * content. Answers {@link PagePdfGet}. See this module's doc, "the two
 * delivery shapes", for exactly which fields are set in each case.
 */
export interface PagePdfGot extends Envelope {
  t: 'page.pdf.got';
  /** Server-minted, opaque; doubles as the `downloadId` when this reply's delivery is the download shape (both name the same finished file). */
  pdfId: string;
  targetId: string;
  /** The real, measured size of the finished PDF. */
  sizeBytes: number;
  /** The target generation the render was taken against, `target.captured.gen`'s own meaning restated for this door. */
  gen: number;
  /** Set when `sizeBytes <= MAX_INLINE_PDF_BYTES`. base64, no `data:` prefix. */
  data?: string;
  /** Set when `sizeBytes > MAX_INLINE_PDF_BYTES`. Equal to `pdfId`; named separately to mirror `download.ready.downloadId`. */
  downloadId?: string;
  /** Set alongside `downloadId`. A short-lived, single-use HTTP URL, the identical mechanism and URL shape `download.ready.url` uses: absolute when the gateway has `publicUrl`, otherwise a host root path that already includes the base path. */
  url?: string;
  /** Set alongside `downloadId`. Epoch ms after which `url` stops working. */
  expiresAt?: number;
  /** Set alongside `downloadId`. Lowercase hex SHA-256 of the finished file. */
  sha256?: string;
}
