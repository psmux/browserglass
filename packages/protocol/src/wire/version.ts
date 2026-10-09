import { CloseCode } from './close-codes.js';

/** The result of a successful {@link negotiateVersion} call. */
export interface VersionNegotiationResult {
  /** The negotiated protocol major, authoritative from `welcome` onward. */
  chosen: number;
  /** True when `chosen !== offered[0]`; the server never silently downgrades. */
  downgraded: boolean;
}

/**
 * Thrown by {@link negotiateVersion} when no acceptable version exists.
 * Carries the close code (4104 `IncompatibleVersion`) and wire error code
 * a caller uses to close the connection.
 */
export class VersionNegotiationError extends Error {
  /** Always {@link CloseCode.IncompatibleVersion}. */
  readonly closeCode: number = CloseCode.IncompatibleVersion;
  /** Always `'bgls.error.version.unsupported'`. */
  readonly wireCode = 'bgls.error.version.unsupported';
  /** The server's supported majors, for `context.serverVersions` on the resulting `error` message. */
  readonly serverVersions: readonly number[];

  constructor(serverVersions: readonly number[]) {
    super(`no acceptable protocol version; server supports [${serverVersions.join(', ')}]`);
    this.name = 'VersionNegotiationError';
    this.serverVersions = serverVersions;
  }
}

/**
 * Implements `bgls.v1` version negotiation.
 *
 * ```
 * supported = server's supported majors, descending
 * offered   = hello.versions, client preference order
 * minAccept = hello.minVersion ?? min(offered)
 *
 * chosen = first v in offered where v is in supported
 * if chosen is undefined:
 *     chosen = max(v in supported where v <= max(offered) and v >= minAccept)
 * if chosen is undefined:
 *     throw (close 4104 IncompatibleVersion)
 * ```
 *
 * Throws {@link VersionNegotiationError} when no acceptable version exists.
 */
export function negotiateVersion(
  offered: readonly number[],
  minAccept: number,
  supported: readonly number[],
): VersionNegotiationResult {
  if (offered.length === 0) {
    throw new VersionNegotiationError(supported);
  }

  let chosen = offered.find((v) => supported.includes(v));

  if (chosen === undefined) {
    const maxOffered = Math.max(...offered);
    const candidates = supported.filter((v) => v <= maxOffered && v >= minAccept);
    chosen = candidates.length > 0 ? Math.max(...candidates) : undefined;
  }

  if (chosen === undefined) {
    throw new VersionNegotiationError(supported);
  }

  return { chosen, downgraded: chosen !== offered[0] };
}
