import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import type { Server as HttpsServer } from 'node:https';
import type { BrowserGlass } from '../index.js';

/**
 * The minimal shape of a Fastify `FastifyRequest` this module reads: the
 * untouched Node `IncomingMessage` underneath it.
 */
export interface FastifyRequestLike {
  readonly raw: IncomingMessage;
}

/**
 * The minimal shape of a Fastify `FastifyReply` this module reads:
 * `hijack()` (tells Fastify the handler is answering the response itself,
 * over `raw`, and Fastify must not touch it again) and `raw`, the
 * untouched Node `ServerResponse`.
 */
export interface FastifyReplyLike {
  readonly raw: ServerResponse;
  hijack(): void;
}

/**
 * The minimal shape of a Fastify content type parser body this module
 * passes on: the raw, unread request stream. Registering a parser with no
 * `opts.parseAs` (Fastify 5 only accepts `'buffer'`/`'string'` there, not
 * `'stream'`) hands the parser this raw stream directly; passing it
 * straight to `done` leaves it completely unconsumed for
 * `bg.handleRequest` to read from `request.raw` itself.
 */
export type FastifyRawPayload = unknown;

/**
 * The minimal shape of a `FastifyInstance` this module needs, kept
 * dependency free: `@browserglass/server` carries no dependency on
 * Fastify (the same "no opinion" rule applies to every framework), so this plugin is typed against only the four methods
 * it actually calls rather than the real `FastifyInstance` type. A real
 * `FastifyInstance` satisfies this shape structurally, so
 * `fastify.register(fastifyBrowserGlass, opts)` works unmodified.
 */
export interface FastifyInstanceLike {
  readonly server: HttpServer | HttpsServer;
  addContentTypeParser(
    contentType: string,
    parser: (
      request: FastifyRequestLike,
      payload: FastifyRawPayload,
      done: (err: Error | null, body?: unknown) => void,
    ) => void,
  ): void;
  route(opts: {
    readonly method: readonly string[];
    readonly url: string;
    readonly bodyLimit?: number;
    readonly handler: (request: FastifyRequestLike, reply: FastifyReplyLike) => Promise<void>;
  }): void;
  addHook(name: 'onClose', fn: () => Promise<void>): void;
}

/**
 * Options accepted by {@link fastifyBrowserGlass}. `prefix` and `ws`
 * default to `bg.config.basePath` and `bg.config.wsPath` respectively, so
 * passing neither reproduces `bg`'s own configured paths. Pass both
 * explicitly only when mounting under a different prefix than the
 * configured `basePath` (default `/browserglass`).
 */
export interface FastifyBrowserGlassOptions {
  readonly bg: BrowserGlass;
  readonly prefix?: string;
  readonly ws?: string;
}

function writeNotFound(res: ServerResponse): void {
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { code: 'E_NOT_FOUND', message: 'not found' } }));
}

/**
 * The Fastify plugin form of BrowserGlass. Registers one wildcard route under
 * `prefix` that hands every request to `bg.handleRequest` (visible in
 * `fastify.printRoutes()`), a second, more specific wildcard for the
 * upload path with an effectively unlimited `bodyLimit` (Fastify's router
 * prefers the more specific match, so this one wins for upload requests
 * without affecting the general route's default limit; see the comment on
 * that route for why it is `Number.MAX_SAFE_INTEGER` rather than
 * `Infinity`), a raw body content type
 * parser for `application/octet-stream` scoped to the prefix so Fastify
 * does not reject an unrecognised content type before BrowserGlass ever
 * sees the request, an `onClose` hook that calls `bg.stop()` so
 * `fastify.close()` shuts BrowserGlass down automatically, and the
 * WebSocket upgrade handler installed on `fastify.server` via
 * `bg.attachUpgrade`.
 *
 * Every route hijacks the Fastify reply (`reply.hijack()`) and writes
 * through `reply.raw`/`request.raw`, since `bg.handleRequest` is a plain
 * `(req, res) => Promise<boolean>` over Node's own request/response types
 * and must own the response lifecycle itself; Fastify must not also try to
 * send one.
 */
export async function fastifyBrowserGlass(
  fastify: FastifyInstanceLike,
  opts: FastifyBrowserGlassOptions,
): Promise<void> {
  const { bg } = opts;
  const prefix = opts.prefix ?? bg.config.basePath;
  const wsPath = opts.ws ?? bg.config.wsPath;

  fastify.addContentTypeParser('application/octet-stream', (_request, payload, done) => {
    done(null, payload);
  });

  const handle = async (request: FastifyRequestLike, reply: FastifyReplyLike): Promise<void> => {
    reply.hijack();
    const handled = await bg.handleRequest(request.raw, reply.raw);
    if (!handled) writeNotFound(reply.raw);
  };

  const uploadPrefix = prefix === '/' ? '/v1/upload' : `${prefix}/v1/upload`;
  fastify.route({
    method: ['POST', 'PUT'],
    url: `${uploadPrefix}/*`,
    // "bodyLimit: Infinity" is not a value Fastify itself accepts
    // (it requires a finite positive integer); Number.MAX_SAFE_INTEGER is
    // the closest a real Fastify route option allows to "no limit". Moot
    // in practice regardless: this handler hijacks the reply and never
    // routes the body through Fastify's own body parsing/limit machinery
    // at all, reading it from `request.raw` inside BrowserGlass instead.
    bodyLimit: Number.MAX_SAFE_INTEGER,
    handler: handle,
  });

  fastify.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: prefix === '/' ? '/*' : `${prefix}/*`,
    handler: handle,
  });

  fastify.addHook('onClose', async () => {
    await bg.stop();
  });

  bg.attachUpgrade(fastify.server, { path: wsPath });
}
