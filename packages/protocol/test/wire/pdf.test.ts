import { describe, expect, it } from 'vitest';
import { DEFAULT_LIMITS } from '../../src/wire/limits.js';
import {
  MAX_INLINE_PDF_BYTES,
  type PagePdfGet,
  type PagePdfGot,
} from '../../src/wire/messages/pdf.js';

/**
 * `PagePdfGot`'s two delivery shapes (`./pdf.ts`'s module doc, "the two
 * delivery shapes"): inline `data` below `MAX_INLINE_PDF_BYTES`, or
 * `downloadId`/`url`/`expiresAt`/`sha256` at or above it, mutually
 * exclusive fields on the SAME message type. Mirrors
 * `pagemap.test.ts`'s own "fields are absent, not empty" pattern: a
 * caller reading `'downloadId' in reply` must see it truly absent for an
 * inline reply, not present-and-undefined, and vice versa.
 */
describe('PagePdfGot: the two delivery shapes are absent, not empty, on the other side', () => {
  it('round trips an inline reply with no downloadId/url/expiresAt/sha256 fields', () => {
    const msg: PagePdfGot = {
      v: 1,
      t: 'page.pdf.got',
      ts: Date.now(),
      pdfId: 'pdf_1',
      targetId: 'tgt_00000000000000000000000001',
      sizeBytes: 1024,
      gen: 3,
      data: 'ZmFrZQ==',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as PagePdfGot;
    expect(roundTripped.data).toBe('ZmFrZQ==');
    expect('downloadId' in roundTripped).toBe(false);
    expect('url' in roundTripped).toBe(false);
    expect('expiresAt' in roundTripped).toBe(false);
    expect('sha256' in roundTripped).toBe(false);
  });

  it('round trips a download-delivery reply with no data field', () => {
    const msg: PagePdfGot = {
      v: 1,
      t: 'page.pdf.got',
      ts: Date.now(),
      pdfId: 'pdf_2',
      targetId: 'tgt_00000000000000000000000001',
      sizeBytes: 5_000_000,
      gen: 3,
      downloadId: 'pdf_2',
      url: '/v1/downloads/abc123',
      expiresAt: Date.now() + 60000,
      sha256: 'a'.repeat(64),
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as PagePdfGot;
    expect('data' in roundTripped).toBe(false);
    expect(roundTripped.downloadId).toBe('pdf_2');
    expect(roundTripped.url).toBe('/v1/downloads/abc123');
    expect(roundTripped.sha256).toHaveLength(64);
  });
});

/** `PagePdfGet`'s paper-size fields, `format` versus explicit `widthInches`/`heightInches`: the type itself allows both to be present (enforcement is a runtime concern, `@browserglass/core`'s `PrintToPdfOptionsError`), but a well-formed request round trips either shape cleanly. */
describe('PagePdfGet: paper size fields round trip either shape', () => {
  it('a named format, with no width/height fields', () => {
    const msg: PagePdfGet = {
      v: 1,
      t: 'page.pdf.get',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      format: 'A4',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as PagePdfGet;
    expect(roundTripped.format).toBe('A4');
    expect('widthInches' in roundTripped).toBe(false);
  });

  it('explicit width/height, with no format field', () => {
    const msg: PagePdfGet = {
      v: 1,
      t: 'page.pdf.get',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      widthInches: 4,
      heightInches: 6,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as PagePdfGet;
    expect(roundTripped.widthInches).toBe(4);
    expect(roundTripped.heightInches).toBe(6);
    expect('format' in roundTripped).toBe(false);
  });
});

describe('MAX_INLINE_PDF_BYTES', () => {
  it("matches target.capture's own inline ceiling (limits.maxInlineCaptureBytes), the sibling this constant is deliberately kept equal to", () => {
    expect(MAX_INLINE_PDF_BYTES).toBe(DEFAULT_LIMITS.maxInlineCaptureBytes);
  });
});
