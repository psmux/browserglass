import { defineConfig } from 'vitest/config';

/**
 * `@browserglass/server` Vitest project config.
 *
 * Only here so the real Chrome tests in this package (for example
 * `test/lifecycle/chrome-shutdown.e2e.test.ts`) start Chrome on seeded
 * profiles and leave nothing in the machine's temp folder: see
 * `runtime-host/test/support/seeded-chrome.ts`. Everything else is the
 * Vitest default this package always ran with.
 */
export default defineConfig({
  test: {
    globalSetup: ['../runtime-host/test/support/seeded-chrome.ts'],
    setupFiles: ['../runtime-host/test/support/seeded-chrome.setup.ts'],
  },
});
