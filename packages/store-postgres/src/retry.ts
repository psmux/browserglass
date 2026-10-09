/**
 * Retry and the 50ms slow-operation warning, ported from `store-sqlite`'s
 * `retry.ts`. SQLite's single writer rules describe
 * `SQLITE_BUSY` backoff (5ms, 15ms, 45ms, 135ms plus jitter, then throw)
 * and a 50ms transaction-duration warning; Postgres has no single writer
 * lock to wait on, but it has the direct equivalent failure mode a real
 * concurrent workload actually produces: a serialisation failure
 * (`40001`) or a detected deadlock (`40P01`) under `SERIALIZABLE` (or, for
 * a deadlock, any) isolation, where the correct response is exactly the
 * same shape as `SQLITE_BUSY`'s: back off and retry the whole operation
 * from scratch, since the failed attempt made no durable change. The same
 * backoff schedule and 50ms warning are kept so the two adapters remain
 * legible side by side and any dashboard built against
 * `bgls_store_retry_total{reason="busy"}` keeps meaning the same thing.
 */

/** The exact backoff schedule, in milliseconds, before jitter. Identical to `store-sqlite`'s. */
export const RETRY_BACKOFF_MS: readonly number[] = [5, 15, 45, 135];

/** Postgres error codes worth retrying: serialization failure and deadlock detected, both meaning "no durable change happened, try again". */
const RETRYABLE_SQLSTATES = new Set(['40001', '40P01']);

/** Process-lifetime counter mirroring `bgls_store_retry_total{reason="serialization"}`. */
let retryCount = 0;

/** Returns the number of serialisation/deadlock retries this store instance has performed since process start. */
export function retryTotal(): number {
  return retryCount;
}

function isRetryableError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    RETRYABLE_SQLSTATES.has(String((err as { code?: unknown }).code))
  );
}

/** Postgres's `23505` (`unique_violation`), the direct equivalent of SQLite's `SQLITE_CONSTRAINT_UNIQUE`. */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === '23505'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Runs `fn` (an async Postgres operation, typically one query or one whole
 * transaction) with the bounded serialisation/deadlock retry schedule, and
 * warns with a stack trace when a single attempt exceeds 50ms, matching
 * `store-sqlite`'s `withBusyRetry` in every observable respect except what
 * it retries on.
 */
export async function withPgRetry<T>(
  fn: () => Promise<T>,
  label: string,
  maxRetries: number = RETRY_BACKOFF_MS.length,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = performance.now();
    try {
      const result = await fn();
      const durationMs = performance.now() - startedAt;
      if (durationMs > 50) {
        console.warn(
          `[store-postgres] ${label} took ${durationMs.toFixed(1)}ms (over the 50ms budget); ` +
            `a slow transaction holds row/advisory locks for longer than every other writer should wait.\n${new Error().stack}`,
        );
      }
      return result;
    } catch (err) {
      if (isRetryableError(err) && attempt < maxRetries) {
        retryCount++;
        const base = RETRY_BACKOFF_MS[attempt % RETRY_BACKOFF_MS.length] as number;
        const jitter = Math.random() * base * 0.5;
        await sleep(base + jitter);
        continue;
      }
      throw err;
    }
  }
}
