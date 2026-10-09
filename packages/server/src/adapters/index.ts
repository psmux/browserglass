/**
 * Framework adapters. `node:http` needs no adapter code
 * at all: `bg.handleRequest` plus `bg.attachUpgrade` is the whole
 * integration (see `test/adapters/node-http.test.ts`). Express needs only
 * the `body-parser` preflight seam, since `bg.rest()` is already standard
 * Express middleware. Fastify, Hono, and Next.js each get real glue code.
 */
export * from './express.js';
export * from './fastify.js';
export * from './hono.js';
export * from './nextjs.js';
