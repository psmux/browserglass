/**
 * A minimal REST client for talking to a running gateway's `/v1/*` API
 * (`packages/server/src/rest/**`), used by `bgls inspect` (and available
 * to any future command that needs it). Every response follows the one
 * error envelope shape; see `packages/server/src/rest/errors.ts`'s `RestErrorBody`.
 */

import type { GatewayConnection } from '../context.js';

/** Thrown when a REST call resolves with a non-2xx status. Carries the parsed error body when the response was valid JSON. */
export class RestClientError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RestClientError';
    this.status = status;
    this.code = code;
  }
}

/** Issues one REST call against `connection.endpoint`, with the resolved bearer token attached, and returns the parsed JSON body. */
export async function restCall<T>(
  connection: GatewayConnection,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${connection.endpoint}${connection.basePath}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${connection.token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const errBody = parsed as
      | { readonly error?: { readonly code?: string; readonly message?: string } }
      | undefined;
    throw new RestClientError(
      res.status,
      errBody?.error?.code ?? 'E_UNKNOWN',
      errBody?.error?.message ?? `HTTP ${res.status}`,
    );
  }
  return parsed as T;
}
