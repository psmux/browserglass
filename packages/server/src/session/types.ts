/**
 * Shared types for `@browserglass/server`'s session layer
 * (`packages/server/src/session/**`): the sink one WS connection presents to
 * a {@link ManagedSession} so wire messages and binary frames can reach it
 * without the session layer knowing anything about sockets, and the wire
 * effects a `ManagedSession` produces for its owning connections to send.
 */

/**
 * The minimal surface a `ManagedSession` needs from one viewer's live WS
 * connection: open/buffered state (also `core`'s `AttachmentTransport`
 * shape, so a sink doubles as one directly), plus the ability to push a
 * control envelope or a binary frame. `sendEnvelope` stamps `sq` itself
 * (per-socket, gapless, `@browserglass/server`'s `ws/connection.ts` owns the
 * counter), so callers never set `sq`.
 */
export interface ConnectionSink {
  readonly viewerId: string;
  isOpen(): boolean;
  bufferedAmount(): number;
  send(buf: Uint8Array): void;
  /**
   * Generic over `T` rather than `Record<string, unknown> & {t:string}`:
   * every real wire message type (`Welcome`, `Goodbye`, `ControlGranted`,
   * ...) is a closed interface with no index signature, and `Envelope`'s
   * own `[k: string]: unknown` index signature makes `keyof Envelope`
   * resolve to `string` rather than its named fields (see
   * `wire/close.ts`'s `GoodbyeFields` comment), so a concrete message type
   * is not structurally assignable to `Record<string, unknown>` even
   * though every one of its fields is. A generic constrained only to
   * `{readonly t: string}` accepts any of them directly.
   */
  sendEnvelope<T extends { readonly t: string }>(env: T): void;
  close(code: number, reason: string): void;
}
