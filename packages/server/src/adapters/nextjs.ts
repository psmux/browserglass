import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { BrowserGlass } from '../index.js';

/**
 * Next.js support. A custom server is mandatory: there is no App
 * Router route handler path for a WebSocket upgrade. Two pieces ship here:
 *
 * 1. {@link createUpgradeDispatcher}, the explicit `shouldHandleUpgrade`
 *    dispatch ("Option B") for a `server.mjs` with an existing
 *    upgrade chain (terminal WS, collab WS, code-server proxy, HMR): the
 *    BrowserGlass branch runs first, so a `/browserglass/socket` upgrade
 *    never falls through to another comparison. A `server.mjs` with no
 *    existing chain can skip this and call `bg.attachUpgrade(httpServer,
 *    opts)` directly instead ("Option A"); both are already on
 *    `bg` itself and need no adapter code.
 * 2. {@link defineGlobalBg} / {@link getBg}, the `globalThis.__bg`
 *    accessor pair: App Router route handlers (`app/api/.../route.ts`) run
 *    inside Next's own module graph, not `server.mjs`'s, so they cannot
 *    close over the `bg` instance `server.mjs` constructs. `server.mjs`
 *    calls `defineGlobalBg(bg)` once, right after `createBrowserGlass`;
 *    `lib/bgls.ts` (or any route handler) calls `getBg()` to read it back,
 *    which throws a plain, readable message when the process was started
 *    as `next dev` rather than through `server.mjs`.
 */

/** The global BrowserGlass slot `defineGlobalBg`/`getBg` read and write. */
interface GlobalWithBg {
  __bg?: BrowserGlass;
}

/**
 * Stores `bg` on `globalThis.__bg`, so `getBg()` (typically called from
 * `lib/bgls.ts`, imported by App Router route handlers running in Next's
 * own module graph) can read it back. Call this once, in `server.mjs`,
 * immediately after `createBrowserGlass` returns and before `bg.start()`.
 */
export function defineGlobalBg(bg: BrowserGlass): void {
  (globalThis as GlobalWithBg).__bg = bg;
}

/**
 * Reads `bg` back from `globalThis.__bg`. Throws a plain, readable error
 * when nothing is there, which is exactly what happens under bare
 * `next dev`: that command never runs `server.mjs`, so
 * {@link defineGlobalBg} is never called and no App Router route can reach
 * BrowserGlass. Run `node server.mjs` (or your equivalent custom server
 * entry point) instead.
 */
export function getBg(): BrowserGlass {
  const bg = (globalThis as GlobalWithBg).__bg;
  if (bg === undefined) {
    throw new Error(
      'BrowserGlass is not available on globalThis.__bg. This usually means the process was ' +
        'started with `next dev` (or `next start`) directly, which never runs your custom server ' +
        'file. Run `node server.mjs` (or your equivalent custom server entry point) instead: it ' +
        'calls defineGlobalBg(bg) right after createBrowserGlass(), before Next.js boots.',
    );
  }
  return bg;
}

/** A `net.Server`'s `'upgrade'` event listener signature. */
export type UpgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Builds the `'upgrade'` event listener for a custom server that already
 * has its own upgrade chain ("Option B": terminal WS, collab WS,
 * code-server proxy, HMR, ...): checks `bg.shouldHandleUpgrade(req)`
 * first, claiming the socket via `bg.handleUpgrade` when it matches, and
 * falling through to `fallback` for everything else. Putting the
 * BrowserGlass branch first is load bearing: `shouldHandleUpgrade` is a
 * cheap, pure predicate (`req.url`/`req.headers` only, no socket
 * consumption), so checking it before any other comparison guarantees a
 * `/browserglass/socket` upgrade is never accidentally matched by an
 * earlier, broader pattern in an existing chain (for example a bare
 * `pathname.startsWith('/browser')` check).
 */
export function createUpgradeDispatcher(
  bg: BrowserGlass,
  fallback: UpgradeListener,
): UpgradeListener {
  return (req, socket, head) => {
    if (bg.shouldHandleUpgrade(req)) {
      bg.handleUpgrade(req, socket, head);
      return;
    }
    fallback(req, socket, head);
  };
}
