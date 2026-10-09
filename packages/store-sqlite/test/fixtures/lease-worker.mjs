// Standalone worker process for the real (multi-process) concurrency test in
// concurrent-lease.test.ts. Run as a separate `node` process, never
// imported: two of these racing against the same SQLite file is the only
// way to exercise the partial-unique-index mutual exclusion under a
// genuine, not simulated, concurrent write.
//
// argv: dbPath tenantId profileId nodeId ttlMs
import { createSqliteStore } from '../../dist/index.mjs';

const [, , dbPath, tenantId, profileId, nodeId, ttlMs] = process.argv;

const store = await createSqliteStore(dbPath, { migrate: 'off' });
try {
  const lease = await store.acquireProfileLease({
    tenantId,
    profileId,
    nodeId,
    holderPid: process.pid,
    ttlMs: Number(ttlMs),
  });
  process.stdout.write(JSON.stringify({ pid: process.pid, lease }));
} finally {
  await store.close();
}
