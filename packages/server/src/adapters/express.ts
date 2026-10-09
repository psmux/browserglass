import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../config/logger.js';
import { noopLogger } from '../config/logger.js';
import type { ResolvedConfig } from '../config/types.js';
import type { BrowserGlass } from '../index.js';
import { runPreflight } from '../lifecycle/preflight.js';
import type { PreflightResult } from '../lifecycle/types.js';

/**
 * `bg.rest()` is already a standard `(req, res, next)` Express middleware
 * (see `BrowserGlass.rest()` on the object `createBrowserGlass` returns).
 * Mount it at the application root, **not** scoped under `basePath`:
 *
 * ```ts
 * app.use(bg.rest());
 * ```
 *
 * This is deliberately not `app.use('/bgls', bg.rest())`. The reason:
 * `app.use(path, mw)` is exactly the Express feature that rewrites `req.url` to be relative to
 * `path` before `mw` ever sees it (`req.originalUrl` keeps the full
 * value), but `BrowserGlass.handleRequest` matches `req.url` against the
 * **full** `basePath` itself, and also answers the unscoped `/healthz`/
 * `/readyz` paths, which a `basePath`-scoped mount could never reach at
 * all. Mounting unscoped hands `handleRequest` the untouched URL and lets
 * its own routing (already correct for `basePath`, `/healthz`, and
 * `/readyz` alike) be the single source of truth; it already calls `next()`
 * for anything it does not claim, so this is exactly as safe for the rest
 * of the app as the scoped form would have been.
 *
 * {@link expressRest} is a thin, optional wrapper around `bg.rest()`, kept
 * only so the `body-parser` preflight check below can reliably find
 * BrowserGlass's own layer in the middleware stack by name: `bg.rest()`'s
 * returned closure is an anonymous function, indistinguishable from any
 * other anonymous middleware once mounted unscoped. Using `bg.rest()`
 * directly still works for serving requests; only
 * {@link checkExpressBodyParser}'s accuracy benefits from `expressRest`.
 *
 * The other Express specific surface this module ships is that same
 * `body-parser` preflight check:
 * `@browserglass/server` itself has no dependency on Express, so it cannot
 * inspect an `app`'s middleware stack to tell whether a global body parser
 * was mounted ahead of BrowserGlass, which silently drains upload bodies
 * to zero bytes. This module supplies that introspection.
 */

/** The name {@link expressRest}'s returned middleware is registered under, so {@link detectExpressBodyParser} can find it in the stack. */
const EXPRESS_REST_LAYER_NAME = 'browserglassRest';

/**
 * Wraps `bg.rest()` in a named function (`browserglassRest`), otherwise
 * behaving identically. Mount this (or `bg.rest()` itself) unscoped, per
 * this module's top level documentation:
 *
 * ```ts
 * app.use(expressRest(bg));
 * ```
 */
export function expressRest(
  bg: BrowserGlass,
): (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void {
  const rest = bg.rest();
  const wrapper = (
    req: IncomingMessage,
    res: ServerResponse,
    next: (err?: unknown) => void,
  ): void => {
    rest(req, res, next);
  };
  Object.defineProperty(wrapper, 'name', { value: EXPRESS_REST_LAYER_NAME, configurable: true });
  return wrapper;
}

/**
 * The minimal shape of an Express `Layer` this module reads: `name` (the
 * mounted middleware function's own name, e.g. `'jsonParser'` for
 * `express.json()`, or `EXPRESS_REST_LAYER_NAME` for {@link expressRest})
 * and `regexp` (the compiled path matcher Express builds for the layer's
 * mount path; `fast_slash` is true when the layer was mounted with no path
 * argument at all, i.e. it applies to every request).
 */
export interface ExpressLayerLike {
  readonly name?: string;
  readonly regexp?: {
    readonly fast_slash?: boolean;
    test(path: string): boolean;
  };
}

/**
 * The minimal shape of an Express `Application` this module reads: its
 * router's middleware stack, under whichever property name the installed
 * Express major version exposes it as (`_router` in Express 4, `router` in
 * Express 5).
 */
export interface ExpressAppLike {
  readonly _router?: { readonly stack?: readonly ExpressLayerLike[] };
  readonly router?: { readonly stack?: readonly ExpressLayerLike[] };
}

/**
 * Function names Express's built in body parsers (`express.json()`,
 * `express.urlencoded()`, `express.raw()`, `express.text()`) and the
 * standalone `body-parser` package register their middleware under.
 */
const BODY_PARSER_LAYER_NAMES: ReadonlySet<string> = new Set([
  'jsonParser',
  'urlencodedParser',
  'rawParser',
  'textParser',
  'bodyParser',
]);

/**
 * Walks `app`'s middleware stack looking for a body parser mounted with no
 * path restriction (`app.use(express.json())`, not
 * `app.use('/api', express.json())`) ahead of the layer named
 * `EXPRESS_REST_LAYER_NAME`, i.e. one registered via {@link expressRest}.
 * Returns the parser's registered function name (for example
 * `'jsonParser'`), or `null` when no such conflict is found. When
 * `expressRest`'s layer is not found at all (BrowserGlass mounted with
 * plain `bg.rest()` instead, or not mounted yet), the whole stack is
 * scanned, since whatever is already global will still run ahead of
 * whatever BrowserGlass is eventually mounted as.
 */
export function detectExpressBodyParser(app: ExpressAppLike, _basePath: string): string | null {
  const stack = app._router?.stack ?? app.router?.stack ?? [];
  let restIndex = stack.length;
  for (let i = 0; i < stack.length; i++) {
    if (stack[i]?.name === EXPRESS_REST_LAYER_NAME) {
      restIndex = i;
      break;
    }
  }
  for (let i = 0; i < restIndex; i++) {
    const layer = stack[i];
    if (
      layer?.name !== undefined &&
      BODY_PARSER_LAYER_NAMES.has(layer.name) &&
      layer.regexp?.fast_slash === true
    ) {
      return layer.name;
    }
  }
  return null;
}

/**
 * The complete list of named checks {@link import('../lifecycle/preflight.js').runPreflight}
 * runs. Mirrored here (rather than exported from `preflight.ts`, which has
 * no reason to know about Express) so {@link checkExpressBodyParser} can
 * isolate the one check it cares about via `preflight.skip`, reusing the
 * canonical `body-parser` check implementation and its exact message
 * wording instead of duplicating it.
 */
const ALL_PREFLIGHT_CHECK_NAMES: readonly string[] = [
  'chrome',
  'chrome-launch',
  'docker',
  'docker-shm',
  'profile-dir',
  'profile-space',
  'port',
  'store',
  'clock',
  'signing-key',
  'basepath-conflict',
  'body-parser',
];

/**
 * Runs BrowserGlass's `body-parser` preflight check against a real Express `app`,
 * independently of `bg.start()`: `createBrowserGlass`'s own `start()` has
 * no way to hand an Express specific detector into its internal preflight
 * run, since `@browserglass/server` carries no dependency on Express (the
 * same "no identity opinion" design rule extends to every framework, not
 * just auth). Call this once, after mounting BrowserGlass
 * (ideally via {@link expressRest}, see this module's top level
 * documentation) and before `bg.start()`, to get the same `warn` verdict
 * and the same "mount bg.rest() before the body parser" message
 * `start()`'s own preflight would produce if it could see into Express.
 */
export async function checkExpressBodyParser(
  config: ResolvedConfig,
  app: ExpressAppLike,
  logger: Logger = noopLogger,
): Promise<PreflightResult> {
  const skip = [
    ...new Set([
      ...config.preflight.skip,
      ...ALL_PREFLIGHT_CHECK_NAMES.filter((name) => name !== 'body-parser'),
    ]),
  ];
  const isolatedConfig: ResolvedConfig = {
    ...config,
    preflight: { ...config.preflight, skip },
  };
  const results = await runPreflight(
    isolatedConfig,
    { detectBodyParserAheadOfRest: () => detectExpressBodyParser(app, config.basePath) },
    logger,
  );
  const result = results.find((r) => r.name === 'body-parser');
  if (result === undefined) {
    throw new Error(
      'checkExpressBodyParser: the body-parser check did not run; this is an internal adapter bug.',
    );
  }
  return result;
}
