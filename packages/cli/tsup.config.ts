import { defineConfig } from 'tsup';

/**
 * Build configuration for `@browserglass/cli`.
 * Three entry points: the library, the `bgls` binary, and the config
 * helper.
 */
export default defineConfig({
  entry: ['src/index.ts', 'src/bin.ts', 'src/config.ts'],
  format: ['esm'],
  target: 'node22',
  // Rolled up to one .d.ts per entry point (plus index.d.cts for the CJS
  // output). Composite is disabled for
  // this isolated dts build only, because tsup's dts step instantiates its
  // own TS program and TS6307 ("file not listed in project") fires under
  // composite:true even though this package's own tsconfig.json includes
  // every file via "include": ["src"].
  dts: { compilerOptions: { composite: false, incremental: false } },
  sourcemap: true,
  clean: true,
  // Canonical .mjs/.cjs output regardless of the package.json "type"
  // field, matching every other package's build.
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.mjs' };
  },
  // Every workspace package plus its runtime deps stay external: `cli` is
  // a Node CLI that resolves them from node_modules at run time, never a
  // bundle meant to inline them (the "native modules are never bundled"
  // rule extends here to the whole dependency graph, not just
  // better-sqlite3/pg).
  external: [/^@browserglass\//, 'better-sqlite3', 'pg', 'citty', 'consola', 'c12', 'tinyexec'],
});
