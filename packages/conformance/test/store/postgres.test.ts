import type { Store } from '@browserglass/protocol';
import { createPostgresStore } from '@browserglass/store-postgres';
/**
 * `Store` contract suite run against the real `@browserglass/store-postgres`
 * adapter, the same generic suite `sqlite.test.ts` runs against
 * `store-sqlite`, proving parity from one shared assertion set rather than
 * asserting it by hand twice.
 *
 * Postgres is not assumed to be running wherever this suite executes.
 * Set `BGLS_TEST_POSTGRES_URL` to a real `postgres://` connection string
 * (a throwaway database is fine; this suite creates and drops its own
 * tenants but never truncates the schema) to run the full behavioural
 * contract for real. Without it, this file registers one explicit skipped
 * test naming the environment variable, rather than silently reporting
 * zero tests or, worse, faking a pass.
 *
 * Two independent `Pool`s are opened against the identical database (never
 * a single shared pool), giving the `acquireProfileLease` concurrency
 * assertion inside `runStoreContractSuite` real, engine level concurrency:
 * two separate connections racing the same `ON CONFLICT ... DO NOTHING`
 * insert, resolved by Postgres's own MVCC/unique-index machinery, not by
 * anything this process serialises.
 */
import { afterAll, beforeAll, describe, it } from 'vitest';
import { runStoreContractSuite } from '../../src/index.js';

const connectionString = process.env['BGLS_TEST_POSTGRES_URL'];

describe.skipIf(!connectionString)('Store contract: store-postgres (real)', () => {
  let store: Store;
  let secondConnection: Store;

  beforeAll(async () => {
    // `migrate: 'auto'` on the first store, `'off'` on the second: only
    // one connection needs to run the migration runner's advisory-lock
    // protected `runMigrations`, and running it twice concurrently would
    // otherwise just serialise on that lock for no benefit.
    store = await createPostgresStore(connectionString as string, { migrate: 'auto' });
    secondConnection = await createPostgresStore(connectionString as string, { migrate: 'off' });
  });

  afterAll(async () => {
    await secondConnection.close();
    await store.close();
  });

  runStoreContractSuite({
    name: 'store-postgres',
    store: () => store,
    secondConnection: () => secondConnection,
  });
});

if (!connectionString) {
  it.skip('store-postgres contract suite (set BGLS_TEST_POSTGRES_URL to a postgres:// connection string to run this suite against a real server)', () =>
    undefined);
}
