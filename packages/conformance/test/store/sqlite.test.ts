/**
 * `Store` contract suite run against the real `@browserglass/store-sqlite`
 * adapter. Two independent connections
 * are opened against the identical temp-file database (never `:memory:`,
 * which is private per connection and could not race), giving the
 * `acquireProfileLease` concurrency assertion inside
 * {@link runStoreContractSuite} real, engine level concurrency: two
 * separate `better-sqlite3` handles, in WAL mode, genuinely racing the
 * partial-unique-index INSERT, not two `Promise`s cooperatively
 * scheduled on one JS thread.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Store } from '@browserglass/protocol';
import { type CreateSqliteStoreOptions, createSqliteStore } from '@browserglass/store-sqlite';
import { afterAll, beforeAll } from 'vitest';
import { runStoreContractSuite } from '../../src/index.js';

let dir: string;
let store: Store;
let secondConnection: Store;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bgls-conformance-store-sqlite-'));
  const dbPath = join(dir, 'control.db');
  const opts: CreateSqliteStoreOptions = { migrate: 'auto' };
  store = await createSqliteStore(dbPath, opts);
  secondConnection = await createSqliteStore(dbPath, { migrate: 'off' });
});

afterAll(async () => {
  await secondConnection.close();
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

runStoreContractSuite({
  name: 'store-sqlite',
  store: () => store,
  secondConnection: () => secondConnection,
});
