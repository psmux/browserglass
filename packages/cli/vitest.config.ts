import { defineConfig } from 'vitest/config';

/**
 * `better-sqlite3` is a native addon (a `.node` binary), and it is a
 * dependency of `@browserglass/store-sqlite`, not of this package. Under
 * pnpm's strict layout that means it lives in
 * `packages/store-sqlite/node_modules/better-sqlite3` and is deliberately
 * NOT hoisted to the workspace root, so nothing that fails to declare it
 * can accidentally import it.
 *
 * Node's own resolver handles that fine at runtime: this package's
 * `node_modules/@browserglass/store-sqlite` is a symlink into
 * `packages/store-sqlite`, and the require walks up from there. Vite's
 * resolver does not, because it resolves bare specifiers from the
 * IMPORTER's root (this package) rather than from the module that actually
 * declares the dependency, and then tries to transform the result. A
 * `.node` binary cannot be transformed at all, so the failure was
 * `Failed to load url better-sqlite3 (resolved id: better-sqlite3)` at
 * collection time, taking five test FILES down before a single test in
 * them ran (`test/session-file.test.ts`, `test/doctor/checks.test.ts`,
 * `test/commands/instances.test.ts`, `test/commands/swarm.test.ts`,
 * `test/commands/swarm-affinity.test.ts`).
 *
 * Marking it external tells Vite to leave the specifier alone and let Node
 * resolve it, which is the correct handling for any native addon and is
 * why `packages/store-sqlite`'s own suite (59 tests) never needed this: it
 * declares the dependency directly, so the importer's root already
 * contains it.
 *
 * This was not caused by any source change. It had been masked for a long
 * time by `pnpm -w test`'s fail-fast ordering: earlier packages in the
 * recursive run aborted the whole run before it ever reached
 * `packages/cli`, so these five files were simply never collected.
 */
export default defineConfig({
  test: {
    // Expands an 8.3 short TEMP on Windows so fixture plugins written under
    // os.tmpdir() can be imported through vite-node. See the file's doc.
    setupFiles: ['./test/support/long-tmpdir.ts'],
    server: {
      deps: {
        // `@browserglass/store-sqlite` is externalised alongside the addon
        // itself: it is a workspace link, so Vite would otherwise process
        // its built `dist` as source and re-resolve `better-sqlite3` from
        // THIS package's root, which is the resolution that fails. Leaving
        // the whole package to Node keeps the require inside
        // `store-sqlite`, where the dependency is declared and present.
        // Regexes, not bare strings: the id Vite tests here is the RESOLVED
        // path (a `node_modules/better-sqlite3/lib/index.js` under this
        // package's pnpm link), not the bare specifier, so an exact string
        // match never fires. Matching the resolved path is what actually
        // keeps the addon out of the transform pipeline; without it the
        // failure merely moves from "Failed to load url better-sqlite3" to
        // "Cannot find module './database'", which is Vite trying and
        // failing to follow better-sqlite3's own internal CJS requires.
        external: [/better-sqlite3/, /@browserglass\/store-sqlite/],
      },
    },
  },
});
