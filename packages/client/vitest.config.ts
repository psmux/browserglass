import { defineConfig } from 'vitest/config';

/**
 * `@browserglass/client` Vitest project config.
 *
 * The renderer and input capture modules exercise `HTMLCanvasElement`,
 * `PointerEvent`, and `ResizeObserver`, so this package's tests run under a
 * browser like DOM environment rather than Vitest's default Node
 * environment. See `test/setup.ts` for the small set of DOM APIs jsdom does
 * not implement (2D canvas rendering, `createImageBitmap`,
 * `PointerEvent.getCoalescedEvents`) that are polyfilled for tests only.
 * None of this ships in the built package: it is devDependency only test
 * infrastructure, picked up automatically by `vitest.workspace.ts` at the
 * repo root.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
  },
});
