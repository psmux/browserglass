import { defineConfig } from 'vitest/config';

/**
 * `@browserglass/react` Vitest project config.
 *
 * Every hook and component here renders through React Testing Library and
 * exercises `HTMLCanvasElement`, `WebSocket`, and pointer/wheel events, so
 * this package's tests run under jsdom rather than Vitest's default Node
 * environment. `test/support/setup.ts` polyfills the same handful of DOM
 * APIs jsdom does not implement that `@browserglass/client`'s own test
 * suite polyfills (2D canvas rendering, `createImageBitmap`,
 * `PointerEvent.getCoalescedEvents`, deterministic `requestAnimationFrame`);
 * none of it ships in the built package. Picked up automatically by
 * `vitest.workspace.ts` at the repo root.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/support/setup.ts'],
    globals: false,
  },
});
