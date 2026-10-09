/**
 * `getResponseBodyFromCdp`: the CDP half of `@browserglass/protocol`'s
 * `page.responsebody.get`, and the ONE place in this build that sends
 * `Network.getResponseBody`.
 *
 * This module answers exactly one question: what does Chrome have
 * buffered, right now, for a `requestId` on an already-resolved CDP
 * session. It knows nothing about WHO may ask, or WHICH `requestId`s a
 * given caller has earned the right to read: that scoping bound (a
 * `requestId` a viewer was actually shown on its own `network.request`
 * feed, versus one it is merely guessing) lives in
 * `packages/server/src/session/managed-session.ts`'s `getResponseBody`,
 * enforced BEFORE this function is ever called. See
 * `@browserglass/protocol`'s `wire/messages/response-body.ts` for that
 * full argument; this file exists only to keep the CDP call, and the
 * "too large" bound, out of the session layer, mirroring the split
 * `./evaluate.ts` and `./accessibility.ts` each already make between "the
 * CDP mechanics" and "who is allowed to ask".
 *
 * `Network.getResponseBody` answering Chrome's own `-32000` "no resource
 * with given identifier found" (an evicted or never-buffered body, most
 * commonly a cross-origin navigation tearing down the session the body
 * lived on) is not handled here at all: it surfaces as an ordinary
 * `CdpError` throw, exactly like any other failed CDP command, and it is
 * `managed-session.ts`'s caller, not this module, that maps `CdpError`
 * codes to wire error codes.
 */

import { decodeBase64 } from '../stream/base64.js';
import type { CdpBridge } from './bridge.js';
import type { CdpSessionId } from './types.js';

/**
 * Every way a `Network.getResponseBody` call can end, as data. Only a
 * `CdpError` throw (the command itself did not complete) leaves this
 * module as an exception; `'too_large'` is a defined outcome, not a
 * failure, mirroring `./evaluate.ts`'s own `EvaluateOutcome`.
 */
export type ResponseBodyOutcome =
  | {
      readonly kind: 'ok';
      readonly body: string;
      readonly base64Encoded: boolean;
      readonly sizeBytes: number;
    }
  /** The body decodes to more than `maxBytes`. The body itself is discarded here, never passed up, so nothing above this line can accidentally serialise it anyway; see `./evaluate.ts`'s own `'too_large'` case, and `MAX_RESPONSE_BODY_BYTES`'s own doc for why this is refused rather than cut. */
  | { readonly kind: 'too_large'; readonly sizeBytes: number; readonly maxBytes: number };

/** UTF-8 byte length, mirroring `./accessibility.ts`'s own helper of the same name (duplicated rather than shared: neither module is exported for reuse by the other, and they have no other reason to depend on each other). */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Sends `Network.getResponseBody` for `requestId` on `sessionId`, and
 * measures the DECODED byte length of what came back:
 * `decodeBase64(body).length` when Chrome reports `base64Encoded: true`,
 * `utf8ByteLength(body)` otherwise. Measuring the decoded length rather
 * than the raw (possibly base64) wire length is `MAX_RESPONSE_BODY_BYTES`'s
 * own requirement: comparing encoded length would let a binary response
 * sneak roughly a third larger than a text one before being refused.
 */
export async function getResponseBodyFromCdp(
  bridge: CdpBridge,
  sessionId: CdpSessionId,
  requestId: string,
  maxBytes: number,
): Promise<ResponseBodyOutcome> {
  const raw = (await bridge.send('Network.getResponseBody', { requestId }, sessionId)) as {
    body?: string;
    base64Encoded?: boolean;
  };
  const body = raw.body ?? '';
  const base64Encoded = raw.base64Encoded === true;
  const sizeBytes = base64Encoded ? decodeBase64(body).length : utf8ByteLength(body);
  if (sizeBytes > maxBytes) {
    return { kind: 'too_large', sizeBytes, maxBytes };
  }
  return { kind: 'ok', body, base64Encoded, sizeBytes };
}
