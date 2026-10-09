import { BglsError } from '@browserglass/protocol';
/**
 * Unit-level tests for `@browserglass/store-postgres` that do NOT require
 * a reachable Postgres server: `capabilities()` is pure, `ping()` is
 * documented to never throw, and `createPostgresStore`'s connection
 * failure path is exactly the "fail with a clear error naming the
 * setting" behaviour this package promises, which an
 * unreachable address demonstrates directly (no server needs to actually
 * answer for the connection to fail).
 *
 * The full behavioural contract (`Store` CRUD, atomicity, and
 * concurrency) lives in `packages/conformance/test/store/postgres.test.ts`,
 * gated on `BGLS_TEST_POSTGRES_URL`, and in `test/concurrency.test.ts` in
 * this package, gated the same way. See both files' own top comments.
 */
import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresStore, createPostgresStore } from '../src/index.js';

/** A `postgres://` URL that fails fast: port 1 is a reserved port nothing listens on, and the host resolves instantly (loopback), so this never waits out a DNS timeout. */
const UNREACHABLE_URL = 'postgres://user:pass@127.0.0.1:1/nope';

describe('store-postgres: capabilities and ping never require a live connection', () => {
  it('capabilities() reports the real Postgres capability set', () => {
    const pool = new Pool({ connectionString: UNREACHABLE_URL });
    const store = new PostgresStore(pool, 'unused', { connectionString: UNREACHABLE_URL });
    const caps = store.capabilities();
    expect(caps).toEqual({
      transactions: true,
      advisoryLocks: true,
      skipLocked: true,
      notify: true,
      concurrentWriters: true,
      maxWriteConcurrency: 10,
    });
    void pool.end();
  });

  it('ping() reports { ok: false } without throwing against an unreachable server', async () => {
    const pool = new Pool({ connectionString: UNREACHABLE_URL, connectionTimeoutMillis: 500 });
    const store = new PostgresStore(pool, 'unused', { connectionString: UNREACHABLE_URL });
    const result = await store.ping();
    expect(result.ok).toBe(false);
    await pool.end().catch(() => undefined);
  });
});

describe('createPostgresStore: connection failure is a clear, named error', () => {
  it('rejects with BglsError E_STORE_CONNECTION_FAILED naming --store/BGLS_STORE_URL when the server is unreachable', async () => {
    await expect(
      createPostgresStore(UNREACHABLE_URL, { pool: { connectionTimeoutMs: 500 } }),
    ).rejects.toMatchObject({
      name: 'BglsError',
      code: 'E_STORE_CONNECTION_FAILED',
    });
  }, 10_000);

  it('the rejection is a real BglsError instance, not merely a look-alike shape', async () => {
    try {
      await createPostgresStore(UNREACHABLE_URL, { pool: { connectionTimeoutMs: 500 } });
      expect.unreachable(
        'createPostgresStore was expected to reject against an unreachable server',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(BglsError);
      expect((err as BglsError).message).toMatch(/--store|BGLS_STORE_URL/);
    }
  }, 10_000);

  it('names the TLS settings instead when tls.enabled is set', async () => {
    try {
      await createPostgresStore(UNREACHABLE_URL, {
        pool: { connectionTimeoutMs: 500 },
        tls: { enabled: true, rejectUnauthorized: false },
      });
      expect.unreachable(
        'createPostgresStore was expected to reject against an unreachable server',
      );
    } catch (err) {
      expect(err).toBeInstanceOf(BglsError);
      expect((err as BglsError).message).toMatch(/--store-tls|BGLS_STORE_TLS/);
    }
  }, 10_000);
});

if (!process.env['BGLS_TEST_POSTGRES_URL']) {
  it.skip('the full Store behavioural contract (set BGLS_TEST_POSTGRES_URL to a postgres:// connection string to run it): see packages/conformance/test/store/postgres.test.ts and test/concurrency.test.ts', () =>
    undefined);
}
