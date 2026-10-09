import { defineConfig } from 'vitest/config';

/**
 * `@browserglass/embed` Vitest project config. `BrowserGlassElement`
 * attaches `@browserglass/client`'s `CanvasRenderer` and `InputCapture` to
 * a real `<canvas>` inside its shadow root and drives a real
 * `BrowserGlassClient`, so this package's tests run under jsdom rather
 * than Vitest's default Node environment, and `test/support/setup.ts`
 * polyfills the handful of DOM APIs jsdom does not implement (2D canvas
 * rendering, `createImageBitmap`, `PointerEvent.getCoalescedEvents`,
 * deterministic `requestAnimationFrame`), the same list
 * `packages/react/test/support/setup.ts` polyfills for the same reason.
 * Duplicated rather than imported across the package boundary: test
 * directories are not part of either package's public surface. Picked up
 * automatically by the repo root `vitest.workspace.ts`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/support/setup.ts'],
    globals: false,
  },
});
