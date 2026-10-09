import { defineConfig } from 'vitest/config';

/**
 * `@browserglass/core` vitest config.
 *
 * This package loads the native `sharp` binding (libvips) in
 * `src/stream/tier1-encoder.ts` for real tier-1 encode tests. libvips is
 * not safe to load under Vitest's default `threads` pool (test files as
 * worker threads sharing one process), and even under the `forks` pool
 * (test files as separate child processes) it still produces intermittent
 * native decode failures (observed as `pngload_buffer: libspng read
 * error`) when several forked processes load the native binding under
 * concurrent CPU load, even though the same test passes reliably in
 * isolation. `singleFork: true` runs every test file in this package
 * sequentially inside one child process: still a real process, not a
 * worker thread, and never more than one file executing at a time, which
 * removes both failure modes. This package's suite is dominated by one
 * CPU-bound property test regardless of parallelism, so the wall-clock
 * cost of serialising the rest is small.
 */
export default defineConfig({
  test: {
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
