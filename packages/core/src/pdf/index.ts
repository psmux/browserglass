/** `@browserglass/core`'s PDF capture module. See `print-to-pdf.ts`'s module doc for why this lives in its own directory rather than under `../stream/` or `../pagemap/`. */
export { printToPdf } from './print-to-pdf.js';
export {
  DEFAULT_PDF_PAPER_FORMAT,
  MAX_PDF_SCALE,
  MIN_PDF_SCALE,
  PDF_PAPER_FORMATS,
  PrintToPdfOptionsError,
  type PdfPaperFormat,
  type PrintToPdfOptions,
  type PrintToPdfResult,
} from './types.js';
