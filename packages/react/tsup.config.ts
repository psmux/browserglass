import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsup';

/**
 * Build configuration for `@browserglass/react`.
 *
 * Four entry points, one per file the package.json `exports` map names:
 * the main browser entry, its `react-server` guard twin, and the same pair
 * for the `./ui` subpath (the `browser` and `react-server` export
 * conditions make importing from a server component fail at build time). `react` and `react-dom` stay
 * external (peer dependencies; a consuming app supplies its own copy).
 *
 * `ui/styles.css` is plain CSS, not a JS module import, so tsup's own
 * pipeline never touches it; `onSuccess` copies it into `dist/ui/` after
 * every build so `@browserglass/react/ui/styles.css` resolves.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'index.react-server': 'src/index.react-server.ts',
    'ui/index': 'src/ui/index.ts',
    'ui/index.react-server': 'src/ui/index.react-server.ts',
  },
  format: ['esm'],
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  // Rolled up to one .d.ts per entry point.
  // Composite is disabled for this isolated dts build only, because tsup's
  // dts step instantiates its own TS program and TS6307 ("file not listed
  // in project") fires under composite:true even though this package's own
  // tsconfig.json includes every file via "include": ["src"].
  dts: { compilerOptions: { composite: false, incremental: false } },
  sourcemap: true,
  clean: true,
  // Canonical .mjs output regardless of the package.json "type" field,
  // matching every other package's build.
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.mjs' };
  },
  async onSuccess() {
    const src = join(__dirname, 'src', 'ui', 'styles.css');
    const dest = join(__dirname, 'dist', 'ui', 'styles.css');
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  },
});
