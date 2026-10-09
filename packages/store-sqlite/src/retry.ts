/**
 * `SQLITE_BUSY` retry and the 50ms slow-transaction warning, per SQLite's
 * single writer rules: "Retries are automatic and bounded. On
 * SQLITE_BUSY: backoff 5ms, 15ms, 45ms, 135ms plus jitter, then throw.
 * Every retry increments bgls_store_retry_total{reason="busy"}." and
 * "Adapter instruments transaction duration, logs a warning above 50ms with
 * a stack trace (always a caller bug)."
 */

/** The exact backoff schedule, in milliseconds, before jitter. */
export const BUSY_BACKOFF_MS: readonly number[] = [5, 15, 45, 135];

/** Process-lifetime counter mirroring `bgls_store_retry_total{reason="busy"}`; a real metrics sink can read it via {@link busyRetryTotal}. */
let busyRetryCount = 0;

/** Returns the number of `SQLITE_BUSY` retries this store instance has performed since process start. */
export function busyRetryTotal(): number {
  return busyRetryCount;
}

function isBusyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'SQLITE_BUSY'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Runs `fn` (a synchronous `better-sqlite3` call, typically a
 * `db.transaction(...).immediate()` invocation) with the bounded
 * `SQLITE_BUSY` retry schedule, and warns with a stack trace when a single
 * attempt exceeds 50ms.
 */
export async function withBusyRetry<T>(fn: () => T, label: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const startedAt = performance.now();
    try {
      const result = fn();
      const durationMs = performance.now() - startedAt;
      if (durationMs > 50) {
        console.warn(
          `[store-sqlite] ${label} took ${durationMs.toFixed(1)}ms (over the 50ms budget); ` +
            `long transactions hold the single writer lock for every other writer.\n${new Error().stack}`,
        );
      }
      return result;
    } catch (err) {
      if (isBusyError(err) && attempt < BUSY_BACKOFF_MS.length) {
        busyRetryCount++;
        const base = BUSY_BACKOFF_MS[attempt] as number;
        const jitter = Math.random() * base * 0.5;
        await sleep(base + jitter);
        continue;
      }
      throw err;
    }
  }
}
