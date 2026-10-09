import { defineConfig } from 'vitest/config';

/**
 * Dedicated vitest config for the S1/S2 spike measurement script. This is
 * deliberately separate from the package's default config: the spike is a
 * manual measurement tool, not a CI test, and must never be picked up by
 * `pnpm -r test` or the package's normal `vitest run` (whose default
 * `include` glob only matches `*.test.ts`/`*.spec.ts`, which this file's
 * sibling script intentionally does not).
 *
 * Run explicitly with:
 *   pnpm --filter @browserglass/runtime-host exec vitest run --config test/spike/vitest.spike.config.ts
 */
export default defineConfig({
  test: {
    include: ['test/spike/spike-*.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
  },
});
