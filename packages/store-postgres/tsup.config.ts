import { defineConfig } from 'tsup';

/**
 * Build configuration for `@browserglass/store-postgres`.
 *
 * Two entries, not one: `index` is the package's public surface;
 * `sync-worker` is `src/sync/worker.ts`, the `worker_threads` script
 * `sync/bridge.ts`'s `SyncBridge` spawns at runtime by resolved file path
 * (`bridge.ts`'s `resolveWorkerPath()`), so it must exist as a real
 * sibling file next to `index.mjs`/`index.cjs` in `dist/`, in both module
 * formats, the same way `index` itself does. `dts.entry` restricts type
 * declaration generation to `index`, since the worker script has no public
 * API of its own to declare.
 */
export default defineConfig({
  entry: { index: 'src/index.ts', 'sync-worker': 'src/sync/worker.ts' },
  format: ['esm', 'cjs'],
  target: 'node22',
  // Rolled up to one index.d.ts (plus index.d.cts for the CJS output).
  // Composite is disabled for this
  // isolated dts build only, because tsup's dts step instantiates its own
  // TS program and TS6307 ("file not listed in project") fires under
  // composite:true even though this package's own tsconfig.json includes
  // every file via "include": ["src"].
  dts: { entry: ['src/index.ts'], compilerOptions: { composite: false, incremental: false } },
  sourcemap: true,
  clean: true,
  platform: 'node',
  // Canonical .mjs/.cjs output regardless of the package.json "type"
  // field, the same for every package in this repo.
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.mjs' };
  },
  external: ['better-sqlite3', 'pg'],
});
