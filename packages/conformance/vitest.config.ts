import { defineConfig } from 'vitest/config';

/**
 * `@browserglass/conformance` Vitest project config.
 *
 * This suite runs against a real gateway (`@browserglass/server` plus a
 * real `@browserglass/store-sqlite`, real `@browserglass/router`, and a
 * real `@browserglass/runtime-host` launching real Chrome on this
 * machine) and, for the chaos scenarios, keeps a real Chrome process
 * alive for tens of seconds. `singleFork` runs every test file
 * sequentially in one child process so two files never race for the
 * same loopback ports or launch two Chrome instances that fight over
 * CPU at once, matching `@browserglass/core`'s own precedent for a
 * suite that cannot tolerate cross-file parallelism. `testTimeout` and
 * `hookTimeout` are generous because a real Chrome launch, a real
 * `bg.start()`/`bg.stop()`, and the subscribe/unsubscribe chaos
 * scenario's 60s run all live inside single tests or hooks.
 *
 * The one test file that exercises `CanvasRenderer`'s coordinate
 * transform (`test/coordinate/roundtrip.test.ts`) opts into jsdom
 * itself via a `// @vitest-environment jsdom` docblock, so the default
 * environment here stays `node`, which every other file (protocol
 * vectors, the Store contract suite, the real-gateway and chaos suites)
 * actually needs for `node:http`, `node:child_process`, and `ws`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    // `better-sqlite3` is a native addon (a `.node` binary) that Vite
    // cannot transform. It reaches this package through
    // `@browserglass/store-sqlite`, and pnpm's strict layout keeps it in
    // that package's own `node_modules` rather than hoisting it. Node's
    // resolver follows the workspace symlink correctly; Vite's does not,
    // because it resolves from the IMPORTER's root and then tries to
    // transform what it finds.
    //
    // Regexes, not bare strings: the id tested here is the RESOLVED path,
    // so an exact specifier match never fires. Without this, twenty test
    // FILES failed at collection with "Failed to load url better-sqlite3",
    // including every e2e parallelism and shared control suite in this
    // package. They had been invisible for a long time, because
    // `pnpm -w test`'s fail-fast ordering aborted the recursive run in an
    // earlier package and never reached `conformance`, which runs last.
    server: {
      deps: {
        external: [/better-sqlite3/, /@browserglass\/store-sqlite/],
      },
    },
    testTimeout: 120_000,
    hookTimeout: 90_000,
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
