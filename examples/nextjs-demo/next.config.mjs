import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal Next.js config. Everything BrowserGlass needs (the WebSocket
 * upgrade, the /browserglass/* REST and socket paths) is wired in
 * server.mjs, not here: App Router route handlers under app/api/** work
 * completely unmodified through the ordinary Next.js request handler.
 *
 * @type {import('next').NextConfig}
 */
const nextConfig = {
  reactStrictMode: true,
  // This workspace's `@browserglass/*` dependencies are `file:` references
  // to `../../packages/*` (deliberately, so this example resolves them
  // through their real, published `exports` maps, per this package's own
  // `package.json` comment). npm installs a `file:` dependency as a
  // symlink, and Next's webpack bundler, once it follows that symlink,
  // tries to bundle the real package source (and everything it imports,
  // including `sharp`'s native, platform conditional exports) into the
  // Route Handler's server bundle instead of leaving it as a plain
  // `require()` resolved at runtime the way an ordinary `node_modules`
  // package is. Listing these as server external packages restores that:
  // Route Handlers under app/api/** call into the real, unbundled
  // `@browserglass/server` package, exactly as server.mjs itself does.
  serverExternalPackages: [
    '@browserglass/server',
    '@browserglass/core',
    '@browserglass/router',
    '@browserglass/protocol',
    '@browserglass/store-sqlite',
    '@browserglass/runtime-host',
    'sharp',
    'better-sqlite3',
  ],
  // Silences "Next.js inferred your workspace root" (this directory has
  // its own package-lock.json, but the parent monorepo's pnpm-lock.yaml is
  // also on disk two levels up).
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
