/**
 * Base64 decoding for the stream pipeline's source boundary. CDP delivers
 * `Page.screencastFrame.data` and `Page.captureScreenshot`'s result as
 * base64 text; decoding it happens exactly once, here, at the
 * `FrameSource` boundary, and never again downstream.
 *
 * Implemented as a plain table lookup rather than through `Buffer` or the
 * DOM `atob`: this package's `tsconfig` exposes neither ambient Node nor
 * DOM globals (see `../cdp/platform.ts`'s header comment for the same
 * constraint), and a hand-rolled decoder is a few lines and has no
 * environment dependency at all.
 */

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < B64_CHARS.length; i += 1) {
    table[B64_CHARS[i] as string] = i;
  }
  return table;
})();

/**
 * Decodes a base64 string (standard alphabet, `=` padding optional) into a
 * fresh `Uint8Array`. Non-alphabet characters (whitespace, newlines) are
 * skipped, which matches every real-world base64 producer's output
 * including CDP's.
 */
export function decodeBase64(input: string): Uint8Array {
  let cleaned = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (ch in B64_LOOKUP) {
      cleaned += ch;
    }
  }

  const len = cleaned.length;
  const byteLength = Math.floor((len * 6) / 8);
  const out = new Uint8Array(byteLength);

  let bitBuffer = 0;
  let bitCount = 0;
  let outIdx = 0;
  for (let i = 0; i < len; i += 1) {
    const val = B64_LOOKUP[cleaned[i] as string] as number;
    bitBuffer = (bitBuffer << 6) | val;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      out[outIdx] = (bitBuffer >> bitCount) & 0xff;
      outIdx += 1;
    }
  }
  return out;
}
