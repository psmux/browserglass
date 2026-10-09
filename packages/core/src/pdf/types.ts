/**
 * The core-level (pre-wire) shapes {@link printToPdf} takes and returns.
 * Mirrors `../downloads/types.ts`'s own split, restated for this module:
 * this package has no dependency on `targetId`/`Envelope` framing (a call
 * is already scoped to one CDP session by construction) and no dependency
 * on the inline-versus-download delivery decision, hashing, or a signed
 * URL, all of which belong to `@browserglass/server`
 * (`packages/server/src/session/managed-session.ts`'s `pdf()`). This
 * module's whole job is "ask Chrome to render one target as a PDF and hand
 * back the bytes it produced", nothing more.
 */

/**
 * A named paper size, resolved to inches by {@link PDF_PAPER_FORMATS}. The
 * eleven names Puppeteer and Chrome's own print dialog both ship: the six
 * US sizes plus ISO A0 through A6, deliberately not the full ISO series
 * (B-series, C-series envelopes) nothing in this codebase's callers has
 * asked for and CDP itself has no opinion on beyond "give me a width and a
 * height".
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

/** `PdfPaperFormat` resolved to `{width, height}` in inches, `Page.printToPDF`'s own unit. Values match Puppeteer's own `paperFormats` table (itself matching Chrome's print dialog defaults), so a caller migrating from either gets the identical sheet size. */
export const PDF_PAPER_FORMATS: Readonly<
  Record<PdfPaperFormat, { readonly width: number; readonly height: number }>
> = Object.freeze({
  Letter: Object.freeze({ width: 8.5, height: 11 }),
  Legal: Object.freeze({ width: 8.5, height: 14 }),
  Tabloid: Object.freeze({ width: 11, height: 17 }),
  Ledger: Object.freeze({ width: 17, height: 11 }),
  A0: Object.freeze({ width: 33.1, height: 46.8 }),
  A1: Object.freeze({ width: 23.4, height: 33.1 }),
  A2: Object.freeze({ width: 16.54, height: 23.4 }),
  A3: Object.freeze({ width: 11.7, height: 16.54 }),
  A4: Object.freeze({ width: 8.27, height: 11.7 }),
  A5: Object.freeze({ width: 5.83, height: 8.27 }),
  A6: Object.freeze({ width: 4.13, height: 5.83 }),
});

/** {@link printToPdf}'s default paper size when neither `format` nor `widthInches`/`heightInches` is given, matching `Page.printToPDF`'s own CDP default. */
export const DEFAULT_PDF_PAPER_FORMAT: PdfPaperFormat = 'Letter';

/** `scale`'s allowed range, `Page.printToPDF`'s own documented bound. */
export const MIN_PDF_SCALE = 0.1;
export const MAX_PDF_SCALE = 2;

/**
 * Options for {@link printToPdf}. Every field is optional and, when
 * omitted, `Page.printToPDF` applies its own CDP default rather than this
 * module silently picking one: the one exception is paper size, which
 * always resolves to {@link DEFAULT_PDF_PAPER_FORMAT} when neither
 * `format` nor an explicit width/height is given, because CDP itself
 * requires SOME `paperWidth`/`paperHeight` pair and "Letter" is the one
 * Chrome's own print dialog opens on.
 */
export interface PrintToPdfOptions {
  /** A named paper size. Mutually exclusive with `widthInches`/`heightInches`; {@link PrintToPdfOptionsError} when both are given. */
  format?: PdfPaperFormat;
  /** Explicit paper width, inches. Must be given together with `heightInches`, never alone. */
  widthInches?: number;
  /** Explicit paper height, inches. Must be given together with `widthInches`, never alone. */
  heightInches?: number;
  /** Default false (portrait). */
  landscape?: boolean;
  /** Whether backgrounds and CSS `background-color`/`background-image` print. Default false, matching Chrome's own print dialog default (and unlike a screenshot, which always includes them: a PDF is understood to be heading to a printer, where ink cost is a real, well known reason this defaults off). */
  printBackground?: boolean;
  /** Scale factor, {@link MIN_PDF_SCALE} to {@link MAX_PDF_SCALE}. Default 1. */
  scale?: number;
  marginTopInches?: number;
  marginBottomInches?: number;
  marginLeftInches?: number;
  marginRightInches?: number;
  /**
   * Page range to print, CDP's own syntax (e.g. `'1-5, 8, 11-13'`). Default
   * empty string, meaning every page. Not validated here: a malformed
   * range is Chrome's own `Page.printToPDF` to reject or interpret, not
   * this module's grammar to reimplement.
   */
  pageRanges?: string;
  /**
   * HTML for the page header. Setting either this or {@link footerTemplate}
   * implies `displayHeaderFooter: true`; a side left unset when the other
   * is given still gets Chrome's own default template for that side, not
   * a blank one. See CDP's own `Page.printToPDF` docs for the template
   * markup (`<span class="pageNumber">` and its siblings).
   */
  headerTemplate?: string;
  footerTemplate?: string;
}

/** Resolves {@link printToPdf}. */
export interface PrintToPdfResult {
  /** CDP's own `ReturnAsBase64` encoding: base64, no `data:` prefix, decoded nowhere in this package (see this module's doc). */
  data: string;
}

/**
 * Thrown by {@link printToPdf} for a caller-supplied option this module
 * can check before ever sending a CDP command, distinct from a `CdpError`
 * (`../cdp/errors.ts`), which means the COMMAND itself failed or timed
 * out. A caller (`ManagedSession.pdf()`) tells the two apart to answer a
 * malformed request with `bgls.error.protocol.bad_envelope` instead of a
 * `capture` category error implying the renderer, not the request, was at
 * fault.
 */
export class PrintToPdfOptionsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrintToPdfOptionsError';
  }
}
