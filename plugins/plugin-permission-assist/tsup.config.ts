import { defineConfig } from 'tsup';

/**
 * Builds to exactly one file, `dist/plugin.mjs`, with zero runtime
 * dependencies: the digest a `bgls plugins add`
 * records has to cover every line that will execute, so there is nothing
 * to bundle here besides this plugin's own source. Node's own `node:*`
 * builtins stay external; they are not a runtime dependency, they ship
 * inside Node itself.
 */
export default defineConfig({
  entry: { plugin: 'src/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  bundle: true,
  splitting: false,
  treeshake: true,
  dts: false,
  sourcemap: false,
  clean: true,
  outExtension() {
    return { js: '.mjs' };
  },
});
