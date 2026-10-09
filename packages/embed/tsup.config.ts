import { defineConfig } from 'tsup';

/**
 * Build configuration for `@browserglass/embed`.
 *
 * Two builds from the same `src/index.ts`, because the two audiences need
 * opposite bundling:
 *
 * 1. `dist/index.mjs` (ESM): `@browserglass/protocol` and
 *    `@browserglass/client` stay external, matching every other package in
 *    this repo, for a consumer with its own bundler and its own copy of
 *    those packages (a React app that also wants the plain-HTML widget
 *    somewhere, a Vue app, and so on).
 * 2. `dist/browserglass-embed.global.js` (IIFE): every module, this
 *    package's own and both workspace dependencies, is bundled straight
 *    in (see this config's own `noExternal` below), because a
 *    `<script src="...">` consumer has no module loader to resolve
 *    `@browserglass/client` against. This is the file a "no build
 *    step" page actually loads; the ESM build
 *    exists for completeness, not as the primary deliverable.
 *
 * Both entries import the same `src/index.ts`, which self-registers
 * `<browser-glass>` as a side effect of being loaded (see that file's own
 * doc comment). `package.json`'s `sideEffects: true` is required for this
 * reason: a bundler that tree-shook the ESM build on the (correct, for
 * most packages) assumption that an unused import has no effect would
 * silently drop the one line of code a plain `<script type="module">`
 * import exists to run.
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    target: 'es2022',
    platform: 'browser',
    dts: { compilerOptions: { composite: false, incremental: false } },
    sourcemap: true,
    clean: true,
    outExtension: () => ({ js: '.mjs' }),
  },
  {
    entry: { 'browserglass-embed': 'src/index.ts' },
    format: ['iife'],
    target: 'es2022',
    platform: 'browser',
    globalName: 'BrowserGlassEmbed',
    noExternal: [/.*/],
    dts: false,
    sourcemap: true,
    // Does not clean: this build runs second and must not delete the ESM
    // output the first config just produced into the same dist/ directory.
    clean: false,
    minify: true,
    outExtension: () => ({ js: '.global.js' }),
  },
]);
