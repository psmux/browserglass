import { defineConfig } from 'tsup';

/**
 * Build configuration for `@browserglass/runtime-host`.
 * One public entry point, `src/index.ts`.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'node22',
  // Rolled up to one index.d.ts (plus index.d.cts for the CJS output).
  // Composite is disabled for this
  // isolated dts build only, because tsup's dts step instantiates its own
  // TS program and TS6307 ("file not listed in project") fires under
  // composite:true even though this package's own tsconfig.json includes
  // every file via "include": ["src"].
  dts: { compilerOptions: { composite: false, incremental: false } },
  sourcemap: true,
  clean: true,
  // Canonical .mjs/.cjs output regardless of the package.json "type"
  // field, the same for every package in this repo.
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.mjs' };
  },
  external: ['better-sqlite3', 'pg'],
});
