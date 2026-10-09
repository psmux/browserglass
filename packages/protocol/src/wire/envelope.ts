/**
 * The base shape of every `bgls.v1` control-channel message. Every field
 * except `v`, `t`, and `ts` is optional here at the type level; individual
 * message interfaces narrow `t` to a literal and add their own payload
 * fields spread at the top level, never nested.
 *
 * Payload field names on any extending interface must not collide with
 * `v`, `t`, `id`, `re`, `sid`, `vid`, `sq`, or `ts`.
 */
export interface Envelope {
  /** Protocol major version. Always `1` for this build. */
  v: 1;
  /** Message type: lowercase, dot separated, group first (e.g. `stream.subscribe`). */
  t: string;
  /** Correlation id, client generated, opaque, at most 64 characters. */
  id?: string;
  /** Echo of a request's `id` on the response. */
  re?: string;
  /** Session id; omitted when unambiguous (one session per socket in v1). */
  sid?: string;
  /** Viewer id; set by the server on messages describing a specific viewer. */
  vid?: string;
  /**
   * Control-channel sequence. Server-to-client only: monotonic from 1,
   * gapless, starting with `welcome` at `sq: 1`. Client-to-server messages
   * must not set this; the server ignores it if present.
   */
  sq?: number;
  /** Wall clock at send, Unix ms, advisory. */
  ts: number;
  /** Payload fields, spread at the top level, never nested under a key. */
  [k: string]: unknown;
}
