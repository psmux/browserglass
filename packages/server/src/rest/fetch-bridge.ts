import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A minimal, duck typed stand in for `IncomingMessage`: only the surface
 * `dispatchRest` and the route handlers actually touch (`method`, `url`,
 * `headers`, `socket.remoteAddress`, and async iteration over the body).
 * Real enough to drive the exact same code path REST framework adapters
 * use, without a Node `http` server underneath it.
 */
class FetchIncomingMessage {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly socket: { readonly remoteAddress: string | undefined };
  private readonly bodyStream: ReadableStream<Uint8Array> | null;

  constructor(request: Request, remoteAddress: string | undefined) {
    this.method = request.method;
    this.url = new URL(request.url).pathname + new URL(request.url).search;
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    this.headers = headers;
    this.socket = { remoteAddress };
    this.bodyStream = request.body;
  }

  [Symbol.asyncIterator](): AsyncIterator<Buffer> {
    const reader = this.bodyStream?.getReader();
    return {
      next: async (): Promise<IteratorResult<Buffer>> => {
        if (reader === undefined) return { done: true, value: undefined };
        const { done, value } = await reader.read();
        if (done) return { done: true, value: undefined };
        return { done: false, value: Buffer.from(value) };
      },
    };
  }
}

/** A minimal, duck typed stand in for `ServerResponse`, capturing everything written into an in-memory buffer. */
class FetchServerResponse {
  statusCode = 200;
  private readonly headers = new Map<string, string>();
  private readonly chunks: Buffer[] = [];
  private resolve!: (result: {
    status: number;
    headers: Map<string, string>;
    body: Buffer;
  }) => void;
  readonly done: Promise<{ status: number; headers: Map<string, string>; body: Buffer }>;

  constructor() {
    this.done = new Promise((resolve) => {
      this.resolve = resolve;
    });
  }

  setHeader(name: string, value: string): void {
    this.headers.set(name, value);
  }

  writeHead(status: number, headers?: Record<string, string>): void {
    this.statusCode = status;
    if (headers !== undefined) {
      for (const [k, v] of Object.entries(headers)) this.headers.set(k, v);
    }
  }

  end(chunk?: string | Buffer): void {
    if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    this.resolve({
      status: this.statusCode,
      headers: this.headers,
      body: Buffer.concat(this.chunks),
    });
  }
}

/** Builds the `{req, res, done}` triple `BrowserGlass.fetch` drives `handleRequest` with. */
export function nodeRequestFromFetch(
  request: Request,
  ctx?: { readonly remoteAddress?: string },
): {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly done: Promise<{ status: number; headers: Map<string, string>; body: Buffer }>;
} {
  const req = new FetchIncomingMessage(request, ctx?.remoteAddress);
  const res = new FetchServerResponse();
  return {
    req: req as unknown as IncomingMessage,
    res: res as unknown as ServerResponse,
    done: res.done,
  };
}

/** Converts the captured `{status, headers, body}` back into a standard web `Response`. */
export function fetchResponseFromNode(captured: {
  readonly status: number;
  readonly headers: Map<string, string>;
  readonly body: Buffer;
}): Response {
  const headers = new Headers();
  for (const [k, v] of captured.headers) headers.set(k, v);
  return new Response(captured.body, { status: captured.status, headers });
}
