import { defineWorkspace } from 'vitest/config';

/**
 * BrowserGlass Vitest workspace. Every package under `packages/*` that owns
 * a `vitest.config.ts` (or falls back to this default project shape) runs as
 * one project in the workspace, so `pnpm -r test` and a single root
 * `vitest run` see the same suite.
 */
export default defineWorkspace(['packages/*']);
