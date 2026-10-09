import { RestError } from './errors.js';

/** Opaque pagination cursors expire this many ms after being issued. */
export const CURSOR_TTL_MS = 10 * 60 * 1000;

interface CursorPayload {
  readonly after: string;
  readonly issuedAt: number;
}

/** Encodes an opaque, base64url cursor carrying `after` and an issue timestamp. */
export function encodeCursor(after: string): string {
  return Buffer.from(
    JSON.stringify({ after, issuedAt: Date.now() } satisfies CursorPayload),
    'utf8',
  ).toString('base64url');
}

/**
 * Decodes a cursor, throwing `RestError` `E_CURSOR_EXPIRED` (400) when it
 * is older than {@link CURSOR_TTL_MS} or malformed, per the "fails with
 * E_CURSOR_EXPIRED rather than silently restarting" rule.
 */
export function decodeCursor(cursor: string): string {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorPayload;
  } catch {
    throw new RestError(400, 'E_CURSOR_EXPIRED', 'Pagination cursor is malformed.');
  }
  if (typeof payload.after !== 'string' || typeof payload.issuedAt !== 'number') {
    throw new RestError(400, 'E_CURSOR_EXPIRED', 'Pagination cursor is malformed.');
  }
  if (Date.now() - payload.issuedAt > CURSOR_TTL_MS) {
    throw new RestError(
      400,
      'E_CURSOR_EXPIRED',
      'Pagination cursor expired; restart the listing from the beginning.',
    );
  }
  return payload.after;
}
