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

/** {@link restSend}'s two stages. */
export interface RestSend<T> {
  /**
   * Resolves once the gateway has acknowledged the request: it answered
   * `100 Continue` (see {@link restSend}) or sent its full response. From
   * then on the gateway completes the request even if this process exits.
   * Rejects when the request fails before that.
   */
  readonly sent: Promise<void>;
  /** The parsed response, exactly as {@link restCall} would return it. */
  readonly done: Promise<T>;
}

/**
 * Like {@link restCall}, but reports separately when the gateway has
 * received the request, before its answer.
 *
 * Exists for a caller that must not wait for the answer. `bgls mcp`
 * releases its browsers when its MCP host lets go of it, and the host may
 * kill the process about two seconds later. A release under load can take
 * fifteen seconds to answer, but the gateway finishes it whether or not
 * anybody is still waiting, so what matters is that the gateway has it.
 *
 * Bytes flushed to the operating system are not that. Under load the
 * gateway can be slow to accept connections, and on Windows a connection
 * still waiting in its accept queue is reset when the client process
 * exits, so the request never arrives: four of seven releases were lost
 * that way while this resolved on the flush. So the request carries
 * `Expect: 100-continue`. Node's HTTP server answers that with `100
 * Continue` right before it hands the request to the gateway's handler,
 * which is the acknowledgement this waits for. A server that skips the
 * interim answer still sends a final response, which counts too.
 */
export function restSend<T>(
  connection: GatewayConnection,
  method: string,
  path: string,
): RestSend<T> {
  let resolveSent: () => void = () => undefined;
  let rejectSent: (err: unknown) => void = () => undefined;
  const sent = new Promise<void>((resolve, reject) => {
    resolveSent = resolve;
    rejectSent = reject;
  });
  const done = (async (): Promise<T> => {
    const url = new URL(`${connection.endpoint}${connection.basePath}${path}`);
    const { request } =
      url.protocol === 'https:' ? await import('node:https') : await import('node:http');
    return new Promise<T>((resolve, reject) => {
      const req = request(url, {
        method,
        headers: {
          authorization: `Bearer ${connection.token}`,
          'content-length': '0',
          expect: '100-continue',
        },
      });
      req.on('continue', () => resolveSent());
      req.on('error', (err) => {
        rejectSent(err);
        reject(err);
      });
      req.on('response', (res) => {
        resolveSent();
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = text.length > 0 ? (JSON.parse(text) as unknown) : undefined;
          } catch {
            parsed = undefined;
          }
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const errBody = parsed as
              | { readonly error?: { readonly code?: string; readonly message?: string } }
              | undefined;
            reject(
              new RestClientError(
                status,
                errBody?.error?.code ?? 'E_UNKNOWN',
                errBody?.error?.message ?? `HTTP ${status}`,
              ),
            );
            return;
          }
          resolve(parsed as T);
        });
      });
      req.end();
    });
  })();
  // `sent` is settled by the request's own events; a failure before the
  // request even exists (a bad URL) has to reach it too.
  done.catch((err: unknown) => rejectSent(err));
  // A caller that only awaits one of the two must not see the other as an
  // unhandled rejection.
  sent.catch(() => undefined);
  return { sent, done };
}
